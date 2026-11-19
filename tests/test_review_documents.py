"""Local private-document integration with synthetic records; no cloud requests."""
import copy
from datetime import datetime, timezone
import hashlib
import unittest

from fastapi import HTTPException
from fastapi.testclient import TestClient
from app import create_app, current_principal, Principal
from backend.notifications import NotificationDispatcher, PreviewMail
import test_screening as fixtures


class ReviewDocumentTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.ScreeningTests(); self.fixture.setUp(); self.addCleanup(self.fixture.doCleanups)
        self.db, self.service = self.fixture.db, self.fixture.documents
        self.db.data[('applications', 'app')]['applicationReference'] = 'NAMPOL-2026-TEST01'
        manifest = self.db.data[('serverDocumentSets', 'a' * 32)]
        manifest.update(schemaVersion=1, createdAt=datetime.now(timezone.utc))
        self.content = fixtures.text_pdf('SYNTHETIC RESEARCH DOCUMENT')
        for kind, record in manifest['documents'].items():
            record.update(fileName=kind + '.pdf', fileSize=len(self.content), sha256=hashlib.sha256(self.content).hexdigest())
        self.fixture.storage.download.side_effect = None; self.fixture.storage.download.return_value = self.content

    def client(self, uid='admin'):
        app = create_app(False); app.state.documents = self.service
        app.state.notifications = NotificationDispatcher(self.db, lambda uid: None, PreviewMail())
        app.dependency_overrides[current_principal] = lambda: Principal(uid)
        return TestClient(app, raise_server_exceptions=False)

    def test_manifest_repairs_recorded_binding_once_and_never_chooses_latest_upload(self):
        newer = copy.deepcopy(self.db.data[('serverDocumentSets', 'a' * 32)]); newer['setId'] = 'b' * 32
        self.db.data[('serverDocumentSets', 'b' * 32)] = newer
        with self.client() as client:
            for _ in range(2):
                result = client.get('/api/applications/app/documents')
                self.assertEqual(result.status_code, 200, result.text); self.assertEqual(result.json()['setId'], 'a' * 32)
                self.assertNotIn('objectPath', result.text)
        self.assertEqual(self.db.read('serverApplicationDocumentBindings', 'app')['setId'], 'a' * 32)
        self.assertEqual(sum(value.get('action') == 'DOCUMENT_BINDING_REPAIRED' for value in self.db.data.values()), 1)

    def test_regional_admin_super_admin_and_owner_can_view_all_three_private_pdfs(self):
        for uid in ('admin', 'super', 'alice'):
            with self.client(uid) as client:
                for kind in ('cv', 'certificate', 'identification'):
                    result = client.get('/api/applications/app/documents/' + kind + '/download')
                    self.assertEqual(result.status_code, 200, result.text)
                    self.assertEqual(result.content, self.content)
                    self.assertEqual(result.headers['content-type'], 'application/pdf')
                    self.assertEqual(result.headers['cache-control'], 'no-store')

    def test_foreign_region_nonowner_and_inactive_admin_cannot_view_or_repair(self):
        self.fixture.grant('erongo', 'admin', 'Erongo')
        self.db.data[('admins', 'admin')]['active'] = False
        for uid in ('erongo', 'unknown', 'admin'):
            with self.client(uid) as client:
                self.assertEqual(client.get('/api/applications/app/documents').status_code, 403)
                self.assertEqual(client.get('/api/applications/app/documents/cv/download').status_code, 403)
        self.assertIsNone(self.db.read('serverApplicationDocumentBindings', 'app'))
        self.fixture.storage.download.assert_not_called()

    def test_mismatch_missing_reference_failed_scan_and_nonpdf_never_rebind_or_disclose(self):
        self.db.data[('serverApplicationDocumentBindings', 'app')] = {'applicationId': 'app', 'ownerUid': 'alice', 'setId': 'b' * 32}
        with self.client() as client:
            self.assertEqual(client.get('/api/applications/app/documents').status_code, 409)
        self.assertEqual(self.db.read('serverApplicationDocumentBindings', 'app')['setId'], 'b' * 32)
        self.db.data.pop(('serverApplicationDocumentBindings', 'app'))
        self.db.data[('serverDocumentSets', 'a' * 32)]['documents']['cv']['scanStatus'] = 'infected'
        with self.client() as client: self.assertEqual(client.get('/api/applications/app/documents').status_code, 409)
        self.db.data[('applications', 'app')].pop('documentSetId')
        with self.client() as client: self.assertEqual(client.get('/api/applications/app/documents').status_code, 404)
        self.fixture.storage.download.assert_not_called()

    def test_applicant_binding_endpoint_cannot_choose_a_different_ready_set(self):
        newer = copy.deepcopy(self.db.data[('serverDocumentSets', 'a' * 32)]); newer['setId'] = 'b' * 32
        self.db.data[('serverDocumentSets', 'b' * 32)] = newer
        with self.client('alice') as client:
            response = client.post('/api/applications/app/document-binding', json={'setId': 'b' * 32})
            self.assertEqual(response.status_code, 409)
        self.assertIsNone(self.db.read('serverApplicationDocumentBindings', 'app'))

    def test_integrity_failure_never_returns_private_document_bytes(self):
        self.fixture.storage.download.return_value = b'tampered'
        with self.client() as client:
            response = client.get('/api/applications/app/documents/cv/download')
            self.assertEqual(response.status_code, 503); self.assertNotIn('tampered', response.text)

    def test_admin_notification_preview_is_audited_without_recipient_or_sensitive_details(self):
        self.db.data[('applications', 'app')]['status'] = 'Approved'
        self.db.data[('notificationOutbox', 'app__Approved')] = {'state': 'previewed', 'status': 'Approved',
            'applicationReference': 'NAMPOL-2026-TEST01', 'applicantId': 'alice', 'region': 'Khomas'}
        with self.client() as client:
            response = client.get('/api/admin/applications/app/notification')
            self.assertEqual(response.status_code, 200, response.text)
            self.assertIn('NAMPOL-2026-TEST01', response.json()['result']['preview']['body'])
            self.assertNotIn('recipient', response.text); self.assertNotIn('objectPath', response.text)
            self.assertEqual(response.headers['cache-control'], 'no-store')
        with self.client('alice') as client:
            self.assertEqual(client.get('/api/admin/applications/app/notification').status_code, 403)
        self.assertTrue(any(value.get('action') == 'NOTIFICATION_STATUS_VIEWED' for value in self.db.data.values()))


if __name__ == '__main__': unittest.main()
