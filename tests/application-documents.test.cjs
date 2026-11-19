const { webcrypto } = require("node:crypto");
const { TextEncoder } = require("node:util");
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('Frontend/apply.html', 'utf8');
const stripImports = source => source.replace(/^import[\s\S]*?from "[^"]+";\r?\n/gm, '');
const helper = stripImports(fs.readFileSync('js/firestore.js', 'utf8')).replaceAll('export async function', 'async function');
const page = stripImports(html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]);
const message = 'Please upload all three required documents before applying for a vacancy.';
const ready = () => ({ setId: 'a'.repeat(32), schemaVersion: 1, state: 'ready', createdAt: '2026-10-22',
    documents: Object.fromEntries(['cv', 'certificate', 'identification'].map(kind => [kind,
        { fileName: `${kind}-synthetic.pdf`, mimeType: 'application/pdf', fileSize: 100, scanStatus: 'clean' }])) });

async function setup(sets = [ready()]) {
    const nodes = new Map(), requests = [], commits = [];
    const node = id => {
        if (!nodes.has(id)) {
            const classes = new Set(['d-none']);
            nodes.set(id, { value: 'synthetic', textContent: '', className: '', disabled: false,
                checked: false, options: [], events: {}, classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
                addEventListener(event, cb) { this.events[event] = cb; },
                checkValidity: () => true, reportValidity() {}, dispatchEvent() {}, add(option) { this.options.push(option); }
            });
        }
        return nodes.get(id);
    };
    const user = { uid: 'synthetic-applicant', email: 'synthetic@example.invalid', emailVerified: true,
        getIdToken: async refresh => { assert.equal(refresh, true); return 'synthetic-firebase-token'; } };
    const auth = { currentUser: user };
    let callback;
    const state = { sets, status: 200, duplicate: false };
    const profile = { role: 'applicant', accountStatus: 'active', profileCompleted: true, firstName: 'Synthetic', lastName: 'Applicant', region: 'Khomas' };
    const context = vm.createContext({
        auth, db: {}, crypto: webcrypto, TextEncoder, console: { error() {}, warn() {} }, alert() {}, AbortController, URLSearchParams,
        setTimeout, clearTimeout,
        window: { location: { hostname: '127.0.0.1', protocol: 'http:', origin: 'http://127.0.0.1:8000', search: '' }, scrollTo() {} },
        document: { getElementById: node },
        onAuthStateChanged: (_, cb) => { callback = cb; },
        getOpenJobs: async () => [],
        collection: (_, name) => ({ collection: name }),
        doc: (dbOrRef, collection, id) => typeof collection === 'undefined' ? { ...dbOrRef, id: 'synthetic-application' } : { collection, id },
        getDoc: async ref => {
            if (ref.collection === 'applications') {
                const found = commits.flat().find(write => write.ref.id === ref.id && write.ref.collection === 'applications');
                return { exists: () => !!found, data: () => found?.data };
            }
            assert.equal(ref.collection, 'users'); assert.equal(ref.id, user.uid);
            return { exists: () => true, data: () => profile };
        },
        query: (...args) => args, where: (...args) => args,
        getDocs: async () => ({ empty: !state.duplicate }), serverTimestamp: () => 'synthetic-time',
        writeBatch: () => { const writes = []; return {
            set(ref, data) { writes.push({ ref, data }); }, async commit() {
                commits.push(writes); if (state.lostResponse) throw Error('synthetic lost commit response');
            }
        }; },
        fetch: async (url, init) => {
            requests.push({ url, ...init });
            return { ok: state.status === 200, status: state.status, json: async () => ({ sets: state.sets }) };
        }
    });
    vm.runInContext(helper, context);
    await vm.runInContext(`(async () => { ${page}\n })()`, context);
    await callback(user);
    return { node, user, auth, state, context, requests, commits,
        submit: () => node('applicationForm').events.submit({ preventDefault() {} }),
        directSubmit: () => vm.runInContext('submitApplication({ applicantId: auth.currentUser.uid, position: "Synthetic Vacancy", region: "Khomas", aiScreeningConsent: document.getElementById("aiScreeningConsent").checked })', context)
    };
}

test('Apply shows exact missing-document message and existing upload link; missing sets cannot submit', async () => {
    const s = await setup([]);
    assert.ok(html.includes(message));
    assert.match(html, /href="documents.html"[\s\S]*?>\s*Upload Documents/);
    assert.equal(s.node('submitBtn').disabled, true);
    assert.equal(s.node('documentWarning').classList.contains('d-none'), false);
    await s.submit(); assert.equal(s.commits.length, 0);
    assert.equal(s.node('alertBox').textContent, message);
});

test('complete backend-confirmed PDFs permit submission and persist the authoritative documentSetId', async () => {
    const s = await setup();
    assert.equal(s.node('submitBtn').disabled, false);
    await s.submit();
    assert.equal(s.commits.length, 1);
    assert.equal(s.commits[0][0].data.documentSetId, 'a'.repeat(32));
    assert.equal(s.commits[0][0].data.applicantId, s.user.uid);
    assert.equal(s.commits[0][0].data.aiScreeningConsent, false);
    assert.equal(s.commits[0][0].data.aiScreeningConsentAt, null);
    assert.equal(s.commits[0][0].data.aiScreeningConsentVersion, null);
    assert.equal(s.commits[0].length, 3);
    assert.equal(s.commits[0][1].ref.collection, 'serverApplicationDocumentBindings');
    assert.equal(s.commits[0][1].data.setId, s.commits[0][0].data.documentSetId);
    assert.equal(s.commits[0][2].data.action, 'DOCUMENT_SET_BOUND');
    assert.equal(s.requests.length, 2); // Open-page check plus a fresh submission check.
    for (const request of s.requests) {
        assert.equal(request.url, 'http://127.0.0.1:8001/api/me/document-sets');
        assert.equal(request.headers.Authorization, 'Bearer synthetic-firebase-token');
        assert.equal(request.cache, 'no-store'); assert.equal(request.redirect, 'error');
    }
    assert.equal(s.context.window.location.href, 'dashboard.html');
});

test('AI CV review consent is optional and recorded with a server timestamp only when selected', async () => {
    const s = await setup(); s.node('aiScreeningConsent').checked = true;
    await s.directSubmit();
    const application = s.commits[0][0].data;
    assert.equal(application.aiScreeningConsent, true);
    assert.equal(application.aiScreeningConsentAt, 'synthetic-time');
    assert.equal(application.aiScreeningConsentVersion, 'openai-cv-review-v1');
});

test('lost commit response and retries return the original application without rebinding a newer upload', async () => {
    const s = await setup(); s.state.lostResponse = true;
    const first = await s.directSubmit(); assert.equal(first.success, true);
    s.state.sets = [{ ...ready(), setId: 'b'.repeat(32), createdAt: '2027-01-01' }];
    const retry = await s.directSubmit();
    assert.equal(retry.success, true); assert.equal(retry.id, first.id);
    assert.equal(s.commits.length, 1); assert.equal(s.commits[0][1].data.setId, 'a'.repeat(32));
});

test('missing individual PDFs, pending, failed, infected and non-PDF records cannot authorize submission', async () => {
    const cases = [];
    for (const kind of ['cv', 'certificate', 'identification']) {
        const set = ready(); delete set.documents[kind]; cases.push(set);
        const image = ready(); image.documents[kind].mimeType = 'image/png'; cases.push(image);
    }
    cases.push({ ...ready(), state: 'pending' }, { ...ready(), state: 'failed' });
    const infected = ready(); infected.documents.cv.scanStatus = 'infected'; cases.push(infected);
    for (const record of cases) {
        const s = await setup([record]);
        assert.equal(s.node('submitBtn').disabled, true);
        const result = await s.directSubmit();
        assert.equal(result.success, false); assert.equal(result.error, message);
        assert.equal(s.commits.length, 0);
    }
});

test('bypassing the disabled button or calling the submission helper directly does not trust legacy flags', async () => {
    const s = await setup([{ documentsValidated: true, prototypeMode: true }]);
    s.node('submitBtn').disabled = false;
    await s.submit(); assert.equal(s.commits.length, 0);
    const result = await s.directSubmit();
    assert.equal(result.success, false); assert.equal(s.commits.length, 0);
});

test('submission rechecks readiness and fails closed when backend or token verification is unavailable', async () => {
    for (const failure of ['removed', 'backend', 'token', 'account']) {
        const s = await setup();
        if (failure === 'removed') s.state.sets = [];
        if (failure === 'backend') s.state.status = 503;
        if (failure === 'token') s.user.getIdToken = async () => { throw Error('synthetic revoked session'); };
        if (failure === 'account') s.auth.currentUser = { uid: 'other' };
        await s.submit(); assert.equal(s.commits.length, 0);
        if (failure === 'removed') {
            assert.equal(s.node('submitBtn').disabled, true);
            assert.equal(s.node('documentWarning').classList.contains('d-none'), false);
        }
    }
});

test('an existing valid set remains usable alongside failed newer uploads; duplicate prevention is retained', async () => {
    const s = await setup([{ ...ready(), setId: 'b'.repeat(32), state: 'failed', createdAt: '2026-10-23' }, ready()]);
    const first = await s.directSubmit(); assert.equal(first.success, true);
    assert.equal(s.commits[0][0].data.documentSetId, 'a'.repeat(32));
    s.state.duplicate = true;
    const duplicate = await s.directSubmit();
    assert.equal(duplicate.success, true); assert.equal(duplicate.id, first.id);
    assert.equal(s.commits.length, 1);
});
