const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../js/admin.js'), 'utf8');
const functions = source.slice(source.indexOf('export async function startApplicationReview'), source.indexOf('// GET REGIONAL STATISTICS'))
    .replaceAll('export async function', 'async function');
const admin = { uid: 'khomas-admin', role: 'admin', region: 'Khomas', staffNumber: 'Khomas001' };
function setup(status = 'Submitted', overrides = {}) {
    const app = { status, applicantId: 'alice', region: 'Khomas', applicationReference: 'REF-1', ...overrides };
    const commits = [];
    const context = vm.createContext({
        db: {}, admin, doc: (_, collection, id) => ({ collection, id }),
        serverTimestamp: () => 'SERVER_TIME',
        runTransaction: async (_, callback) => {
            const writes = [];
            await callback({
                get: async () => ({ exists: () => true, data: () => app }),
                update: (ref, data) => writes.push({ operation: 'update', ref, data }),
                set: (ref, data) => writes.push({ operation: 'set', ref, data })
            });
            commits.push(writes);
        }
    });
    vm.runInContext(functions, context);
    return { context, commits, run: code => vm.runInContext(code, context) };
}
test('start and final decisions write canonical matching logs in the same transaction', async () => {
    for (const [status, command, action, reason] of [
        ['Submitted', 'startApplicationReview("app1", admin)', 'REVIEW_STARTED', ''],
        ['Under Review', 'reviewApplication("app1", "Approved", " Eligible ", admin)', 'APPLICATION_APPROVED', 'Eligible'],
        ['Under Review', 'reviewApplication("app1", "Denied", " Ineligible ", admin)', 'APPLICATION_DENIED', 'Ineligible']
    ]) {
        const s = setup(status); await s.run(command);
        assert.equal(s.commits.length, 1); assert.equal(s.commits[0].length, status === "Submitted" ? 2 : 4);
        const [application, audit] = s.commits[0];
        assert.equal(application.ref.collection, 'applications');
        assert.equal(audit.ref.collection, 'auditLogs');
        assert.equal(audit.ref.id, `app1__${action}`);
        assert.equal(audit.data.action, action); assert.equal(audit.data.reason, reason);
        assert.equal(audit.data.applicationId, application.ref.id);
        assert.equal(audit.data.applicantId, 'alice'); assert.equal(audit.data.region, 'Khomas');
        assert.equal(audit.data.adminId, admin.uid); assert.equal(audit.data.staffNumber, admin.staffNumber);
        assert.equal(audit.data.timestamp, application.data.updatedAt);
    }
});
test('wrong region, wrong state, missing denial reason never commit', async () => {
    for (const [s, command] of [
        [setup('Submitted', { region: 'Erongo' }), 'startApplicationReview("app1", admin)'],
        [setup('Under Review', { region: 'Erongo' }), 'reviewApplication("app1", "Approved", "", admin)'],
        [setup('Approved'), 'startApplicationReview("app1", admin)'],
        [setup('Submitted'), 'reviewApplication("app1", "Approved", "", admin)'],
        [setup('Under Review'), 'reviewApplication("app1", "Denied", " ", admin)']
    ]) {
        await assert.rejects(s.run(command)); assert.equal(s.commits.length, 0);
    }
});
test('super admin reviews across regions', async () => {
    const s = setup('Submitted', { region: 'Erongo' });
    s.context.admin = { ...admin, role: 'super_admin' };
    await s.run('startApplicationReview("app1", admin)');
    assert.equal(s.commits[0][1].data.region, 'Erongo');
});
test('admin module parses', () => assert.doesNotThrow(() => new vm.SourceTextModule(source)));

test('final decisions atomically enqueue a private UID-only notification and queue audit', async () => {
    const s = setup('Under Review'); await s.run('reviewApplication("app1", "Denied", "Reason", admin)');
    const writes = s.commits[0]; assert.equal(writes.length, 4);
    assert.equal(writes[2].ref.collection, 'notificationOutbox'); assert.equal(writes[2].ref.id, 'app1__Denied');
    assert.equal(writes[2].data.state, 'pending'); assert.equal(writes[2].data.applicantId, 'alice');
    assert.equal(writes[2].data.createdAt, writes[0].data.reviewedAt);
    assert.equal(writes[2].data.to, undefined); assert.equal(writes[2].data.reason, undefined);
    assert.equal(writes[3].data.action, 'NOTIFICATION_QUEUED');
});

test('same review/decision retry never rewrites timestamps or duplicates notifications', async () => {
    const start = setup('Under Review'); await start.run('startApplicationReview("app1", admin)');
    assert.equal(start.commits[0].length, 0);
    const final = setup('Approved', { reviewedBy: admin.uid, decisionReason: 'Eligible' });
    await final.run('reviewApplication("app1", "Approved", "Eligible", admin)'); assert.equal(final.commits[0].length, 0);
    await assert.rejects(final.run('reviewApplication("app1", "Denied", "Change", admin)'));
});
