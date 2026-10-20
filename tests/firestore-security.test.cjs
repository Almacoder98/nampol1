// Real rules tests. Requires a running Firestore emulator loaded with firestore.rules.
// Native REST calls keep this suite independent of additional npm dependencies.
const { test } = require('node:test');
const assert = require('node:assert/strict');
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
const commit = (writes, identity) => request(`${database}/documents:commit`, { writes }, identity);
const allowed = result => assert.equal(result.status, 200, result.text);
const denied = result => assert.equal(result.status, 403, result.text);
const admin = token('khomas-admin');
const superAdmin = token('super-admin');
function application(region = 'Khomas') {
    return { applicantId: 'alice', applicationReference: 'REF-1', region, status: 'Submitted',
        reviewStartedAt: null, reviewedAt: null, reviewedBy: null, reviewedByStaffNumber: null, decisionReason: null };
}
function transition(id, status = 'Under Review', uid = 'khomas-admin', region = 'Khomas') {
    const starting = status === 'Under Review';
    const action = starting ? 'REVIEW_STARTED' : status === 'Approved' ? 'APPLICATION_APPROVED' : 'APPLICATION_DENIED';
    const staffNumber = uid === 'super-admin' ? 'SUPER001' : 'Khomas001';
    const reason = starting ? '' : 'Decision reason';
    const fields = { status, reviewedBy: uid, reviewedByStaffNumber: staffNumber, updatedAt: serverTime,
        ...(starting ? { reviewStartedAt: serverTime } : { reviewedAt: serverTime, decisionReason: reason }) };
    return [write(`applications/${id}`, fields, true), write(`auditLogs/${id}__${action}`, {
        action, adminId: uid, staffNumber, applicationId: id, applicationReference: 'REF-1',
        applicantId: 'alice', region, reason, timestamp: serverTime
    })];
}
function documentEvent(target, region, extra = {}) {
    return { actorUid: 'khomas-admin', actorRole: 'admin', action: 'admin.documents_accessed',
        entityType: 'applicantDocuments', entityId: target, targetApplicantId: target, region,
        createdAt: serverTime, ...extra };
}

test('Firestore security integration (emulator required)', { skip: !host && 'FIRESTORE_EMULATOR_HOST is not set' }, async t => {
    allowed(await commit([
        write('admins/khomas-admin', { role: 'admin', region: 'Khomas', active: true, staffNumber: 'Khomas001' }),
        write('admins/super-admin', { role: 'super_admin', active: true, staffNumber: 'SUPER001' }),
        write('admins/inactive', { role: 'admin', region: 'Khomas', active: false }),
        write('users/alice', { uid: 'alice', role: 'applicant', region: 'Khomas', accountStatus: 'active', profileCompleted: true }),
        write('users/bob', { uid: 'bob', role: 'applicant', region: 'Erongo' }),
        write('applicantDocuments/alice', { applicantId: 'alice', documentsValidated: true }),
        write('applicantDocuments/bob', { applicantId: 'bob', documentsValidated: true })
    ]));
    await t.test('profile ownership, regional boundaries, active and verified admin checks', async () => {
        allowed(await request(`${prefix}/users/alice`, null, token('alice'), 'GET'));
        allowed(await request(`${prefix}/users/alice`, null, token('alice', false), 'GET'));
        allowed(await request(`${prefix}/users/alice`, null, admin, 'GET'));
        denied(await request(`${prefix}/users/bob`, null, admin, 'GET'));
        denied(await request(`${prefix}/users/bob`, null, token('alice'), 'GET'));
        allowed(await request(`${prefix}/users/bob`, null, superAdmin, 'GET'));
        denied(await request(`${prefix}/users/alice`, null, token('inactive'), 'GET'));
        denied(await request(`${prefix}/users/alice`, null, token('khomas-admin', false), 'GET'));
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
});
