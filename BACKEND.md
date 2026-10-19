# Phase 2A Backend

Python 3.12 or newer is recommended for the full local test suite. The dedicated
`.venv-backend/` environment is isolated from global site-packages and excluded
from Git. It is outside the generated `public/` directory and is never included
in the secure frontend server's allowlist. Frontend integration is not enabled.
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

ClamAV was not detected on PATH, in the checked standard install locations, or
as a Windows service. Loopback port 3310 was unreachable and `CLAMAV_PORT` was
unset. A direct scanner availability check returned HTTP 503 as expected;
malware scanning has not been bypassed. Install/configure the native daemon and
verify its signatures and limits before attempting real uploads.

Before supplying credentials, confirm the actual frontend process on port 8000
returns 403/404 for private paths. A header-only check during this preparation
returned HTTP 200 for `/.env`, `/app.py`, and `/.venv-backend/pyvenv.cfg`, which is
not the secure launcher's expected behavior. No secret contents were fetched or
printed and the running server was not changed. Resolve the serving boundary
before using sensitive files. No frontend integration or live cloud upload was
performed.

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
transaction, and do not modify applications or submission/review workflows.
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
retroactively bound. A separately reviewed submission/rules migration and
frontend integration remain necessary. Keep synthetic sample data only.
