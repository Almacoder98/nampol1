"""Offline Phase 2 tests; no credentials, live accounts, SMS or police service."""
import copy
import io
import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject

from app import Authorization, Principal, create_app, current_principal
from backend.documents import DocumentRepository, DocumentService
from backend.local_nlp import LocalEvidenceMatcher
from backend.screening import ScreeningService, criteria, extract_pdf, simulated_verification
from scripts.seed_screening_demo import fixture
from test_documents import Database, Reference, Transaction, transactional


def text_pdf(text):
    writer = PdfWriter(); page = writer.add_blank_page(width=300, height=300)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
    stream = DecodedStreamObject(); stream.set_data(f'BT /F1 12 Tf 10 100 Td ({text}) Tj ET'.encode())
    page[NameObject('/Contents')] = writer._add_object(stream)
    output = io.BytesIO(); writer.write(output); return output.getvalue()


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.matcher = LocalEvidenceMatcher(model_loader=lambda: None)

    def evidence(self, text='', readable=True): return {'text': text, 'readable': readable}

    def test_cv_requirements_show_local_excerpt_or_manual_verification(self):
        checks = criteria('CV: Python\nCV: first aid\nExperience: two years',
                          self.evidence('Python'), matcher=self.matcher)
        self.assertEqual([row['status'] for row in checks],
                         ['met', 'could_not_verify', 'could_not_verify'])
        self.assertEqual(checks[0]['excerpt'], 'Python')
        self.assertIn('Needs manual verification', checks[1]['explanation'])
        self.assertTrue(all(row['explanation'] and 'sources' in row for row in checks))

    def test_word_boundaries_and_punctuation_not_substrings(self):
        for text, expected in [('JavaScript', 'could_not_verify'), ('JAVA, programming', 'met')]:
            self.assertEqual(criteria('Skill: Java', self.evidence(text),
                                      matcher=self.matcher)[0]['status'], expected)

    def test_ambiguous_equivalence_and_compound_criteria_do_not_guess(self):
        for value in ['Bachelor or Diploma', 'NQF 7', 'Bachelor in medicine', 'Diploma and certificate', 'equivalent qualification']:
            self.assertEqual(criteria(f'Qualification: {value}', self.evidence('Bachelor'),
                                      matcher=self.matcher)[0]['status'], 'could_not_verify')

    def test_image_only_missing_documents_and_empty_requirements_are_unknown(self):
        for requirements in ['CV: Python\nQualification: Diploma\nField: policing', '']:
            checks = criteria(requirements, {'text': '', 'readable': False, 'issue': 'unreadable'},
                              matcher=self.matcher)
            self.assertTrue(all(check['status'] == 'could_not_verify' for check in checks))
        empty_criteria = criteria('', self.evidence(''), matcher=self.matcher)
        self.assertIn('No published vacancy criteria', empty_criteria[0]['explanation'])

    def test_fallback_does_not_turn_partial_overlap_into_evidence(self):
        self.assertIsNone(self.matcher.find(
            'Microsoft Excel proficiency', 'Used Microsoft Word for reports.'))
        self.assertIsNone(self.matcher.find(
            'Diploma', 'Certificate in Administration from a fictional college.'))
        self.assertEqual(self.matcher.engine, 'Local NLP text-match fallback (token overlap)')

    def test_requirement_count_limit_is_visible(self):
        checks = criteria('\n'.join(['CV: Python'] * 45), self.evidence('Python'),
                          matcher=self.matcher)
        self.assertEqual(len(checks), 41); self.assertEqual(checks[-1]['status'], 'could_not_verify')

    def test_real_pdf_worker_extracts_text_and_blank_or_corrupt_files_are_unknown(self):
        self.assertIn('Python', extract_pdf(text_pdf('Python Diploma'))['text'])
        self.assertFalse(extract_pdf(b'not a PDF')['readable'])
        writer = PdfWriter(); writer.add_blank_page(100, 100); output = io.BytesIO(); writer.write(output)
        self.assertFalse(extract_pdf(output.getvalue())['readable'])

    def test_worker_timeout_and_credential_isolation(self):
        with patch('backend.screening.subprocess.run', side_effect=TimeoutError) as worker:
            self.assertFalse(extract_pdf(b'%PDF-test')['readable'])
        self.assertEqual(worker.call_args.kwargs['timeout'], 30)
        self.assertNotIn('GOOGLE_APPLICATION_CREDENTIALS', worker.call_args.kwargs['env'])
        self.assertNotIn('SUPABASE_SECRET_KEY', worker.call_args.kwargs['env'])

    def test_synthetic_clear_flagged_unavailable_and_malformed_never_imply_real_checks(self):
        for scenario, expected in [('clear', 'simulated_clear'), ('flagged', 'simulated_flagged'), ('unavailable', 'could_not_verify')]:
            case = fixture('app', 'alice', scenario, 'SYNTHETIC-TEST')
            result = simulated_verification(case, 'app', 'alice')
            self.assertEqual(result['status'], expected); self.assertTrue(result['simulated'])
            self.assertIn('NOT A POLICE', result['source'])
        for changes in [{'synthetic': False}, {'ownerUid': 'bob'}, {'applicationId': 'other'}, {'subjectReference': 'REAL-ID'}]:
            case = {**fixture('app', 'alice', 'clear', 'SYNTHETIC-TEST'), **changes}
            self.assertEqual(simulated_verification(case, 'app', 'alice')['status'], 'could_not_verify')
        self.assertEqual(simulated_verification(None, 'app', 'alice')['status'], 'could_not_verify')


class ScreeningTests(unittest.TestCase):
    def setUp(self):
        self.db = Database(); self.actor = Principal('admin')
        for name in ('backend.screening.firestore.transactional', 'backend.documents.firestore.transactional'):
            p = patch(name, transactional); p.start(); self.addCleanup(p.stop)
        p = patch.object(Transaction, 'set', lambda transaction, ref, value: transaction.operations.append((ref, 'set', value)), create=True)
        p.start(); self.addCleanup(p.stop)
        def set_reference(ref, value): ref.db.data[ref.key] = copy.deepcopy(value)
        p = patch.object(Reference, 'set', set_reference, create=True); p.start(); self.addCleanup(p.stop)
        self.grant('admin', 'admin', 'Khomas'); self.grant('super', 'super_admin', '')
        self.db.data[('users', 'alice')] = {'role': 'applicant', 'accountStatus': 'active', 'profileCompleted': True, 'region': 'Khomas'}
        self.db.data[('applications', 'app')] = {'applicantId': 'alice', 'region': 'Khomas', 'status': 'Submitted',
            'position': 'Officer', 'qualification': 'Diploma', 'vacancyId': 'job', 'documentSetId': 'a' * 32}
        self.db.data[('jobs', 'job')] = {'title': 'Officer', 'region': 'Khomas', 'published': True, 'status': 'Open',
            'requirements': 'CV: Python\nCV: first aid\nQualification: Diploma\nField: policing'}
        import hashlib
        content = {'cv': b'Python', 'certificate': b'Diploma in policing', 'identification': b'SYNTHETIC'}
        self.db.data[('serverDocumentSets', 'a' * 32)] = {'setId': 'a' * 32, 'ownerUid': 'alice', 'state': 'ready',
            'documents': {kind: {'objectPath': kind, 'fileSize': len(value), 'mimeType': 'application/pdf',
                                  'scanStatus': 'clean', 'sha256': hashlib.sha256(value).hexdigest()} for kind, value in content.items()}}
        self.storage = Mock(); self.storage.download.side_effect = content.__getitem__
        self.documents = DocumentService(Authorization(self.db), DocumentRepository(self.db), self.storage, Mock())
        self.extractor = Mock(side_effect=lambda value: {'text': value.decode(), 'readable': True})
        self.matcher = LocalEvidenceMatcher(model_loader=lambda: None)
        self.service = ScreeningService(Authorization(self.db), self.documents, self.db, self.extractor,
                                        matcher=self.matcher)

    def grant(self, uid, role, region):
        number, code = f'STAFF-{uid.upper()}', f'test-index-{uid}'
        self.db.data[('admins', uid)] = {'role': role, 'region': region, 'active': True, 'staffNumber': number, 'staffCodeId': code, 'provisioningVersion': 1}
        self.db.data[('adminStaffCodes', code)] = {'uid': uid, 'staffNumber': number, 'state': 'active'}

    def test_run_matches_only_cv_and_preserves_application_and_minimizes_stored_data(self):
        before = copy.deepcopy(self.db.data[('applications', 'app')])
        result = self.service.run(self.actor, 'app')['result']
        self.assertEqual(result['summary'], {'met': 1, 'not_met': 0, 'could_not_verify': 3})
        self.assertEqual(result['criteria'][0]['excerpt'], 'Python')
        self.assertEqual(result['aiReview']['status'], 'not_used_local_only')
        self.assertIn('No CV text was sent', result['aiReview']['message'])
        self.assertEqual(result['authenticity'], 'not_verified'); self.assertTrue(result['advisory'])
        self.assertIn('not evidence of ineligibility', result['notice'])
        self.assertEqual(self.db.data[('applications', 'app')], before)
        self.assertEqual(self.storage.download.call_count, 1) # Only the CV is read.
        saved = self.db.read('serverScreeningRuns', result['runId'])
        self.assertNotIn('objectPath', str(saved)); self.assertNotIn('Diploma in policing', str(saved))
        actions = [value['action'] for (collection, _), value in self.db.data.items() if collection == 'auditLogs']
        self.assertIn('SCREENING_COMPLETED', actions); self.assertIn('SIMULATED_CRIMINAL_VERIFICATION', actions)

    def test_external_ai_reviewer_is_never_called_even_with_recorded_opt_in(self):
        reviewer = Mock()
        self.service.ai_reviewer = reviewer
        self.db.data[('applications', 'app')]['aiScreeningConsent'] = True
        result = self.service.run(self.actor, 'app')['result']
        self.assertEqual(result['aiReview']['status'], 'not_used_local_only')
        reviewer.review.assert_not_called()

    def test_missing_and_scanned_cv_return_clear_manual_verification(self):
        application = self.db.data[('applications', 'app')]
        application['documentSetId'] = None
        missing = self.service.run(self.actor, 'app')['result']
        self.assertEqual(missing['cvStatus'], 'missing')
        self.assertIn('No CV is linked', missing['criteria'][0]['explanation'])
        self.assertFalse(self.service.get(self.actor, 'app')['result']['stale'])

        application['documentSetId'] = 'a' * 32
        self.extractor.side_effect = None
        self.extractor.return_value = {'text': '', 'readable': False}
        scanned = self.service.run(self.actor, 'app')['result']
        self.assertEqual(scanned['cvStatus'], 'unreadable')
        self.assertIn('scanned or image-only', scanned['criteria'][0]['explanation'])
        self.assertFalse(self.service.get(self.actor, 'app')['result']['stale'])

    def test_missing_published_criteria_are_reported_without_marking_report_outdated(self):
        self.db.data[('jobs', 'job')]['requirements'] = ''
        result = self.service.run(self.actor, 'app')['result']
        self.assertIn('No published vacancy criteria', result['criteria'][0]['explanation'])
        self.assertFalse(self.service.get(self.actor, 'app')['result']['stale'])

    def test_multiple_runs_keep_immutable_history_and_latest_pointer(self):
        first = self.service.run(self.actor, 'app')['result']; second = self.service.run(self.actor, 'app')['result']
        self.assertNotEqual(first['runId'], second['runId'])
        self.assertEqual(self.db.read('serverScreeningRuns', first['runId']), first)
        self.assertEqual(self.service.get(self.actor, 'app')['result']['runId'], second['runId'])
        self.assertTrue(any(value.get('action') == 'SCREENING_VIEWED' for value in self.db.data.values()))

    def test_wrong_region_applicant_and_inactive_admin_denied_before_documents(self):
        self.grant('erongo', 'admin', 'Erongo'); self.db.data[('admins', 'inactive')] = {'active': False}
        for uid in ['alice', 'erongo', 'inactive', 'unknown']:
            for method in [self.service.run, self.service.get]:
                with self.assertRaises(HTTPException) as error: method(Principal(uid), 'app')
                self.assertEqual(error.exception.status_code, 403)
        self.storage.download.assert_not_called()
        self.assertIsNone(self.db.read('serverScreeningResults', 'app'))

    def test_super_admin_can_screen_across_regions(self):
        self.assertTrue(self.service.run(Principal('super'), 'app')['result']['advisory'])

    def test_legacy_missing_closed_unpublished_or_mismatched_vacancy(self):
        for mutation in [{'vacancyId': None}, {'vacancyId': 'missing'}]:
            self.db.data[('applications', 'app')].update(mutation)
            self.assertEqual(self.service.run(self.actor, 'app')['result']['vacancyResolution'], 'could_not_verify')
        self.db.data[('applications', 'app')]['vacancyId'] = 'job'
        for mutation in [{'published': False}, {'published': True, 'region': 'Erongo'}, {'region': 'Khomas', 'title': 'Different'}]:
            self.db.data[('jobs', 'job')].update(mutation)
            self.assertEqual(self.service.run(self.actor, 'app')['result']['summary']['could_not_verify'], 1)
        self.db.data[('jobs', 'job')].update(title='Officer', status='Closed')
        self.assertEqual(self.service.run(self.actor, 'app')['result']['vacancyResolution'], 'matched')

    def test_changed_vacancy_marks_existing_result_outdated(self):
        self.service.run(self.actor, 'app'); self.db.data[('jobs', 'job')]['requirements'] = 'CV: first aid'
        self.assertTrue(self.service.get(self.actor, 'app')['result']['stale'])

    def test_changed_synthetic_fixture_marks_existing_result_outdated(self):
        self.service.run(self.actor, 'app')
        self.db.data[('syntheticVerificationCases', 'app')] = fixture('app', 'alice', 'flagged', 'SYNTHETIC-NEW')
        self.assertTrue(self.service.get(self.actor, 'app')['result']['stale'])

    def test_revoked_document_evidence_marks_existing_result_outdated(self):
        self.service.run(self.actor, 'app')
        self.db.data[('serverDocumentSets', 'a' * 32)]['state'] = 'failed'
        self.assertTrue(self.service.get(self.actor, 'app')['result']['stale'])

    def test_corrupt_private_object_and_binding_mismatch_cannot_publish_result(self):
        self.storage.download.side_effect = lambda path: b'tampered'
        with self.assertRaises(HTTPException): self.service.run(self.actor, 'app')
        self.assertIsNone(self.db.read('serverScreeningResults', 'app'))
        self.db.data[('serverApplicationDocumentBindings', 'app')] = {'ownerUid': 'alice', 'setId': 'b' * 32}
        with self.assertRaises(HTTPException): self.service.run(self.actor, 'app')

    def test_non_clean_cv_is_manual_verification_not_a_failed_screen(self):
        self.db.data[('serverDocumentSets', 'a' * 32)]['documents']['cv']['scanStatus'] = 'infected'
        result = self.service.run(self.actor, 'app')['result']
        self.assertEqual(result['cvStatus'], 'unavailable')
        self.assertIn('clean PDF', result['criteria'][0]['explanation'])
        self.storage.download.assert_not_called()

    def test_synthetic_flag_never_rejects_or_changes_application(self):
        self.db.data[('syntheticVerificationCases', 'app')] = fixture('app', 'alice', 'flagged', 'SYNTHETIC-FLAG')
        result = self.service.run(self.actor, 'app')['result']
        self.assertEqual(result['criminalVerification']['status'], 'simulated_flagged')
        self.assertEqual(self.db.read('applications', 'app')['status'], 'Submitted')

    def test_concurrent_vacancy_or_authorization_change_rejected_atomically(self):
        def change(value):
            self.db.data[('admins', 'admin')]['active'] = False
            return {'text': value.decode(), 'readable': True}
        self.extractor.side_effect = change
        with self.assertRaises(HTTPException): self.service.run(self.actor, 'app')
        self.assertIsNone(self.db.read('serverScreeningResults', 'app'))

    def test_audit_failure_prevents_screening_or_result_disclosure(self):
        with patch.object(self.service, 'audit', side_effect=RuntimeError('audit unavailable')):
            for method in [self.service.run, self.service.get]:
                with self.assertRaises(RuntimeError): method(self.actor, 'app')
        self.storage.download.assert_not_called()

    def test_result_history_pointer_and_completion_audits_are_atomic(self):
        create = Reference.create
        def fail_audit(reference, value):
            if value.get('action') == 'SIMULATED_CRIMINAL_VERIFICATION':
                raise RuntimeError('audit write failed')
            return create(reference, value)
        with patch.object(Reference, 'create', fail_audit):
            with self.assertRaises(RuntimeError): self.service.run(self.actor, 'app')
        self.assertIsNone(self.db.read('serverScreeningResults', 'app'))
        self.assertFalse(any(collection == 'serverScreeningRuns' for collection, _ in self.db.data))
        self.assertEqual(self.db.read('applications', 'app')['status'], 'Submitted')

    def test_changed_vacancy_during_extraction_rejects_publication(self):
        def change(value):
            self.db.data[('jobs', 'job')]['requirements'] = 'CV: changed'
            return {'text': value.decode(), 'readable': True}
        self.extractor.side_effect = change
        with self.assertRaises(HTTPException): self.service.run(self.actor, 'app')
        self.assertIsNone(self.db.read('serverScreeningResults', 'app'))

    def test_changed_manifest_during_extraction_rejects_publication(self):
        def change(value):
            self.db.data[('serverDocumentSets', 'a' * 32)]['state'] = 'failed'
            return {'text': value.decode(), 'readable': True}
        self.extractor.side_effect = change
        with self.assertRaises(HTTPException): self.service.run(self.actor, 'app')
        self.assertIsNone(self.db.read('serverScreeningResults', 'app'))

    def test_changed_synthetic_case_before_commit_rejects_publication(self):
        commit = self.service.commit
        def change(*args):
            self.db.data[('syntheticVerificationCases', 'app')] = fixture('app', 'alice', 'flagged', 'SYNTHETIC-CHANGED')
            return commit(*args)
        with patch.object(self.service, 'commit', side_effect=change):
            with self.assertRaises(HTTPException): self.service.run(self.actor, 'app')
        self.assertIsNone(self.db.read('serverScreeningResults', 'app'))

    def test_capacity_limit_refuses_work_without_document_access(self):
        self.service.slots = Mock(); self.service.slots.acquire.return_value = False
        with self.assertRaises(HTTPException) as error: self.service.run(self.actor, 'app')
        self.assertEqual(error.exception.status_code, 429); self.storage.download.assert_not_called()

    def test_api_requires_verified_email_rejects_body_and_does_not_cache(self):
        application = create_app(False); application.state.screening = self.service; application.state.firebase_app = None
        with TestClient(application, raise_server_exceptions=False) as client:
            self.assertEqual(client.get('/api/admin/applications/app/screening').status_code, 401)
            with patch('app.auth.verify_id_token', return_value={'uid': 'admin', 'aud': 'nampol-recruitment',
                'iss': 'https://securetoken.google.com/nampol-recruitment', 'email_verified': False, 'firebase': {}}):
                self.assertEqual(client.post('/api/admin/applications/app/screening', headers={'Authorization': 'Bearer primary-only'}).status_code, 403)
            application.dependency_overrides[current_principal] = lambda: self.actor
            self.assertEqual(client.post('/api/admin/applications/app/screening', json={'scenario': 'clear'}).status_code, 422)
            response = client.post('/api/admin/applications/app/screening')
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.headers['cache-control'], 'no-store')
            self.assertEqual(client.get('/api/admin/applications/app/screening').status_code, 200)

    def test_local_api_roundtrip_uses_real_pdf_extraction_integrity_checks_and_synthetic_case(self):
        import hashlib
        content = {'cv': text_pdf('Python first aid'), 'certificate': text_pdf('Diploma in policing')}
        manifest = self.db.data[('serverDocumentSets', 'a' * 32)]
        for kind, value in content.items():
            manifest['documents'][kind].update(fileSize=len(value), sha256=hashlib.sha256(value).hexdigest())
        self.storage.download.side_effect = content.__getitem__
        self.service.extractor = extract_pdf
        self.db.data[('syntheticVerificationCases', 'app')] = fixture('app', 'alice', 'clear', 'SYNTHETIC-ROUNDTRIP')
        application = create_app(False); application.state.screening = self.service
        application.dependency_overrides[current_principal] = lambda: self.actor
        with TestClient(application) as client:
            response = client.post('/api/admin/applications/app/screening')
            self.assertEqual(response.status_code, 200, response.text)
            result = response.json()['result']
            self.assertEqual(result['summary'], {'met': 2, 'not_met': 0, 'could_not_verify': 2})
            self.assertTrue(all(check['excerpt'] for check in result['criteria'] if check['status'] == 'met'))
            self.assertEqual(result['criminalVerification']['status'], 'simulated_clear')
            self.assertEqual(client.get('/api/admin/applications/app/screening').json()['result']['runId'], result['runId'])
        self.assertEqual(self.db.read('applications', 'app')['status'], 'Submitted')


if __name__ == '__main__': unittest.main()
