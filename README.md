# NamPol Recruitment

## Phase 5 candidate shortlisting

The local administrator workflow now supports separate, audited shortlist
addition/removal, a vacancy-specific view and a safe applicant-visible indicator.
Internal comments stay private and final approval/denial remain independent.
See [PHASE5_SHORTLISTING.md](PHASE5_SHORTLISTING.md) for controls, browser steps,
security design, limitations and regression evidence. Nothing is deployed;
SMTP configuration remains **PENDING**. Login uses email/password after email verification.

## Phase 4 academic demonstration readiness

See [PHASE4_DEMONSTRATION.md](PHASE4_DEMONSTRATION.md) for the presentation sequence,
synthetic identities/PDFs, endpoint inventory, research checklist and blockers.
SMTP remains **PENDING**. No live accounts or deployments were created.
Run all local regression layers using the cached temporary Java:

```powershell
& .\.venv-backend\Scripts\python.exe -B scripts/run_phase4_regression.py
```

## Phase 3 review, bound documents and decision notifications

Local atomic submission bindings, private application PDF review, decision email
outbox/preview and live applicant status updates are documented in
[PHASE3_REVIEW.md](PHASE3_REVIEW.md). Email defaults to **preview only**. Real SMTP
delivery and deployment remain unapproved. No existing server was restarted
during this phase.

## Phase 2 advisory screening and simulated verification

The admin application review modal includes **Screen CV**. It compares only the
selected application's protected CV PDF with the linked, published vacancy
requirements. FastEmbed sentence embeddings run locally when the model is
available; otherwise a local token-overlap fallback is labelled in the report.
Each criterion shows a possible CV excerpt or needs manual verification.
No CV text is sent to an external AI service, and screening never changes the
application decision.

## Phase 1 authentication and administrator security

Local implementation and focused tests are documented in [PHASE1_SECURITY.md](PHASE1_SECURITY.md).
Login uses Firebase email/password and requires verified email. Administrator access
then checks the existing UID-bound administrator profile for an active allowed role
and region.

## Firebase setup

The browser uses Firebase Authentication and Firestore. Documents use FastAPI,
ClamAV and private Supabase Storage. Firebase Storage is not the upload path.
Before an approved complete live demonstration:

1. In Firebase Authentication, enable Email/Password sign-in and configure
   the email verification template and authorized domains for your test host.
2. Configure the existing trusted backend, private Supabase bucket and ClamAV
   as described in [BACKEND.md](BACKEND.md).
3. Coordinate frontend/backend/rules rollout before seeking approval.
   No deployment is authorized in Phase 4.

4. Administrator profiles are maintained in the existing `admins/{Firebase UID}`
   documents. Public registration creates applicants only.

Use the dedicated synthetic identities and PDFs for the academic presentation.
Normal document-upload validation remains unchanged.

## Run locally

On Windows, start the existing backend virtual environment and secure frontend
together from the repository root:

```powershell
powershell.exe -NoProfile -File .\scripts\start_nampol.ps1
```

The launcher checks the existing ClamAV daemon on `127.0.0.1:3310` with PING
and a harmless INSTREAM scan, then starts FastAPI on `127.0.0.1:8001` and the
allowlisted frontend on `127.0.0.1:8000`. It does not install dependencies or
change scanner, authentication, database or storage configuration. ClamAV must
already be running; a successful probe does not establish signature freshness.
Start it with the explicit user configuration before launching the application:

```powershell
& 'C:\Program Files\ClamAV\clamd.exe' `
  "--config-file=$env:LOCALAPPDATA\ClamAV\clamd.conf" --foreground --debug
```

Keep that terminal open until the log reports `TCP: Bound to [127.0.0.1]:3310`
and `SelfCheck: Database status OK`. If ClamAV reports that its virus database
is older than seven days, update it first from a separate PowerShell terminal:

```powershell
& 'C:\Program Files\ClamAV\freshclam.exe' `
  "--config-file=$env:LOCALAPPDATA\ClamAV\freshclam.conf"
```

Do not start a second `clamd` process while port 3310 is occupied. The managed
runner is also available for background startup:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\run_clamav.ps1
```

Check readiness before starting the app with `Test-NetConnection 127.0.0.1
-Port 3310`; the application launcher performs the authoritative PING and
INSTREAM checks and will stop without starting either application server when
ClamAV is unavailable.

The launcher's saved project URL/key pair takes priority over environment values,
so stale terminal settings cannot silently replace it. Environment values are used
to bootstrap setup when no saved pair exists. A single Firebase Admin service-account
file in `%LOCALAPPDATA%\NamPol\secrets` is discovered automatically. Required
values missing from those sources are requested with masked local terminal
prompts, never through chat. The launcher does not read the repository's legacy
`.env`. It requires a service-account JSON file for the intended Firebase project
outside this repository, a Supabase HTTPS origin, and the server `sb_secret_` key.

After entering missing values once, verified settings are saved automatically.
Both the URL and key are encrypted using current-user Windows DPAPI in
`%LOCALAPPDATA%\NamPol\launcher\credentials.clixml`; the directory grants access
only to your Windows account and SYSTEM. The Firebase file path is saved alongside
them; the existing service-account file is neither copied nor changed.
The encrypted values can be decrypted only by the same Windows account on the
same computer. Keep the existing Firebase JSON private. To explicitly save
already configured environment values, add `-SaveCredentials` to the command.

Saving works as a normal Windows user, including repeated saves to the already
protected directory. The launcher persists only access-control (DACL) changes
through .NET; it leaves ownership and auditing unchanged. It does not use
`Set-Acl`, request `SeSecurityPrivilege`, elevate the launcher or disable auditing.
DPAPI encryption and the current-user/SYSTEM access restriction remain enforced.

Open `http://127.0.0.1:8000/Frontend/login.html` after the launcher reports both
servers ready. Before saving configuration or starting servers, the launcher
verifies DNS and HTTPS (without sending a key on the connectivity probe), then
makes a read-only Supabase bucket request. It must accept the key and confirm
`applicant-documents` is private. This checks storage readiness, not a full upload
or Firebase IAM. Before replacing the saved file, a fresh PowerShell process must
decrypt the candidate and repeat this preflight using only its saved values.
If verification fails, the candidate is removed and the old file is retained.
Older configurations with a plain-text URL remain readable and migrate to an
encrypted URL only after successful verification; the key remains encrypted.
Backend liveness is `http://127.0.0.1:8001/health`. Keep the terminal open
and press Ctrl+C to stop both launcher-owned servers. Occupied ports cause a
clear error; the launcher never stops an existing process to take its port.
Server subprocess output is drained without printing or writing it to logs;
startup failures display sanitized operator guidance. Credentials are passed
only in FastAPI's environment, never in process arguments or to the frontend.

For a noninteractive preflight without starting application servers:

```powershell
powershell.exe -NoProfile -File .\scripts\start_nampol.ps1 -CheckOnly -NoPrompt
```

To replace a stale URL/key pair through masked prompts, ignoring old Supabase
environment values and retaining the existing Firebase file path:

```powershell
powershell.exe -NoProfile -File .\scripts\start_nampol.ps1 -Configure
```

Copy the project URL and active secret key from the same project in the Supabase
dashboard. Use the HTTPS origin without `/rest/v1/`. Invalid credentials, an
unresolvable host, unavailable storage or a missing/public bucket block startup;
the existing saved file is retained if the replacement values fail readiness.
Ordinary launches do not prompt for saved credentials or ask whether to save them.
In the VS Code PowerShell terminal, type each value at its matching prompt,
then press Enter. Standard PowerShell masked input hides both Supabase values;
asterisks may appear as you type. Copied whitespace is removed. Enter credentials
only at their prompts, never at the `PS>` command prompt. After verification and
successful encrypted saving, use the ordinary launch command without `-Configure`
to reuse the saved values automatically.
`-SaveCredentials` remains supported for explicitly re-verifying/re-saving a pair.
No bucket policy or configuration is changed by the probe. During an upload,
fixed safe error codes distinguish storage credential, connection, timeout and
bucket errors. Ambiguous failures still block repeat uploads until reconciliation.

Launcher integration tests use temporary synthetic credentials, Windows DPAPI,
real local server processes and the existing ClamAV daemon, then clean up their
servers and temporary files. No cloud requests or document uploads are made:

```powershell
powershell.exe -NoProfile -File .\tests\start_nampol.test.ps1
```

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

The review modal's **Screen CV** action uses the existing admin authentication,
application-region authorization, private document download, scan and integrity
checks. It reads only the CV and compares its locally extracted text with the
linked published vacancy's requirements. Results offer possible excerpts or
manual verification; an absent match is not a negative eligibility finding.
Text-based PDFs are supported. Scanned/image-only PDFs, missing CVs, and missing
published criteria are called out explicitly. Document authenticity is not
verified, and a human administrator makes every application decision.

The local sentence model package is pinned in `requirements.txt`. Install backend
dependencies and prewarm the cached model (optional; first-time model download
requires network access):

```powershell
& .\.venv-backend\Scripts\python.exe -m pip install -r requirements.txt
& .\.venv-backend\Scripts\python.exe -c "from backend.local_nlp import LocalEvidenceMatcher; print(LocalEvidenceMatcher().prepare())"
```

Preferred launch (starts both servers and checks the existing private-storage
and ClamAV configuration):

```powershell
powershell.exe -NoProfile -File .\scripts\start_nampol.ps1
```

For separate terminals, after securely configuring the backend environment,
start the backend and frontend with:

```powershell
& .\.venv-backend\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8001 --no-access-log
& .\.venv-backend\Scripts\python.exe scripts\serve_frontend.py --port 8000
```

Open `http://127.0.0.1:8000/Frontend/login.html`, sign in as an existing
authorized administrator, open an application review modal, and select
**Screen CV**. Use only a dedicated demonstration environment and fictional
applicant records. The alpha and beta PDFs under `output\pdf\phase4-demo\` are
fictional; `demo\phase4_accounts.json` contains offline test identities, not
live login accounts. Do not provision its `example.invalid` addresses.

Repeat the offline strong/weak/missing-or-unreadable flow without cloud accounts:

```powershell
& .\.venv-backend\Scripts\python.exe -B -m unittest discover -s tests -p test_phase4_integration.py
node --test tests\screening.test.cjs
```

The integration test submits synthetic PDFs through the offline upload and
admin-screening APIs, checks a strong and a weak match, then checks missing and
image-only CVs. It does not create live accounts or verify browser login.

## Local check

From the repository root, start the secure frontend server with:

```powershell
py scripts/serve_frontend.py
```

Open `http://localhost:8000/Frontend/` to inspect the interface. Protected access
requires verified email and applicable trusted grants. Local testing does not
deploy changes to Firebase or production. Follow the Phase 4 guide for approved
hosted demonstration prerequisites.
