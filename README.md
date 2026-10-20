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

From the repository root, start the allowlisted frontend server (Python 3.12+):

```powershell
py scripts/serve_frontend.py
```

It generates `public/` from an explicit list of frontend files and serves only
those assets on `127.0.0.1:8000`. Open `http://localhost:8000/Frontend/`.
All existing `/Frontend/`, `/js/`, and `/css/` URLs and relative imports remain
unchanged. Restart the server after source edits to regenerate the public snapshot;
edit the original sources, not generated `public/` files.

Directory listings, private files, traversal paths, symlinks, and Windows
junctions are not served. Keep credentials outside the repository and web root;
`.gitignore` does not prevent HTTP access. Do not run a repository-root
`python -m http.server`. The browser Firebase client configuration remains a
public asset; Firebase service-account credentials and backend secrets do not.
The separate backend remains on port 8001 and is not served by this launcher.

If port 8000 is occupied, the launcher exits without stopping the existing server.
For parallel testing use `py scripts/serve_frontend.py --port 8002`, then open
`http://localhost:8002/Frontend/`. Port 8002 is a different browser origin and
is not in the backend's existing CORS allowlist; use port 8000 for normal work.
When ready to replace an older unsafe server, stop that server manually first.
The launcher does not secure another server that is still serving the repository.
To generate files without starting a server, use `--prepare-only`.

Local security tests (no third-party dependencies):

```powershell
py -m unittest discover -s tests -p test_frontend_server.py -v
```

## Applicant workflow

Applicant registration sends an email verification link. After verification,
the applicant logs in, completes the profile, selects a CV, identification, and
qualification certificate for metadata validation, and submits an application.
In the current prototype mode the files themselves are not uploaded or stored;
the app records document metadata in Firestore and marks the records validated.
Submitted applications appear in the dashboard and the status page.

Authorized administrators review applications within their region (or across
regions as a `super_admin`), record a reason, and make a final approval or
denial. The applicant dashboard/status page reads the latest saved decision.
Application-stage events, document access, and final decisions are appended
to immutable Firestore audit records.

## Vacancies and screening

Active administrators can create, close, reopen, or delete vacancies from the
Vacancies section of `Frontend/admin.html`. A vacancy includes a title, region,
description, and optional requirements. Only published vacancies with status
`Open` are readable on the public home page and applicant dashboard. The Apply
link carries the selected title into the existing application form. New
vacancies are not seeded automatically; publish one from the admin portal to
see it in the listings.

Application review includes a read-only screening checklist for CV metadata
presence, recorded qualification/field/year, and the existing document
validation flag. In the current prototype flow the file itself is not stored,
so the checklist cannot inspect CV content or verify authenticity. It does not
calculate a match score or make eligibility or rejection decisions. The
checklist is context for a human reviewer only.

## Local check

From the repository root, start the secure frontend server with:

```powershell
py scripts/serve_frontend.py
```

Open `http://localhost:8000/Frontend/`. Sign in as an active admin to publish
a test vacancy, then check the home page, applicant dashboard, and Apply link.
Open an application in the admin portal to see its screening checklist. The
new Firestore rules must be deployed to the Firebase project before vacancy
reads and writes will work there; deployment is intentionally not part of this
change. Use test data and the existing admin accounts while checking the flow.
