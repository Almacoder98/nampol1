"""Offline human shortlisting, with synthetic identities and transactional storage."""
import copy
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from uuid import uuid4
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from app import create_app, current_principal, Principal
from backend.shortlisting import ShortlistService
import test_documents as records
import test_screening as setup_helpers
import test_phase4_integration as integration


class QueryCollection:
    def __init__(self, db, name): self.db, self.name, self.filter = db, name, None
    def document(self, identifier=None): return records.Reference(self.db, self.name, identifier or uuid4().hex)
    def where(self, filter): self.filter = filter; return self
    def stream(self):
        return [records.Snapshot(value) for (collection, _), value in self.db.data.items()
                if collection == self.name and (not self.filter or value.get(self.filter.field_path) == self.filter.value)]


class ShortlistTests(unittest.TestCase):
    def setUp(self):
        self.fixture = setup_helpers.ScreeningTests(); self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.db = self.fixture.db
        self.db.collection = lambda name: QueryCollection(self.db, name)
        p = patch('backend.shortlisting.firestore.transactional', records.transactional)
        p.start(); self.addCleanup(p.stop)
        self.service = ShortlistService(self.fixture.documents.authorization, self.db)
        self.fixture.grant('erongo', 'admin', 'Erongo')
        self.db.data['applications', 'app'].update(applicantName='Synthetic Applicant', applicationReference='NAMPOL-2026-TEST01')

    def body(self, action='shortlist', version=0, request=None, reason='Human review: suitable for interview consideration.'):
        return {'action': action, 'reason': reason, 'expectedVersion': version, 'requestId': request or uuid4().hex}

    def events(self):
        return [copy.deepcopy(value) for (col, _), value in self.db.data.items()
                if col == 'auditLogs' and value.get('action', '').startswith('CANDIDATE_')]

    def client(self, uid='admin', authenticated=True):
        app = create_app(False); app.state.shortlisting = self.service
        if authenticated: app.dependency_overrides[current_principal] = lambda: Principal(uid)
        return TestClient(app, raise_server_exceptions=False)

    def test_authorized_selection_is_separate_atomic_private_and_server_timestamped(self):
        before = copy.deepcopy(self.db.data['applications', 'app'])
        body = self.body(reason='INTERNAL synthetic rationale')
        with self.client() as client:
            response = client.post('/api/admin/applications/app/shortlist', json=body)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.headers['cache-control'], 'no-store')
            self.assertEqual(client.get('/api/admin/applications/app/shortlist').json()['result']['status'], 'shortlisted')
        record = self.db.read('serverShortlists', 'app')
        self.assertEqual(record['vacancyId'], 'job'); self.assertEqual(record['reviewerId'], 'admin')
        self.assertEqual(record['version'], 1); self.assertIsInstance(record['shortlistedAt'], datetime)
        self.assertEqual(before, self.db.data['applications', 'app'])
        self.assertFalse(any(col == 'notificationOutbox' for col, _ in self.db.data))
        public = self.db.read('applicantShortlistStatuses', 'app')
        self.assertEqual(set(public), {'applicationId', 'vacancyId', 'ownerUid', 'status', 'updatedAt'})
        self.assertNotIn('INTERNAL', str(public)); self.assertNotIn('reviewerId', public)
        self.assertEqual(self.events()[0]['action'], 'CANDIDATE_SHORTLISTED')
        self.assertEqual(self.events()[0]['timestamp'], record['shortlistedAt'])
        self.assertEqual(self.events()[0]['reason'], body['reason'])

    def test_cross_region_applicant_unknown_inactive_and_revoked_staff_denied(self):
        self.fixture.grant('inactive', 'admin', 'Khomas'); self.db.data['admins', 'inactive']['active'] = False
        self.fixture.grant('revoked', 'admin', 'Khomas')
        code = self.db.data['admins', 'revoked']['staffCodeId']; self.db.data['adminStaffCodes', code]['state'] = 'revoked'
        for uid in ('erongo', 'alice', 'unknown', 'inactive', 'revoked'):
            with self.client(uid) as client:
                self.assertEqual(client.get('/api/admin/applications/app/shortlist').status_code, 403, uid)
                self.assertEqual(client.post('/api/admin/applications/app/shortlist', json=self.body()).status_code, 403, uid)
                self.assertEqual(client.get('/api/admin/vacancies/job/shortlist').status_code, 403, uid)
        self.assertIsNone(self.db.read('serverShortlists', 'app')); self.assertEqual(self.events(), [])

    def test_super_admin_can_select_across_regions_and_closed_vacancies_remain_reviewable(self):
        self.db.data['jobs', 'job']['status'] = 'Closed'
        self.assertTrue(self.service.change(Principal('super'), 'app', self.body())['changed'])
        self.assertEqual(len(self.service.list_vacancy(Principal('super'), 'job')['items']), 1)

    def test_remove_preserves_first_audit_and_public_application_decision(self):
        self.service.change(Principal('admin'), 'app', self.body())
        first = self.events()[0]; original_time = self.db.read('serverShortlists', 'app')['shortlistedAt']
        with self.client() as client:
            response = client.post('/api/admin/applications/app/shortlist', json=self.body('remove', 1, reason='Manual review: removed from interview consideration.'))
            self.assertEqual(response.status_code, 200, response.text)
        record = self.db.read('serverShortlists', 'app')
        self.assertEqual(record['status'], 'not_shortlisted'); self.assertEqual(record['version'], 2)
        self.assertEqual(record['shortlistedAt'], original_time); self.assertIsInstance(record['removedAt'], datetime)
        self.assertIn(first, self.events()); self.assertEqual(len(self.events()), 2)
        self.assertEqual(self.db.read('applicantShortlistStatuses', 'app')['status'], 'not_shortlisted')
        self.assertEqual(self.db.read('applications', 'app')['status'], 'Submitted')
        self.assertEqual(self.service.list_vacancy(Principal('admin'), 'job')['items'], [])

    def test_duplicate_concurrent_requests_commit_once_and_stale_retry_never_readds_removed_candidate(self):
        body = self.body()
        with ThreadPoolExecutor(max_workers=5) as pool:
            results = list(pool.map(lambda _: self.service.change(Principal('admin'), 'app', body), range(5)))
        self.assertEqual(sum(result['changed'] for result in results), 1); self.assertEqual(len(self.events()), 1)
        self.service.change(Principal('admin'), 'app', self.body('remove', 1))
        retry = self.service.change(Principal('admin'), 'app', body)
        self.assertTrue(retry['replayed']); self.assertEqual(retry['result']['status'], 'not_shortlisted')
        self.assertEqual(len(self.events()), 2)

    def test_duplicate_desired_state_does_not_reset_reviewer_time_or_audit(self):
        self.service.change(Principal('admin'), 'app', self.body())
        before = self.db.read('serverShortlists', 'app')
        result = self.service.change(Principal('super'), 'app', self.body(version=1))
        self.assertFalse(result['changed']); self.assertEqual(before, self.db.read('serverShortlists', 'app'))
        self.assertEqual(len(self.events()), 1)

    def test_version_conflict_or_reused_request_id_with_changed_meaning_is_rejected(self):
        body = self.body(); self.service.change(Principal('admin'), 'app', body)
        for attempt in [self.body('remove', 0), {**body, 'action': 'remove'}]:
            with self.assertRaises(HTTPException) as error: self.service.change(Principal('admin'), 'app', attempt)
            self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(len(self.events()), 1)

    def test_invalid_payload_notes_and_forged_role_timestamp_or_vacancy_are_rejected(self):
        with self.client() as client:
            for body in [self.body(reason=' '), self.body(reason='\u200b\ufeff'), self.body(reason='x' * 1001),
                         self.body(action='approve'), {**self.body(), 'reviewerId': 'super'},
                         {**self.body(), 'vacancyId': 'other'}, {**self.body(), 'shortlistedAt': 'client-time'},
                         {**self.body(), 'expectedVersion': True}]:
                response = client.post('/api/admin/applications/app/shortlist', json=body)
                self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.events(), [])

    def test_missing_unpublished_mismatched_or_legacy_vacancy_is_not_guessed(self):
        for changes in [{'published': False}, {'region': 'Erongo'}, {'title': 'Other'}]:
            saved = copy.deepcopy(self.db.data['jobs', 'job']); self.db.data['jobs', 'job'].update(changes)
            with self.assertRaises(HTTPException): self.service.change(Principal('admin'), 'app', self.body())
            self.db.data['jobs', 'job'] = saved
        self.db.data['applications', 'app']['vacancyId'] = None
        with self.assertRaises(HTTPException): self.service.change(Principal('admin'), 'app', self.body())
        self.assertEqual(self.events(), [])

    def test_vacancy_view_is_scoped_and_excludes_removed_and_mismatched_records(self):
        self.service.change(Principal('admin'), 'app', self.body())
        self.db.data['serverShortlists', 'foreign'] = {**self.db.read('serverShortlists', 'app'), 'applicationId': 'foreign', 'region': 'Erongo'}
        response = self.service.list_vacancy(Principal('admin'), 'job')
        self.assertEqual([row['applicationId'] for row in response['items']], ['app'])
        self.assertEqual(response['items'][0]['applicationStatus'], 'Submitted')
        with self.client('erongo') as client:
            self.assertEqual(client.get('/api/admin/vacancies/job/shortlist').status_code, 403)

    def test_audit_failure_rolls_back_private_record_public_status_and_retry_receipt(self):
        original = records.Reference.create
        def fail_audit(ref, value):
            if ref.key[0] == 'auditLogs': raise RuntimeError('synthetic audit failure')
            return original(ref, value)
        with patch.object(records.Reference, 'create', fail_audit):
            with self.assertRaises(RuntimeError): self.service.change(Principal('admin'), 'app', self.body())
        self.assertFalse(any(col in ('serverShortlists', 'serverShortlistRequests', 'applicantShortlistStatuses') for col, _ in self.db.data))

    def test_existing_approve_and_deny_work_after_shortlisting_without_conflating_states(self):
        for decision in ('Approved', 'Denied'):
            # Use independent synthetic application IDs with the actual client transaction code.
            app_id = 'application-' + decision.lower()
            self.db.data['applications', app_id] = copy.deepcopy(self.db.data['applications', 'app'])
            self.service.change(Principal('admin'), app_id, self.body())
            admin = {**self.db.read('admins', 'admin'), 'uid': 'admin'}
            for args in [dict(mode='start'), dict(mode='decide', decision=decision, reason='Manual qualification review')]:
                response = integration.Phase4IntegrationTests.bridge(self, uid='admin', applicationId=app_id, admin=admin, **args)
                integration.Phase4IntegrationTests.apply_writes(self, response)
            self.assertEqual(self.db.read('applications', app_id)['status'], decision)
            self.assertEqual(self.db.read('serverShortlists', app_id)['status'], 'shortlisted')
            self.assertEqual(self.db.read('notificationOutbox', app_id + '__' + decision)['state'], 'pending')
            self.service.change(Principal('admin'), app_id, self.body('remove', 1))
            self.assertEqual(self.db.read('applications', app_id)['status'], decision)

    def test_unsigned_direct_api_requests_are_denied_and_new_fields_cannot_be_publicly_forged(self):
        with self.client(authenticated=False) as client:
            for method, path in [('GET', '/api/admin/applications/app/shortlist'), ('POST', '/api/admin/applications/app/shortlist'),
                                 ('GET', '/api/admin/vacancies/job/shortlist')]:
                self.assertEqual(client.request(method, path, json=self.body()).status_code, 401)


if __name__ == '__main__': unittest.main()
