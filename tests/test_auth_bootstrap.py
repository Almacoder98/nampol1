"""Enrollment bootstrap retains existing token and verified-email checks."""
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
from app import FIREBASE_PROJECT, create_app

class AuthBootstrapTests(unittest.TestCase):
    def setUp(self):
        application = create_app(initialize_services=False)
        application.state.firebase_app = None
        self.client = TestClient(application)

    def test_anonymous_request_is_rejected(self):
        self.assertEqual(self.client.get('/api/auth/bootstrap').status_code, 401)

    def request_with_verified_email(self, verified):
        claims = {'uid': 'test-user', 'email_verified': verified,
                  'aud': FIREBASE_PROJECT,
                  'iss': f'https://securetoken.google.com/{FIREBASE_PROJECT}'}
        with patch('app.auth.verify_id_token', return_value=claims):
            return self.client.get('/api/auth/bootstrap',
                                   headers={'Authorization': 'Bearer synthetic-token'})

    def test_verified_user_receives_no_data_or_admin_grant(self):
        response = self.request_with_verified_email(True)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'uid': 'test-user'})

    def test_unverified_user_is_rejected(self):
        self.assertEqual(self.request_with_verified_email(False).status_code, 403)
