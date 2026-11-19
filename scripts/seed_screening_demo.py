"""IT-only synthetic fixture preparation. Dry-run by default; no real police data."""
import argparse
from datetime import datetime, timezone
import os
import re
from uuid import uuid4

import firebase_admin
from firebase_admin import auth, credentials, firestore


def fixture(application_id, uid, scenario, reference):
    if (not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', application_id)
            or not uid or '/' in uid or scenario not in ('clear', 'flagged', 'unavailable')
            or not re.fullmatch(r'SYNTHETIC-[A-Z0-9-]{1,64}', reference)):
        raise ValueError('Use a dedicated application/UID, allowed synthetic scenario and SYNTHETIC- reference.')
    return {'applicationId': application_id, 'ownerUid': uid, 'scenario': scenario,
            'subjectReference': reference, 'synthetic': True,
            'source': 'SYNTHETIC DEMONSTRATION — NOT A POLICE DATABASE'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--application-id', required=True)
    parser.add_argument('--uid', required=True)
    parser.add_argument('--scenario', choices=['clear', 'flagged', 'unavailable'], required=True)
    parser.add_argument('--reference', required=True, help='Clearly labelled SYNTHETIC-... case reference, no real ID number')
    parser.add_argument('--apply', action='store_true', help='Explicitly write the approved dedicated fixture using operator ADC/IAM')
    args = parser.parse_args()
    try:
        record = fixture(args.application_id, args.uid, args.scenario, args.reference)
    except ValueError as error:
        parser.error(str(error))
    if not args.apply:
        print('DRY RUN: would create/update one syntheticVerificationCases record and one audit event in nampol-recruitment.')
        print('No credentials loaded, accounts modified or database requests sent. Use --apply only after dedicated-data approval.')
        return
    if os.environ.get('FIREBASE_AUTH_EMULATOR_HOST') or os.environ.get('FIRESTORE_EMULATOR_HOST'):
        parser.error('This operator command refuses emulator configuration; offline tests use injected fixtures.')
    app = firebase_admin.initialize_app(credentials.ApplicationDefault(), {'projectId': 'nampol-recruitment'}, name='nampol-synthetic-demo')
    try:
        user = auth.get_user(args.uid, app=app)
        if not re.match(r'^phase2-test[-+@]', user.email or '', re.I):
            raise ValueError('A labelled dedicated test Auth account is required.')
        client = firestore.client(app=app)
        @firestore.transactional
        def save(transaction):
            application = client.collection('applications').document(args.application_id).get(transaction=transaction).to_dict()
            if not application or application.get('applicantId') != args.uid:
                raise ValueError('Dedicated application/UID mismatch.')
            transaction.set(client.collection('syntheticVerificationCases').document(args.application_id), record)
            transaction.create(client.collection('auditLogs').document(uuid4().hex), {
                'action': 'SYNTHETIC_FIXTURE_CONFIGURED', 'applicationId': args.application_id,
                'region': application.get('region', ''), 'synthetic': True,
                'timestamp': datetime.now(timezone.utc), 'actorUid': 'IT_OPERATOR_ADC',
                'subjectReference': args.reference})
        save(client.transaction())
        print('Dedicated synthetic fixture and audit event saved. No application, profile or decision was modified.')
    except Exception:
        parser.exit(1, 'Fixture preparation failed. Check dedicated UID/application and operator IAM. No private details logged.\n')
    finally:
        firebase_admin.delete_app(app)


if __name__ == '__main__':
    main()
