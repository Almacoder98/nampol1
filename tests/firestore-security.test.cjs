// Real rules tests. Requires a running Firestore emulator loaded with firestore.rules.
// Native REST calls keep this suite independent of additional npm dependencies.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const host = process.env.FIRESTORE_EMULATOR_HOST;
const project = process.env.GCLOUD_PROJECT || 'demo-nampol-security';
const database = `projects/${project}/databases/(default)`;
const prefix = `${database}/documents`;
const serverTime = 'SERVER_TIME';
function token(uid, verified = true) {
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
        sub: uid, user_id: uid, aud: project, iss: `https://securetoken.google.com/${project}`,
        iat: now, exp: now + 3600, auth_time: now, email_verified: verified,
        firebase: { sign_in_provider: 'password' }
    })}.`;
}
function value(v) {
    if (v === null) return { nullValue: null };
    if (typeof v === 'string') return { stringValue: v };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') return { integerValue: String(v) };
    return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, item]) => [k, value(item)])) } };
}
function write(name, data, patch = false) {
    const entries = Object.entries(data);
    const result = { update: { name: `${prefix}/${name}`, fields: Object.fromEntries(entries
        .filter(([, v]) => v !== serverTime).map(([k, v]) => [k, value(v)])) } };
    const transforms = entries.filter(([, v]) => v === serverTime)
        .map(([k]) => ({ fieldPath: k, setToServerValue: 'REQUEST_TIME' }));
    if (transforms.length) result.updateTransforms = transforms;
    if (patch) {
        result.updateMask = { fieldPaths: entries.filter(([, v]) => v !== serverTime).map(([k]) => k) };
        result.currentDocument = { exists: true };
    }
    return result;
}
async function request(endpoint, body, identity = 'owner', method = 'POST') {
    const response = await fetch(`http://${host}/v1/${endpoint}`, {
        method, headers: { Authorization: `Bearer ${identity}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {})
    });
    const text = await response.text();
    return { status: response.status, text };
}
const rawCommit = (writes, identity) => request(`${database}/documents:commit`, { writes }, identity);
function submissionExtras(id, data) {
    return [write(`serverApplicationDocumentBindings/${id}`, { applicationId: id, ownerUid: 'alice', setId: data.documentSetId || 'a'.repeat(32), boundAt: serverTime }),
        write(`auditLogs/${id}__DOCUMENT_SET_BOUND`, { action: 'DOCUMENT_SET_BOUND', actorUid: 'alice', actorRole: 'applicant',
            applicationId: id, setId: data.documentSetId || 'a'.repeat(32), region: data.region || 'Khomas', timestamp: serverTime })];
}
// Fixtures and normal submission tests include the now-mandatory atomic binding.
// rawCommit is used below to test attempts to omit or corrupt that protocol.
function commit(writes, identity) {
    const extras = [];
    for (const entry of writes) {
        if (entry.update?.name.startsWith(`${prefix}/applications/`) && !entry.updateMask) {
            const id = entry.update.name.split('/').at(-1);
            const fields = entry.update.fields;
            extras.push(...submissionExtras(id, { documentSetId: fields.documentSetId?.stringValue, region: fields.region?.stringValue }));
        }
    }
    return rawCommit([...writes, ...extras], identity);
}
const allowed = result => assert.equal(result.status, 200, result.text);
const denied = result => assert.equal(result.status, 403, result.text);
const admin = token('khomas-admin');
const superAdmin = token('super-admin');
const staffCodeId = number => createHash('sha256').update(number).digest('hex');
function adminFixtures(uid, role, staffNumber, region = 'Khomas') {
    const codeId = staffCodeId(staffNumber);
    return [write(`admins/${uid}`, { role, region, active: true, staffNumber, provisioningVersion: 1, staffCodeId: codeId }),
        write(`adminStaffCodes/${codeId}`, { uid, staffNumber, state: 'active' })];
}
function application(region = 'Khomas', aiScreeningConsent = false) {
    return { applicantId: 'alice', applicationReference: 'NAMPOL-2026-TEST01', region, status: 'Submitted',
        documentSetId: 'a'.repeat(32), submittedAt: serverTime, updatedAt: serverTime,
        aiScreeningConsent, aiScreeningConsentAt: aiScreeningConsent ? serverTime : null,
        aiScreeningConsentVersion: aiScreeningConsent ? 'openai-cv-review-v1' : null,
        reviewStartedAt: null, reviewedAt: null, reviewedBy: null, reviewedByStaffNumber: null, decisionReason: null };
}
function readyDocuments(id = 'a'.repeat(32)) {
    return { setId: id, ownerUid: 'alice', schemaVersion: 1, state: 'ready', documents:
        Object.fromEntries(['cv', 'certificate', 'identification'].map(kind => [kind,
            { fileName: `${kind}-synthetic.pdf`, fileSize: 100, mimeType: 'application/pdf', scanStatus: 'clean' }])) };
}
function transition(id, status = 'Under Review', uid = 'khomas-admin', region = 'Khomas') {
    const starting = status === 'Under Review';
    const action = starting ? 'REVIEW_STARTED' : status === 'Approved' ? 'APPLICATION_APPROVED' : 'APPLICATION_DENIED';
    const staffNumber = uid === 'super-admin' ? 'SUPER001' : 'KHOMAS001';
    const reason = starting ? '' : 'Decision reason';
    const fields = { status, reviewedBy: uid, reviewedByStaffNumber: staffNumber, updatedAt: serverTime,
        ...(starting ? { reviewStartedAt: serverTime } : { reviewedAt: serverTime, decisionReason: reason }) };
    const writes = [write(`applications/${id}`, fields, true), write(`auditLogs/${id}__${action}`, {
        action, adminId: uid, staffNumber, applicationId: id, applicationReference: 'NAMPOL-2026-TEST01',
        applicantId: 'alice', region, reason, timestamp: serverTime
    })];
    if (!starting) {
        const notificationId = `${id}__${status}`;
        writes.push(write(`notificationOutbox/${notificationId}`, { applicationId: id, applicantId: 'alice',
            applicationReference: 'NAMPOL-2026-TEST01', region, status, state: 'pending', createdAt: serverTime }),
            write(`auditLogs/${notificationId}__queued`, { action: 'NOTIFICATION_QUEUED', actorUid: uid,
                applicationId: id, notificationId, region, timestamp: serverTime }));
    }
    return writes;
}
function documentEvent(target, region, extra = {}) {
    return { actorUid: 'khomas-admin', actorRole: 'admin', action: 'admin.documents_accessed',
        entityType: 'applicantDocuments', entityId: target, targetApplicantId: target, region,
        createdAt: serverTime, ...extra };
}

test('Firestore security integration (emulator required)', { skip: !host && 'FIRESTORE_EMULATOR_HOST is not set' }, async t => {
    allowed(await commit([
        ...adminFixtures('khomas-admin', 'admin', 'KHOMAS001'),
        ...adminFixtures('super-admin', 'super_admin', 'SUPER001'),
        write('admins/inactive', { role: 'admin', region: 'Khomas', active: false }),
        write('users/alice', { uid: 'alice', role: 'applicant', region: 'Khomas', accountStatus: 'active', profileCompleted: true }),
        write('users/bob', { uid: 'bob', role: 'applicant', region: 'Erongo' }),
        write('applicantDocuments/alice', { applicantId: 'alice', documentsValidated: true }),
        write('applicantDocuments/bob', { applicantId: 'bob', documentsValidated: true }),
        write(`serverDocumentSets/${'a'.repeat(32)}`, readyDocuments())
    ]));
    await t.test('profile ownership, regional boundaries, active and verified admin checks', async () => {
        allowed(await request(`${prefix}/users/alice`, null, token('alice'), 'GET'));
        denied(await request(`${prefix}/users/alice`, null, token('alice', false), 'GET'));
        allowed(await request(`${prefix}/users/alice`, null, admin, 'GET'));
        denied(await request(`${prefix}/users/bob`, null, admin, 'GET'));
        denied(await request(`${prefix}/users/bob`, null, token('alice'), 'GET'));
        allowed(await request(`${prefix}/users/bob`, null, superAdmin, 'GET'));
        denied(await request(`${prefix}/users/alice`, null, token('inactive'), 'GET'));
        denied(await request(`${prefix}/users/alice`, null, token('khomas-admin', false), 'GET'));
    });
    await t.test('verified password sessions access data without an extra claim', async () => {
        const passwordOnly = token('alice');
        allowed(await request(`${prefix}/users/alice`, null, passwordOnly, 'GET'));
        allowed(await request(`${prefix}/applicantDocuments/alice`, null, passwordOnly, 'GET'));
        denied(await request(`${prefix}/admins/khomas-admin`, null, passwordOnly, 'GET'));
        denied(await commit([write('users/alice', { phone: 'forged' }, true)], passwordOnly));
    });
    await t.test('public registration cannot mint admins, provisioning records, staff reservations or privileged flags', async () => {
        const attacker = token('attacker');
        denied(await commit([write('admins/attacker', { role: 'super_admin', active: true })], attacker));
        denied(await commit([write('adminProvisioning/attacker', { role: 'super_admin', codeDigest: 'forged' })], attacker));
        denied(await commit([write(`adminStaffCodes/${staffCodeId('ATTACKER')}`, { uid: 'attacker', state: 'active' })], attacker));
        denied(await commit([write('users/attacker', { uid: 'attacker', role: 'admin', accountStatus: 'active', profileCompleted: false })], attacker));
        denied(await commit([write('users/attacker', { uid: 'attacker', role: 'applicant', accountStatus: 'active', profileCompleted: false, provisioningVersion: 1 })], attacker));
        allowed(await commit([write('adminProvisioning/it-reserved', { state: 'pending' })]));
        denied(await commit([write('users/it-reserved', { uid: 'it-reserved', role: 'applicant', accountStatus: 'active', profileCompleted: false })], token('it-reserved')));
        denied(await request(`${prefix}/adminStaffCodes/${staffCodeId('KHOMAS001')}`, null, admin, 'GET'));
        denied(await request(`${prefix}/adminProvisioning/it-reserved`, null, superAdmin, 'GET'));
    });
    await t.test('legacy and mismatched staff grants do not confer regional or super-admin authority', async () => {
        allowed(await commit([write('admins/legacy', { role: 'super_admin', active: true }),
            ...adminFixtures('mismatch', 'admin', 'WRONG001')]));
        allowed(await commit([write(`adminStaffCodes/${staffCodeId('WRONG001')}`, { uid: 'someone-else' }, true)]));
        denied(await request(`${prefix}/users/alice`, null, token('legacy'), 'GET'));
        denied(await request(`${prefix}/users/alice`, null, token('mismatch'), 'GET'));
    });
    await t.test('missing or mismatched audit rolls back the application update', async () => {
        allowed(await commit([write('applications/missing-audit', application())]));
        const pair = transition('missing-audit');
        denied(await commit([pair[0]], admin));
        pair[1].update.fields.reason = value('forged reason');
        denied(await commit(pair, admin));
        const current = await request(`${prefix}/applications/missing-audit`, null, admin, 'GET');
        allowed(current); assert.equal(JSON.parse(current.text).fields.status.stringValue, 'Submitted');
    });
    await t.test('paired start and final decisions succeed; logs are immutable and cannot be replayed', async () => {
        for (const decision of ['Approved', 'Denied']) {
            const id = `valid-${decision}`;
            allowed(await commit([write(`applications/${id}`, application())]));
            const pair = transition(id);
            allowed(await commit(pair, admin));
            denied(await commit([pair[1]], admin));
            denied(await commit([write(`auditLogs/${id}__REVIEW_STARTED`, { reason: 'changed' }, true)], admin));
            denied(await commit([{ delete: `${prefix}/auditLogs/${id}__REVIEW_STARTED` }], admin));
            denied(await commit([transition(id, decision)[0]], admin));
            allowed(await commit(transition(id, decision), admin));
        }
    });
    await t.test('audit alone, arbitrary ID, wrong region, and applicant review attempts fail', async () => {
        for (const id of ['orphan', 'wrong-id', 'regional', 'applicant']) {
            allowed(await commit([write(`applications/${id}`, application(id === 'regional' ? 'Erongo' : 'Khomas'))]));
        }
        denied(await commit([transition('orphan')[1]], admin));
        const pair = transition('wrong-id'); pair[1].update.name = `${prefix}/auditLogs/arbitrary-id`;
        denied(await commit(pair, admin));
        denied(await commit(transition('regional', 'Under Review', 'khomas-admin', 'Erongo'), admin));
        denied(await commit(transition('applicant'), token('alice')));
        allowed(await commit(transition('regional', 'Under Review', 'super-admin', 'Erongo'), superAdmin));
    });
    await t.test('document-access audits bind applicant, entity, region, and administrator', async () => {
        allowed(await commit([write('auditLogs/access-good', documentEvent('alice', 'Khomas'))], admin));
        for (const [id, event] of [
            ['foreign', documentEvent('bob', 'Erongo')],
            ['spoof-region', documentEvent('bob', 'Khomas')],
            ['wrong-entity', documentEvent('alice', 'Khomas', { entityId: 'bob' })],
            ['missing-target', documentEvent('nobody', 'Khomas')],
            ['wrong-actor', documentEvent('alice', 'Khomas', { actorUid: 'super-admin' })]
        ]) denied(await commit([write(`auditLogs/access-${id}`, event)], admin));
        allowed(await commit([write('auditLogs/access-super', documentEvent('bob', 'Erongo', {
            actorUid: 'super-admin', actorRole: 'super_admin'
        }))], superAdmin));
        denied(await commit([write('auditLogs/access-applicant', documentEvent('alice', 'Khomas'))], token('alice')));
    });
    await t.test('registration, submission and published vacancy behavior remain available', async () => {
        allowed(await commit([write('users/new-applicant', {
            uid: 'new-applicant', role: 'applicant', accountStatus: 'active', profileCompleted: false
        })], token('new-applicant', false)));
        allowed(await commit([write('applications/new-submission', { ...application(), documentsValidated: true })], token('alice')));
        const job = { title: 'Constable', region: 'Khomas', description: 'Description', requirements: '',
            status: 'Open', published: true, createdAt: serverTime, updatedAt: serverTime };
        allowed(await commit([write('jobs/open-job', job)], admin));
        // An unrelated verified applicant can read public jobs.
        allowed(await request(`${prefix}/jobs/open-job`, null, token('new-applicant'), 'GET'));
        denied(await commit([write('jobs/foreign-job', { ...job, region: 'Erongo' })], admin));
        allowed(await commit([write('jobs/open-job', { status: 'Closed', updatedAt: serverTime }, true)], admin));
        denied(await request(`${prefix}/jobs/open-job`, null, token('new-applicant'), 'GET'));
    });
    await t.test('READY PDFs allow submission and reuse without a new upload; legacy flags cannot bypass rules', async () => {
        for (const id of ['ready-one', 'ready-two']) {
            allowed(await commit([write(`applications/${id}`, { ...application(), documentsValidated: true })], token('alice')));
        }
        const noId = { ...application(), documentsValidated: true }; delete noId.documentSetId;
        denied(await commit([write('applications/legacy-only', noId)], token('alice')));
        denied(await commit([write('applications/nonexistent', { ...application(), documentsValidated: true, documentSetId: 'f'.repeat(32) })], token('alice')));
        denied(await commit([write('applications/invalid-id', { ...application(), documentsValidated: true, documentSetId: '../forged' })], token('alice')));
    });
    await t.test('an applicant with no documents cannot submit even with forged legacy flags', async () => {
        allowed(await commit([write('users/no-documents', {
            uid: 'no-documents', role: 'applicant', region: 'Khomas', accountStatus: 'active', profileCompleted: true
        })]));
        denied(await commit([write('applications/no-documents', {
            ...application(), applicantId: 'no-documents', documentSetId: 'f'.repeat(32), documentsValidated: true
        })], token('no-documents')));
    });
    await t.test('applicant profile edits and own application reads remain scoped; verification is required to submit', async () => {
        allowed(await commit([write('users/alice', { phone: '0810000000', updatedAt: serverTime }, true)], token('alice')));
        denied(await commit([write('users/alice', { role: 'admin' }, true)], token('alice')));
        denied(await commit([write('users/alice', { region: 'Erongo' }, true)], token('alice')));
        allowed(await request(`${prefix}/applications/ready-one`, null, token('alice'), 'GET'));
        denied(await request(`${prefix}/applications/ready-one`, null, token('bob'), 'GET'));
        denied(await commit([write('applications/unverified-ready', {
            ...application(), documentsValidated: true
        })], token('alice', false)));
        denied(await commit([write('applications/spoofed-applicant', {
            ...application(), documentsValidated: true
        })], token('bob')));
    });
    await t.test('direct Firestore submission rejects missing PDFs, non-ready, foreign, unclean and invalid sets', async () => {
        const invalid = [];
        for (const kind of ['cv', 'certificate', 'identification']) {
            const set = readyDocuments(); delete set.documents[kind]; invalid.push(set);
        }
        invalid.push({ ...readyDocuments(), documents: {} });
        for (const state of ['pending', 'failed']) invalid.push({ ...readyDocuments(), state });
        invalid.push({ ...readyDocuments(), ownerUid: 'bob' });
        invalid.push({ ...readyDocuments(), schemaVersion: 2 });
        for (const kind of ['cv', 'certificate', 'identification']) {
            for (const change of [{ mimeType: 'image/png' }, { scanStatus: 'infected' },
                { scanStatus: 'failed' }, { scanStatus: 'pending' }, { fileSize: 0 }, { fileSize: 5242881 }]) {
                const set = readyDocuments(); Object.assign(set.documents[kind], change); invalid.push(set);
            }
        }
        for (let i = 0; i < invalid.length; i++) {
            const id = (i + 1).toString(16).padStart(32, '0');
            allowed(await commit([write(`serverDocumentSets/${id}`, { ...invalid[i], setId: id })]));
            denied(await commit([write(`applications/invalid-set-${i}`, {
                ...application(), documentSetId: id, documentsValidated: true
            })], token('alice')));
        }
    });
    await t.test('browser cannot forge READY manifests, batch them with applications or replace a submitted reference', async () => {
        const forged = 'e'.repeat(32);
        const setWrite = write(`serverDocumentSets/${forged}`, readyDocuments(forged));
        const appWrite = write('applications/forged-ready', { ...application(), documentSetId: forged, documentsValidated: true });
        denied(await commit([setWrite], token('alice')));
        denied(await commit([setWrite, appWrite], token('alice')));
        denied(await commit([write(`serverDocumentSets/${'a'.repeat(32)}`, { state: 'ready' }, true)], token('alice')));
        denied(await commit([write('applications/ready-one', { documentSetId: forged }, true)], token('alice')));
        denied(await commit([write('applications/ready-one', { documentSetId: forged }, true)], admin));
    });
    await t.test('screening evidence, result history and synthetic fixtures are private and server-owned', async () => {
        for (const collection of ['serverScreeningResults', 'serverScreeningRuns', 'syntheticVerificationCases']) {
            allowed(await commit([write(`${collection}/phase2-test`, { applicationId: 'ready-one', region: 'Khomas', synthetic: true })]));
            for (const identity of [token('alice'), admin, superAdmin, token('outsider')]) {
                denied(await request(`${prefix}/${collection}/phase2-test`, null, identity, 'GET'));
                denied(await commit([write(`${collection}/forged`, { scenario: 'clear', status: 'met' })], identity));
                denied(await commit([write(`${collection}/phase2-test`, { scenario: 'clear' }, true)], identity));
                denied(await commit([{ delete: `${prefix}/${collection}/phase2-test` }], identity));
            }
        }
        for (const extra of [{ aiScreeningStatus: 'Passed' }, { aiMatchScore: 100 },
            { verificationStatus: 'Clear' }, { criminalVerification: 'clear' }, { screeningResult: { status: 'met' } }]) {
            denied(await commit([write(`applications/forged-screening-${Object.keys(extra)[0]}`,
                { ...application(), documentsValidated: true, ...extra })], token('alice')));
        }
        denied(await commit([write('auditLogs/forged-screening-action', { action: 'SCREENING_COMPLETED',
            adminId: 'khomas-admin', region: 'Khomas', applicationId: 'ready-one', timestamp: serverTime })], admin));
    });
    await t.test('linked vacancies must be published, open and match the submitted position and region', async () => {
        allowed(await commit([write('jobs/phase2-job', { title: 'Officer', region: 'Khomas', published: true, status: 'Open' })]));
        const data = { ...application(), position: 'Officer', vacancyId: 'phase2-job', documentsValidated: true };
        allowed(await commit([write('applications/phase2-linked', data)], token('alice')));
        for (const update of [{ published: false }, { published: true, status: 'Closed' },
            { status: 'Open', region: 'Erongo' }, { region: 'Khomas', title: 'Different' }]) {
            allowed(await commit([write('jobs/phase2-job', update, true)]));
            denied(await commit([write('applications/phase2-invalid', data)], token('alice')));
        }
        denied(await commit([write('applications/phase2-linked', { vacancyId: 'another' }, true)], token('alice')));
    });
    await t.test('an application, immutable binding and binding audit must be created atomically', async () => {
        const id = 'phase3-atomic'; const data = { ...application(), documentsValidated: true };
        denied(await rawCommit([write(`applications/${id}`, data)], token('alice')));
        const extras = submissionExtras(id, data);
        denied(await rawCommit([write(`applications/${id}`, data), extras[0]], token('alice')));
        const forged = submissionExtras(id, { ...data, documentSetId: 'b'.repeat(32) });
        denied(await rawCommit([write(`applications/${id}`, data), ...forged], token('alice')));
        allowed(await rawCommit([write(`applications/${id}`, data), ...extras], token('alice')));
        const optedInId = 'phase3-ai-consent';
        const optedIn = { ...application('Khomas', true), documentsValidated: true };
        allowed(await rawCommit([write(`applications/${optedInId}`, optedIn),
            ...submissionExtras(optedInId, optedIn)], token('alice')));
        let invalidIndex = 0;
        for (const invalidConsent of [
            { ...application(), aiScreeningConsent: true },
            { ...application(), aiScreeningConsent: true, aiScreeningConsentAt: serverTime,
                aiScreeningConsentVersion: 'wrong-version' },
            { ...application(), aiScreeningConsentAt: serverTime,
                aiScreeningConsentVersion: 'openai-cv-review-v1' },
        ]) {
            const invalidId = `invalid-consent-${++invalidIndex}`;
            denied(await commit([write(`applications/${invalidId}`,
                { ...invalidConsent, documentsValidated: true })], token('alice')));
        }
        denied(await rawCommit([write(`serverApplicationDocumentBindings/${id}`, { setId: 'b'.repeat(32) }, true)], token('alice')));
        denied(await rawCommit([write(`serverApplicationDocumentBindings/${id}`, { setId: 'b'.repeat(32) }, true)], admin));
        denied(await rawCommit([{ delete: `${prefix}/auditLogs/${id}__DOCUMENT_SET_BOUND` }], token('alice')));
    });
    await t.test('a final decision requires an atomic private notification; callers cannot send or rewrite email jobs', async () => {
        const id = 'phase3-notification';
        allowed(await commit([write(`applications/${id}`, application())]));
        allowed(await commit(transition(id), admin));
        const decision = transition(id, 'Denied');
        denied(await rawCommit(decision.slice(0, 2), admin));
        denied(await rawCommit(decision.slice(0, 3), admin));
        const extraRecipient = transition(id, 'Denied'); extraRecipient[2].update.fields.to = value('attacker@example.invalid');
        denied(await rawCommit(extraRecipient, admin));
        allowed(await rawCommit(decision, admin));
        for (const actor of [token('alice'), admin, superAdmin]) {
            denied(await request(`${prefix}/notificationOutbox/${id}__Denied`, null, actor, 'GET'));
            denied(await rawCommit([write(`notificationOutbox/${id}__Denied`, { state: 'pending' }, true)], actor));
            denied(await rawCommit([{ delete: `${prefix}/notificationOutbox/${id}__Denied` }], actor));
        }
        denied(await rawCommit(decision, admin));
        denied(await rawCommit([write(`auditLogs/${id}__Denied__queued`, { action: 'NOTIFICATION_SENT' }, true)], admin));
        denied(await rawCommit([write(`auditLogs/${id}__forged_sent`, { action: 'NOTIFICATION_SENT',
            actorUid: 'system:notifications', applicationId: id, region: 'Khomas', timestamp: serverTime })], admin));
    });
    await t.test('only the verified applicant can update optional non-negative academic points without gaining privileges', async () => {
        const own = token('alice');
        for (const points of [32, 0, null]) allowed(await rawCommit([write('users/alice', { academicPoints: points }, true)], own));
        for (const points of [-1, '32', true]) denied(await rawCommit([write('users/alice', { academicPoints: points }, true)], own));
        const fractional = write('users/alice', { academicPoints: null }, true);
        fractional.update.fields.academicPoints = { doubleValue: 32.5 };
        denied(await rawCommit([fractional], own));
        denied(await rawCommit([write('users/alice', { academicPoints: 99 }, true)], token('other')));
        denied(await rawCommit([write('users/alice', { academicPoints: 99 }, true)], admin));
        denied(await rawCommit([write('users/alice', { academicPoints: 99 }, true)], token('alice', true, '')));
        denied(await rawCommit([write('users/alice', { academicPoints: 99, role: 'admin' }, true)], own));
        allowed(await rawCommit([write('users/alice', { academicPoints: 35 }, true)], own));
    });
    await t.test('shortlist records and retry receipts are backend-only for all browser roles', async () => {
        allowed(await rawCommit([write('serverShortlists/phase5-shortlist', {
            applicationId: 'phase5-shortlist', vacancyId: 'phase5-vacancy', ownerUid: 'alice', region: 'Khomas',
            status: 'shortlisted', reviewerId: 'khomas-admin', reason: 'PRIVATE SHORTLIST NOTE', version: 1, shortlistedAt: serverTime }),
            write('serverShortlistRequests/phase5-receipt', { digest: 'SERVER ONLY', actorUid: 'khomas-admin' })], 'owner'));
        for (const actor of [token('alice'), token('bob'), admin, superAdmin, token('khomas-admin', true, '')]) {
            for (const path of ['serverShortlists/phase5-shortlist', 'serverShortlistRequests/phase5-receipt']) {
                denied(await request(`${prefix}/${path}`, null, actor, 'GET'));
                denied(await rawCommit([write(path, { status: 'not_shortlisted' }, true)], actor));
                denied(await rawCommit([{ delete: `${prefix}/${path}` }], actor));
            }
            denied(await rawCommit([write('serverShortlists/client-forged', { ownerUid: 'alice', status: 'shortlisted' })], actor));
            denied(await rawCommit([write('serverShortlistRequests/client-forged', { digest: 'forged' })], actor));
        }
    });
    await t.test('applicants can read only their safe shortlist mirror and cannot forge or rewrite it', async () => {
        allowed(await rawCommit([write('applicantShortlistStatuses/phase5-shortlist', {
            applicationId: 'phase5-shortlist', vacancyId: 'phase5-vacancy', ownerUid: 'alice', status: 'shortlisted', updatedAt: serverTime })], 'owner'));
        const own = await request(`${prefix}/applicantShortlistStatuses/phase5-shortlist`, null, token('alice'), 'GET');
        allowed(own); assert.ok(!own.text.includes('reason')); assert.ok(!own.text.includes('reviewerId'));
        for (const actor of [token('bob'), admin, superAdmin, token('alice', true, ''), token('alice', false)])
            denied(await request(`${prefix}/applicantShortlistStatuses/phase5-shortlist`, null, actor, 'GET'));
        for (const actor of [token('alice'), admin, superAdmin]) {
            denied(await rawCommit([write('applicantShortlistStatuses/phase5-shortlist', { status: 'not_shortlisted' }, true)], actor));
            denied(await rawCommit([write('applicantShortlistStatuses/forged', { ownerUid: 'alice', status: 'shortlisted' })], actor));
            denied(await rawCommit([{ delete: `${prefix}/applicantShortlistStatuses/phase5-shortlist` }], actor));
        }
        const query = { structuredQuery: { from: [{ collectionId: 'applicantShortlistStatuses' }], where: {
            fieldFilter: { field: { fieldPath: 'ownerUid' }, op: 'EQUAL', value: value('alice') } } } };
        allowed(await request(`${prefix}:runQuery`, query, token('alice')));
        denied(await request(`${prefix}:runQuery`, { structuredQuery: { from: [{ collectionId: 'applicantShortlistStatuses' }] } }, token('alice')));
    });
    await t.test('shortlist audit events cannot be forged, updated or deleted and internal explanations stay admin-only', async () => {
        const event = { action: 'CANDIDATE_SHORTLISTED', actorUid: 'khomas-admin', adminId: 'khomas-admin',
            applicationId: 'phase5-shortlist', vacancyId: 'phase5-vacancy', region: 'Khomas',
            reason: 'PRIVATE SHORTLIST NOTE', timestamp: serverTime };
        allowed(await rawCommit([write('auditLogs/phase5-server-shortlist-event', event)], 'owner'));
        allowed(await request(`${prefix}/auditLogs/phase5-server-shortlist-event`, null, admin, 'GET'));
        denied(await request(`${prefix}/auditLogs/phase5-server-shortlist-event`, null, token('alice'), 'GET'));
        for (const actor of [token('alice'), admin, superAdmin]) {
            for (const action of ['CANDIDATE_SHORTLISTED', 'CANDIDATE_REMOVED_FROM_SHORTLIST'])
                denied(await rawCommit([write('auditLogs/phase5-forged-' + action, { ...event, action })], actor));
            denied(await rawCommit([write('auditLogs/phase5-server-shortlist-event', { reason: 'tampered' }, true)], actor));
            denied(await rawCommit([{ delete: `${prefix}/auditLogs/phase5-server-shortlist-event` }], actor));
        }
    });
    await t.test('denial reasons cannot be whitespace and review timestamps must come from the server', async () => {
        const id = 'phase3-denial-validation';
        allowed(await commit([write(`applications/${id}`, application())]));
        const forgedTime = transition(id); forgedTime[0].update.fields.reviewStartedAt = value('client-clock');
        forgedTime[0].updateTransforms = forgedTime[0].updateTransforms.filter(field => field.fieldPath !== 'reviewStartedAt');
        denied(await rawCommit(forgedTime, admin));
        allowed(await rawCommit(transition(id), admin));
        for (const reason of ['', '   ', '\n\t\r', '\u00a0', '\u200b\ufeff']) {
            const deniedDecision = transition(id, 'Denied');
            deniedDecision[0].update.fields.decisionReason = value(reason);
            deniedDecision[1].update.fields.reason = value(reason);
            denied(await rawCommit(deniedDecision, admin));
        }
        const valid = transition(id, 'Denied');
        valid[0].update.fields.decisionReason = value('Reason\nwith detail'); valid[1].update.fields.reason = value('Reason\nwith detail');
        allowed(await rawCommit(valid, admin));
        const result = await request(`${prefix}/applications/${id}`, null, token('alice'), 'GET');
        allowed(result); const stored = JSON.parse(result.text).fields;
        assert.equal(stored.status.stringValue, 'Denied'); assert.ok(stored.reviewedAt.timestampValue);
        const job = await request(`${prefix}/notificationOutbox/${id}__Denied`, null, 'owner', 'GET');
        allowed(job); assert.equal(JSON.parse(job.text).fields.createdAt.timestampValue, stored.reviewedAt.timestampValue);
    });
});
