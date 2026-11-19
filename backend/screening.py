"""Local advisory CV evidence matching; never an employment decision."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
from uuid import uuid4

from fastapi import HTTPException
from firebase_admin import firestore
from backend.documents import now, set_identifier
from backend.local_nlp import LocalEvidenceMatcher

VERSION = 'advisory-local-cv-v2'
NOTICE = ('Local CV text matching only. Excerpts are evidence suggestions, not proof of '
          'qualification, proficiency, authenticity or eligibility. A missing match is not '
          'evidence of ineligibility. A human recruiter must review the original CV and make '
          'all decisions; no automated ranking, approval or rejection is performed.')


def extract_pdf(content):
    """Child process bounds CPU/wall time, memory, pages and output; no OCR guessing."""
    try:
        # Do not give the parser inherited service-account or storage credentials.
        env = {key: value for key, value in os.environ.items()
               if key.upper() in {'SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'LANG'}}
        result = subprocess.run([sys.executable, '-B', '-m', 'backend.screening_pdf'], input=content,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30,
                                cwd=Path(__file__).resolve().parent.parent, env=env, check=True,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        data = json.loads(result.stdout)
        if data.get('complete') is True and isinstance(data.get('text'), str) and len(data['text']) <= 100050:
            return {'text': data['text'], 'readable': bool(data['text'].strip())}
    except Exception:
        pass
    return {'text': '', 'readable': False}


_DEFAULT_MATCHER = LocalEvidenceMatcher()


def criteria(requirements, cv, certificate=None, declaration='', matcher=None):
    matcher = matcher or _DEFAULT_MATCHER
    lines = [re.sub(r'^\s*[-*•]\s*', '', line).strip() for line in re.split(r'[\n;]+', requirements)]
    lines = [line for line in lines if line]
    if not lines:
        return [{'requirement': 'Published vacancy requirements', 'status': 'could_not_verify',
                 'explanation': 'No published vacancy criteria are available. Needs manual verification.',
                 'sources': [], 'excerpt': None}]
    results = []
    for line in lines[:40]:
        labelled = re.fullmatch(r'[^:]{1,40}\s*:\s*(.+)', line)
        expected = labelled[1].strip() if labelled else line
        evidence = matcher.find(expected, cv.get('text', '')) if cv.get('readable') else None
        if evidence:
            status = 'met'
            explanation = (
                f"Possible supporting evidence found by {evidence['method']}. "
                "Check the full CV; this text does not verify skill or eligibility."
            )
            sources = ['cv']
            excerpt = evidence['excerpt']
        else:
            status = 'could_not_verify'
            if cv.get('issue') == 'missing':
                reason = "No CV is linked to this application."
            elif cv.get('issue') == 'unreadable':
                reason = "The CV has no extractable text; it may be scanned or image-only."
            elif cv.get('issue') == 'unavailable':
                reason = "The linked CV is not currently available as a clean PDF."
            elif cv.get('readable'):
                reason = "No sufficiently relevant excerpt was found in the readable CV text."
            else:
                reason = "CV text is unavailable for this application."
            explanation = f"{reason} Needs manual verification; this is not a negative eligibility finding."
            sources = []
            excerpt = None
        results.append({'requirement': line, 'status': status, 'explanation': explanation,
                        'sources': sources, 'excerpt': excerpt})
    if len(lines) > 40:
        results.append({'requirement': 'Additional requirements', 'status': 'could_not_verify',
                        'explanation': 'More than 40 criteria were supplied; remaining criteria need manual verification.',
                        'sources': [], 'excerpt': None})
    return results


def simulated_verification(case, application_id, owner):
    result = {'simulated': True, 'source': 'SYNTHETIC DEMONSTRATION FIXTURES — NOT A POLICE DATABASE',
              'status': 'could_not_verify', 'explanation': 'No valid synthetic fixture is assigned. No real criminal-record check was performed.'}
    if (not case or case.get('synthetic') is not True or case.get('applicationId') != application_id
            or case.get('ownerUid') != owner or not re.fullmatch(r'SYNTHETIC-[A-Z0-9-]{1,64}', str(case.get('subjectReference', '')))):
        return result
    scenario = case.get('scenario')
    if scenario in ('clear', 'flagged'):
        result.update(status='simulated_clear' if scenario == 'clear' else 'simulated_flagged',
                      explanation=('Synthetic fixture has no simulated record.' if scenario == 'clear' else
                                   'Synthetic fixture contains a simulated flag. Human demonstration review is required; this is not evidence about a real person.'),
                      subjectReference=case['subjectReference'])
    return result


class ScreeningService:
    def __init__(self, authorization, documents, client, extractor=extract_pdf, matcher=None):
        self.authorization, self.documents, self.client, self.extractor = authorization, documents, client, extractor
        self.matcher = matcher or _DEFAULT_MATCHER
        self.slots = threading.BoundedSemaphore(2)

    def read(self, collection, identifier):
        snapshot = self.client.collection(collection).document(identifier).get()
        return snapshot.to_dict() if snapshot.exists else None

    def application(self, actor, application_id):
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', application_id):
            raise HTTPException(404, 'Resource not found.')
        application = self.read('applications', application_id)
        if not application:
            raise HTTPException(404, 'Resource not found.')
        try:
            admin = self.authorization.administrator(actor, application.get('region'))
        except HTTPException:
            self.audit(actor, 'SCREENING_ACCESS_DENIED', application_id, application.get('region', ''), outcome='denied')
            raise
        return application, admin

    def audit(self, actor, action, application_id, region, **extra):
        self.client.collection('auditLogs').document().create(
            {'actorUid': actor.uid, 'adminId': actor.uid, 'action': action,
             'applicationId': application_id, 'region': region, 'timestamp': now(), **extra})

    def get(self, actor, application_id):
        application, _ = self.application(actor, application_id)
        self.audit(actor, 'SCREENING_VIEWED', application_id, application['region'])
        pointer = self.read('serverScreeningResults', application_id)
        if not pointer:
            return {'result': None}
        # Full results are accessible only through the backend so every read is audited.
        report = self.read('serverScreeningRuns', pointer['runId'])
        if not report or report.get('applicationId') != application_id:
            raise HTTPException(503, 'Screening result unavailable.')
        report = dict(report)
        report['stale'] = report.get('engineVersion') != VERSION
        vacancy = self.read('jobs', report['vacancyId']) if report.get('vacancyId') else None
        report['stale'] |= bool(report.get('vacancyId')
            and (not vacancy or self.vacancy_digest(vacancy) != report.get('vacancyDigest')))
        case = self.read('syntheticVerificationCases', application_id)
        report['stale'] |= self.case_digest(case) != report.get('caseDigest')
        manifest = self.read('serverDocumentSets', report['documentSetId']) if report.get('documentSetId') else None
        if 'documentSetDigest' in report:
            report['stale'] |= self.document_digest(manifest) != report['documentSetDigest']
        else:
            report['stale'] |= (not manifest or manifest.get('state') != 'ready'
                or manifest.get('ownerUid') != report.get('ownerUid')
                or manifest.get('documents', {}).get('cv', {}).get('scanStatus') != 'clean'
                or any(manifest.get('documents', {}).get(kind, {}).get('sha256') != digest
                       for kind, digest in report.get('documentHashes', {}).items()))
        current, _ = self.application(actor, application_id)
        if current.get('applicantId') != report.get('ownerUid') or current.get('region') != report.get('region'):
            raise HTTPException(409, 'Stored result no longer matches this application.')
        report['stale'] |= (current.get('documentSetId') != report.get('applicationDocumentSetId')
            or current.get('vacancyId') != report.get('applicationVacancyId')
            or current.get('position') != report.get('applicationPosition'))
        return {'result': report}

    @staticmethod
    def case_digest(case):
        return hashlib.sha256(json.dumps(case or {}, sort_keys=True, default=str).encode()).hexdigest()

    @staticmethod
    def document_digest(manifest):
        return hashlib.sha256(json.dumps(manifest, sort_keys=True, default=str).encode()).hexdigest()

    @staticmethod
    def vacancy_digest(vacancy):
        return hashlib.sha256(json.dumps({key: vacancy.get(key) for key in
            ('title', 'region', 'requirements', 'published', 'status')}, sort_keys=True).encode()).hexdigest()

    def run(self, actor, application_id):
        application, admin = self.application(actor, application_id)
        region = application['region']
        if not self.slots.acquire(blocking=False):
            raise HTTPException(429, 'Screening capacity reached. Retry later.')
        try:
            self.audit(actor, 'SCREENING_STARTED', application_id, region, actorRole=admin['role'])
            vacancy_id = application.get('vacancyId')
            vacancy = self.read('jobs', vacancy_id) if isinstance(vacancy_id, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', vacancy_id) else None
            if vacancy and (vacancy.get('published') is not True or vacancy.get('region') != region
                            or vacancy.get('title') != application.get('position')):
                vacancy = None
            cv = {'text': '', 'readable': False, 'issue': 'missing'}
            manifest = None
            set_id = application.get('documentSetId')
            if set_id:
                try:
                    manifest = self.documents.repository.owned(
                        application['applicantId'], set_identifier(set_id))
                except HTTPException as error:
                    if error.status_code != 404:
                        raise
                    cv['issue'] = 'missing'
                else:
                    binding = self.read('serverApplicationDocumentBindings', application_id)
                    if binding and (binding.get('setId') != set_id
                                    or binding.get('ownerUid') != application['applicantId']):
                        raise HTTPException(409, 'Application document reference does not match its immutable binding.')
                    item = (manifest.get('documents') or {}).get('cv')
                    if manifest.get('state') != 'ready':
                        cv['issue'] = 'unavailable'
                    elif (not item or item.get('scanStatus') != 'clean'
                          or item.get('mimeType') != 'application/pdf'):
                        cv['issue'] = 'unavailable'
                    else:
                        content, _ = self.documents.download(actor, manifest, 'cv', region, application_id)
                        extracted = self.extractor(content)
                        cv = {**extracted, 'issue': None if extracted.get('readable') else 'unreadable'}
            requirements = vacancy.get('requirements', '') if vacancy else ''
            if not isinstance(requirements, str) or len(requirements) > 2000:
                raise HTTPException(409, 'Invalid vacancy requirements.')
            checks = criteria(requirements, cv, matcher=self.matcher)
            ai_review = {'status': 'not_used_local_only',
                         'message': 'No CV text was sent to an external AI service.'}
            case = self.read('syntheticVerificationCases', application_id)
            criminal = simulated_verification(case, application_id, application['applicantId'])
            report = {'schemaVersion': 2, 'engineVersion': VERSION, 'runId': uuid4().hex,
                      'applicationId': application_id, 'ownerUid': application['applicantId'], 'region': region,
                      'vacancyId': vacancy_id if vacancy else None,
                      'applicationVacancyId': vacancy_id, 'applicationPosition': application.get('position'),
                      'vacancyDigest': self.vacancy_digest(vacancy) if vacancy else None,
                      'vacancyTitle': vacancy.get('title') if vacancy else None,
                      'vacancyResolution': 'matched' if vacancy else 'could_not_verify',
                      'documentSetId': set_id,
                      'applicationDocumentSetId': set_id, 'documentSetDigest': self.document_digest(manifest),
                      'documentHashes': ({'cv': (manifest.get('documents') or {}).get('cv', {}).get('sha256')}
                          if manifest and (manifest.get('documents') or {}).get('cv', {}).get('sha256') else {}),
                      'createdAt': now(), 'createdBy': actor.uid, 'advisory': True, 'notice': NOTICE,
                      'criteria': checks, 'aiReview': ai_review, 'matchingEngine': self.matcher.engine,
                      'cvStatus': ('readable' if cv.get('readable') else
                                   'unreadable' if cv.get('issue') == 'unreadable' else
                                   'unavailable' if cv.get('issue') == 'unavailable' else 'missing'),
                      'summary': {status: sum(check['status'] == status for check in checks)
                          for status in ('met', 'not_met', 'could_not_verify')},
                      'textExtraction': {'cv': cv['readable']},
                      'authenticity': 'not_verified', 'criminalVerification': criminal,
                      'caseDigest': self.case_digest(case), 'stale': False}
            self.commit(actor, application_id, application, vacancy, case, manifest, report)
            return {'result': report}
        except Exception:
            try:
                self.audit(actor, 'SCREENING_FAILED', application_id, region, outcome='failed')
            except Exception:
                pass
            raise
        finally:
            self.slots.release()

    def commit(self, actor, application_id, expected, vacancy, case, manifest, report):
        @firestore.transactional
        def save(transaction):
            ref = self.client.collection('applications').document(application_id)
            current = ref.get(transaction=transaction).to_dict()
            # All authorization and source checks precede writes and are rechecked
            # in the transaction to reject concurrent grant/source changes.
            class Records:
                def read(inner, collection, identifier):
                    return self.client.collection(collection).document(identifier).get(transaction=transaction).to_dict()
            from backend.admin_security import active_admin
            grant = active_admin(Records(), actor.uid)
            if not current or current != expected or (grant['role'] != 'super_admin' and grant.get('region') != current.get('region')):
                raise HTTPException(409, 'Application or permissions changed. Reload and screen again.')
            if vacancy:
                latest = self.client.collection('jobs').document(report['vacancyId']).get(transaction=transaction).to_dict()
                if not latest or self.vacancy_digest(latest) != report['vacancyDigest']:
                    raise HTTPException(409, 'Vacancy criteria changed. Run screening again.')
            if manifest:
                latest_manifest = self.client.collection('serverDocumentSets').document(report['documentSetId']).get(transaction=transaction).to_dict()
                if latest_manifest != manifest:
                    raise HTTPException(409, 'Document evidence changed. Run screening again.')
            latest_case = self.client.collection('syntheticVerificationCases').document(application_id).get(transaction=transaction).to_dict()
            if latest_case != case:
                raise HTTPException(409, 'Synthetic fixture changed. Run screening again.')
            transaction.create(self.client.collection('serverScreeningRuns').document(report['runId']), report)
            pointer = self.client.collection('serverScreeningResults').document(application_id)
            # Transaction.set supports creation and subsequent runs, preserving immutable history.
            transaction.set(pointer, {'runId': report['runId'], 'region': report['region']})
            for action in ('SCREENING_COMPLETED', 'SIMULATED_CRIMINAL_VERIFICATION'):
                transaction.create(self.client.collection('auditLogs').document(uuid4().hex),
                    {'actorUid': actor.uid, 'adminId': actor.uid, 'action': action, 'region': report['region'],
                     'applicationId': application_id, 'runId': report['runId'], 'timestamp': report['createdAt'],
                     'simulated': action == 'SIMULATED_CRIMINAL_VERIFICATION', 'outcome': 'completed'})
        save(self.client.transaction())
