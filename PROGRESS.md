# NamPol E-Recruitment progress — 20 October 2026

Development stopped for the night at the user's request. Resume with document
upload diagnosis; do not start MFA or the IT Administrator dashboard yet.

## Implemented and preserved

- Applicant registration, email verification, login, profile and application flows.
- Regional administrator review, matching atomic review audit records, vacancy
  management/public listings, and administrator verification/password-reset UI.
- Secure allowlisted frontend server on loopback port 8000; private project files
  are excluded. Restart it after frontend edits to rebuild the served snapshot.
- FastAPI document API on loopback port 8001: Firebase bearer-token verification,
  current applicant/admin authorization, bounded multipart/PDF validation,
  fail-closed ClamAV scanning, private Supabase adapter and immutable document sets.
- Document page submits `cv`, `identification`, `certificate`, waits for a clean
  ready backend response, blocks duplicate/uncertain retries and displays set IDs.
- Publishing atomically links safe metadata and set IDs into applicantDocuments
  and updates existing user document flags. Application-specific binding remains
  explicit; it is not automatically performed during application submission.
- Approved Windows task `NamPol-ClamAV` installed. Hidden current-user runner logs
  exits and retries up to three times, 60 seconds apart. Recovery/PONG/scanning
  passed earlier; database startup can take two to three minutes.

## Verified results and unresolved issues

- Latest shutdown checkpoint: Python 48 passed, six skipped (four Windows symlink
  checks and two opt-in live-ClamAV tests). JavaScript 24 passed; one Firestore
  emulator suite skipped because the emulator is not configured. Diff checks pass.
- Earlier live checks passed: /health 200, ClamAV PONG, read-only Firestore access,
  unauthenticated document requests 401, correct-origin CORS and private-file 404s.
- Browser upload remains blocked by FastAPI rejecting the applicant's refreshed
  token. The exact rejection cause is NOT confirmed. Safe `reason=...` diagnostics
  were added to app.py; no token/claim/credential values or SDK messages are logged.
- Local time appeared about three seconds behind Google's HTTP response time;
  Windows Time was stopped. Clock drift is only a hypothesis. No time settings,
  authentication tolerance or credential values were changed.
- One earlier full live-scanner run had 49 passes, one fail-closed scanner 503 and
  four skips; isolated real-scanner tests subsequently passed 2/2. Intermittency
  is unresolved. Those tests use real clamd but in-memory cloud/auth fixtures.
- No agent-performed live applicant upload has succeeded. Actual Supabase object
  privacy, uploaded Firestore linkage and dashboard success remain unverified.
  Non-synthetic browser selections were cleared without submission by the agent.
- Actual Console/Network inspection was interrupted twice by physical Escape.
- Firestore emulator/rules enforcement and deployed-rule state require checking.
  Some older README/testing descriptions reflect earlier prototype stages.

## Exact next steps

1. In the existing credential-configured backend terminal, restart if it has not
   loaded the latest diagnostics: Ctrl+C, then
   `& .\.venv-backend\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8001`.
   Keep credentials private; see BACKEND.md if the process environment was lost.
2. Confirm /health 200 and ClamAV PONG. Use the secure frontend launcher only:
   `& .\.venv-backend\Scripts\python.exe scripts/serve_frontend.py --port 8000`.
   Do not start duplicates or serve the repository root.
3. Sign in privately as the available verified, active test applicant with a
   completed profile. Reload `/Frontend/documents.html`; inspect the failed
   request's status/response, Console and backend's safe `reason=...` label.
   Do not copy bearer headers, passwords, keys or credential JSON into chat/logs.
4. Fix the confirmed authentication cause. If clock drift is confirmed, obtain
   approval before starting/resynchronizing Windows Time or other system changes.
   Keep signature, issuer, audience, expiry and revocation checks intact.
5. Select only `.venv-backend/synthetic-upload/synthetic-cv.pdf`,
   `synthetic-identification.pdf` and `synthetic-certificate.pdf`. Submit once.
   Verify real POST success, three clean scans, private stored objects, a ready
   serverDocumentSets record and matching applicantDocuments/user state.
6. Reload the document page and applicant dashboard; verify the same set ID and
   successful-upload state. Investigate any scanner 503 without bypassing scans.
7. Run relevant regressions and the Firestore emulator suite when available;
   record live evidence separately from mocked tests. No GitHub push is authorized.

Credentials, local logs, virtual environments and generated public/test artifacts
are preserved locally. This checkpoint adds no features or credential changes.
