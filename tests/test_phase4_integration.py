"""Composition checks using synthetic PDFs and actual API/client orchestration.

Firebase identity, database, ClamAV and private object storage are offline test
adapters. This is not evidence of live provider delivery or a browser login.
"""
import copy
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient
from pypdf import PdfWriter
from app import Authorization, Principal, create_app, current_principal
from backend.documents import DocumentRepository, DocumentService
from backend.local_nlp import LocalEvidenceMatcher
from backend.notifications import NotificationDispatcher, PreviewMail
from backend.screening import ScreeningService
from scripts.seed_screening_demo import fixture
import test_documents as records
import test_screening as setup_helpers

ROOT = Path(__file__).resolve().parents[1]
PLAN = json.loads((ROOT / 'demo/phase4_accounts.json').read_text(encoding='utf-8'))


class Phase4IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.base = setup_helpers.ScreeningTests(); self.base.setUp()
        self.addCleanup(self.base.doCleanups)
        self.db = self.base.db
        # Keep only synthetic trusted administrator grants from the fixture.
        self.db.data = {key: value for key, value in self.db.data.items()
                        if key[0] in ('admins', 'adminStaffCodes')}
        self.base.grant('erongo', 'admin', 'Erongo')
        self.db.data['jobs', PLAN['vacancy']['id']] = copy.deepcopy(PLAN['vacancy'])
        self.objects = {}
        storage = Mock()
        storage.upload.side_effect = lambda path, content, mime: self.objects.__setitem__(path, content)
        storage.download.side_effect = self.objects.__getitem__
        storage.delete.side_effect = lambda path: self.objects.pop(path, None)
        self.scanner = Mock()  # Never replace production ClamAV: dependency injection only.
        self.documents = DocumentService(Authorization(self.db), DocumentRepository(self.db), storage, self.scanner)
        self.screening = ScreeningService(Authorization(self.db), self.documents, self.db,
            matcher=LocalEvidenceMatcher(model_loader=lambda: None))
        self.mail = PreviewMail()
        self.notifications = NotificationDispatcher(self.db, lambda uid: SimpleNamespace(
            email=next(a['email'] for a in PLAN['accounts'] if a['uid'] == uid),
            disabled=False, email_verified=True), self.mail)
        p = patch('backend.notifications.firestore.transactional', records.transactional)
        p.start(); self.addCleanup(p.stop)

    def client(self, uid):
        app = create_app(False)
        app.state.documents = self.documents; app.state.screening = self.screening
        app.state.notifications = self.notifications
        app.dependency_overrides[current_principal] = lambda: Principal(uid)
        return TestClient(app, raise_server_exceptions=False)

    def bridge(self, **input):
        input['records'] = {collection + '/' + key: value for (collection, key), value in self.db.data.items()}
        response = subprocess.run(['node', 'tests/phase4-workflow-bridge.cjs'], cwd=ROOT,
            input=json.dumps(input, default=str), text=True, capture_output=True, timeout=20)
        self.assertEqual(response.returncode, 0, response.stderr)
        return json.loads(response.stdout)

    def apply_writes(self, response):
        timestamp = datetime.now(timezone.utc)
        def resolve(value):
            if value == '__SERVER_TIME__': return timestamp
            if isinstance(value, dict): return {key: resolve(item) for key, item in value.items()}
            if isinstance(value, list): return [resolve(item) for item in value]
            return value
        for write in response['writes']:
            key = write['ref']['collection'], write['ref']['id']
            if write['operation'] == 'update': self.db.data[key].update(resolve(write['data']))
            else:
                self.assertNotIn(key, self.db.data)
                self.db.data[key] = resolve(write['data'])

    def run_candidate(self, name, decision):
        account = next(a for a in PLAN['accounts'] if a['uid'] == 'demo-applicant-' + name)
        uid = account['uid']
        self.db.data['users', uid] = {**account, 'accountStatus': 'active', 'profileCompleted': False}
        content = {kind: (ROOT / f'output/pdf/phase4-demo/{name}-{suffix}.pdf').read_bytes()
                   for kind, suffix in [('cv', 'cv'), ('certificate', 'qualification'), ('identification', 'identification')]}
        files = {kind: (kind + '.pdf', data, 'application/pdf') for kind, data in content.items()}
        with self.client(uid) as client:
            self.assertEqual(client.post('/api/me/document-sets', files=files).status_code, 403)
            self.db.data['users', uid]['profileCompleted'] = True
            missing = self.bridge(mode='submit', uid=uid, sets=[], application={
                'applicantId': uid, 'position': PLAN['vacancy']['title'], 'region': 'Khomas'})
            self.assertFalse(missing['result']['success']); self.assertEqual(missing['writes'], [])
            partial = dict(files); partial.pop('identification')
            self.assertEqual(client.post('/api/me/document-sets', files=partial).status_code, 422)
            uploaded = client.post('/api/me/document-sets', files=files)
            self.assertEqual(uploaded.status_code, 201, uploaded.text)
            ready = uploaded.json(); self.assertEqual(ready['state'], 'ready')
            sets = client.get('/api/me/document-sets').json()['sets']
            submission = self.bridge(mode='submit', uid=uid, sets=sets, application={
                'applicantId': uid, 'applicantName': account['firstName'] + ' ' + account['lastName'],
                'applicantEmail': account['email'], 'position': PLAN['vacancy']['title'],
                'vacancyId': PLAN['vacancy']['id'], 'region': 'Khomas', 'qualification': account['highestQualification']})
            self.assertTrue(submission['result']['success'], submission)
            self.assertEqual(len(submission['writes']), 3); self.apply_writes(submission)
            application_id = submission['result']['id']
            self.assertEqual(self.db.read('serverApplicationDocumentBindings', application_id)['setId'], ready['setId'])
            for kind in content:
                response = client.get(f'/api/applications/{application_id}/documents/{kind}/download')
                self.assertEqual(response.status_code, 200); self.assertEqual(response.content, content[kind])
            retry = self.bridge(mode='submit', uid=uid, sets=[], application={
                'applicantId': uid, 'position': PLAN['vacancy']['title'], 'vacancyId': PLAN['vacancy']['id']})
            self.assertEqual(retry['result']['id'], application_id); self.assertEqual(retry['writes'], [])
        self.db.data['syntheticVerificationCases', application_id] = fixture(application_id, uid, account['scenario'], 'SYNTHETIC-' + name.upper())
        with self.client('erongo') as client:
            self.assertEqual(client.get(f'/api/applications/{application_id}/documents').status_code, 403)
            self.assertEqual(client.post(f'/api/admin/applications/{application_id}/screening').status_code, 403)
        with self.client('admin') as client:
            for kind in content:
                self.assertEqual(client.get(f'/api/applications/{application_id}/documents/{kind}/download').content, content[kind])
            response = client.post(f'/api/admin/applications/{application_id}/screening')
            self.assertEqual(response.status_code, 200, response.text)
            report = response.json()['result']
            self.assertEqual(report['summary'], PLAN['expected'][name])
            self.assertTrue(report['advisory']); self.assertEqual(report['authenticity'], 'not_verified')
            self.assertEqual(report['criminalVerification']['status'], 'simulated_' + account['scenario'])
            self.assertEqual(self.db.read('applications', application_id)['status'], 'Submitted')
        with self.client('super') as client:
            self.assertEqual(client.get(f'/api/admin/applications/{application_id}/screening').status_code, 200)
        admin = {**self.db.read('admins', 'admin'), 'uid': 'admin'}
        self.apply_writes(self.bridge(mode='start', uid='admin', applicationId=application_id, admin=admin))
        reason = '' if decision == 'Approved' else 'Academic demonstration: manual qualification review requires a Diploma; synthetic flag is not the decision basis.'
        kwargs = dict(mode='decide', uid='admin', applicationId=application_id, admin=admin, decision=decision, reason=reason)
        self.apply_writes(self.bridge(**kwargs))
        application = self.db.read('applications', application_id)
        self.assertEqual(application['status'], decision)
        self.assertIsInstance(application['reviewedAt'], datetime)
        self.assertEqual(application['reviewedAt'], application['updatedAt'])
        self.assertEqual(self.bridge(**kwargs)['writes'], [])
        with patch.object(self.mail, 'send', wraps=self.mail.send) as delivery:
            self.assertEqual(self.notifications.deliver(application_id + '__' + decision), 'previewed')
            self.assertEqual(self.notifications.deliver(application_id + '__' + decision), 'unchanged')
            self.assertEqual(delivery.call_count, 1)
        with self.client('admin') as client:
            response = client.get(f'/api/admin/applications/{application_id}/notification')
            self.assertEqual(response.status_code, 200, response.text)
            preview = response.json()['result']['preview']['body']
            self.assertIn(application['applicationReference'], preview); self.assertNotIn(account['email'], preview)
            self.assertNotIn(reason or 'DO_NOT_INCLUDE', preview)
        actions = {v.get('action') for (col, _), v in self.db.data.items() if col == 'auditLogs'}
        self.assertTrue({'DOCUMENT_UPLOAD_READY', 'DOCUMENT_SET_BOUND', 'SCREENING_COMPLETED',
                         'SIMULATED_CRIMINAL_VERIFICATION', 'REVIEW_STARTED', 'NOTIFICATION_QUEUED',
                         'NOTIFICATION_PREVIEWED'}.issubset(actions), actions)

    def test_alpha_actual_pdfs_upload_submit_screen_approve_preview(self):
        self.run_candidate('alpha', 'Approved')

    def test_beta_actual_pdfs_upload_submit_screen_manual_deny_preview(self):
        self.run_candidate('beta', 'Denied')

    def test_admin_screen_endpoint_handles_missing_and_scanned_cv_fixtures(self):
        set_id = 'c' * 32
        application = {'applicantId': 'synthetic-screen-applicant', 'region': 'Khomas',
            'status': 'Submitted', 'position': PLAN['vacancy']['title'],
            'vacancyId': PLAN['vacancy']['id'], 'documentSetId': set_id}
        self.db.data['applications', 'screen-case'] = application
        original = copy.deepcopy(application)
        manifest = {'setId': set_id, 'ownerUid': application['applicantId'], 'state': 'ready',
            'documents': {'cv': {'objectPath': 'synthetic-screen-cv', 'fileSize': 0,
                'mimeType': 'application/pdf', 'scanStatus': 'clean', 'sha256': hashlib.sha256(b'').hexdigest()}}}
        self.db.data['serverDocumentSets', set_id] = manifest
        with self.client('admin') as client:
            application['documentSetId'] = None
            missing = client.post('/api/admin/applications/screen-case/screening')
            self.assertEqual(missing.status_code, 200, missing.text)
            missing_report = missing.json()['result']
            self.assertEqual(missing_report['cvStatus'], 'missing')
            self.assertTrue(all(not row['excerpt'] for row in missing_report['criteria']))
            self.assertTrue(all('Needs manual verification' in row['explanation']
                                for row in missing_report['criteria']))
            self.assertFalse(client.get('/api/admin/applications/screen-case/screening')
                             .json()['result']['stale'])

            application['documentSetId'] = original['documentSetId']
            writer = PdfWriter()
            writer.add_blank_page(width=100, height=100)
            empty_pdf = io.BytesIO()
            writer.write(empty_pdf)
            raw = empty_pdf.getvalue()
            manifest['documents']['cv'].update(fileSize=len(raw), sha256=hashlib.sha256(raw).hexdigest())
            self.objects[manifest['documents']['cv']['objectPath']] = raw
            scanned = client.post('/api/admin/applications/screen-case/screening')
            self.assertEqual(scanned.status_code, 200, scanned.text)
            scanned_report = scanned.json()['result']
            self.assertEqual(scanned_report['cvStatus'], 'unreadable')
            self.assertTrue(all('scanned or image-only' in row['explanation']
                                for row in scanned_report['criteria']))
            self.assertFalse(client.get('/api/admin/applications/screen-case/screening')
                             .json()['result']['stale'])
        self.assertEqual(application['status'], original['status'])

    def test_demo_pdf_manifest_and_no_live_credentials(self):
        manifest = json.loads((ROOT / 'output/pdf/phase4-demo/manifest.json').read_text())
        self.assertEqual(len(manifest['documents']), 6)
        from pypdf import PdfReader
        for row in manifest['documents']:
            path = ROOT / row['path']; raw = path.read_bytes()
            self.assertEqual(hashlib.sha256(raw).hexdigest(), row['sha256'])
            self.assertLess(len(raw), 5 * 1024 * 1024)
            self.assertIn('SYNTHETIC', PdfReader(path).pages[0].extract_text())
        self.assertEqual(len(PdfReader(ROOT / 'output/pdf/phase4-demo-pack.pdf').pages), 6)
        self.assertTrue(all(a['email'].endswith('@example.invalid') for a in PLAN['accounts']))
        self.assertNotIn('password', {key.lower() for a in PLAN['accounts'] for key in a})


if __name__ == '__main__': unittest.main()
