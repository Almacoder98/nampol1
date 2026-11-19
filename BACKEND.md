# Phase 2A Backend

Python 3.12 or newer is recommended for the full local test suite. The dedicated
`.venv-backend/` environment is isolated from global site-packages and excluded
from Git. It is outside the generated `public/` directory and is never included
in the secure frontend server's allowlist. The document centre is integrated with the secure upload API.
Do not serve the repository root with a generic static server.

```powershell
py -m venv .venv-backend
& .\.venv-backend\Scripts\python.exe -m pip install -r requirements-dev.txt
& .\.venv-backend\Scripts\python.exe -m pip check
& .\.venv-backend\Scripts\python.exe -c "import app, backend.documents, backend.storage, backend.validation; print('Backend imports OK')"
& .\.venv-backend\Scripts\python.exe -m unittest discover -s tests -v
```

The isolated environment has been prepared with Python 3.14.5 and the existing
pinned requirements, including Pillow 12.2.0 and pypdf 6.20.0. `pip check` and
imports of `app` and all backend modules passed. The full local Python run
completed 47 tests: 43 passed, four Windows symlink tests skipped because link
creation was unavailable. All 33 backend/document tests passed. Nonblocking
warnings concern Starlette's legacy httpx test adapter and a deprecated pypdf
helper used to generate an unsafe PDF test fixture. Cloud services and malware
scanning are mocked in the unit tests; these results do not certify live uploads.

ClamAV is installed at `C:\Program Files\ClamAV\clamd.exe`, with its
configuration in `%LOCALAPPDATA%\ClamAV\clamd.conf`. The daemon's default
configuration lookup is beside the executable; starting it without an explicit
config path exits with code 1 when that default file is absent. Start it from a
PowerShell terminal with the user config path and leave the foreground process
running:

```powershell
$clamd = "C:\Program Files\ClamAV\clamd.exe"
$config = Join-Path $env:LOCALAPPDATA "ClamAV\clamd.conf"
& $clamd "--config-file=$config" --foreground --debug
```

Do not start a second daemon if port 3310 is already listening. The config
should keep `TCPAddr 127.0.0.1`, and its `StreamMaxLength` must cover the
backend's 5 MiB file limit. This config has no `LogFile` directive, so
foreground debug output goes to the terminal rather than a ClamAV log file.
Wait for `TCP: Bound to [127.0.0.1]:3310` and `SelfCheck: Database status OK`
before starting FastAPI. A startup warning that the virus database is older
than seven days means signatures should be refreshed before application
testing; it does not mean the daemon is ready. Refresh the database from a
second terminal with the matching user configuration:

```powershell
$freshclam = "C:\Program Files\ClamAV\freshclam.exe"
$freshconf = Join-Path $env:LOCALAPPDATA "ClamAV\freshclam.conf"
& $freshclam "--config-file=$freshconf"
```

Then restart `clamd` and verify the loopback listener. The application launcher
also performs a protocol-level PING and harmless INSTREAM scan, so a missing
listener or failed scan blocks backend/frontend startup rather than allowing
uploads to run without malware scanning.
For the backend, set `CLAMAV_PORT=3310`. Availability and protocol checks do not
certify signature freshness; malware scanning remains fail-closed.

### ClamAV lifecycle investigation (20 October 2026)

No clamd process, listener, Windows service, or ClamAV scheduled task was found
at the start of the investigation. The active configuration is valid: loopback
TCP 3310, StreamMaxLength 25M, MaxScanSize 100M, MaxFileSize 25M, ScanPDF yes,
and AlertExceedsMax yes. The current user owns the database directory and has
full control; all three CVD files were readable. SYSTEM also has full control.
No database permissions or signature files were changed.

One definite launch failure was reproduced: even `clamd.exe --version` without
an explicit config exits 1 because `C:\Program Files\ClamAV\clamd.conf` is absent.
The same version command with the user config exits 0 (ClamAV 1.5.4, daily 28157).
This explains launches using the default path, but cannot explain a daemon
which already loaded its database and subsequently stopped.

The reported VS Code restart failure is consistent with an unmanaged console
process losing its terminal/job host. This is an inference, not a confirmed
historical exit cause: no previous daemon exit code or native LogFile was
available. Application crash/hang events were checked over four days. One WER
event on 18 October names clamd 1.5.4 with RADAR_PRE_LEAK_64; that is a memory
diagnostic, not proof of a crash or the reason for termination. The observed
daemon used about 0.9 GiB RAM on an approximately 8 GiB machine. No matching
application fault/hang event was found in that query. No conflicting listener
or second clamd instance was found. No OOM or signature-corruption diagnosis
has been established.

A single hidden diagnostic daemon was started with the explicit existing config
and `C:\Program Files\ClamAV` as its working directory. Its stdout/stderr are
captured under `%TEMP%\nampol-clamav-diagnostics`; it stayed running across
multiple independent command sessions and repeated live PING checks. TCP is
LISTENING only on 127.0.0.1:3310; zPING returns PONG. The existing backend
`ClamAVScanner` successfully scanned harmless synthetic bytes. A generated blank
PDF file also passed real ClamAV INSTREAM scanning and the backend's existing
`validate_document` PDF checks, then was deleted. No storage or Firebase calls
were made. An initial sandbox temporary-directory permission error affected only
test-file creation; the retry in the writable workspace passed and the empty
temporary directory was removed.

This verifies the backend scanner transport and PDF validation directly. No
FastAPI process was listening on 8001 during this investigation; a running HTTP
upload endpoint with real cloud configuration has not been exercised. Set
`$env:CLAMAV_PORT = '3310'` in the eventual backend terminal before launching
uvicorn. No credentials, Firebase logic, Supabase logic, security rules, scan
limits, or installed software were changed.

The proposed durable fix is a user-level Windows logon task named
`NamPol-ClamAV`, independent of VS Code. Native Windows services are also
[supported by ClamAV](https://docs.clamav.net/manual/Usage/Services.html), but a
current-user task avoids introducing an elevated service identity for this
local prototype. Two reviewable scripts are provided:

- `scripts/run_clamav.ps1`: refuses duplicate clamd processes, launches the
  existing executable hidden with explicit config and a native daemon log,
  waits for its exit, and records its actual exit code. On exit it waits
  60 seconds and retries at most three times within the runner. After all
  retries are exhausted it exits with failure. It refuses duplicate processes.
- `scripts/register_clamav_task.ps1`: copies the reviewed runner into
  `%LOCALAPPDATA%\ClamAV\run_clamav.ps1`, then registers the task at current-user
  logon with an interactive limited token, no password, no execution timeout,
  battery operation allowed and IgnoreNew instances. Scheduler retries are
  disabled; the runner enforces the three retries one minute apart. It refuses to overwrite an existing named task and never
  changes PowerShell execution policy. Logs go to `%LOCALAPPDATA%\ClamAV\logs`.
  Signing out stops this user-level mechanism; sign-in starts it again. Running
  before sign-in would need a separately approved service design.

The user explicitly approved registration. `NamPol-ClamAV` is now installed,
and the runner has been copied to LocalAppData. Both scripts passed PowerShell
parser checks; registration was dry-run with `-WhatIf` before installation.
The registered settings were verified: limited current-user token and PT0S
execution limit (unlimited). The final scheduler restart count is zero because
bounded recovery is implemented inside the runner.
CurrentUser execution policy remains RemoteSigned.
The 25 document/backend-scanner unit tests passed, including unavailable scanner,
malware/error replies, and scan-before-storage behavior. Live synthetic scanning
is additional to those mocked unit tests. `git diff --check` passed.

The approved setup command was (already run; do not register a duplicate):

```powershell
& .\scripts\register_clamav_task.ps1
```

Only the verified diagnostic PID 17716 was stopped. The task then started
clamd PID 14364 with the explicit existing config and native log path. Task
state was Running. Startup was slower than the first readiness deadline:
the process remained alive and loaded 3,628,169 signatures before listening.
Do not launch duplicates while database loading/compilation is in progress.
The task-managed instance subsequently returned PONG and passed a real
synthetic PDF scan through the backend scanner and validator.

A controlled protocol SHUTDOWN was requested to test task recovery. Clamd took
time to finish shutdown, and the runner recorded its actual exit code as 0,
then returned failure as designed to request a task restart. Despite the
registered RestartOnFailure count=3/interval=PT1M, Task Scheduler did not relaunch
the task in the observation window. The final runner instead implements the same
maximum three one-minute retries itself. Scheduler retries were removed so they
cannot multiply the retry budget. A settings-only update was rejected with
0x80041319 (missing Count); exporting the existing task XML, removing only the
RestartOnFailure element, and re-registering that same task resolved it.

Recovery was tested by terminating only the verified task-owned daemon
PID 19624. The runner logged exit code -1 and retry=1/3 at 01:16:44
local time, then launched replacement PID 18620 at 01:17:44 without a manual
Start-ScheduledTask call. This verifies the one-minute runner recovery.
The replacement subsequently returned PONG and passed a generated harmless
blank-PDF file through real ClamAV scanning and the existing backend PDF
validator; the file was deleted immediately. Recovery, listening readiness, and
backend scanner connectivity are PASS. Database load/compile on this machine
can take roughly two to three minutes; wait for PONG before starting uploads. A full Windows sign-out/reboot and VS Code restart
have not been performed. No software reinstall or Windows service was needed.

Before supplying credentials, confirm the actual frontend process on port 8000
returns 403/404 for private paths. A header-only check during this preparation
returned HTTP 200 for `/.env`, `/app.py`, and `/.venv-backend/pyvenv.cfg`, which is
not the secure launcher's expected behavior. No secret contents were fetched or
printed and the running server was not changed. Resolve the serving boundary
before using sensitive files. That earlier check predates the frontend integration. No live cloud upload has been performed.

Supply these environment variables in the backend terminal, without writing
secret values into source code, frontend files, terminal history, or logs:

- `GOOGLE_APPLICATION_CREDENTIALS`: absolute path to a Firebase service-account
  JSON file stored outside this repository, or use secure Application Default
  Credentials. The account needs Firestore access and Firebase Auth permission
  to check revoked tokens/disabled users for `nampol-recruitment`.
- `SUPABASE_URL`: HTTPS project URL from `nampol-document-storage` settings.
  The display name alone is not the project's URL/reference.
- `SUPABASE_SECRET_KEY`: server-only `sb_secret_...` key.
- `SUPABASE_BUCKET`: optional; only `applicant-documents` is accepted.
- `FIREBASE_PROJECT_ID`: optional; only `nampol-recruitment` is accepted.

Never put these credentials in `public/`, browser files, or a file served over
HTTP. Keep Firebase service-account JSON outside the repository; use protected
server environment variables or a secret manager for the Supabase secret.

No dotenv file is read. Existing secrets are not modified. Supabase operations
use a private REST adapter with a server-only apikey header, no redirects, no
environment proxy inheritance, and generic upstream errors. Every operation
checks that the bucket is private; this backend never changes its policies.
Credential values are excluded from configuration repr and startup errors.
Do not enable credential/token logging or SDK HTTP debug logging.

Start from the repository root after supplying configuration:

```powershell
& .\.venv-backend\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8001
```

Visit `http://127.0.0.1:8001/health`. This is a liveness endpoint, not a remote
Firebase/Supabase connectivity test. Startup fails on missing configuration.
CORS allows exactly `http://localhost:8000` and `http://127.0.0.1:8000`.
GET and POST are allowed cross-origin methods. CORS is not authorization.
Never serve credentials from the existing repository-root static HTTP server.

Protected routes in later phases must depend on `current_principal` and invoke
the authorization helpers before invoking the trusted repository/storage client.
Firebase revocation checks also reject disabled accounts. Profiles are fetched
on each authorization check. Admin scope comes from the loaded application.
`serverDocumentSets` is unmatched by the current Firestore rules, so browsers
cannot read/write it. Admin SDK bypasses rules: backend checks remain essential.
The repository creates distinct pending sets using create-only writes and checks
ownership on reads. It never trusts `applicantDocuments` prototype records.

## Malware Scanning

Install and run ClamAV clamd on loopback, maintain its signatures with freshclam,
and supply `CLAMAV_PORT` (usually 3310). Configure StreamMaxLength at least
5242880 bytes, suitable scan limits, and AlertExceedsMax so scan-limit violations
are rejected. Do not expose clamd's unauthenticated TCP port to a network.
The scanner uses bounded INSTREAM messages and a socket timeout. Only the exact
clean response passes. Missing daemon, errors, oversized scan streams, malware,
and missing configuration fail closed. This implementation does not install,
start, or certify the freshness of a scanner. No bypass/test-clean flag exists.

## Endpoints

All document routes require Firebase bearer tokens, verified email, revocation
checks, and current Firestore authorization. No tokens in query strings.

- POST `/api/me/document-sets`: multipart fields `cv`, `identification`,
  `certificate`, each a single file. No other or duplicate fields accepted.
- GET `/api/me/document-sets`: up to 50 owned sets (pagination is not implemented).
- GET `/api/me/document-sets/{setId}`: owned safe metadata.
- GET `/api/me/document-sets/{setId}/{type}/download`: owned ready attachment.
- POST `/api/applications/{applicationId}/document-binding`: JSON containing only
  `setId`; owner-only, ready set, submitted application, immutable binding.
- GET `/api/applications/{applicationId}/documents`: authorized pinned metadata.
- GET `/api/applications/{applicationId}/documents/{type}/download`: authorized
  pinned attachment. Types are `cv`, `identification`, `certificate`.

Upload request bodies are limited to three 5 MiB files plus 64 KiB overhead,
including chunked requests. A 30-second body timeout and two per-process upload
slots bound local concurrency. After authorization, multipart parsing uses
bounded file/field counts and closes temporary files. CVs remain PDF-only.
Detected signatures, strict PDF structure, encryption/active-content rejection,
image parsing/dimension limits, and matching MIME are required after scanning.
Original filenames are discarded; displayed/attachment names are generated.

`backend.documents.DocumentRepository` is the Phase 2A manifest repository.
It stores each new set as pending with all generated paths, then commits ready
state and the success audit in one Firestore transaction after scanning and
storage succeed. Ready versions cannot be replaced through any endpoint.
Bindings live in `serverApplicationDocumentBindings`, are create-only in a
transaction, and do not modify applications or submission/review workflows. Publishing a ready
set now atomically updates `applicantDocuments/{uid}` (root and per-file `setId`,
safe generated metadata, `prototypeMode=false`, `storageMode=server-private`) and
the existing user document flags in the same transaction as ready state and audit.
No storage paths or credentials are copied to the compatibility record.
Both new collections remain browser-denied under the existing rules.

Partial upload failures mark sets failed before deleting generated objects.
Cleanup failure leaves `cleanupRequired=true` and paths for reconciliation.
Ambiguous publish failures never delete a set already committed ready. If the
database is unavailable, pending records retain paths; no file is downloadable.
Success audits are mandatory. Rejection audits are best-effort during outages.
Downloads require a clean ready manifest and matching SHA-256/size, then return
an attachment with no-store/nosniff. Download audits describe authorized/prepared
bytes, not confirmed browser receipt. No public or signed URLs are issued.

## Verification and Limits

Run `python -m unittest discover -s tests -v` using requirements-dev.txt.
Tests use synthetic files, a mocked transactional Firestore implementation,
httpx MockTransport, and a mocked ClamAV socket. They do not access cloud secrets
or services. Real Firebase/Supabase/ClamAV interoperability is still unverified.

Not ready for real sensitive documents or public exposure: scanner signature
freshness and scan-limit configuration require operator verification; document
parsers run in-process without OS CPU/memory isolation; distributed rate limits,
idempotent upload retry keys, pagination, automated orphan reconciliation,
retention/deletion policy, and production monitoring are not implemented.
Retries create separate versions. Crash leftovers require operator cleanup
using server-owned pending/failed manifests, never blanket deletion of ready
objects. No API deletion endpoint is provided.

The existing submission system still trusts prototype flags. They never grant
file access in this API, but cannot prove a submitted application has real files.
Bindings are explicit and only created while status is Submitted; unbound legacy
applications return no stored binding, and reviewed applications cannot be
retroactively bound. A separately reviewed submission/rules migration and automatic application
binding remain necessary; this document-centre integration does not pin new or
existing applications to an immutable set. Keep synthetic sample data only.


## Frontend document upload integration

`Frontend/documents.html` loads `js/documents.js`. All three selections must be
non-empty PDFs up to 5 MiB each. Browser checks are convenience checks only;
FastAPI still validates bytes, scans with ClamAV and uploads to private storage.
The page refreshes the signed-in Firebase applicant's ID token and sends it only
in the Authorization header. FormData fields are exactly `cv`, `identification`,
and `certificate`; the browser sets the multipart boundary. There are no browser
Firestore writes or direct Supabase requests in the document centre.

On localhost/127.0.0.1 the public API origin is the same hostname on port 8001.
Other hosts use same-origin `/api`, requiring an HTTPS reverse proxy to FastAPI.
No secret configuration is accepted by the frontend. The page reconciles owned
sets through GET before enabling POST, shows clean ready IDs from the backend,
and blocks further uploads when a pending set is returned. It disables the form
while uploading, clears successful selections, and never retries POST on its own.
A lost response, timeout, server error or malformed confirmation leaves the
outcome uncertain and requires reload/reconciliation. The API has no durable
idempotency key: cross-tab submissions and retries after reload can still create
separate versions. The list endpoint currently returns at most 50 sets.

Run frontend regression tests without spawning isolated Node worker processes:

```powershell
node --experimental-vm-modules --test --test-isolation=none tests/documents.test.cjs tests/review-security.test.cjs tests/vacancies.test.cjs
```

Tests mock Firebase, network responses, DOM nodes, storage and scanner; no real
applicant files or cloud uploads are used. Firestore emulator tests retain their
separate setup in SECURITY_TESTING.md; rules are unchanged by this integration.

Integration verification: 24 JavaScript tests passed (nine document-centre tests
plus existing review/vacancy regressions). The Firestore integration suite skipped
because FIRESTORE_EMULATOR_HOST was unset. Python discovery ran 50 tests: 46
passed and four Windows symlink tests skipped; all 35 backend/document tests
passed. The final targeted document rerun passed all 25 tests. `git diff --check`
passed. No changes were pushed, no real documents were uploaded, and live cloud
interoperability has not been tested.

For a browser smoke test:

1. Configure server-only Firebase ADC and Supabase environment values described
   above; confirm `applicant-documents` is private and set `CLAMAV_PORT=3310`.
2. Keep the verified clamd daemon running and start/restart FastAPI on loopback
   port 8001 using the command above.
3. Use the secure frontend launcher (never a repository-root static server):
   `& .\.venv-backend\Scripts\python.exe scripts/serve_frontend.py --port 8000`.
   It rebuilds the allowlisted `public/` snapshot. If 8000 is occupied, resolve
   the existing process before browser testing; the API CORS allows port 8000.
   Confirm private paths such as `/.env` and `/app.py` return 403/404.
4. Open `http://127.0.0.1:8000/Frontend/documents.html`, sign in as a verified,
   active applicant with a completed profile, and select three synthetic safe
   PDFs. Confirm a ready set ID appears only after POST returns successfully.
5. Reload and check that the same ID is listed and that the server-written
   applicant record references it. Check offline/rejected-file behavior with
   synthetic files only. Application-specific download/admin UI and automatic
   immutable binding are separate work; existing submission and review remain.


ClamAV task operation (installed with explicit user approval):

```powershell
Get-ScheduledTask -TaskName 'NamPol-ClamAV' | Select-Object TaskName, State
Get-Content "$env:LOCALAPPDATA\ClamAV\logs\runner.log" -Tail 10
Get-Content "$env:LOCALAPPDATA\ClamAV\logs\clamd.log" -Tail 10
```

Task state Running also covers the 60-second retry wait and database loading;
only a live PONG plus scan verifies readiness. If all three runner retries are
exhausted, investigate the recorded exit codes/native log before manually
starting the existing task again. The user-level task is expected to be
independent of VS Code; actual VS Code restart and Windows re-logon/reboot
checks remain manual follow-up. The FastAPI HTTP server remains unstarted;
its existing scanner/validator was tested directly with CLAMAV_PORT=3310.
No applicant documents, Firebase credentials, Supabase credentials, or cloud
uploads were used in these checks. No changes were pushed to GitHub.

## Document upload verification: configuration handoff (20 October 2026)

The documented Uvicorn startup was attempted with CLAMAV_PORT=3310. It exited
with `Backend configuration or credentials are unavailable`; no health response
could be verified. Required GOOGLE_APPLICATION_CREDENTIALS, SUPABASE_URL and
SUPABASE_SECRET_KEY were absent from the process and user/machine environment,
and the standard gcloud ADC file was absent. Only the names/presence of entries
in the legacy .env were inspected: FLASK_SECRET_KEY and FIREBASE_CREDENTIALS.
Their values were not printed, and FastAPI intentionally does not read that file.
Do not bypass startup checks or run a mock-configured backend as the live server.

ClamAV returned PONG and a direct harmless INSTREAM request returned stream: OK.
One initial scan probe timed out; subsequent real-scanner HTTP orchestration
tests passed. The existing Python suite ran 50 tests: 46 passed and four Windows
symlink tests skipped. JavaScript ran 25 tests: 24 passed and the Firestore
emulator integration suite skipped because FIRESTORE_EMULATOR_HOST was unset.
`git diff --check` passed.

New opt-in tests in `tests/test_live_clamav_upload.py` both passed:

- `test_real_scanner_upload_manifest_linkage_and_download`: actual clamd scans
  all three generated PDFs through the FastAPI multipart test client; checks ready
  manifest, matching applicant set IDs, listing and integrity-checked download.
- `test_real_scanner_malformed_pdf_never_reaches_storage`: actual clamd scans
  a harmless malformed PDF; backend rejects it before any storage or metadata
  publication.

These tests deliberately use an explicit test identity and in-memory cloud
fixtures. They verify real scanner integration, not live Firebase authentication,
Firestore persistence, Supabase bucket privacy or live private uploads. Run with:

```powershell
$env:NAMPOL_LIVE_CLAMAV_TEST = '1'
$env:CLAMAV_PORT = '3310'
& .\.venv-backend\Scripts\python.exe -m unittest discover -s tests -p test_live_clamav_upload.py -v
```

The user confirmed a verified active test applicant is available. Three blank,
synthetic PDFs were prepared in `.venv-backend/synthetic-upload/`, marked as
synthetic in PDF metadata. They are Git-ignored and outside the frontend allowlist.
No real applicant documents were used, and no live cloud objects were uploaded.

To configure a dedicated backend PowerShell terminal securely, run the following
from the project root. Obtain the project URL and server secret from the intended
Supabase project's settings; use a Firebase service-account JSON stored outside
the repository. Enter values at the prompts, never in chat or command literals.
The secret prompt is masked and the command history contains no entered values.
These variables are process-local; no configuration file or persistent environment
setting is created. If using ADC instead, omit the service-account prompt.

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS = Read-Host 'Absolute Firebase service-account JSON path outside this repository'
$env:SUPABASE_URL = Read-Host 'Supabase HTTPS project URL'
$supabaseSecret = Read-Host 'Supabase sb_secret_ key' -AsSecureString
$env:SUPABASE_SECRET_KEY = [System.Net.NetworkCredential]::new('', $supabaseSecret).Password
$supabaseSecret.Dispose()
Remove-Variable supabaseSecret
$env:CLAMAV_PORT = '3310'
& .\.venv-backend\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8001
```

Leave that terminal open. Report only startup success or sanitized error text;
never print environment values or credential contents. Remaining live checks:
GET /health, real test-applicant sign-in, the three-file browser POST, backend
confirmation of clean ready state, actual private bucket/object verification,
and matching serverDocumentSets/applicantDocuments/user flags in Firestore.
Browser loading, duplicate-click protection, success display and reload must
also be verified against the configured backend. No production application,
authentication, storage, security-rule or administrator code was changed in
this verification phase; only this documentation and the opt-in test file changed.

### Live service checks after credential configuration

After the user configured the backend privately, GET
`http://127.0.0.1:8001/health` returned 200 with status=ok and phase=2A.
ClamAV returned PONG. The secure frontend launcher was started on 127.0.0.1:8000;
the document page returned 200, while HEAD requests for /.env, /app.py and
/.venv-backend/pyvenv.cfg returned 404. The Chrome page was opened at
http://localhost:8000/Frontend/documents.html and correctly redirected to login
because that browser session was signed out.

Unauthenticated GET and POST /api/me/document-sets returned 401. The localhost
frontend POST preflight returned 200 with the exact allowed origin; an untrusted
origin returned 400 without an allow-origin header. A read-only live Firestore
connection check passed without printing credentials or changing records. An
initial probe used a reserved double-underscore document ID and was corrected;
that diagnostic error did not involve application code or applicant data.

Both opt-in real-ClamAV HTTP orchestration tests passed again. Their cloud
fixtures remain mocked, so they do not certify a live Supabase upload.
The user was asked to sign in privately to the available test applicant; the
computer-use guidance prohibits automating user authentication dialogs.
At this checkpoint no live document POST, Supabase object verification, or
uploaded applicant-set linkage check has been completed. Do not report those
as passed until the signed-in synthetic upload is confirmed and its records
are checked.

After the user signed in, the document page showed an authentication rejection.
Non-synthetic files had been selected; the agent cleared them by reloading and
did not submit them. Reloading force-refreshed Firebase authentication but the
backend still rejected access, so no synthetic upload was attempted yet.
A comparison against Google's public certificate endpoint response Date/Age
suggested the local clock was approximately three seconds behind. W32Time was
Stopped with Manual startup; `w32tm /query /status` returned 0x80070426.
This is a possible cause, not yet proof of the token rejection reason.

`app.py` now logs fixed, credential-free authentication rejection labels through
the `nampol.auth` logger. For example, `reason=server_clock_behind_token`
identifies the SDK's token-used-too-early failure; other labels distinguish
expired/revoked tokens, disabled/missing users and project/issuer mismatches.
No raw token, claims, UID, SDK error text or secret is logged. Response messages,
signature/expiry/revocation checks and clock tolerance are unchanged. Two new
backend tests verify diagnostic usefulness and exclusion of token/SDK details;
all 12 backend tests passed. The user was asked to restart the existing backend
in its privately configured terminal, reload the page and report only the safe
reason label. No Windows time service/settings have been changed.

The subsequent full Python run with live-scanner opt-in executed 54 tests:
49 passed, four Windows symlink tests skipped, and one live malformed-PDF test
failed because scanning returned fail-closed 503 rather than the expected PDF
validation 422. The next live upload test passed. An isolated rerun of both real
ClamAV tests outside sandbox network restrictions passed (2/2). The intermittent
scanner availability failure is recorded, not treated as resolved by a retry;
it has not been reproduced through a live applicant upload because authentication
still blocks that workflow. No changes to scanning or token acceptance policy
were made to force a passing result. Live Supabase storage/privacy and actual
uploaded applicant linkage remain unverified.

### Authentication investigation and clock repair (20 October 2026)

The clock defect is now measured independently of browser authentication:
`w32tm /stripchart /computer:time.windows.com /dataonly /samples:3` returned
+3.987, +3.992 and +3.988 seconds; a later sample was +4.005 seconds. Windows
Time remained Stopped/Manual and its status query returned 0x80070426. Fresh,
uncached Google HTTPS response timestamps corroborated approximately 4–5
seconds of lag (less precise because of network latency and timestamp rounding).
Only the external service-account file's project ID was compared, without
printing its contents; it matches the frontend/backend `nampol-recruitment`.

The actual Firebase SDK was exercised offline using ephemeral RSA keys and
synthetic claims. With the verifier clock four seconds behind issued-at, the
signed token fails with `reason=server_clock_behind_token`; the identical token
passes at its issued-at time, including the SDK's user revocation/disabled check.
Force-refreshing immediately before GET/POST explains why refreshing does not
resolve this clock defect. No clock-skew allowance, expiry grace, sleep/retry
workaround, emulator, or verification bypass was added.

This confirms a reproducible cause, not the historical request's exact label:
no backend/frontend listener or accessible browser session was available during
this investigation. Real test-applicant revocation, current profile permissions,
and deployed IAM permissions could not be checked without that live session.
This tool shell also lacks the privately configured server environment. Do not
infer that the existing dedicated backend terminal has lost its configuration.

`app.py` now returns safe structured authentication errors: expired sessions
remain 401 (`session_expired`); invalid/revoked/disabled sessions remain 401;
clock and project failures return 503 (`auth_clock_error`/`auth_project_error`);
Firebase backend credential/permission errors return 503 (`auth_backend_error`).
Other verification outages remain fail-closed 503. Fixed log labels additionally
identify email verification, owner mismatch, missing profile, wrong applicant
role, inactive account and incomplete profile, without logging identities or
tokens. Applicant authorization remains 403 with unchanged access requirements.

`js/documents.js` distinguishes these backend errors from session expiry and
refresh network/throttling failures. Only explicit authentication errors known
to precede document processing are safe to retry manually without reconciliation;
POST is never automatically retried. Other ambiguous failures retain the existing
reload/reconciliation requirement. All signature, issuer/audience, expiry,
revocation, verified-email and applicant-profile checks remain enforced.

Starting Windows Time was attempted but Windows denied service-control access.
No time or service setting was changed. The underlying OS repair remains pending.
Open PowerShell **as Administrator** and run:

```powershell
Set-Service -Name W32Time -StartupType Automatic
Start-Service -Name W32Time
w32tm /resync
w32tm /query /status
w32tm /stripchart /computer:time.windows.com /dataonly /samples:3
```

Confirm synchronization succeeds and the offset is close to zero. If resync
fails, resolve the Windows time source/network issue before browser testing;
do not increase token tolerance to hide it. Domain-managed machines should use
their organization's time source; no peer/source override is proposed here.

Then restart FastAPI in the privately configured terminal on 127.0.0.1:8001
and restart `scripts/serve_frontend.py --port 8000` so its allowlisted snapshot
contains the changed JavaScript. Keep ClamAV ready on loopback 3310. Open
`http://127.0.0.1:8000/Frontend/documents.html`, sign in privately as the verified,
active test applicant with completed profile, and first confirm GET document
reconciliation succeeds. Only then upload three synthetic PDFs and confirm a
ready set ID survives reload. If authentication still fails, record only the
HTTP status and safe `reason=` label; never copy an Authorization header/token.

Validation: full Python discovery ran 60 tests, 54 passed, six skipped (four
Windows symlink privilege checks and two opt-in live-ClamAV tests). This includes
all 43 authentication/backend/document tests. JavaScript document/review/vacancy
regressions passed 27/27. SDK tests reject expired tokens without grace, invalid
signatures, wrong projects, disabled users and revoked tokens; HTTP tests confirm
authentication failures never invoke upload processing. No cloud uploads,
credential changes, administrator features or GitHub pushes were made.

### Storage readiness and document failure diagnostics

The saved Supabase hostname still failed DNS lookup (Windows error 11001) during
the document-upload investigation. The separately supplied public project URL
resolved, but read-only Auth settings and REST checks rejected the saved key with
401 Invalid API key. These checks do not prove that key is invalid everywhere;
they show it did not authenticate against that supplied project. No key values,
tokens, applicant identifiers or document content were printed. At the start of
the latest inspection neither application server was listening. Firebase and
scanner success from an earlier request therefore must not be confused with
current full live upload readiness.

The launcher now uses `python -m backend.preflight` to check the configured
private bucket before it saves new configuration or starts application servers.
Only a successful read with `public=false` passes. It prints fixed safe codes and
discards raw subprocess errors. `-Configure -SaveCredentials` privately replaces
stale URL/key values, ignoring inherited Supabase values for that launch, while
retaining the existing Firebase path. Replacement configuration is only saved
after successful storage readiness. It does not change bucket settings or rules.

The storage adapter now maps upstream errors to credential-free codes and logs
fixed operation/reason/status labels. Document UI errors explain those codes
instead of hiding every storage failure behind an uncertain-outcome message.
Uploads still require reload/reconciliation after storage failures; no automatic
POST retry or success assertion was added. Secret keys remain apikey headers on
server-side requests. No unverified Authorization-header workaround was added:
the previously supplied project rejected the saved key at Auth/REST endpoints.

Validation: Python discovery ran 63 tests, 57 passed and six skipped (four Windows
symlink checks and two opt-in real-scanner tests). All 28 JavaScript regressions
passed. Both opt-in real-ClamAV multipart tests subsequently passed, exercising
PDF validation, ready publication/linkage and integrity-checked download with
in-memory cloud fixtures. Launcher regression tests passed encrypted storage,
reconfiguration, readiness failure handling, output redaction, credential
isolation, real local server startup and cleanup. Synthetic test servers and
temporary credentials were removed. No live cloud documents were uploaded.

An initial launcher test hit a scanner-readiness failure. Three later PINGs,
three real scans (0.639/0.031/0.024 seconds), the repeated launcher test and both
real-scanner HTTP tests passed. This intermittent availability failure is not
claimed resolved by the subsequent successes. Scanner security/timeouts and
daemon settings were unchanged; a readiness failure still blocks startup.

Live upload completion remains pending a verified matching project URL/key pair
entered privately in the user's terminal. Do not claim Supabase uploads or
cloud-to-applicant linkage passed until an actual synthetic applicant upload
returns ready and survives reload. Existing failed manifests remain untouched.
