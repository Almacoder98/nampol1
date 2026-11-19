const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('js/review-profile.js', 'utf8').replace(/^import[^\n]+\r?\n/gm, '')
    .replaceAll('export function', 'function');
function setup(request) {
    const fields = Object.fromEntries(['name','email','phone','address','dateOfBirth','gender','region','qualification','employment','skills','points']
        .map(key => [key, { textContent: '' }]));
    const feedback = { textContent: '' }; let authChanged, unsubscribed = false;
    const auth = { currentUser: { uid: 'synthetic-admin' } };
    const context = vm.createContext({ auth, applicantProfileRequest: request,
        onAuthStateChanged: (_, callback) => { authChanged = callback; return () => { unsubscribed = true; }; } });
    vm.runInContext(source, context);
    return { fields, feedback, auth, changed: user => authChanged(user), unsubscribed: () => unsubscribed,
        review: context.createApplicantProfileReview(fields, feedback) };
}
test('profile review displays phone, email, qualification, recorded points and safe text', async () => {
    const s = setup(async () => ({ firstName: '<img src=x onerror=alert(1)>', lastName: 'Demo',
        phone: '+264 DEMO', email: 'demo@example.invalid', highestQualification: 'Diploma',
        skills: ['First aid'], academicPoints: 32 }));
    await s.review.load('application');
    assert.equal(s.fields.phone.textContent, '+264 DEMO'); assert.equal(s.fields.email.textContent, 'demo@example.invalid');
    assert.match(s.fields.points.textContent, /^32.*verify/); assert.match(s.fields.name.textContent, /<img/);
    assert.equal(s.fields.name.innerHTML, undefined); assert.match(s.feedback.textContent, /not proof of identity/);
});
test('missing points and profile errors never create a score or disable document/review controls', async () => {
    const s = setup(async () => ({})); await s.review.load('app');
    assert.match(s.fields.points.textContent, /Not recorded/); assert.equal(s.fields.phone.textContent, 'Not provided');
    const fail = setup(async () => { throw Error('Not authorized'); }); await fail.review.load('app');
    assert.match(fail.feedback.textContent, /Profile unavailable.*still inspect/);
});
test('switching applications or closing modal discards stale profile responses', async () => {
    const resolve = {};
    const s = setup(id => new Promise(done => { resolve[id] = done; }));
    const old = s.review.load('old'), current = s.review.load('current');
    resolve.current({ firstName: 'Current' }); await current;
    resolve.old({ firstName: 'Wrong applicant' }); await old;
    assert.equal(s.fields.name.textContent, 'Current');
    const closing = s.review.load('closing'); s.review.clear(); resolve.closing({ email: 'private@example.invalid' }); await closing;
    assert.equal(s.fields.email.textContent, 'Not provided');
});
test('account change and page disposal clear personal details and stop pending display', async () => {
    const s = setup(async () => ({ email: 'private@example.invalid' })); await s.review.load('app');
    s.auth.currentUser = null; s.changed(null); assert.equal(s.fields.email.textContent, 'Not provided');
    s.review.destroy(); assert.equal(s.unsubscribed(), true);
});
test('Review Profile & Documents opens immediately without waiting for Firestore or PDF requests', async () => {
    const html = fs.readFileSync('Frontend/admin.html', 'utf8');
    const fn = html.slice(html.indexOf('async function openApplicationReview('), html.indexOf('async function completeReviewAction('));
    const calls = [], node = () => ({ textContent: '', value: '', classList: { add() {}, toggle() {} } });
    const nodes = new Map();
    const context = vm.createContext({ selectedApplication: null,
        document: { getElementById: id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); } },
        setReviewDetail() {}, formatTimestamp: () => '',
        reviewModal: { show: () => calls.push('show') },
        profileReview: { load: () => { calls.push('profile'); return new Promise(() => {}); } },
        shortlistReview: { load: () => { calls.push('shortlist'); return new Promise(() => {}); } },
        documentViewer: { load: () => { calls.push('documents'); return new Promise(() => {}); } },
        loadScreening: () => calls.push('screening'), loadNotification: () => calls.push('notification'),
        startReviewButton: node(), decisionReasonGroup: node(), approveApplicationButton: node(),
        denyApplicationButton: node(), decisionReasonInput: node(), reviewModalAlert: node() });
    vm.runInContext(fn, context); await context.openApplicationReview({ id: 'synthetic', status: 'Submitted' });
    assert.deepEqual(calls, ['show','profile','shortlist','documents','screening','notification']);
    assert.match(html, /reviewButton.textContent = "Review Profile & Documents"/);
    for (const id of ['reviewProfilePhone','reviewProfileEmail','reviewProfilePoints','reviewDocumentButtons'])
        assert.ok(html.includes(`id="${id}"`));
});
