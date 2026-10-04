# NamPol Recruitment

## Firebase setup

The browser application uses Firebase Authentication, Cloud Firestore, and
Cloud Storage. Before testing the complete workflow:

1. In Firebase Authentication, enable Email/Password sign-in and configure
   the email verification template and authorized domains for your test host.
2. Ensure the configured Firebase project has its Cloud Storage bucket
   enabled.
3. Deploy the access rules from this repository:

   ```powershell
   firebase deploy --only firestore:rules,storage --project nampol-recruitment
   ```

4. Create administrator accounts in Firebase Authentication, then create a
   matching `admins/{authUid}` Firestore document. Set `active: true`, a role
   of `admin`, `recruiter`, or `super_admin`, and (except for a super admin)
   the administrator's `region`. Add `staffNumber`, `firstName`, `lastName`,
   `email`, and `unit` for the dashboard.

Do not accept real identity documents until the rules have been deployed and
the Firebase project has been reviewed for privacy, retention, and access
requirements. Test with non-sensitive sample files.

## Run locally

Serve the repository root over HTTP so pages under `Frontend/` can load the
shared `js/` and `css/` directories. Open
`http://localhost:8000/Frontend/` after starting a local static server from the
repository root. Do not expose the repository root to an untrusted network:
it contains local development files.

## Applicant workflow

Applicant registration sends an email verification link. After verification,
the applicant logs in, completes the profile, uploads a CV, identification,
and qualification certificate to Storage, and submits an application. Submitted
applications appear in the dashboard and the status page.

Authorized administrators review applications within their region (or across
regions as a `super_admin`), record a reason, and make a final approval or
denial. The applicant dashboard/status page reads the latest saved decision.
Application-stage events, document access, and final decisions are appended
to immutable Firestore audit records.
