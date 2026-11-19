const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('js/documents.js', 'utf8').replace(/^import .*;\r?\n/gm, '');
const setId = 'a'.repeat(32);
const ready = () => ({ setId, schemaVersion: 1, state: 'ready', documents:
    Object.fromEntries(['cv', 'identification', 'certificate'].map(kind => [kind,
        { fileName: `${kind}.pdf`, fileSize: 100, mimeType: 'application/pdf', scanStatus: 'clean' }])) });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function setup() {
    const nodes = new Map();
    function node(id) {
        if (!nodes.has(id)) nodes.set(id, {
            textContent: '', className: '', disabled: false, files: [], children: [], events: {},
            classList: { add() {}, remove() {}, toggle() {} },
            addEventListener(name, handler) { this.events[name] = handler; },
            setAttribute() {}, replaceChildren() { this.children = []; },
            append(child) { this.children.push(child); },
            reset() { for (const id of ['cvFile', 'idFile', 'certificateFile']) node(id).files = []; }
        });
        return nodes.get(id);
    }
    const requests = [];
    const user = { uid: 'alice', emailVerified: true, getIdToken: async force => {
        assert.equal(force, true); return 'firebase-id-token';
    } };
    const auth = { currentUser: user };
    let callback;
    const context = vm.createContext({
        auth, db: {}, window: { location: { hostname: '127.0.0.1', protocol: 'http:', origin: 'http://127.0.0.1:8000' } },
        document: { getElementById: node, createElement: () => ({}) },
        doc: (_, collection, id) => ({ collection, id }),
        getDoc: async ref => ({ exists: () => ref.collection === 'users', data: () => ({
            role: 'applicant', accountStatus: 'active', profileCompleted: true
        }) }),
        onAuthStateChanged: (_, cb) => { callback = cb; },
        FormData: class { constructor() { this.entries = []; } append(...args) { this.entries.push(args); } },
        AbortController, setTimeout, clearTimeout,
        fetch: async (url, options) => { requests.push({ url, ...options }); return {
            ok: true, status: 200, json: async () => ({ sets: [] })
        }; }
    });
    vm.runInContext(source, context);
    await callback(user);
    requests.length = 0;
    for (const id of ['cvFile', 'idFile', 'certificateFile']) node(id).files = [{ name: 'sample.pdf', type: 'application/pdf', size: 100 }];
    return { node, user, auth, context, callback, requests,
        submit: () => node('documentForm').events.submit({ preventDefault() {} }),
        reply(status, result = ready()) { context.fetch = async (url, options) => {
            requests.push({ url, ...options }); return { ok: status >= 200 && status < 300, status, json: async () => result };
        }; }
    };
}
test('posts only three exact multipart fields with a Firebase bearer token; waits for server confirmation', async () => {
    const s = await setup(); const wait = deferred();
    s.context.fetch = async (url, options) => { s.requests.push({ url, ...options }); return wait.promise; };
    const pending = s.submit();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.node('saveDocumentsBtn').disabled, true);
    assert.doesNotMatch(s.node('alertBox').className, /alert-success/);
    await s.submit(); assert.equal(s.requests.length, 1);
    const req = s.requests[0];
    assert.equal(req.url, 'http://127.0.0.1:8001/api/me/document-sets');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.Authorization, 'Bearer firebase-id-token');
    assert.equal(req.headers['Content-Type'], undefined);
    assert.deepEqual(Array.from(req.body.entries, entry => entry[0]), ['cv', 'identification', 'certificate']);
    wait.resolve({ ok: true, status: 201, json: async () => ready() }); await pending;
    assert.match(s.node('alertBox').className, /alert-success/);
    assert.match(s.node('alertBox').textContent, new RegExp(setId));
    assert.match(s.node('savedDocumentsList').children[0].textContent, new RegExp(setId));
    await s.submit(); assert.equal(s.requests.length, 1); // Cleared selections cannot be resent.
});
test('rejects missing, empty, oversized and non-PDF selections before any request', async () => {
    for (const files of [[], [{ name: 'x.pdf', size: 0 }], [{ name: 'x.pdf', size: 5242881 }],
        [{ name: 'x.png', type: 'image/png', size: 10 }]]) {
        const s = await setup(); s.node('cvFile').files = files; await s.submit();
        assert.equal(s.requests.length, 0); assert.match(s.node('alertBox').className, /warning/);
    }
});
test('expired/revoked tokens and account changes never send selected files', async () => {
    const s = await setup(); s.user.getIdToken = async () => { throw Error('revoked'); };
    await s.submit(); assert.equal(s.requests.length, 0); assert.match(s.node('alertBox').textContent, /log in again/);
    s.auth.currentUser = { uid: 'bob' }; await s.submit(); assert.equal(s.requests.length, 0);
});
test('HTTP authentication, validation, size and capacity errors never report success', async () => {
    for (const status of [401, 403, 408, 413, 422, 429, 503]) {
        const s = await setup(); s.reply(status); await s.submit();
        assert.doesNotMatch(s.node('alertBox').className, /success/);
        assert.equal(s.node('savedDocumentsList').children.length, 0);
        assert.equal(s.node('saveDocumentsBtn').disabled, status === 503);
    }
});
test('lost responses and invalid success manifests block retries until reconciliation', async () => {
    for (const mode of ['offline', 'json', 'pending', 'infected', 'missing']) {
        const s = await setup(); const manifest = ready();
        if (mode === 'offline') s.context.fetch = async () => { throw TypeError('network'); };
        else if (mode === 'json') s.context.fetch = async () => ({ ok: true, json: async () => { throw Error('bad json'); } });
        else { if (mode === 'pending') manifest.state = 'pending';
            if (mode === 'infected') manifest.documents.cv.scanStatus = 'infected';
            if (mode === 'missing') delete manifest.documents.certificate;
            s.reply(201, manifest);
        }
        await s.submit(); assert.equal(s.node('saveDocumentsBtn').disabled, true);
        assert.doesNotMatch(s.node('alertBox').className, /success/);
        const count = s.requests.length; await s.submit(); assert.equal(s.requests.length, count);
    }
});
test('backend unavailable during initial reconciliation leaves upload disabled', async () => {
    const s = await setup(); s.context.fetch = async () => { throw TypeError('offline'); };
    await s.callback(s.user); assert.equal(s.node('saveDocumentsBtn').disabled, true);
    assert.match(s.node('alertBox').textContent, /backend is running/);
});

test('clock, project and backend credential failures give operator guidance without retrying POST', async () => {
    for (const [code, message] of [['auth_clock_error', /clock/], ['auth_project_error', /project/],
        ['auth_backend_error', /credentials and permissions/]]) {
        const s = await setup(); s.reply(503, { detail: { code } }); await s.submit();
        assert.match(s.node('alertBox').textContent, message);
        assert.doesNotMatch(s.node('alertBox').textContent, /expired|log in again|outcome could not be confirmed/);
        assert.equal(s.requests.length, 1);
        assert.equal(s.node('saveDocumentsBtn').disabled, false);
        assert.doesNotMatch(s.node('alertBox').className, /success/);
    }
});

test('only an explicit expiry code reports an expired session', async () => {
    for (const [code, expired] of [['session_expired', true], ['authentication_rejected', false], [undefined, false]]) {
        const s = await setup(); s.reply(401, { detail: { code } }); await s.submit();
        assert.equal(/session has expired/.test(s.node('alertBox').textContent), expired);
        assert.equal(s.requests.length, 1);
    }
});

test('refresh network failures do not send documents or claim the session expired', async () => {
    const s = await setup();
    s.user.getIdToken = async () => { throw { code: 'auth/network-request-failed' }; };
    await s.submit();
    assert.equal(s.requests.length, 0);
    assert.match(s.node('alertBox').textContent, /connection/);
    assert.doesNotMatch(s.node('alertBox').textContent, /expired|log in again/);
});

test('storage failures explain the cause, require reconciliation and never retry POST', async () => {
    for (const [code, message] of [['storage_credentials_error', /credentials/],
        ['storage_connection_error', /DNS/], ['storage_bucket_missing', /bucket/],
        ['storage_bucket_not_private', /not private/], ['storage_timeout', /timed out/],
        ['storage_request_error', /storage request/], ['storage_service_error', /unavailable/]]) {
        const s = await setup(); s.reply(503, { detail: { code } }); await s.submit();
        assert.match(s.node('alertBox').textContent, message);
        assert.match(s.node('alertBox').textContent, /Reload/);
        assert.equal(s.node('saveDocumentsBtn').disabled, true);
        assert.equal(s.requests.length, 1);
        await s.submit(); assert.equal(s.requests.length, 1);
        assert.doesNotMatch(s.node('alertBox').className, /success/);
    }
});
test('timeout aborts the request and prevents an automatic resubmission', async () => {
    const s = await setup();
    s.context.setTimeout = handler => { queueMicrotask(handler); return 1; };
    s.context.clearTimeout = () => {};
    s.context.fetch = async (_, options) => {
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(options.signal.aborted, true);
        throw Error('aborted');
    };
    await s.submit();
    assert.equal(s.node('saveDocumentsBtn').disabled, true);
    assert.match(s.node('alertBox').textContent, /Reload/);
});
test('account changes while the POST is in flight cannot display success for another user', async () => {
    const s = await setup();
    s.context.fetch = async () => {
        s.auth.currentUser = { uid: 'bob' };
        return { ok: true, status: 201, json: async () => ready() };
    };
    await s.submit();
    assert.doesNotMatch(s.node('alertBox').className, /success/);
    assert.equal(s.node('savedDocumentsList').children.length, 0);
    assert.equal(s.node('saveDocumentsBtn').disabled, true);
});
test('saved sets use safe text and only show ready scanned records', async () => {
    const s = await setup(); const manifest = ready(); manifest.documents.cv.fileName = '<img src=x onerror=bad()>';
    const pending = { ...ready(), state: 'pending' };
    s.reply(200, { sets: [pending, manifest] }); await s.callback(s.user);
    assert.equal(s.node('savedDocumentsList').children.length, 1);
    assert.match(s.node('savedDocumentsList').children[0].textContent, /<img/);
    assert.equal(s.node('saveDocumentsBtn').disabled, true);
    assert.match(s.node('alertBox').textContent, /still pending/);
});
