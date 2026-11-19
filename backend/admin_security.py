"""UID-bound administrator profile lookup for email/password sessions."""

from fastapi import HTTPException


ROLES = frozenset({'admin', 'recruiter', 'super_admin'})
SAFE_ADMIN_FIELDS = (
    'staffNumber', 'firstName', 'lastName', 'email', 'role', 'region', 'unit', 'active'
)


def active_admin(records, uid):
    """Return the existing active administrator profile for a Firebase UID."""
    record = records.read('admins', uid)
    if not record or record.get('active') is not True or record.get('role') not in ROLES:
        raise HTTPException(403, 'Administrator access denied.')
    if record.get('role') != 'super_admin' and not isinstance(record.get('region'), str):
        raise HTTPException(403, 'Administrator profile has no assigned region.')
    return record


class AdminSecurity:
    def __init__(self, client):
        self.client = client

    def read(self, collection, uid):
        snapshot = self.client.collection(collection).document(uid).get()
        return snapshot.to_dict() if snapshot.exists else None

    def session(self, uid):
        record = active_admin(self, uid)
        return {'uid': uid, **{key: record.get(key, '') for key in SAFE_ADMIN_FIELDS}}
