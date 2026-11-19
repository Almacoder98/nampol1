const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('js/screening.js', 'utf8').replace(/^import[^\n]+\r?\n/gm, '')
    .replaceAll('export async function', 'async function').replaceAll('export function', 'function');

function setup({ status = 200, changeAccount = false } = {}) {
    const calls = []; const auth = { currentUser: { uid: 'admin', emailVerified: true, getIdToken: async () => 'synthetic-token' } };
    class Element {
        constructor(tag) { this.tag = tag; this.children = []; }
        append(node) { this.children.push(node); }
        replaceChildren() { this.children = []; }
    }
    const context = vm.createContext({ auth, AbortSignal,
        window: { location: { hostname: 'localhost', protocol: 'http:', origin: 'http://localhost:8000' } },
        document: { createElement: tag => new Element(tag) },
        fetch: async (url, request) => {
            calls.push({ url, ...request }); if (changeAccount) auth.currentUser = null;
            return { ok: status === 200, status, json: async () => ({ result: { advisory: true } }) };
        }
    });
    vm.runInContext(source, context); return { context, auth, calls, container: new Element('div') };
}

test('screening GET and POST send only real Firebase bearer credentials, with no caller outcomes', async () => {
    const s = setup();
    await s.context.screeningRequest('sample-app'); await s.context.screeningRequest('sample-app', true);
    assert.equal(s.calls[0].method, 'GET'); assert.equal(s.calls[1].method, 'POST');
    for (const call of s.calls) {
        assert.match(call.url, /^http:\/\/localhost:8001\/api\/admin\/applications\/sample-app\/screening$/);
        assert.equal(call.headers.Authorization, 'Bearer synthetic-token'); assert.equal(call.cache, 'no-store');
        assert.equal(call.body, undefined); assert.equal(call.credentials, 'omit');
    }
});

test('password-only sessions can screen while a changed account never receives a result', async () => {
    const s = setup(); await s.context.screeningRequest('sample');
    assert.equal(s.calls.length, 1);
    await assert.rejects(setup({ changeAccount: true }).context.screeningRequest('sample'), /session changed/);
});

test('denied and unavailable screening does not claim a successful result', async () => {
    for (const status of [401, 403, 404, 409, 429, 503]) {
        await assert.rejects(setup({ status }).context.screeningRequest('sample'));
    }
});

test('CV evidence counts are advisory and do not rank or decide applications', () => {
    const s = setup(); s.context.renderScreening(s.container, { summary: { met: 4, not_met: 0, could_not_verify: 1 } });
    const text = s.container.children.map(node => node.textContent).join('\n');
    assert.match(text, /Possible CV excerpts found for 4 requirement/);
    assert.match(text, /not a score or eligibility decision/);
});

test('renderer uses text-only DOM, labels CV evidence advisory and exposes manual-verification explanations', () => {
    const s = setup(); const malicious = '<img src=x onerror=alert(1)>';
    s.context.renderScreening(s.container, { notice: 'Advisory only', stale: true,
        matchingEngine: 'Local NLP text-match fallback (token overlap)', cvStatus: 'readable',
        criteria: [{ requirement: malicious, status: 'met', explanation: 'Possible supporting evidence found',
            excerpt: 'Synthetic excerpt' }] });
    const text = s.container.children.map(node => node.textContent).join('\n');
    assert.match(text, /OUTDATED/); assert.match(text, /Matching method: Local NLP text-match fallback/);
    assert.match(text, /CV excerpt: "Synthetic excerpt"/); assert.ok(text.includes(malicious));
    assert.match(text, /Possible supporting evidence found/);
    assert.match(text, /never approve or reject/);
    assert.ok(s.container.children.every(node => node.innerHTML === undefined));
});

test('renderer confirms external AI is unused for local screening', () => {
    const s = setup();
    s.context.renderScreening(s.container, {
        aiReview: { status: 'not_used_local_only', message: 'No CV text was sent to an external AI service.' },
    });
    const text = s.container.children.map(node => node.textContent).join('\n');
    assert.match(text, /External AI service: not used/);
    assert.match(text, /No CV text was sent to an external AI service/);
});

test('renderer gives explicit missing and scanned PDF guidance', () => {
    for (const [status, message] of [
        ['missing', /No CV is linked/],
        ['unreadable', /scanned or image-only/],
    ]) {
        const s = setup();
        s.context.renderScreening(s.container, {
            cvStatus: status,
            vacancyResolution: 'matched',
            criteria: [{ requirement: 'First aid', status: 'could_not_verify',
                explanation: 'Needs manual verification; this is not a negative eligibility finding.' }],
        });
        const text = s.container.children.map(node => node.textContent).join('\n');
        assert.match(text, message);
        assert.match(text, /NEEDS MANUAL VERIFICATION/);
        assert.match(text, /not a negative eligibility finding/);
    }
});

test('admin review modal exposes Screen CV for the selected application', () => {
    const admin = fs.readFileSync('Frontend/admin.html', 'utf8');
    assert.match(admin, /id="screenCvBtn">Screen CV/);
    assert.match(admin, /selectedApplication\.id, true/);
});

test('missing server report is shown as unscreened, never inferred from applicant client markers', () => {
    const s = setup(); s.context.renderScreening(s.container, null);
    assert.match(s.container.children[0].textContent, /Not screened/);
});
