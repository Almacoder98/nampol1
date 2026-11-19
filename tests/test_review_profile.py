"""Synthetic profile-review access tests; no live applicant or provider calls."""
import unittest
from fastapi.testclient import TestClient
from app import Principal, create_app, current_principal
import test_screening as fixtures


class ApplicantReviewProfileTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.ScreeningTests(); self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.db = self.fixture.db
        self.fixture.grant('erongo', 'admin', 'Erongo')
        self.db.data['users', 'alice'].update(firstName='Synthetic', lastName='Applicant',
            email='test@example.invalid', phone='+264 DEMO ONLY', address='Synthetic address',
            dateOfBirth='2000-01-01', gender='Female', highestQualification='Diploma',
            employmentStatus='Student', skills=['Computer literacy'], academicPoints=32,
            privateRecoverySecret='MUST_NOT_DISCLOSE', idNumber='PRIVATE-ID-NOT-NEEDED')

    def client(self, uid='admin', authenticated=True):
        app = create_app(False); app.state.documents = self.fixture.documents
        if authenticated: app.dependency_overrides[current_principal] = lambda: Principal(uid)
        return TestClient(app, raise_server_exceptions=False)

    def test_authorized_review_returns_contact_profile_and_recorded_points_without_extra_secrets(self):
        with self.client() as client:
            response = client.get('/api/admin/applications/app/profile')
        self.assertEqual(response.status_code, 200, response.text)
        profile = response.json()['result']
        self.assertEqual(profile['phone'], '+264 DEMO ONLY')
        self.assertEqual(profile['email'], 'test@example.invalid')
        self.assertEqual(profile['academicPoints'], 32)
        self.assertEqual(profile['highestQualification'], 'Diploma')
        self.assertNotIn('PRIVATE-ID', response.text); self.assertNotIn('MUST_NOT_DISCLOSE', response.text)
        self.assertEqual(response.headers['cache-control'], 'no-store')
        events = [value for (col, _), value in self.db.data.items() if col == 'auditLogs']
        self.assertTrue(any(v.get('action') == 'APPLICANT_PROFILE_VIEWED' and v['actorUid'] == 'admin' for v in events))
        self.assertNotIn('test@example.invalid', str(events))

    def test_cross_region_applicant_unknown_and_inactive_admin_are_denied(self):
        self.fixture.grant('inactive', 'admin', 'Khomas')
        self.db.data['admins', 'inactive']['active'] = False
        for uid in ('erongo', 'alice', 'unknown', 'inactive'):
            with self.client(uid) as client:
                response = client.get('/api/admin/applications/app/profile')
            self.assertEqual(response.status_code, 403, (uid, response.text))
            self.assertNotIn('test@example.invalid', response.text)

    def test_super_admin_access_and_profile_region_recheck(self):
        self.db.data['users', 'alice']['region'] = 'Erongo'
        with self.client() as client:
            self.assertEqual(client.get('/api/admin/applications/app/profile').status_code, 403)
        with self.client('super') as client:
            self.assertEqual(client.get('/api/admin/applications/app/profile').status_code, 200)

    def test_missing_profile_or_application_never_returns_unrelated_record(self):
        with self.client() as client:
            self.assertEqual(client.get('/api/admin/applications/absent/profile').status_code, 404)
            self.db.data.pop(('users', 'alice'))
            self.assertEqual(client.get('/api/admin/applications/app/profile').status_code, 404)

    def test_missing_invalid_or_legacy_score_is_not_invented_as_academic_points(self):
        self.db.data['applications', 'app']['aiMatchScore'] = 99
        with self.client() as client:
            for points in (None, True, '32', -1, 1.5, float('inf')):
                self.db.data['users', 'alice']['academicPoints'] = points
                response = client.get('/api/admin/applications/app/profile')
                self.assertEqual(response.status_code, 200, response.text)
                self.assertIsNone(response.json()['result']['academicPoints'])

    def test_unsigned_direct_profile_request_is_rejected(self):
        with self.client(authenticated=False) as client:
            self.assertEqual(client.get('/api/admin/applications/app/profile').status_code, 401)


if __name__ == '__main__': unittest.main()
