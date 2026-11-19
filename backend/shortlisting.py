"""Human shortlist selection, separate from final decisions. Trusted writes only."""
import hashlib
import json
import re
import unicodedata
from uuid import uuid4

from fastapi import HTTPException
from firebase_admin import firestore
from google.cloud.firestore_v1.base_query import FieldFilter

from backend.admin_security import active_admin
from backend.documents import now


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value):
        raise HTTPException(404, 'Record not found.')
    return value


class ShortlistService:
    RECORDS = 'serverShortlists'
    RECEIPTS = 'serverShortlistRequests'
    PUBLIC = 'applicantShortlistStatuses'

    def __init__(self, authorization, client):
        self.authorization, self.client = authorization, client

    def read(self, collection, key):
        return self.client.collection(collection).document(key).get().to_dict()

    def authorized_application(self, actor, application_id):
        application = self.read('applications', identifier(application_id))
        if not application:
            raise HTTPException(404, 'Application not found.')
        self.authorization.administrator(actor, application.get('region'))
        return application

    @staticmethod
    def empty(application_id):
        return {'applicationId': application_id, 'status': 'not_shortlisted', 'version': 0,
                'reason': '', 'reviewerId': None, 'shortlistedAt': None, 'removedAt': None}

    def get(self, actor, application_id):
        application = self.authorized_application(actor, application_id)
        record = self.read(self.RECORDS, application_id)
        if record and (record.get('ownerUid') != application.get('applicantId')
                       or record.get('vacancyId') != application.get('vacancyId')
                       or record.get('region') != application.get('region')):
            raise HTTPException(409, 'Shortlist source changed. Contact IT.')
        self.authorization.administrator(actor, application.get('region'))
        return {'result': record or self.empty(application_id)}

    def change(self, actor, application_id, body):
        identifier(application_id)
        if not isinstance(body, dict) or set(body) != {'action', 'reason', 'requestId', 'expectedVersion'}:
            raise HTTPException(422, 'Supply only action, reason, requestId and expectedVersion.')
        action, reason, request_id, expected = (body[key] for key in ('action', 'reason', 'requestId', 'expectedVersion'))
        if action not in ('shortlist', 'remove') or not isinstance(reason, str) or len(reason) > 1000:
            raise HTTPException(422, 'Choose shortlist/remove and enter a reason of up to 1,000 characters.')
        reason = reason.strip()
        if not any(not char.isspace() and unicodedata.category(char)[0] not in 'CZ' for char in reason):
            raise HTTPException(422, 'A reason or comment is required.')
        if (not isinstance(request_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,64}', request_id)
                or type(expected) is not int or expected < 0):
            raise HTTPException(422, 'A valid request ID and shortlist version are required.')
        # The receipt binds a retry to its original meaning, even after a later removal.
        digest = hashlib.sha256(json.dumps([action, reason, expected]).encode()).hexdigest()
        receipt_id = hashlib.sha256(json.dumps([actor.uid, application_id, request_id]).encode()).hexdigest()
        app_ref = self.client.collection('applications').document(application_id)
        shortlist_ref = self.client.collection(self.RECORDS).document(application_id)
        receipt_ref = self.client.collection(self.RECEIPTS).document(receipt_id)

        @firestore.transactional
        def commit(transaction):
            class Records:
                def read(inner, collection, key):
                    return self.client.collection(collection).document(key).get(transaction=transaction).to_dict()
            records = Records()
            grant = active_admin(records, actor.uid)
            application = app_ref.get(transaction=transaction).to_dict()
            if not application:
                raise HTTPException(404, 'Application not found.')
            if grant['role'] != 'super_admin' and grant.get('region') != application.get('region'):
                raise HTTPException(403, 'Application is outside your authorized region.')
            current = shortlist_ref.get(transaction=transaction).to_dict()
            receipt = receipt_ref.get(transaction=transaction).to_dict()
            if current and (current.get('ownerUid') != application.get('applicantId')
                            or current.get('vacancyId') != application.get('vacancyId')
                            or current.get('region') != application.get('region')):
                raise HTTPException(409, 'Shortlist source changed. Contact IT.')
            if receipt:
                if receipt.get('digest') != digest:
                    raise HTTPException(409, 'This request ID was already used for another action.')
                return {'result': current or self.empty(application_id), 'changed': False, 'replayed': True}
            version = current.get('version', 0) if current else 0
            if expected != version:
                raise HTTPException(409, 'Another review changed the shortlist. Refresh before continuing.')
            target = 'shortlisted' if action == 'shortlist' else 'not_shortlisted'
            if target == 'shortlisted':
                if application.get('status') not in ('Submitted', 'Under Review'):
                    raise HTTPException(409, 'Only submitted or under-review applications can be shortlisted.')
                vacancy_id = identifier(application.get('vacancyId'))
                vacancy = records.read('jobs', vacancy_id)
                if (not vacancy or vacancy.get('published') is not True
                        or vacancy.get('region') != application.get('region')
                        or vacancy.get('title') != application.get('position')):
                    raise HTTPException(409, 'A matching published vacancy is required; no vacancy was guessed.')
            else:
                vacancy_id = application.get('vacancyId')
            timestamp = now()  # Backend UTC time; never accepted from the browser.
            receipt_data = {'digest': digest, 'applicationId': application_id, 'actorUid': actor.uid, 'createdAt': timestamp}
            if (current or {}).get('status', 'not_shortlisted') == target:
                transaction.create(receipt_ref, receipt_data)
                return {'result': current or self.empty(application_id), 'changed': False, 'replayed': False}
            record = {'applicationId': application_id, 'vacancyId': vacancy_id,
                'ownerUid': application['applicantId'], 'region': application['region'],
                'status': target, 'reviewerId': actor.uid, 'reason': reason, 'version': version + 1,
                'shortlistedAt': timestamp if action == 'shortlist' else current['shortlistedAt'],
                'removedAt': timestamp if action == 'remove' else None, 'updatedAt': timestamp}
            transaction.set(shortlist_ref, record)
            transaction.set(self.client.collection(self.PUBLIC).document(application_id), {
                'applicationId': application_id, 'vacancyId': vacancy_id, 'ownerUid': application['applicantId'],
                'status': target, 'updatedAt': timestamp})
            transaction.create(receipt_ref, receipt_data)
            transaction.create(self.client.collection('auditLogs').document(uuid4().hex), {
                'action': 'CANDIDATE_SHORTLISTED' if action == 'shortlist' else 'CANDIDATE_REMOVED_FROM_SHORTLIST',
                'actorUid': actor.uid, 'adminId': actor.uid, 'actorRole': grant['role'],
                'applicationId': application_id, 'vacancyId': vacancy_id, 'applicantId': application['applicantId'],
                'region': application['region'], 'shortlistVersion': version + 1, 'reason': reason, 'timestamp': timestamp})
            # Audit logs are administrator-only; preserve the internal explanation
            # immutably even after the latest shortlist record changes.
            # Notes stay in the private record; no application or email job is changed.
            return {'result': record, 'changed': True, 'replayed': False}
        return commit(self.client.transaction())

    def list_vacancy(self, actor, vacancy_id):
        vacancy_id = identifier(vacancy_id)
        vacancy = self.read('jobs', vacancy_id)
        if not vacancy:
            raise HTTPException(404, 'Vacancy not found.')
        self.authorization.administrator(actor, vacancy.get('region'))
        # One equality filter uses the existing automatic single-field index.
        snapshots = self.client.collection(self.RECORDS).where(filter=FieldFilter('vacancyId', '==', vacancy_id)).stream()
        items = []
        for snapshot in snapshots:
            record = snapshot.to_dict()
            if record.get('status') != 'shortlisted' or record.get('region') != vacancy.get('region'):
                continue
            application = self.read('applications', identifier(record.get('applicationId')))
            if (not application or application.get('vacancyId') != vacancy_id
                    or application.get('region') != vacancy.get('region')
                    or application.get('applicantId') != record.get('ownerUid')):
                continue
            items.append({**record, 'applicantName': application.get('applicantName', ''),
                          'applicationReference': application.get('applicationReference', record['applicationId']),
                          'applicationStatus': application.get('status', '')})
        latest = self.read('jobs', vacancy_id)
        if not latest or latest.get('region') != vacancy.get('region'):
            raise HTTPException(409, 'Vacancy scope changed. Refresh the shortlist.')
        self.authorization.administrator(actor, latest.get('region'))
        items.sort(key=lambda item: item['applicationId'])
        return {'vacancyId': vacancy_id, 'title': vacancy.get('title', ''), 'items': items}
