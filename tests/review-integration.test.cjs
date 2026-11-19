const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const strip = path => fs.readFileSync(path, 'utf8').replace(/^import[^\n]+\r?\n/gm, '')
    .replaceAll('export async function', 'async function').replaceAll('export function', 'function');

function viewerSetup({ status = 200 } = {}) {
    const requests = [], revoked = []; let changed;
    class Element {
        constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.events = {}; }
        append(...nodes) { this.children.push(...nodes); }
        replaceChildren() { this.children = []; }
        setAttribute(name, value) { this[name] = value; }
        addEventListener(name, fn) { this.events[name] = fn; }
    }
    const user = { uid: 'regional-admin', getIdToken: async () => 'synthetic-token' }, auth = { currentUser: null }; auth.currentUser = user;
    const context = vm.createContext({ auth, AbortController, setTimeout, clearTimeout,
        window: { location: { hostname: 'localhost', protocol: 'http:', origin: 'http://localhost:8000' } },
        onAuthStateChanged: (_, callback) => { changed = callback; return () => {}; },
        document: { createElement: tag => new Element(tag) },
        URL: { createObjectURL: () => 'blob:synthetic-private-pdf', revokeObjectURL: url => revoked.push(url) },
        fetch: async (url, request) => { requests.push({ url, ...request }); return {
            ok: status === 200, status, headers: { get: () => 'application/pdf' }, blob: async () => ({ size: 100 }),
            json: async () => ({ state: 'ready', documents: Object.fromEntries(['cv', 'certificate', 'identification'].map(kind =>
                [kind, { mimeType: 'application/pdf', scanStatus: 'clean' }])) }) }; }
    });
    vm.runInContext(strip('js/review-documents.js'), context);
    const buttons = new Element('div'), display = new Element('div'), feedback = new Element('p');
    const viewer = context.createReviewDocumentViewer(buttons, display, feedback);
    return { context, viewer, auth, user, buttons, display, feedback, requests, revoked, changed: user => changed(user) };
}

test('review PDF viewer fetches all three kinds through authenticated private endpoints and revokes blobs', async () => {
    const s = viewerSetup(); await s.viewer.load('application-one'); assert.equal(s.buttons.children.length, 3);
    for (const [index, kind] of ['cv', 'certificate', 'identification'].entries()) {
        await s.buttons.children[index].events.click();
        assert.match(s.requests.at(-1).url, new RegExp(`/documents/${kind}/download$`));
        assert.equal(s.display.children[0].sandbox, '');
        assert.equal(s.display.children[0].src, 'blob:synthetic-private-pdf');
        assert.equal(s.display.children[1].rel, 'noopener noreferrer');
    }
    for (const request of s.requests) {
        assert.equal(request.headers.Authorization, 'Bearer synthetic-token'); assert.equal(request.cache, 'no-store');
        assert.ok(!request.url.includes('synthetic-token')); assert.ok(!request.url.includes('supabase'));
    }
    s.viewer.clear(); assert.equal(s.display.children.length, 0); assert.equal(s.buttons.children.length, 0);
    assert.equal(s.revoked.length, 3);
});

test('password-only sessions can load PDFs while unauthorized regions cannot', async () => {
    const s = viewerSetup({ status: 403 }); await s.viewer.load('sample');
    assert.equal(s.buttons.children.length, 0); assert.equal(s.display.children.length, 0);
    assert.match(s.feedback.textContent, /authorized/);
});

test('account change clears document contents and stale responses cannot display another application', async () => {
    const s = viewerSetup(); await s.viewer.load('sample'); await s.buttons.children[0].events.click();
    s.auth.currentUser = null; s.changed(null);
    assert.equal(s.display.children.length, 0); assert.equal(s.revoked.length, 1);
    const pending = s.viewer.load('old'); s.viewer.clear(); await pending;
    assert.equal(s.buttons.children.length, 0);
});

test('live status watcher is applicant-scoped, receives review changes and stops after unsubscribe/account changes', async () => {
    let callback, failure, unsubscribed = 0; const updated = [], filters = [];
    const user = { uid: 'alice' }, auth = { currentUser: user };
    const context = vm.createContext({ auth, db: {},
        collection: (_, name) => name, where: (...args) => { filters.push(args); return args; }, query: (...args) => args,
        onSnapshot: (q, cb, fail) => { if (q[0] === 'applications') { callback = cb; failure = fail; } return () => unsubscribed++; } });
    vm.runInContext(strip('js/application-status.js'), context);
    const stop = await context.watchApplicantApplications(user, applications => updated.push(applications), () => {});
    assert.deepEqual(filters[0], ['applicantId', '==', 'alice']);
    for (const status of ['Submitted', 'Under Review', 'Approved', 'Denied']) {
        callback({ docs: [{ id: 'app', data: () => ({ status }) }] }); assert.equal(updated.at(-1)[0].status, status);
    }
    stop(); callback({ docs: [] }); assert.equal(updated.length, 4); assert.equal(unsubscribed, 2);
    auth.currentUser = null; callback({ docs: [] }); assert.equal(updated.length, 4);
});

test('status subscription accepts password sessions and applicant pages include live integration', async () => {
    const auth = { currentUser: { uid: 'alice' } };
    const context = vm.createContext({ auth, db: {},
        collection: (_, name) => name, where: (...args) => args, query: (...args) => args,
        onSnapshot: () => () => {} });
    vm.runInContext(strip('js/application-status.js'), context);
    const stop = await context.watchApplicantApplications(auth.currentUser, () => {}, () => {});
    stop();
    auth.currentUser = null;
    await assert.rejects(context.watchApplicantApplications({ uid: 'alice' }, () => {}, () => {}), /session changed/);
    for (const path of ['Frontend/dashboard.html', 'Frontend/status.html', 'Frontend/admin.html', 'Frontend/apply.html']) {
        const html = fs.readFileSync(path, 'utf8');
        for (const match of html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)) {
            assert.doesNotThrow(() => new vm.SourceTextModule(match[1]));
        }
        if (path.includes('dashboard') || path.includes('status')) assert.match(html, /watchApplicantApplications\(user/);
        assert.doesNotMatch(html, /session-guard\.js/);
    }
});
