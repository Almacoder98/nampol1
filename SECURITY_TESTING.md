# Regional authorization and atomic review auditing

## Latest emulator verification — 22 October 2026

The current `firestore.rules` compiled and passed the real Firestore REST integration suite in the isolated `demo-nampol-security` project: **12 tests passed, 0 failed, 0 skipped** (11 scenario groups plus the parent test). The emulator stopped successfully after the run. These results supersede the earlier Java/emulator limitation recorded below.

Verified through client-authenticated direct REST requests:

- An applicant with no documents cannot submit, including when claiming `documentsValidated: true`.
- Missing individual PDFs, an empty document map, pending/failed sets, foreign ownership, unsupported schema, non-PDF files, infected/failed/pending scans, empty files and files above 5 MiB all prevent submission (26 invalid manifests tested).
- A server-owned `ready` manifest containing all three clean PDFs allows submission and reuse. The stored state value is lowercase `ready`.
- Missing, nonexistent or malformed set IDs and legacy metadata flags cannot bypass the requirement. Clients cannot create/update manifests, create a manifest alongside an application in an atomic batch, or replace a submitted document reference; administrators cannot replace that reference either.
- Regional and super-admin review start/approval/denial and atomic audit enforcement remain functional. Invalid/replayed/modified/deleted audits and unauthorized review attempts remain denied.
- Applicant registration, own-profile reads/allowed edits, own-application reads and public vacancy behavior remain functional. Cross-applicant reads, role escalation, completed-profile region changes, unverified submissions and impersonated submissions remain denied.

Related JavaScript regression suites also passed: **46 tests, 0 failures, 0 skips** across `application-documents`, `documents`, `profile`, `review-security` and `vacancies`. These exercise client behavior with mocks; the 12 tests above exercise actual emulator rules. No live Firebase deployment or file-scanner validation was performed in this run.

The existing temporary Temurin Java 21.0.12.1+1 runtime and Firestore emulator 1.22.0 were used with Firebase CLI 15.32.1 and Node 24.20.0. Run from a fresh PowerShell process so all assignments remain process-local:

```powershell
$env:JAVA_HOME = Join-Path $env:TEMP 'nampol-firestore-test-tools\jdk-21.0.12.1+1-jre'
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
$env:FIREBASE_EMULATORS_PATH = Join-Path $env:TEMP 'nampol-firestore-test-tools\emulators'
$env:XDG_CONFIG_HOME = Join-Path $env:TEMP 'nampol-firebase-validation'
$env:CI = 'true'
$env:DEBUG = ''
firebase.cmd emulators:exec --only firestore --project demo-nampol-security --config firebase.security-tests.json "node --test --test-isolation=none tests/firestore-security.test.cjs"
```

No installer, registry changes, persistent PATH/JAVA_HOME edits, deployment, or GitHub push were used. The sandbox initially blocked the CLI's Java child process; the successful local emulator runs used approved execution outside that process restriction. The final run output is in `%TEMP%\nampol-firestore-test-tools\security-test-results-2026-10-22.log`; Firebase refreshed the ignored `firebase-debug.log` and `firestore-debug.log` files in the project.

This verification changed only `tests/firestore-security.test.cjs` and this testing document, in addition to generated logs/temporary CLI state. Existing worktree edits were preserved, and the security rules were not edited or weakened. Tested rules SHA-256: `DD05A53AB2ED3D0F35AC7CD7A865A922E582B2C159586F3D940C190EB571ACA6`.

**Deployment is still required to activate the updated local rules in Firebase.** These tests load the local rules into an emulator only; they do not update or inspect production rules. Deploy the reviewed `firestore.rules` when authorized, unless that exact version has already been deployed separately. Nothing was deployed here.

## Changes

- `firestore.rules`: applicants retain signed-in access to their own profiles. Verified active regional administrators can read applicant profiles only in their stored region; super administrators retain access across regions. Regions used by the shared review/document helper must be nonempty strings.
- Each application review update now requires a fresh audit record in the same commit, using `getAfter()`. Canonical IDs are `<applicationId>__REVIEW_STARTED`, `<applicationId>__APPLICATION_APPROVED`, and `<applicationId>__APPLICATION_DENIED`.
- The application update checks event identity, actor/staff number, applicant, region, action, reason and server timestamp. Audit creation separately checks the exact event schema, application reference, and the application's before/after status. Audit-only writes, updates without logs, arbitrary log IDs, replayed logs, and modified/deleted logs are denied.
- `js/admin.js`: both review transactions now use these canonical audit IDs. Review start and final decision remain two-write atomic transactions, with no new application fields or submission changes. Existing historical random-ID logs remain readable and immutable; no migration or backfill is needed for ordinary existing applications.
- Document-access audit records must name an existing applicant profile and document metadata record. The entity ID must equal the applicant UID, the recorded region must equal the profile's actual region, and the administrator must be authorized for that region. Actor identity/role, exact schema, and server timestamp are validated. Super administrators may log access across regions but must still record the correct target region.
- Vacancy code and the jobs rule block, registration, submission, and document upload logic were not changed. Existing unrelated edits were preserved.

## Limits of client access auditing

Firestore rules cannot prove a read occurred, force a client read to create a log, or prove a human viewed a document. An authorized client can submit an access event without reading, or perform an allowed read without logging. These events remain client-reported access claims, with validated identity and scope. They are not proof of file download or viewing. Stronger access auditing requires routing access through a trusted server that authorizes and records the operation before returning the data. Even server delivery does not prove human viewing.

Server/Admin SDK operations bypass Firestore rules; trusted services must maintain their own authorization and audit invariants. The existing backend document-download path already performs authorization and server-owned audit logging and was left unchanged. Review-transition enforcement here applies to Web/mobile client writes governed by these rules.

## Tests

Client regression tests (no new npm dependencies):

```powershell
node --experimental-vm-modules --test --test-isolation=none tests/vacancies.test.cjs tests/review-security.test.cjs tests/firestore-security.test.cjs
```

The review tests execute the actual transaction functions with mocked Firebase APIs and check matching atomic writes, invalid states/regions/reasons, and super-administrator scope. Vacancy tests cover publishing and its existing query constraints. The REST integration suite skips explicitly when `FIRESTORE_EMULATOR_HOST` is unset; a skipped suite does not validate rules enforcement.

Python backend/document tests:

```powershell
.venv/Scripts/python.exe -m unittest discover -s tests -p 'test_*.py'
```

Real Firestore rules integration (Java and Firebase CLI required):

```powershell
firebase emulators:exec --only firestore --project demo-nampol-security --config firebase.security-tests.json "node --test --test-isolation=none tests/firestore-security.test.cjs"
```

Use the isolated `demo-nampol-security` emulator project. The suite seeds test data with the emulator owner credential; never point it at production. It checks profile authorization; missing/mismatched/standalone/immutable review logs; both final decisions; regional/applicant denial; super-administrator access; forged document-access targets/regions/entities/actors; and registration, submission, and vacancy behavior.

## Results from this session

- JavaScript: 13 tests passed, zero failures. One real Firestore integration suite was skipped because `FIRESTORE_EMULATOR_HOST` is unset. Java is not available, so the emulator/compiler checks were not run.
- Rules delimiter checks and `git diff --check` passed; structural checks do not replace Firebase compilation or authorization testing.
- Python unittest discovery failed to import both existing suites. System Python lacks `pypdf`; the existing `.venv` lacks `PIL` (Pillow). An attempt to install the pinned Pillow/pypdf dependencies into `.venv` failed because pip could not resolve `Pillow==12.2.0` from the configured package source. No backend test cases executed. Requirements and backend functionality were left unchanged.
- Browser/manual Firebase checks remain outstanding. In particular, verify profile region boundaries and actual atomic-write enforcement with the emulator suite before deployment.

For future regional collection queries against `users`, include both `role == "applicant"` and `region == admin.region`; direct owner reads remain allowed without those query filters. No administrator `users` collection query was present in the inspected dashboard code.

Firebase documents the atomic validation mechanism at https://firebase.google.com/docs/firestore/manage-data/transactions#data_validation_for_atomic_operations.

## Rollout

Nothing has been deployed or pushed. Deploy the reviewed complete rules file and updated `js/admin.js` together when authorized; old cached clients using random audit IDs will have review transitions rejected by the new rules and must reload. Test real rules with the emulator and verify the browser review and regional-access flows before deployment. These changes do not retrofit missing historical logs.
