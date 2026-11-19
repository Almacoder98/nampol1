const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('public registration hardcodes applicant role and never writes admin collections', async () => {
    const source = fs.readFileSync('js/auth.js', 'utf8').replace(/^import[\s\S]*?from "[^"]+";\r?\n/gm, '')
        .replaceAll('export async function', 'async function').replaceAll('export function', 'function');
    const writes = [];
    const context = vm.createContext({ auth: {}, db: {}, console: { error() {} },
        createUserWithEmailAndPassword: async () => ({ user: { uid: 'new-applicant' } }),
        doc: (_, collection, uid) => ({ collection, uid }), serverTimestamp: () => 'server time',
        writeBatch: () => ({ set: (ref, data) => writes.push({ ref, data }), commit: async () => {} }),
        sendEmailVerification: async () => {}, signOut: async () => {}         });

        test('applicant login uses Firebase email and password', async () => {
            const source = fs.readFileSync('js/auth.js', 'utf8').replace(/^import[\s\S]*?from "[^"]+";\r?\n/gm, '')
                .replaceAll('export async function', 'async function').replaceAll('export function', 'function');
            const calls = [];
            const user = { uid: 'applicant', emailVerified: true };
            const context = vm.createContext({ auth: {}, db: {}, console: { error() {} },
                signInWithEmailAndPassword: async (auth, email, password) => {
                    calls.push([auth, email, password]);
                    return { user };
                },
                doc: (_, collection, uid) => ({ collection, uid }),
                getDoc: async () => ({ exists: () => true, data: () => ({ role: 'applicant', accountStatus: 'active' }) }),
                writeBatch: () => ({ set() {}, commit: async () => {} }),
                serverTimestamp: () => 'server time',
                signOut: async () => {}
            });
            vm.runInContext(source, context);
            const result = await context.loginUser('sample@example.invalid', 'not-real');
            assert.equal(result.success, true);
            assert.equal(result.user, user);
            assert.equal(calls.length, 1);
            assert.deepEqual(calls[0], [context.auth, 'sample@example.invalid', 'not-real']);
        });
    vm.runInContext(source, context);
    const result = await context.registerUser('sample@example.invalid', 'not-real', { role: 'super_admin', staffNumber: 'STOLEN-001' });
    assert.equal(result.success, true);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].ref.collection, 'users');
    assert.equal(writes[0].data.role, 'applicant');
    assert.equal(writes[0].data.staffNumber, undefined);
});

test('administrator signs in with password then asks backend for its grant; never trusts a client role', async () => {
    const source = fs.readFileSync('js/admin.js', 'utf8').replace(/^import[\s\S]*?from "[^"]+";\r?\n/gm, '')
        .replaceAll('export async function', 'async function').replaceAll('export function', 'function');
    const calls = [];
    const user = { uid: 'staff', emailVerified: true };
    const auth = { currentUser: null };
    const context = vm.createContext({ auth, db: {},
        signInWithEmailAndPassword: async (actual, email, password) => {
            assert.equal(actual, auth);
            assert.equal(email, 'sample@example.invalid');
            assert.equal(password, 'not-real');
            calls.push('password');
            auth.currentUser = user;
            return { user };
        },
        completeAdminAccess: async actual => { assert.equal(actual, user); calls.push('backend'); return { role: 'admin', region: 'Khomas' }; },
        signOut: async () => { auth.currentUser = null; } });
    vm.runInContext(source, context);
    const result = await context.loginAdmin('sample@example.invalid', 'not-real');
    assert.equal(result.success, true);
    assert.deepEqual(calls, ['password', 'backend']);
});
