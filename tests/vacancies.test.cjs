const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'Frontend/admin.html'), 'utf8');
const vacancyCode = html.slice(html.indexOf('    const vacancyForm ='), html.indexOf('    // ========================================================\n    // PROTECT THIS PAGE'));

class Element {
    constructor() {
        this.value = ''; this.children = []; this.handlers = {}; this.disabled = false;
        this.classList = { add() {}, remove() {} };
    }
    addEventListener(name, callback) { this.handlers[name] = callback; }
    append(...children) { this.children.push(...children); }
    replaceChildren() { this.children = []; }
    scrollIntoView() {}
}
function setup(admin = { active: true, role: 'admin', region: 'Khomas' }, jobs = []) {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
    };
    const submit = new Element();
    element('vacancyForm').querySelector = () => submit;
    element('vacancyForm').reset = () => {
        for (const id of ['jobTitle', 'jobRegion', 'jobDescription', 'jobRequirements']) element(id).value = '';
    };
    const calls = { queries: [], creates: [], updates: [], messages: [], tokens: [] };
    const context = vm.createContext({
        currentAdmin: admin, db: {}, console: { error() {} }, confirm: () => true,
        document: { getElementById: element, createElement: () => new Element() },
        auth: { currentUser: { getIdTokenResult: async force => { calls.tokens.push(force); return { claims: { email_verified: true } }; } } },
        collection: (_, name) => ({ collection: name }),
        where: (field, operator, value) => ({ field, operator, value }),
        query: (collection, ...filters) => ({ ...collection, filters }),
        doc: (_, collection, id) => ({ collection, id }),
        serverTimestamp: () => 'SERVER_TIMESTAMP',
        getDocs: async query => {
            calls.queries.push(query);
            return { empty: jobs.length === 0, docs: jobs.map(job => ({ id: job.id, data: () => job })) };
        },
        addDoc: async (ref, data) => calls.creates.push({ ref, data }),
        updateDoc: async (ref, data) => calls.updates.push({ ref, data }),
        deleteDoc: async () => {},
        showMessage: (_, message) => calls.messages.push(message)
    });
    vm.runInContext(vacancyCode, context);
    const run = code => vm.runInContext(code, context);
    run('resetVacancyForm()');
    const fill = () => {
        element('jobTitle').value = ' Police Constable ';
        element('jobDescription').value = ' Recruitment ';
        element('jobRequirements').value = ' Certificate ';
    };
    return { context, element, submit, calls, run, fill, save: () => element('vacancyForm').handlers.submit({ preventDefault() {} }) };
}

test('regional loading uses exact assigned region; super admin loads across regions', async () => {
    for (const role of ['admin', 'recruiter', 'super_admin']) {
        const s = setup({ active: true, role, region: 'Khomas' });
        await s.run('loadVacancies()');
        assert.equal(s.calls.tokens[0], true);
        const q = s.calls.queries[0];
        assert.equal(q.collection, 'jobs');
        if (role === 'super_admin') assert.equal(q.filters, undefined);
        else assert.equal(JSON.stringify(q.filters), JSON.stringify([{ field: 'region', operator: '==', value: 'Khomas' }]));
    }
});

test('invalid or missing admin scope never queries or writes', async () => {
    for (const admin of [null, { active: false, role: 'admin', region: 'Khomas' }, { active: true, role: 'applicant', region: 'Khomas' }, { active: true, role: 'admin', region: '' }, { active: true, role: 'admin', region: '  ' }]) {
        const s = setup(admin);
        await s.run('loadVacancies()'); await s.save();
        assert.equal(s.calls.queries.length, 0); assert.equal(s.calls.creates.length, 0);
        assert.equal(s.submit.disabled, true);
    }
});

test('unverified token blocks vacancy query and explains verification', async () => {
    const s = setup();
    s.context.auth.currentUser.getIdTokenResult = async () => ({ claims: { email_verified: false } });
    await s.run('loadVacancies()');
    assert.equal(s.calls.queries.length, 0);
    assert.match(s.calls.messages[0], /Verify your administrator email/);
});

test('repeated publishing restores region and ignores a tampered regional input', async () => {
    const s = setup();
    for (let i = 0; i < 2; i++) {
        s.fill(); s.element('jobRegion').value = 'Erongo'; await s.save();
        const data = s.calls.creates[i].data;
        assert.deepEqual(Object.keys(data).sort(), ['title', 'region', 'description', 'requirements', 'status', 'published', 'createdAt', 'updatedAt'].sort());
        assert.equal(data.region, 'Khomas'); assert.equal(data.title, 'Police Constable');
        assert.equal(data.status, 'Open'); assert.equal(data.published, true);
        assert.equal(data.createdAt, 'SERVER_TIMESTAMP'); assert.equal(data.updatedAt, 'SERVER_TIMESTAMP');
        assert.equal(s.element('jobRegion').value, 'Khomas'); assert.equal(s.element('jobRegion').readOnly, true);
    }
});

test('publishing refreshes verification before writing and blocks invalid sessions', async () => {
    for (const state of ['verified', 'unverified', 'signed-out']) {
        const s = setup();
        s.fill();
        if (state === 'signed-out') s.context.auth.currentUser = null;
        else s.context.auth.currentUser.getIdTokenResult = async force => {
            s.calls.tokens.push(force);
            return { claims: { email_verified: state === 'verified' } };
        };
        s.context.addDoc = async (ref, data) => {
            assert.equal(s.calls.tokens[0], true, 'refresh must precede the write');
            s.calls.creates.push({ ref, data });
        };
        await s.save();
        assert.equal(s.calls.creates.length, state === 'verified' ? 1 : 0);
        assert.equal(s.submit.disabled, false);
        if (state !== 'verified') {
            assert.equal(s.element('jobTitle').value, ' Police Constable ');
            assert.match(s.calls.messages[0], state === 'unverified' ? /Verify/ : /sign in again/);
        }
    }
});

test('a failed publishing request preserves the form and allows retry', async () => {
    const s = setup();
    s.fill();
    const create = s.context.addDoc;
    s.context.addDoc = async () => { throw { code: 'permission-denied' }; };
    await s.save();
    assert.equal(s.calls.creates.length, 0);
    assert.equal(s.submit.disabled, false);
    assert.equal(s.element('jobTitle').value, ' Police Constable ');
    assert.equal(s.element('jobRegion').value, 'Khomas');
    assert.match(s.calls.messages[0], /deployed \/jobs rules/);
    s.context.addDoc = create;
    await s.save();
    assert.equal(s.calls.creates.length, 1);
    assert.equal(s.calls.creates[0].data.region, 'Khomas');
    assert.equal(s.element('jobTitle').value, '');
});

test('super admin publishes to chosen region without an assigned region', async () => {
    const s = setup({ active: true, role: 'super_admin' });
    s.fill(); s.element('jobRegion').value = ' Erongo '; await s.save();
    assert.equal(s.calls.creates[0].data.region, 'Erongo');
    assert.equal(s.element('jobRegion').readOnly, false);
});

test('edit, close/reopen, publish/unpublish preserve immutable fields', async () => {
    for (const status of ['Open', 'Closed']) {
        const published = status === 'Open';
        const s = setup(undefined, [{ id: 'job1', title: 'Constable', region: 'Khomas', description: 'Old', requirements: '', status, published }]);
        await s.run('loadVacancies()');
        const actions = s.element('adminJobsList').children[0].children[1].children;
        await actions[0].handlers.click();
        assert.equal(s.element('jobRegion').readOnly, true);
        s.fill(); await s.save();
        assert.deepEqual(Object.keys(s.calls.updates[0].data).sort(), ['title', 'description', 'requirements', 'updatedAt'].sort());
        await actions[1].handlers.click();
        assert.equal(s.calls.updates[1].data.status, status === 'Open' ? 'Closed' : 'Open');
        await actions[2].handlers.click();
        assert.equal(s.calls.updates[2].data.published, !published);
    }
});

test('permission failures explain deployed rules; failed actions can be retried', async () => {
    const s = setup(undefined, [{ id: 'job1', title: 'Constable', region: 'Khomas', status: 'Open', published: true }]);
    await s.run('loadVacancies()');
    const close = s.element('adminJobsList').children[0].children[1].children[1];
    s.context.updateDoc = async () => { throw { code: 'permission-denied' }; };
    await close.handlers.click();
    assert.equal(close.disabled, false);
    assert.match(s.calls.messages[0], /deployed \/jobs rules/);
    s.context.getDocs = async () => { throw { code: 'permission-denied' }; };
    await s.run('loadVacancies()');
    assert.match(s.calls.messages[1], /admins\/\{Firebase UID\}/);
});

test('public listing query requires both published and Open', async () => {
    const s = setup();
    const source = fs.readFileSync(path.join(root, 'js/jobs.js'), 'utf8')
        .replace(/^import .*;\r?\n/gm, '').replace('export async function', 'async function');
    vm.runInContext(source, s.context);
    await s.run('getOpenJobs()');
    assert.equal(JSON.stringify(s.calls.queries[0].filters), JSON.stringify([
        { field: 'status', operator: '==', value: 'Open' },
        { field: 'published', operator: '==', value: true }
    ]));
    assert.match(fs.readFileSync(path.join(root, 'Frontend/index.html'), 'utf8'), /await getOpenJobs\(\)/);
});

test('admin and homepage inline scripts and jobs module parse', () => {
    for (const filename of ['Frontend/admin.html', 'Frontend/index.html', 'js/jobs.js']) {
        const source = fs.readFileSync(path.join(root, filename), 'utf8');
        const scripts = filename.endsWith('.js') ? [source]
            : [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
        for (const script of scripts) {
            assert.doesNotThrow(() => new vm.SourceTextModule(script), filename);
        }
    }
});
