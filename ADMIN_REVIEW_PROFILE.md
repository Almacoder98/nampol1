# Applicant profile and document review

The application table now has a **Review Profile & Documents** button. Its modal
opens immediately, with independent loading for the current applicant profile,
original application PDFs, advisory screening and notification state. A missing
profile or unavailable backend does not prevent the modal from opening.

The profile shows name, email, cell phone, address, date of birth, gender, region,
highest qualification, employment status, skills and recorded academic points.
The original submitted application remains a separate snapshot. Contact details
are applicant-provided; a profile phone number is not proof of identity.
ID numbers and unrelated private profile fields are not copied into this API.
The authorized identification PDF remains available through the private viewer.

Inside Review, use **Applicant Profile**, **View Documents** or **Screen CV** to jump to the corresponding section. View CV, Qualifications and
Identification use the original bound document set. Missing historical PDFs
cannot be reconstructed from metadata, and a newer set is never substituted.
Document-service errors now distinguish expired login, denied access, missing
original files/bindings and unavailable backend/storage services.

**Screen CV** compares only the selected application's protected CV PDF with
the linked published vacancy requirements. Local FastEmbed sentence embeddings
are used when available; the report labels the token-overlap fallback otherwise.
Each criterion shows a redacted possible excerpt or needs manual verification.
Missing or scanned PDFs and missing criteria are called out explicitly. The
analysis is local, sends no CV text to an external AI service, and does not
change the application or make a hiring decision.

## Both kinds of points

- Applicant Profile has an optional **Academic / qualification points** field.
  It accepts a non-negative whole-number total or a blank value. It does not
  calculate points from grades or invent a qualification equivalence policy.
  Applicants can edit/clear it; administrators see it as **applicant-declared**
  and must verify it against the qualification PDF. Old profiles show Not recorded.
- Automated CV screening shows possible evidence excerpts and requirements
  needing manual verification. It is advisory, separate from academic points,
  and never approves or rejects an application. No eligibility score is shown.

Existing profile updates do not write the new field unless its value changes,
so ordinary edits on old profiles need no migration or default-field write.

## Authorization and operations

`GET /api/admin/applications/{id}/profile` requires verified Firebase email
authentication and an active administrator profile. Regional authorization is checked against both the application and the
profile. Super administrators retain cross-region access. Applicants cannot use
this administrator endpoint. Responses are `no-store`, allowlisted and audited
as `APPLICANT_PROFILE_VIEWED` without copying contact details into the audit.
Modal closure, application changes and account changes discard stale responses
and clear displayed profile data.

The only rules change permits the authenticated applicant to update their own
optional `academicPoints` to null or a non-negative integer. Administrator fields,
roles, regions, documents, applications, decisions and audit protections are
unchanged. Attempts by other applicants/admins, unverified sessions,
invalid values or combined role escalation are rejected in the emulator.

**No deployment was performed.** The updated rules must eventually be approved
and deployed with the compatible client before applicants can save changed
academic points against live Firebase. Keep the coordinated admin rollout
requirements. Real SMTP delivery remains pending. No genuine records were read
or changed by these tests.

To load the local source changes, stop old servers with Ctrl+C in their own
terminals and run from the project root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start_nampol.ps1
```

Then hard-refresh the administrator page and choose Review Profile & Documents.
Restarting loads local code; it does not deploy rules or
recover missing historical files. No existing server was stopped during this work.

## Files changed in this review enhancement

Final regression results: **240 passed, zero failed, six existing Python skips**:
133 Python passes (139 collected), 86 JavaScript passes and 21 Firestore emulator
passes. Fifteen focused checks were added. The emulator's first startup timed
out before tests; the isolated retry completed all 21 checks successfully.
Final client checks were repeated after the compatibility fix that omits
unchanged academic-points fields from ordinary profile saves.

- `Frontend/admin.html`, `Frontend/profile.html`.
- `app.py`, `firestore.rules`.
- `js/review-profile.js`, `js/review-documents.js`, `js/screening.js`, `js/profile.js`.
- `scripts/serve_frontend.py` (allowlist the new public module).
- `tests/test_review_profile.py`, `tests/review-profile.test.cjs`,
  `tests/profile.test.cjs`, `tests/screening.test.cjs`,
  `tests/firestore-security.test.cjs`, `tests/test_phase4_contract.py`.
- This guide. Local results/hashes are in `.nampol/admin-profile-*.log` and
  `.nampol/admin-profile-evidence.json`; earlier Phase 4 evidence is historical.

All earlier development changes were preserved. No billing, real messages,
genuine applicant decisions, deployments or GitHub pushes were performed.
