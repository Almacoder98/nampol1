"""IT-only operator tool. Uses ADC/IAM; no public provisioning endpoint exists.

Run `python -m scripts.admin_provision --help` from the repository root.
Never redirect the issue command's one-time activation code into shared logs.
"""
import argparse
import os
import firebase_admin
from firebase_admin import auth, credentials, firestore
from backend.admin_security import AdminSecurity

PROJECT = 'nampol-recruitment'


def main():
    parser = argparse.ArgumentParser(description='IT-controlled NamPol administrator provisioning')
    sub = parser.add_subparsers(dest='command', required=True)
    issue = sub.add_parser('issue', help='Reserve a unique staff number and issue a UID-bound single-use activation code')
    issue.add_argument('--uid', required=True, help='UID of the separate IT-created Firebase Auth account')
    issue.add_argument('--staff-number', required=True, help='Unique public staff identifier, not a password')
    issue.add_argument('--role', choices=['admin', 'recruiter', 'super_admin'], required=True)
    issue.add_argument('--region', default='')
    issue.add_argument('--hours', type=int, default=24)
    disable = sub.add_parser('deactivate', help='Deactivate a grant and revoke its Firebase sessions')
    disable.add_argument('--uid', required=True)
    args = parser.parse_args()
    if os.environ.get('FIREBASE_AUTH_EMULATOR_HOST') or os.environ.get('FIRESTORE_EMULATOR_HOST'):
        parser.error('This operator tool refuses emulator configuration.')
    app = firebase_admin.initialize_app(credentials.ApplicationDefault(), {'projectId': PROJECT}, name='nampol-it-provisioning')
    try:
        client = firestore.client(app=app)
        service = AdminSecurity(client, lambda uid: auth.get_user(uid, app=app))
        if args.command == 'issue':
            code = service.issue(args.uid, args.staff_number, args.role, args.region, hours=args.hours)
            print('Project: ' + PROJECT)
            print('Deliver this activation code privately to the approved account owner. It expires and can be consumed once:')
            print(code)
        else:
            service.deactivate(args.uid)
            auth.revoke_refresh_tokens(args.uid, app=app)
            print('Administrator grant deactivated; sessions revoked in ' + PROJECT + '.')
    except Exception:
        # SDK exceptions can contain sensitive request/credential information.
        parser.exit(1, 'Provisioning failed. Check target UID, unique staff number, role/region and operator IAM permissions. No code is shown on failure.\n')
    finally:
        firebase_admin.delete_app(app)


if __name__ == '__main__':
    main()
