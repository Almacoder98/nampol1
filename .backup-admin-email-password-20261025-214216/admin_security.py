"""IT-issued, UID-bound admin activation. Never expose provisioning as a public API."""
import hashlib
import hmac
import re
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from firebase_admin import firestore

ROLES = frozenset({'admin', 'recruiter', 'super_admin'})
REGIONS = frozenset({'Erongo', 'Hardap', 'Kavango East', 'Kavango West', 'Karas', '//Karas',
                    '!Karas', 'ǁKaras', 'Khomas', 'Kunene', 'Ohangwena', 'Omaheke',
                    'Omusati', 'Oshana', 'Oshikoto', 'Otjozondjupa', 'Zambezi'})
SAFE_ADMIN_FIELDS = ('staffNumber', 'firstName', 'lastName', 'email', 'role', 'region', 'unit', 'active')


def staff_identity(value):
    if not isinstance(value, str):
        raise ValueError('A staff identifier is required.')
    value = value.strip().upper()
    if not re.fullmatch(r'[A-Z0-9][A-Z0-9-]{5,31}', value):
        raise ValueError('Staff identifiers must contain 6-32 letters, digits or hyphens.')
    return value, hashlib.sha256(value.encode()).hexdigest()


def provisioned_admin(records, uid):
    """Shared trusted check for the existing UID-bound administrator grant."""
    record = records.read('admins', uid)
    if not record or record.get('active') is not True or record.get('role') not in ROLES:
        raise HTTPException(403, 'Administrator access denied. Contact IT for provisioning.')
    return record


class AdminSecurity:
    def __init__(self, client, user_lookup, clock=None):
        self.client, self.user_lookup = client, user_lookup
        self.clock = clock or (lambda: datetime.now(timezone.utc))

    def read(self, collection, uid):
        snapshot = self.client.collection(collection).document(uid).get()
        return snapshot.to_dict() if snapshot.exists else None

    def session(self, uid):
        try:
            record = provisioned_admin(self, uid)
        except HTTPException:
            pending = self.read('adminProvisioning', uid)
            if pending and pending.get('state') == 'pending' and pending.get('expiresAt', self.clock()) > self.clock():
                raise HTTPException(403, {'code': 'admin_activation_required', 'message': 'Enter your IT-issued activation code.'}) from None
            raise
        return {'uid': uid, **{key: record.get(key, '') for key in SAFE_ADMIN_FIELDS}}

    def issue(self, uid, staff_number, role, region, *, hours=24):
        """Called only by the local IT CLI under operator ADC/IAM credentials."""
        if not isinstance(uid, str) or not uid or '/' in uid or len(uid) > 128:
            raise ValueError('Invalid Firebase UID.')
        if role not in ROLES or (role != 'super_admin' and region not in REGIONS):
            raise ValueError('Select an allowed role and an exact assigned region.')
        if not 1 <= hours <= 24:
            raise ValueError('Activation expiry must be between 1 and 24 hours.')
        user = self.user_lookup(uid)
        if user.disabled or not user.email:
            raise ValueError('The target Firebase Auth account must be enabled and have an email address.')
        staff, index_id = staff_identity(staff_number)
        code = secrets.token_urlsafe(32)
        issued = self.clock()
        pending_ref = self.client.collection('adminProvisioning').document(uid)
        index_ref = self.client.collection('adminStaffCodes').document(index_id)
        admin_ref = self.client.collection('admins').document(uid)
        applicant_ref = self.client.collection('users').document(uid)
        audit_ref = self.client.collection('auditLogs').document()

        @firestore.transactional
        def issue_once(transaction):
            index = index_ref.get(transaction=transaction).to_dict()
            admin = admin_ref.get(transaction=transaction).to_dict()
            applicant = applicant_ref.get(transaction=transaction).to_dict()
            existing_pending = pending_ref.get(transaction=transaction)
            if applicant is not None:
                raise ValueError('Use a separate IT-created Auth identity, not a public applicant account.')
            if index and index.get('uid') != uid:
                raise ValueError('This staff identifier is already reserved and cannot be reassigned.')
            if admin and admin.get('active') is True and admin.get('provisioningVersion') == 1:
                raise ValueError('Deactivate the existing grant before changing its provisioning.')
            data = {'uid': uid, 'email': user.email.lower(), 'staffNumber': staff, 'staffCodeId': index_id,
                    'role': role, 'region': region if role != 'super_admin' else '', 'state': 'pending',
                    'codeDigest': hashlib.sha256(code.encode()).hexdigest(), 'issuedAt': issued,
                    'expiresAt': issued + timedelta(hours=hours), 'failedAttempts': 0, 'lockedUntil': issued}
            index_data = {'uid': uid, 'staffNumber': staff, 'state': 'reserved', 'updatedAt': issued}
            if existing_pending.exists: transaction.update(pending_ref, data)
            else: transaction.create(pending_ref, data)
            if index: transaction.update(index_ref, index_data)
            else: transaction.create(index_ref, index_data)
            transaction.create(audit_ref, {'action': 'ADMIN_PROVISIONING_ISSUED', 'targetUid': uid,
                               'staffNumber': staff, 'region': data['region'], 'timestamp': issued,
                               'actorType': 'IT_OPERATOR', 'outcome': 'issued'})
        issue_once(self.client.transaction())
        return code

    def activate(self, uid, code):
        # Only a Firebase-verified UID reaches this method.
        if not isinstance(code, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', code):
            code = ''  # Invalid formats still count toward the per-UID throttle.
        user = self.user_lookup(uid)
        if user.disabled or not user.email_verified or not user.email:
            raise HTTPException(403, 'Administrator activation denied.')
        pending_ref = self.client.collection('adminProvisioning').document(uid)
        admin_ref = self.client.collection('admins').document(uid)
        applicant_ref = self.client.collection('users').document(uid)
        audit_ref = self.client.collection('auditLogs').document()
        timestamp = self.clock()

        @firestore.transactional
        def consume(transaction):
            pending = pending_ref.get(transaction=transaction).to_dict()
            if not pending or pending.get('state') != 'pending' or pending.get('expiresAt', timestamp) <= timestamp:
                return 'invalid'
            if pending.get('lockedUntil', timestamp) > timestamp:
                return 'locked'
            valid = hmac.compare_digest(hashlib.sha256(code.encode()).hexdigest(), pending['codeDigest'])
            if not valid or pending.get('email') != user.email.lower():
                attempts = pending.get('failedAttempts', 0) + 1
                transaction.update(pending_ref, {'failedAttempts': attempts % 5,
                                   'lockedUntil': timestamp + timedelta(minutes=15) if attempts >= 5 else timestamp})
                transaction.create(audit_ref, {'action': 'ADMIN_ACTIVATION_REJECTED', 'actorUid': uid,
                                   'region': '', 'timestamp': timestamp, 'outcome': 'denied'})
                return 'invalid'
            index_ref = self.client.collection('adminStaffCodes').document(pending['staffCodeId'])
            index = index_ref.get(transaction=transaction).to_dict()
            applicant = applicant_ref.get(transaction=transaction).to_dict()
            old_admin = admin_ref.get(transaction=transaction).to_dict()
            if (applicant is not None or not index or index.get('uid') != uid
                    or index.get('staffNumber') != pending['staffNumber'] or index.get('state') != 'reserved'):
                return 'invalid'
            admin = {key: (old_admin or {}).get(key, '') for key in ('firstName', 'lastName', 'unit')}
            admin.update({key: pending[key] for key in ('email', 'staffNumber', 'staffCodeId', 'role', 'region')})
            admin.update({'active': True, 'provisioningVersion': 1, 'provisionedAt': timestamp, 'uid': uid})
            if old_admin: transaction.update(admin_ref, admin)
            else: transaction.create(admin_ref, admin)
            transaction.update(index_ref, {'state': 'active', 'updatedAt': timestamp})
            transaction.update(pending_ref, {'state': 'consumed', 'codeDigest': '', 'consumedAt': timestamp})
            transaction.create(audit_ref, {'action': 'ADMIN_ACTIVATED', 'actorUid': uid,
                               'staffNumber': pending['staffNumber'], 'region': pending['region'],
                               'timestamp': timestamp, 'outcome': 'activated'})
            return 'ok'
        result = consume(self.client.transaction())
        if result != 'ok':
            raise HTTPException(429 if result == 'locked' else 403, 'Invalid or expired staff activation code.')
        return self.session(uid)

    def deactivate(self, uid):
        """IT-only grant/code cancellation, including not-yet-activated invitations."""
        if not isinstance(uid, str) or not uid or '/' in uid or len(uid) > 128:
            raise ValueError('Invalid Firebase UID.')
        admin_ref = self.client.collection('admins').document(uid)
        pending_ref = self.client.collection('adminProvisioning').document(uid)
        audit_ref = self.client.collection('auditLogs').document()
        timestamp = self.clock()
        @firestore.transactional
        def disable(transaction):
            admin = admin_ref.get(transaction=transaction).to_dict()
            pending = pending_ref.get(transaction=transaction).to_dict()
            if not admin and not pending:
                raise ValueError('No administrator grant or pending provisioning record exists.')
            index_ids = {value.get('staffCodeId') for value in (admin, pending) if value and value.get('staffCodeId')}
            indexes = []
            for index_id in index_ids:
                reference = self.client.collection('adminStaffCodes').document(index_id)
                value = reference.get(transaction=transaction).to_dict()
                if value and value.get('uid') == uid: indexes.append(reference)
            if admin: transaction.update(admin_ref, {'active': False})
            if pending: transaction.update(pending_ref, {'state': 'cancelled', 'codeDigest': ''})
            for reference in indexes: transaction.update(reference, {'state': 'disabled', 'updatedAt': timestamp})
            transaction.create(audit_ref, {'action': 'ADMIN_DEACTIVATED', 'targetUid': uid,
                               'region': (admin or pending).get('region', ''), 'actorType': 'IT_OPERATOR',
                               'timestamp': timestamp})
        disable(self.client.transaction())
