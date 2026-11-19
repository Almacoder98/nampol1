const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('Frontend/profile.html', 'utf8');
const source = fs.readFileSync('js/profile.js', 'utf8')
    .replace(/^import[\s\S]*?from "[^"]+";\r?\n/gm, '');
const ready = (id = 'a', date = '2026-10-21') => ({
    setId: id.repeat(32), schemaVersion: 1, state: 'ready', createdAt: date,
    documents: Object.fromEntries(['cv', 'certificate', 'identification'].map(kind => [kind, {
        fileName: `${kind}-synthetic.pdf`, fileSize: 100, mimeType: 'application/pdf', scanStatus: 'clean'
    }]))
});

async function setup(options = {}) {
    const nodes = new Map();
    function node(id) {
        if (!nodes.has(id)) {
            assert.match(html, new RegExp(`id="${id}"`), `element exists: ${id}`);
            const classes = new Set();
            const tag = html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`))[0];
            for (const c of (tag.match(/class="([^"]*)"/)?.[1] || '').split(' ')) classes.add(c);
            nodes.set(id, { value: '', textContent: '', disabled: false, events: {}, className: '',
                classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
                addEventListener(name, callback) { this.events[name] = callback; }, focus() { this.focused = true; }
            });
        }
        return nodes.get(id);
    }
    const profile = { firstName: 'Synthetic', lastName: 'Applicant', email: 'saved@example.invalid',
        phone: '000000000', region: 'Khomas', address: 'Synthetic address', highestQualification: 'Grade 12',
        employmentStatus: 'Student', skills: ['Typing'], profileCompleted: true,
        role: 'applicant', accountStatus: 'active', ...options.profile };
    const requests = [], updates = [], viewers = [], timers = [], objects = [], revoked = [];
    const user = { uid: 'synthetic-applicant', email: 'registered@example.invalid', emailVerified: true,
        getIdToken: async refresh => { assert.equal(refresh, true); return 'synthetic-firebase-token'; } };
    const auth = { currentUser: user };
    let callback;
    let signedOut = 0;
    const context = vm.createContext({
        auth, db: {}, console: { error() {} }, alert() {}, AbortController,
        document: { getElementById: node },
        window: { location: { hostname: '127.0.0.1', protocol: 'http:', origin: 'http://127.0.0.1:8000' },
            scrollTo() {}, open(url, target) {
                assert.equal(url, 'about:blank'); assert.equal(target, '_blank');
                const viewer = { location: {}, close() { this.closed = true; } }; viewers.push(viewer); return viewer;
            } },
        onAuthStateChanged: (_, cb) => { callback = cb; },
        signOut: async () => { signedOut++; auth.currentUser = null; },
        doc: (_, collection, id) => { assert.equal(collection, 'users'); assert.equal(id, user.uid); return { collection, id }; },
        getDoc: async () => ({ exists: () => options.exists !== false, data: () => profile }),
        serverTimestamp: () => 'synthetic-timestamp',
        writeBatch: () => ({ update(ref, data) { updates.push({ ref, data }); }, async commit() {
            if (options.saveError) throw Error('synthetic save failure');
        } }),
        setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; }, clearTimeout() {},
        URL: { createObjectURL(blob) { objects.push(blob); return 'blob:synthetic-pdf'; }, revokeObjectURL(url) { revoked.push(url); } },
        fetch: async (url, init) => {
            requests.push({ url, ...init });
            return { ok: true, status: 200,
                json: async () => ({ sets: options.sets || [ready()] }),
                blob: async () => ({ type: options.blobType || 'application/pdf' }) };
        }
    });
    vm.runInContext(source, context);
    await callback(user);
    return { node, profile, requests, updates, user, auth, context, viewers, timers, objects, revoked, callback,
        signedOut: () => signedOut, click: id => node(id).events.click(),
        submit: () => node('profileForm').events.submit({ preventDefault() {} }) };
}

test('dashboard changes only its existing My Documents action to My Profile; profile has two simple sections', () => {
    const dashboard = fs.readFileSync('Frontend/dashboard.html', 'utf8');
    assert.match(dashboard, /href="profile.html"\s+class="btn btn-secondary-dashboard"\s*>\s*My Profile/);
    assert.doesNotMatch(dashboard, />\s*My Documents\s*</);
    assert.match(dashboard, /href="apply.html"\s+class="btn btn-dashboard"\s*>\s*New Application/);
    assert.match(dashboard, /href="status.html"\s+class="btn btn-secondary-dashboard"\s*>\s*Check Status/);
    assert.match(html, /My Applicant Profile/);
    assert.equal((html.match(/class="section-title"/g) || []).length, 2);
    assert.doesNotMatch(html, /Upload confirmed|scan clean|verification label|Example:/i);
});

test('loads the signed-in applicant profile and registered email into the summary', async () => {
    const s = await setup();
    assert.equal(s.node('savedFullName').textContent, 'Synthetic Applicant');
    assert.equal(s.node('savedEmail').textContent, s.user.email);
    assert.equal(s.node('savedPhone').textContent, s.profile.phone);
    assert.equal(s.node('savedRegion').textContent, s.profile.region);
    assert.equal(s.node('profileSummary').classList.contains('d-none'), false);
    assert.equal(s.node('profileForm').classList.contains('d-none'), true);
    assert.equal(s.node('profilePage').classList.contains('d-none'), false);
});

test('edit saves only existing permitted fields, keeps completed region fixed, and returns to summary', async () => {
    const s = await setup();
    await s.click('editProfileBtn');
    assert.equal(s.node('profileForm').classList.contains('d-none'), false);
    assert.equal(s.node('region').disabled, true);
    s.node('phone').value = ' 111111111 ';
    s.node('region').value = 'Erongo'; // DOM tampering cannot replace the locked region.
    s.node('skills').value = 'Typing, , Communication';
    await s.submit();
    assert.equal(s.updates.length, 1);
    assert.equal(s.updates[0].ref.id, s.user.uid);
    assert.equal(s.updates[0].data.phone, '111111111');
    assert.equal(s.updates[0].data.region, 'Khomas');
    assert.deepEqual(Object.keys(s.updates[0].data).sort(), ['address', 'employmentStatus', 'highestQualification',
        'phone', 'profileCompleted', 'region', 'skills', 'updatedAt']);
    assert.equal(s.node('savedPhone').textContent, '111111111');
    assert.equal(s.node('profileForm').classList.contains('d-none'), true);
    assert.equal(s.context.window.location.href, undefined);
});

test('academic points are optional, editable, applicant-declared and preserved in profile summary', async () => {
    const s = await setup({ profile: { academicPoints: 32 } });
    assert.equal(s.node('academicPoints').value, '32');
    assert.match(s.node('savedAcademicPoints').textContent, /32.*not verified/);
    await s.click('editProfileBtn'); s.node('academicPoints').value = '35'; await s.submit();
    assert.equal(s.updates[0].data.academicPoints, 35);
    assert.match(s.node('savedAcademicPoints').textContent, /^35/);
    await s.click('editProfileBtn'); s.node('academicPoints').value = ''; await s.submit();
    assert.equal(s.updates[1].data.academicPoints, null);
    assert.equal(s.node('savedAcademicPoints').textContent, 'Not recorded');
});

test('invalid academic points cannot save; zero remains a recorded value', async () => {
    for (const value of ['-1', '1.5', 'not-a-number', 'Infinity']) {
        const s = await setup(); await s.click('editProfileBtn'); s.node('academicPoints').value = value;
        await s.submit(); assert.equal(s.updates.length, 0); assert.match(s.node('alertBox').textContent, /whole number/);
    }
    const s = await setup(); await s.click('editProfileBtn'); s.node('academicPoints').value = '0';
    await s.submit(); assert.equal(s.updates[0].data.academicPoints, 0);
});

test('cancel discards edits; invalid input and failed saves do not change the summary', async () => {
    const s = await setup();
    await s.click('editProfileBtn'); s.node('phone').value = 'changed'; await s.click('cancelEditBtn');
    assert.equal(s.node('phone').value, s.profile.phone);
    assert.equal(s.updates.length, 0);
    await s.click('editProfileBtn'); s.node('phone').value = ''; await s.submit();
    assert.equal(s.updates.length, 0);
    const failure = await setup({ saveError: true });
    await failure.click('editProfileBtn'); failure.node('phone').value = '111'; await failure.submit();
    assert.equal(failure.node('savedPhone').textContent, failure.profile.phone);
    assert.equal(failure.node('saveBtn').disabled, false);
    assert.equal(failure.node('profileForm').classList.contains('d-none'), false);
    assert.match(failure.node('alertBox').textContent, /Unable to save/);
});

test('first-time profile completion retains the existing document-upload redirect', async () => {
    const s = await setup({ profile: { profileCompleted: false } });
    assert.equal(s.node('profileForm').classList.contains('d-none'), false);
    assert.equal(s.requests.length, 0);
    assert.equal(s.node('region').disabled, false);
    await s.submit();
    s.timers.find(timer => timer.delay === 1500).fn();
    assert.equal(s.context.window.location.href, 'documents.html');
    assert.equal(s.updates[0].data.profileCompleted, true);
});

test('shows filenames from the newest complete ready PDF set, using text rather than HTML', async () => {
    const newest = ready('b', '2026-10-22');
    newest.documents.cv.fileName = '<script>synthetic.pdf</script>';
    const failed = { ...ready('c', '2026-10-23'), state: 'failed' };
    const s = await setup({ sets: [ready(), newest, failed] });
    assert.equal(s.node('cvFileName').textContent, newest.documents.cv.fileName);
    assert.equal(s.node('viewCvBtn').classList.contains('d-none'), false);
    await s.click('viewCvBtn');
    assert.match(s.requests[1].url, new RegExp(`/me/document-sets/${'b'.repeat(32)}/cv/download$`));
});

test('empty, failed, incomplete and non-PDF sets never create fake filenames or view actions', async () => {
    const incomplete = ready(); delete incomplete.documents.cv;
    const image = ready(); image.documents.cv.mimeType = 'image/png';
    for (const sets of [[], [{ ...ready(), state: 'failed' }], [incomplete], [image]]) {
        const s = await setup({ sets });
        assert.equal(s.node('cvFileName').textContent, '—');
        assert.equal(s.node('viewCvBtn').classList.contains('d-none'), true);
        await s.click('viewCvBtn'); assert.equal(s.requests.length, 1);
    }
});

test('all three PDF views use refreshed Firebase bearer tokens and owner-scoped endpoints, then revoke blob URLs', async () => {
    const s = await setup();
    for (const [button, kind] of [['viewCvBtn', 'cv'], ['viewCertificateBtn', 'certificate'], ['viewIdentificationBtn', 'identification']]) {
        await s.click(button);
        const request = s.requests.at(-1);
        assert.equal(request.url, `http://127.0.0.1:8001/api/me/document-sets/${'a'.repeat(32)}/${kind}/download`);
        assert.equal(request.headers.Authorization, 'Bearer synthetic-firebase-token');
        assert.equal(request.credentials, 'omit'); assert.equal(request.cache, 'no-store'); assert.equal(request.redirect, 'error');
        assert.equal(s.viewers.at(-1).opener, null);
        assert.equal(s.viewers.at(-1).location.href, 'blob:synthetic-pdf');
    }
    for (const timer of s.timers.filter(timer => timer.delay === 60000)) timer.fn();
    assert.equal(s.revoked.length, 3);
});

test('expired tokens, denied downloads and unexpected content close the viewer without exposing a document', async () => {
    for (const failure of ['token', 401, 403, 503, 'content']) {
        const s = await setup({ blobType: failure === 'content' ? 'text/html' : 'application/pdf' });
        if (failure === 'token') s.user.getIdToken = async () => { throw Error('Synthetic expired token'); };
        else if (typeof failure === 'number') s.context.fetch = async () => ({ ok: false, status: failure });
        await s.click('viewCvBtn');
        assert.equal(s.viewers[0].closed, true); assert.equal(s.objects.length, 0);
        assert.equal(s.node('viewCvBtn').disabled, false);
    }
});

test('account switches during download never display the prior account PDF or allow its profile to be saved', async () => {
    const s = await setup();
    s.context.fetch = async () => ({ ok: true, status: 200, blob: async () => {
        s.auth.currentUser = { uid: 'other' }; return { type: 'application/pdf' };
    } });
    await s.click('viewCvBtn');
    assert.equal(s.viewers[0].closed, true); assert.equal(s.objects.length, 0);
    await s.submit(); assert.equal(s.updates.length, 0);
    await s.callback(null);
    assert.equal(s.node('viewCvBtn').classList.contains('d-none'), true);
    assert.equal(s.node('cvFileName').textContent, '—');
    assert.equal(s.context.window.location.href, 'login.html');
});

test('unverified, inactive, non-applicant and missing-profile sessions cannot load documents', async () => {
    for (const opts of [{ profile: { accountStatus: 'inactive' } }, { profile: { role: 'admin' } }, { exists: false }]) {
        const s = await setup(opts);
        assert.equal(s.requests.length, 0); assert.equal(s.signedOut(), 1);
        assert.equal(s.context.window.location.href, 'login.html');
    }
    const s = await setup(); s.requests.length = 0; s.user.emailVerified = false;
    await s.callback(s.user); assert.equal(s.requests.length, 0); assert.equal(s.signedOut(), 1);
});

test('document service failure leaves personal information and editing available', async () => {
    const s = await setup();
    s.context.fetch = async () => { throw Error('Synthetic offline service'); };
    await s.callback(s.user);
    assert.equal(s.node('savedPhone').textContent, s.profile.phone);
    assert.equal(s.node('profilePage').classList.contains('d-none'), false);
    assert.equal(s.node('viewCvBtn').classList.contains('d-none'), true);
    await s.click('editProfileBtn'); assert.equal(s.node('profileForm').classList.contains('d-none'), false);
});
