# Vacancy verification and deployment

## Diagnosis

The current regional dashboard query already includes `where("region", "==", currentAdmin.region)`. The public `getOpenJobs()` query already requires both `status == "Open"` and `published == true`. These constraints match the local `/jobs/{jobId}` rules. An unfiltered regional query would be denied; only super administrators use an unfiltered query.

The `/jobs` rule block was already a local, uncommitted addition when this investigation began. If Firebase still has the earlier rules without that block, reads and writes to jobs are denied. This is the leading deployment explanation, not a verified observation of the live project. Deployed rules and Khomas001's live authentication/admin record were not accessible during this investigation.

Other denial causes include an old email-verification token, a missing admin document, inactive status, an invalid role, or mismatched account/region values. Staff number `Khomas001` is a display identifier: the document must be `admins/{Firebase Auth UID}`, not `admins/Khomas001` unless those are actually identical.

The existing publishing form also cleared its region after every successful submission and permitted regional users to type a different region. The dashboard now restores and locks the assigned region, uses the stored admin region in writes, and refreshes email-verification claims before listing vacancies. Edit, publish/unpublish, close/reopen, and existing delete actions retain server-side authorization. Region and creation timestamp are preserved on edits.

## Files changed for this fix

- `Frontend/admin.html`: vacancy form, queries, controls, error handling, and Manage Vacancies shortcut.
- `firestore.rules`: only the jobs block; explicit administrator/public read branches and all eight required creation keys. Other collections' rules were left as found.
- `tests/vacancies.test.cjs`: isolated vacancy regression tests using mocked Firebase and DOM APIs.
- `VACANCY_TESTING.md`: this diagnosis and verification guide.

`Frontend/index.html` and `js/jobs.js` were inspected and left unchanged because they already request only published, open vacancies. Existing unrelated working-tree changes were preserved.

## Automated checks completed

Run from the project root with Node 24:

```powershell
node --experimental-vm-modules --test --test-isolation=none tests/vacancies.test.cjs
```

All eleven vacancy tests pass. They cover regional/super-admin query construction, invalid account scope, unverified tokens, repeated publishing and tampered region inputs, super-admin publishing, editing and visibility/status updates, retryable permission errors, public query constraints, and parsing the dashboard/homepage inline scripts and jobs module. `git diff --check` also passes.

These are mock-based client tests, not Firestore rule execution or browser integration tests. The Firestore emulator was not run because Java is unavailable in this environment. Live Firebase, rule compilation, and browser rendering still require verification.

## Deployment and manual verification still required

1. Review the complete local `firestore.rules` before deployment: it contains other pre-existing local changes beyond this fix. Deploy the reviewed Firestore rules to the same project used by `js/firebase-config.js` (`nampol-recruitment`). No deployment or GitHub push was performed. A manual CLI command is `firebase deploy --only firestore:rules --project nampol-recruitment`.
2. In Firebase Authentication, verify Khomas001's actual email account is verified. In `admins/{that account's UID}`, check boolean `active: true`, role exactly `admin` or `recruiter`, and region exactly `Khomas`. For super administrators use `role: "super_admin"`; they can manage all regions without an assigned region. Do not grant applicants an admin record or role.
3. Sign out and sign in again. Khomas001 should see only Khomas vacancies, including unpublished and closed ones. Publish twice consecutively; verify the region remains Khomas and both writes succeed.
4. Edit a vacancy's title, description, and requirements. Close/reopen and unpublish/publish it. Confirm its region and `createdAt` never change. Test that a failed operation leaves the action button usable.
5. As a regional administrator, attempt another-region queries and writes through a test client or the emulator; they must be denied for private vacancies and all writes. Published open vacancies remain publicly readable across regions by design. Check that applicants, unverified users, and inactive admins cannot write jobs.
6. As a verified active super administrator, list all jobs and create/update/close vacancies in both Khomas and Erongo. As a regional admin without a region, management should be disabled.
7. Open `Frontend/index.html` in a signed-out/private browser. Only vacancies with BOTH `published: true` and `status: "Open"` should appear after reloading. Close or unpublish a vacancy, reload the homepage, and verify it disappears. These pages use one-time reads, so changes appear on reload rather than through a live subscription.
8. Verify the application/document/review flows still behave normally; they were not modified by this fix.


## Latest publishing-error verification

- The live HTTP responses at `http://localhost:8000/Frontend/admin.html` and `http://localhost:8000/js/firebase-config.js` match the workspace files byte for byte. Firebase configuration uses project `nampol-recruitment` and its default Firestore database.
- Regional vacancy queries use `where("region", "==", currentAdmin.region)`; only super administrators list all jobs. Creation writes exactly the eight fields allowed by the jobs rules, with `status: "Open"`, `published: true`, and server timestamps. Both listing and form submission force an ID-token refresh and require `email_verified: true`.
- No remaining local vacancy code/rules mismatch was found, so production code and rules were left unchanged in this verification. Only this guide was updated.
- Missing `/jobs/{jobId}` in the previously deployed rules explains the earlier permission error. If that version is still deployed, it must be replaced with the reviewed local rules. The currently deployed version and live Khomas001 account were not available for inspection; persistent errors after deployment require checking the account configuration below.
- Latest combined JavaScript run: 15 passed, zero failed; one real Firestore integration suite skipped because no emulator is running. Syntax and `git diff --check` passed. Firebase CLI 15.32.1 was invoked against the isolated demo emulator project, but rule compilation did not start: the CLI could not spawn `java -version` (EPERM), and Java was not found on PATH. This is a tooling failure, not a reported rules compiler error.

### Manual deployment commands (not executed)

Run these in PowerShell. Using `firebase.cmd` avoids PowerShell script execution-policy problems. Explicit `--project` avoids depending on a project alias.

```powershell
Set-Location -LiteralPath 'C:\Users\Makomo\OneDrive\Desktop\Nampol recruitment'
firebase.cmd login
firebase.cmd projects:list
firebase.cmd deploy --only firestore:rules --project nampol-recruitment --config firebase.json
```

Confirm `nampol-recruitment` is listed under the intended Firebase account. The last command replaces the complete deployed Firestore rules with the local `firestore.rules`; it does not deploy Storage rules, Hosting, or indexes. Review the full rules file, including earlier regional-profile and atomic-review-audit changes, first. No commands here deploy automatically.

### Check Khomas001 and publish the requested vacancy

1. In Firebase Console, select `nampol-recruitment`, then Authentication > Users. Find the account/email used to log in as Khomas001; copy its Firebase Authentication UID and confirm email verification.
2. In Firestore Database > Data, open `admins/{that UID}`. The document ID must be the Auth UID, not merely the staff number. Check `staffNumber: "Khomas001"`, boolean `active: true`, role exactly `"admin"` or `"recruiter"`, and region exactly `"Khomas"`. Keep the actual authorized role; do not promote a regional administrator to super admin to bypass an error.
3. After manually deploying the rules, sign out and in, then hard-reload the dashboard. Both list loading and publishing already refresh the verified token. Confirm Khomas vacancies load without a permission error.
4. In Manage vacancies, enter title `Cadet constable`. The region should remain locked to `Khomas`. Enter a description, such as `Cadet constable recruitment in Khomas.`, and the actual requirements (or leave requirements empty). Click Publish vacancy once and wait for the success message.
5. In Firestore, confirm the new jobs document has title `Cadet constable`, region `Khomas`, status `Open`, published boolean `true`, description and requirements strings, and populated `createdAt`/`updatedAt` timestamps. Confirm it appears in Current vacancies.
6. Open `http://localhost:8000/Frontend/index.html` in a private window and reload. `Cadet constable` should appear under Open vacancies. The homepage uses one-time reads, so reload after changes.
7. Close or unpublish the vacancy in the admin dashboard, reload the private homepage, and confirm it disappears. Reopen and publish it again if it should remain public.
8. If access is still denied after successful rules deployment, inspect the Console's current Rules tab and recheck UID, verification, boolean active, exact role, and case-sensitive region. These steps distinguish a rules deployment issue from administrator authorization. Do not relax the rules.
