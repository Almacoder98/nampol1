const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const strip = file => fs.readFileSync(file, 'utf8').replace(/^import[^\n]+\r?\n/gm, '')
    .replaceAll('export async function', 'async function').replaceAll('export function', 'function');
class Element {
    constructor() { this.children = []; this.events = {}; this.value = ''; this.disabled = false; }
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return this.text || ''; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren() { this.children = []; this.text = ''; }
    addEventListener(name, callback) { this.events[name] = callback; }
    focus() { this.focused = true; }
}
function setup(handler) {
    const requests = [], callbacks = [];
    const auth = { currentUser: { uid: 'admin', getIdToken: async () => 'synthetic-token' } };
    const context = vm.createContext({ auth, crypto: webcrypto, AbortSignal,
        window: { location: { hostname: 'localhost', protocol: 'http:', origin: 'http://localhost:8000' } },
        document: { createElement: () => new Element() },
        onAuthStateChanged: (_, cb) => { callbacks.push(cb); return () => {}; },
        fetch: async (url, init) => {
            requests.push({ url, ...init }); const response = await handler?.(url, init);
            return { ok: (response?.status || 200) === 200, status: response?.status || 200,
                json: async () => response?.body || { result: { status: 'not_shortlisted', version: 0 } } };
        } });
    vm.runInContext(strip('js/shortlisting.js'), context);
    const fields = Object.fromEntries(['add','remove','refresh','reason','status'].map(key => [key, new Element()]));
    let changes = 0;
    const review = context.createShortlistReview(fields, () => { changes++; });
    return { context, auth, requests, fields, review, changes: () => changes,
        changed: user => callbacks.forEach(cb => cb(user)) };
}
const application = { id: 'app', vacancyId: 'job', status: 'Under Review' };

test('password-authenticated shortlist GET/POST use refreshed credentials and only an internal action payload', async () => {
    const s = setup(); await s.review.load(application); s.fields.reason.value = 'Manual review';
    await s.fields.add.events.click();
    assert.equal(s.requests.length, 2);
    for (const call of s.requests) {
        assert.equal(call.url, 'http://localhost:8001/api/admin/applications/app/shortlist');
        assert.equal(call.headers.Authorization, 'Bearer synthetic-token'); assert.equal(call.cache, 'no-store');
        assert.equal(call.credentials, 'omit'); assert.equal(call.redirect, 'error');
    }
    const body = JSON.parse(s.requests[1].body);
    assert.deepEqual(Object.keys(body).sort(), ['action','expectedVersion','reason','requestId']);
    assert.equal(body.action, 'shortlist'); assert.equal(body.expectedVersion, 0);
    assert.equal(s.changes(), 1);
});

test('password-only users can access shortlists; absent or changed accounts cannot receive results', async () => {
    const s = setup(); await s.review.load(application);
    assert.equal(s.requests.length, 1); assert.equal(s.fields.add.disabled, false);
    s.auth.currentUser = null;
    const absent = setup(); absent.auth.currentUser = null; await absent.review.load(application);
    assert.equal(absent.requests.length, 0);
    const changed = setup(() => { changed.auth.currentUser = null; return {}; });
    await changed.review.load(application);
    assert.match(changed.fields.status.textContent, /session changed/);
    assert.equal(changed.fields.add.disabled, true);
});

test('required comments and add/remove buttons reflect a separate shortlist state', async () => {
    let active = false;
    const s = setup((_, request) => {
        if (request.body) active = JSON.parse(request.body).action === 'shortlist';
        return { body: { result: { status: active ? 'shortlisted' : 'not_shortlisted', version: active ? 1 : 2,
            reviewerId: 'admin', reason: '<script>synthetic</script>' } } };
    });
    await s.review.load(application); await s.fields.add.events.click();
    assert.equal(s.requests.length, 1); assert.equal(s.fields.reason.focused, true);
    s.fields.reason.value = 'Suitable for interview'; await s.fields.add.events.click();
    assert.equal(s.fields.add.disabled, true); assert.equal(s.fields.remove.disabled, false);
    assert.match(s.fields.status.textContent, /not final approval/); assert.equal(s.fields.status.innerHTML, undefined);
    s.fields.reason.value = 'Removed after manual review'; await s.fields.remove.events.click();
    assert.equal(s.fields.add.disabled, false); assert.equal(s.fields.remove.disabled, true);
    assert.equal(application.status, 'Under Review');
});

test('retry after an uncertain connection uses the same request ID and original version', async () => {
    let posts = 0;
    const s = setup((_, request) => {
        if (request.body && ++posts === 1) throw Error('Synthetic lost response');
        return { body: { result: { status: posts ? 'shortlisted' : 'not_shortlisted', version: posts ? 1 : 0 } } };
    });
    await s.review.load(application); s.fields.reason.value = 'Human selection';
    await s.fields.add.events.click(); await s.fields.add.events.click();
    assert.equal(s.requests[1].body, s.requests[2].body); assert.equal(s.changes(), 1);
});

test('version conflicts disable further writes until an explicit refresh', async () => {
    const s = setup((_, request) => request.body ? { status: 409, body: { detail: 'Another review changed the shortlist' } } : undefined);
    await s.review.load(application); s.fields.reason.value = 'Manual review'; await s.fields.add.events.click();
    assert.equal(s.fields.add.disabled, true); assert.equal(s.fields.remove.disabled, true);
    assert.equal(s.fields.refresh.disabled, false); assert.match(s.fields.status.textContent, /Refresh/);
});

test('closing or switching accounts clears internal notes and discards pending results', async () => {
    let finish;
    const s = setup(() => new Promise(resolve => { finish = resolve; }));
    const pending = s.review.load(application); await new Promise(resolve => setImmediate(resolve));
    s.review.clear(); finish({ body: { result: { status: 'shortlisted', version: 1, reason: 'PRIVATE' } } }); await pending;
    assert.equal(s.fields.status.textContent, ''); assert.equal(s.fields.add.disabled, true);
    const loaded = setup(() => ({ body: { result: { status: 'shortlisted', version: 1, reason: 'PRIVATE' } } }));
    await loaded.review.load(application); loaded.auth.currentUser = null; loaded.changed(null);
    assert.equal(loaded.fields.status.textContent, '');
});

test('legacy/unlinked and final applications cannot be newly shortlisted in the UI', async () => {
    for (const app of [{ ...application, vacancyId: null }, { ...application, status: 'Approved' }, { ...application, status: 'Denied' }]) {
        const s = setup(); await s.review.load(app); assert.equal(s.fields.add.disabled, true);
    }
});

test('vacancy-specific view uses the authorized endpoint, safe text and correct application review link', async () => {
    const s = setup(() => ({ body: { items: [{ applicationId: 'app', applicantName: '<img onerror=alert(1)>',
        applicationReference: 'SYNTHETIC', applicationStatus: 'Under Review', reason: 'Internal', reviewerId: 'admin', shortlistedAt: 'server-time' }] } }));
    const select = new Element(), refresh = new Element(), output = new Element(), opened = [];
    select.value = 'vacancy-one';
    const view = s.context.createVacancyShortlistView(select, refresh, output, id => opened.push(id));
    await view.load(); assert.match(s.requests[0].url, /vacancies\/vacancy-one\/shortlist$/);
    assert.match(output.children[0].children[0].textContent, /<img/);
    assert.equal(output.children[0].children[0].innerHTML, undefined);
    output.children[0].children[2].events.click(); assert.deepEqual(opened, ['app']);
    s.auth.currentUser = null; s.changed(null); assert.equal(output.children.length, 0);
});

test('applicant live indicators use an owner-only safe mirror and never merge internal notes or overwrite decisions', async () => {
    const callbacks = {}, updated = [], filters = []; let stops = 0;
    const user = { uid: 'alice' }, auth = { currentUser: user };
    const context = vm.createContext({ auth, db: {},
        collection: (_, name) => name, query: (...args) => args,
        where: (...args) => { filters.push(args); return args; },
        onSnapshot: (q, cb) => { callbacks[q[0]] = cb; return () => { stops++; }; } });
    vm.runInContext(strip('js/application-status.js'), context);
    const stop = await context.watchApplicantApplications(user, items => updated.push(items), () => {});
    callbacks.applications({ docs: [{ id: 'app', data: () => ({ status: 'Under Review', shortlistStatus: 'forged' }) }] });
    callbacks.applicantShortlistStatuses({ docs: [{ id: 'app', data: () => ({ status: 'shortlisted', reason: 'NEVER MERGE' }) }] });
    assert.equal(updated.at(-1)[0].status, 'Under Review'); assert.equal(updated.at(-1)[0].shortlistStatus, 'shortlisted');
    assert.equal(updated.at(-1)[0].reason, undefined); assert.deepEqual(filters[1], ['ownerUid','==','alice']);
    assert.match(context.applicantShortlistLabel(updated.at(-1)[0]), /not final approval/);
    callbacks.applicantShortlistStatuses({ docs: [{ id: 'app', data: () => ({ status: 'not_shortlisted' }) }] });
    assert.equal(updated.at(-1)[0].shortlistStatus, 'not_shortlisted');
    stop(); assert.equal(stops, 2);
});

test('both pages preserve legacy Shortlisted as distinct from Approved and show the separate selection indicator', () => {
    for (const page of ['Frontend/dashboard.html','Frontend/status.html']) {
        const html = fs.readFileSync(page, 'utf8');
        const start = html.indexOf('function normaliseStatus('), end = html.indexOf('function getStatusClass(', start);
        const next = html.indexOf('function ', end + 'function getStatusClass('.length);
        const context = vm.createContext({}); vm.runInContext(html.slice(start, next), context);
        assert.equal(context.normaliseStatus('Shortlisted'), 'Shortlisted');
        assert.equal(context.normaliseStatus('Approved'), 'Approved'); assert.equal(context.normaliseStatus('Denied'), 'Denied');
        assert.equal(context.getStatusClass('Shortlisted'), 'status-review');
        assert.ok(html.includes('applicantShortlistLabel(application)'));
    }
});
