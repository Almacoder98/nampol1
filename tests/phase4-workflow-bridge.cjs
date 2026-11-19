// Runs the actual submission/review client functions against an offline adapter.
// Firestore emulator tests separately enforce the real authorization boundary.
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { TextEncoder } = require('node:util');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const writes = [];
const snapshot = ref => {
    const value = input.records[ref.collection + '/' + ref.id];
    return { exists: () => value !== undefined, data: () => value };
};
const user = { uid: input.uid, getIdToken: async () => 'offline-fixture-token' };
const context = vm.createContext({ db: {}, auth: { currentUser: user }, crypto: webcrypto, TextEncoder,
    AbortController, setTimeout, clearTimeout, console: { error() {}, warn() {} },
    window: { location: { hostname: 'localhost', protocol: 'http:', origin: 'http://localhost:8000' } },
    doc: (_, collection, id) => ({ collection, id }), collection: (_, collection) => ({ collection }),
    query: (...args) => args, where: (...args) => args, getDocs: async () => ({ empty: true }),
    getDoc: async ref => snapshot(ref), serverTimestamp: () => '__SERVER_TIME__',
    fetch: async (url, request) => {
        if (url !== 'http://localhost:8001/api/me/document-sets' || request.headers.Authorization !== 'Bearer offline-fixture-token')
            throw Error('Unexpected endpoint or authorization');
        return { ok: true, status: 200, json: async () => ({ sets: input.sets || [] }) };
    },
    writeBatch: () => ({ set: (ref, data) => writes.push({ ref, data, operation: 'create' }), commit: async () => {} }),
    runTransaction: async (_, callback) => callback({ get: async ref => snapshot(ref),
        update: (ref, data) => writes.push({ ref, data, operation: 'update' }),
        set: (ref, data) => writes.push({ ref, data, operation: 'create' }) })
});
async function run() {
    let result;
    if (input.mode === 'submit') {
        const source = fs.readFileSync('js/firestore.js', 'utf8')
            .replace(/^import[\s\S]*?from "[^"]+";\r?\n/gm, '').replaceAll('export async function', 'async function');
        vm.runInContext(source, context);
        result = await context.submitApplication(input.application);
    } else {
        const source = fs.readFileSync('js/admin.js', 'utf8');
        vm.runInContext(source.slice(source.indexOf('export async function startApplicationReview'),
            source.indexOf('// GET REGIONAL STATISTICS')).replaceAll('export async function', 'async function'), context);
        if (input.mode === 'start') await context.startApplicationReview(input.applicationId, input.admin);
        else await context.reviewApplication(input.applicationId, input.decision, input.reason, input.admin);
        result = { success: true };
    }
    process.stdout.write(JSON.stringify({ result, writes }));
}
run().catch(error => { process.stderr.write(error.message); process.exitCode = 1; });
