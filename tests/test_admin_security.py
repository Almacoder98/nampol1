"""Offline Phase 1 security tests. No cloud credentials or live accounts."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import hashlib
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from app import Authorization, Principal, create_app, verify_firebase_token
from backend.admin_security import AdminSecurity, staff_identity
from test_documents import Database, transactional


class AdminSecurityTests(unittest.TestCase):
    def setUp(self):
        self.db = Database()
        self.now = datetime(2026, 10, 23, tzinfo=timezone.utc)
        self.users = {uid: SimpleNamespace(email=uid + '@example.invalid', disabled=False, email_verified=True)
                      for uid in ('staff', 'other', 'applicant')}
        self.service = AdminSecurity(self.db, self.users.__getitem__, lambda: self.now)
        self.patch = patch('backend.admin_security.firestore.transactional', transactional)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def issue(self, uid='staff', number='NAMPOL-001', role='admin', region='Khomas'):
        return self.service.issue(uid, number, role, region)

    def test_code_is_random_hashed_uid_bound_and_consumed_once(self):
        code = self.issue()
        self.assertEqual(len(code), 43)
        stored = self.db.read('adminProvisioning', 'staff')
        self.assertNotIn(code, str(self.db.data))
        self.assertEqual(stored['codeDigest'], hashlib.sha256(code.encode()).hexdigest())
        with self.assertRaises(HTTPException): self.service.activate('other', code)
        result = self.service.activate('staff', code)
        self.assertEqual(result['role'], 'admin')
        self.assertEqual(result['region'], 'Khomas')
        with self.assertRaises(HTTPException): self.service.activate('staff', code)
        self.assertEqual(self.db.read('adminProvisioning', 'staff')['codeDigest'], '')

    def test_unique_staff_identifier_cannot_be_reassigned_or_used_as_a_secret(self):
        self.issue()
        with self.assertRaises(ValueError): self.issue('other', 'nampol-001')
        with self.assertRaises(HTTPException): self.service.activate('staff', 'NAMPOL-001')
        self.assertIsNone(self.db.read('admins', 'staff'))

    def test_public_applicant_cannot_be_provisioned_even_with_an_operator_code(self):
        self.db.data[('users', 'applicant')] = {'role': 'applicant'}
        with self.assertRaises(ValueError): self.issue('applicant')
        self.assertIsNone(self.db.read('adminProvisioning', 'applicant'))
        with self.assertRaises(HTTPException): self.service.activate('applicant', 'A' * 43)

    def test_expiry_email_changes_disabled_and_unverified_users_fail_closed(self):
        code = self.issue()
        self.now += timedelta(days=2)
        with self.assertRaises(HTTPException): self.service.activate('staff', code)
        self.now -= timedelta(days=2)
        for field, value in [('disabled', True), ('email_verified', False), ('email', 'changed@example.invalid')]:
            original = getattr(self.users['staff'], field)
            setattr(self.users['staff'], field, value)
            with self.assertRaises(HTTPException): self.service.activate('staff', code)
            setattr(self.users['staff'], field, original)
        self.assertIsNone(self.db.read('admins', 'staff'))

    def test_wrong_codes_are_throttled_and_never_logged(self):
        code = self.issue()
        for _ in range(5):
            with self.assertRaises(HTTPException): self.service.activate('staff', 'B' * 43)
        with self.assertRaises(HTTPException) as caught: self.service.activate('staff', code)
        self.assertEqual(caught.exception.status_code, 429)
        self.assertNotIn('B' * 43, str(self.db.data))
        self.now += timedelta(minutes=16)
        self.assertTrue(self.service.activate('staff', code)['active'])

    def test_reissued_code_invalidates_the_old_code(self):
        old = self.issue()
        new = self.issue()
        self.assertNotEqual(old, new)
        with self.assertRaises(HTTPException): self.service.activate('staff', old)
        self.assertEqual(self.service.activate('staff', new)['staffNumber'], 'NAMPOL-001')

    def test_it_can_cancel_a_pending_code_before_activation(self):
        code = self.issue()
        self.service.deactivate('staff')
        with self.assertRaises(HTTPException): self.service.activate('staff', code)
        self.assertEqual(self.db.read('adminProvisioning', 'staff')['codeDigest'], '')

    def test_deactivation_removes_grant_but_never_recycles_the_staff_identifier(self):
        self.service.activate('staff', self.issue())
        self.service.deactivate('staff')
        with self.assertRaises(HTTPException): self.service.session('staff')
        with self.assertRaises(ValueError): self.issue('other', 'NAMPOL-001')
        self.assertTrue(any(item.get('action') == 'ADMIN_DEACTIVATED' for item in self.db.data.values()))

    def test_concurrent_activation_has_exactly_one_winner(self):
        code = self.issue()
        def activate(_):
            try: self.service.activate('staff', code); return True
            except HTTPException: return False
        with ThreadPoolExecutor(max_workers=4) as pool:
            self.assertEqual(sum(pool.map(activate, range(8))), 1)

    def test_role_region_validation_and_current_registry_are_authoritative(self):
        for role, region in [('owner', 'Khomas'), ('admin', ''), ('admin', 'Invented')]:
            with self.assertRaises(ValueError): self.issue(role=role, region=region)
        self.service.activate('staff', self.issue())
        boundary = Authorization(self.db)
        boundary.administrator(Principal('staff'), 'Khomas')
        with self.assertRaises(HTTPException): boundary.administrator(Principal('staff'), 'Erongo')
        self.db.data[('admins', 'staff')]['role'] = 'super_admin'
        boundary.administrator(Principal('staff'), 'Erongo')
        _, index_id = staff_identity('NAMPOL-001')
        self.db.data[('adminStaffCodes', index_id)]['uid'] = 'other'
        with self.assertRaises(HTTPException): boundary.administrator(Principal('staff'), 'Khomas')

    def test_existing_active_admin_record_remains_a_grant(self):
        self.db.data[('admins', 'staff')] = {'active': True, 'role': 'super_admin', 'staffNumber': 'NAMPOL-001'}
        self.assertEqual(self.service.session('staff')['role'], 'super_admin')
        self.assertEqual(Authorization(self.db).administrator(Principal('staff'), 'Khomas')['role'], 'super_admin')

class PhaseOneEndpointTests(unittest.TestCase):
    def claims(self):
        return {'uid': 'staff', 'aud': 'nampol-recruitment',
                'iss': 'https://securetoken.google.com/nampol-recruitment', 'email_verified': True,
                'firebase': {'sign_in_provider': 'password'}}

    def test_password_only_verified_token_authenticates(self):
        with patch('app.auth.verify_id_token', return_value=self.claims()):
            self.assertEqual(verify_firebase_token('signed-token', None), Principal('staff'))

    def test_unapproved_authentication_bootstrap_endpoint_is_removed(self):
        application = create_app(False)
        application.state.firebase_app = None
        application.state.admin_security = Mock()
        with TestClient(application) as client, patch('app.auth.verify_id_token', return_value=self.claims()):
            headers = {'Authorization': 'Bearer token'}
            response = client.get('/api/auth/bootstrap', headers=headers)
            self.assertEqual(response.status_code, 404)

    def test_no_public_admin_creation_and_activation_cannot_accept_roles(self):
        application = create_app(False)
        application.state.firebase_app = None
        application.state.admin_security = Mock()
        with TestClient(application) as client, patch('app.auth.verify_id_token', return_value=self.claims()):
            headers = {'Authorization': 'Bearer token'}
            for path in ('/api/admin/register', '/api/admin/provision'):
                self.assertEqual(client.post(path, headers=headers, json={'role': 'super_admin'}).status_code, 404)
            self.assertEqual(client.post('/api/admin/activate', headers=headers,
                             json={'code': 'A' * 43, 'role': 'super_admin', 'region': 'Erongo'}).status_code, 422)
        application.state.admin_security.activate.assert_not_called()


if __name__ == '__main__': unittest.main()
