"""Real SDK verification with ephemeral RSA keys and offline certificate/user fixtures.

No application credentials, browser sessions or cloud requests are used.
"""
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import Mock, patch

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from firebase_admin import _auth_client, _token_gen
from google.auth import crypt, jwt

from app import FIREBASE_PROJECT, Principal, verify_firebase_token


class StrictFirebaseSDKTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.private = key.private_bytes(serialization.Encoding.PEM,
                                       serialization.PrivateFormat.PKCS8,
                                       serialization.NoEncryption())
        cls.public = key.public_key().public_bytes(serialization.Encoding.PEM,
                                                   serialization.PublicFormat.SubjectPublicKeyInfo)

    def setUp(self):
        self.issued = 1800000000
        self.client = _auth_client.Client.__new__(_auth_client.Client)
        self.client._tenant_id = None
        self.client._token_verifier = _token_gen.TokenVerifier(
            SimpleNamespace(project_id=FIREBASE_PROJECT, options={}))
        self.client.get_user = Mock(return_value=SimpleNamespace(
            disabled=False, tokens_valid_after_timestamp=0))
        self.addCleanup(patch.stopall)
        patch('firebase_admin.auth._get_client', return_value=self.client).start()
        patch('google.oauth2.id_token._fetch_certs', return_value={'offline-test': self.public}).start()
        # Make emulator use impossible even if the developer's test shell enables it.
        patch('firebase_admin._auth_utils.is_emulated', return_value=False).start()

    def token(self, **changes):
        claims = {'sub': 'synthetic-applicant', 'aud': FIREBASE_PROJECT,
                  'iss': f'https://securetoken.google.com/{FIREBASE_PROJECT}',
                  'iat': self.issued, 'exp': self.issued + 3600,
                  'auth_time': self.issued - 60, 'email_verified': True,
                  'firebase': {'sign_in_second_factor': 'totp'}, **changes}
        signer = crypt.RSASigner.from_string(self.private, key_id='offline-test')
        return jwt.encode(signer, claims).decode()

    def verify_at(self, token, seconds):
        now = datetime.fromtimestamp(seconds, timezone.utc).replace(tzinfo=None)
        with patch('google.auth._helpers.utcnow', return_value=now):
            return verify_firebase_token(token, None)

    def test_four_second_clock_lag_rejects_then_same_token_passes_after_sync(self):
        token = self.token()
        with self.assertLogs('nampol.auth', level='WARNING') as captured:
            with self.assertRaises(HTTPException) as caught:
                self.verify_at(token, self.issued - 4)
        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(caught.exception.detail['code'], 'auth_clock_error')
        self.assertIn('reason=server_clock_behind_token', ' '.join(captured.output))
        self.client.get_user.assert_not_called()
        self.assertEqual(self.verify_at(token, self.issued), Principal('synthetic-applicant'))
        self.client.get_user.assert_called_once_with('synthetic-applicant')

    def test_expired_token_stays_rejected_without_expiry_grace(self):
        with self.assertRaises(HTTPException) as caught:
            self.verify_at(self.token(), self.issued + 3601)
        self.assertEqual(caught.exception.status_code, 401)
        self.assertEqual(caught.exception.detail['code'], 'session_expired')

    def test_verified_password_sign_in_does_not_require_a_second_factor(self):
        for firebase in ({}, {'sign_in_provider': 'password'}, {'sign_in_second_factor': 'phone'}):
            self.assertEqual(self.verify_at(self.token(firebase=firebase), self.issued),
                             Principal('synthetic-applicant'))

    def test_revocation_and_disabled_checks_still_run_after_signature_verification(self):
        for disabled, revoked in ((True, False), (False, True)):
            self.client.get_user.return_value = SimpleNamespace(
                disabled=disabled,
                tokens_valid_after_timestamp=(self.issued + 1) * 1000 if revoked else 0)
            with self.assertRaises(HTTPException) as caught:
                self.verify_at(self.token(), self.issued)
            self.assertEqual(caught.exception.status_code, 401)

    def test_invalid_signature_and_wrong_project_still_fail_closed(self):
        token = self.token()
        header, payload, signature = token.split('.')
        bad_signature = ('A' if signature[0] != 'A' else 'B') + signature[1:]
        for token, status in ((f'{header}.{payload}.{bad_signature}', 401),
                              (self.token(aud='other-project'), 503),
                              (self.token(iss='https://securetoken.google.com/other-project'), 503)):
            with self.assertRaises(HTTPException) as caught:
                self.verify_at(token, self.issued)
            self.assertEqual(caught.exception.status_code, status)
        self.client.get_user.assert_not_called()


if __name__ == '__main__':
    unittest.main()
