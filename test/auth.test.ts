import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DEFAULT_KDF, FAST_KDF, hashPassword, passwordProblem, verifyPassword } from '../src/auth/passwords.ts';
import { AuthError, AuthService } from '../src/auth/service.ts';
import { Database } from '../src/db/database.ts';

async function withAuth(
    run: (auth: AuthService, db: Database) => void | Promise<void>,
    options: { sessionTtlDays?: number; now?: () => Date } = {},
): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), 'story-auth-'));
    const db = new Database(path.join(dir, 'test.sqlite'));

    try {
        const auth = new AuthService(db, { kdf: FAST_KDF, sessionTtlDays: 1, ...options });
        await run(auth, db);
    } finally {
        db.close();
        await rm(dir, { recursive: true, force: true });
    }
}

/** Run `fn`, require it to throw an AuthError, and return its code. */
function throwsCode(fn: () => unknown): string {
    try {
        fn();
    } catch (error) {
        assert.ok(error instanceof AuthError, `expected an AuthError, got ${String(error)}`);
        return error.code;
    }

    assert.fail('expected an AuthError to be thrown');
}

// ------------------------------------------------------------------ passwords

test('a password verifies against its own hash and not against another', () => {
    const { hash, salt } = hashPassword('correct horse battery staple', FAST_KDF);

    assert.equal(verifyPassword('correct horse battery staple', salt, hash), true);
    assert.equal(verifyPassword('wrong password entirely', salt, hash), false);
    assert.equal(verifyPassword('', salt, hash), false);
});

test('the stored hash carries its parameters, so the cost can be raised later', () => {
    // Hashed with the cheap test parameters...
    const { hash, salt } = hashPassword('a-good-password', FAST_KDF);
    assert.match(hash, /^scrypt\$1024\$8\$1\$/);

    // ...and still verifiable after the defaults change, because verification
    // reads N/r/p out of the stored value rather than assuming them.
    assert.equal(DEFAULT_KDF.cost, 16384);
    assert.equal(verifyPassword('a-good-password', salt, hash), true);
});

test('a malformed stored hash reads as a wrong password, not a crash', () => {
    assert.equal(verifyPassword('x', 'salt', 'not-a-hash'), false);
    assert.equal(verifyPassword('x', 'salt', 'scrypt$1024$8$1'), false);
    assert.equal(verifyPassword('x', 'salt', 'bcrypt$1$2$3$AAAA'), false);
});

test('password policy rejects short and oversized passwords', () => {
    assert.equal(passwordProblem('short'), 'password must be at least 8 characters');
    assert.equal(passwordProblem('长密码也需要至少八个字符'), null);
    assert.equal(passwordProblem('x'.repeat(2000)), 'password is too long');
    assert.equal(passwordProblem('long-enough'), null);
});

// ---------------------------------------------------------------- registration

test('the first account becomes an admin, later ones do not', async () => {
    await withAuth((auth) => {
        const first = auth.register({ handle: 'owner', password: 'owner-password' });
        assert.equal(first.user.role, 'admin');
        assert.equal(first.user.status, 'active');
        assert.equal(first.user.handle, 'owner');

        const second = auth.register({ handle: 'guest', password: 'guest-password' });
        assert.equal(second.user.role, 'user');
        assert.equal(auth.count(), 2);
    });
});

test('registration validates the handle and the password, and refuses duplicates', async () => {
    await withAuth((auth) => {
        assert.equal(throwsCode(() => auth.register({ handle: 'ab', password: 'long-enough-password' })), 'invalid_handle');
        assert.equal(throwsCode(() => auth.register({ handle: 'bad handle', password: 'long-enough-password' })), 'invalid_handle');
        assert.equal(throwsCode(() => auth.register({ handle: 'good-handle', password: 'short' })), 'invalid_password');

        auth.register({ handle: 'taken', password: 'long-enough-password' });
        assert.equal(throwsCode(() => auth.register({ handle: 'TAKEN', password: 'long-enough-password' })), 'handle_taken');
    });
});

test('handles are normalised, so case and spaces do not create duplicates', async () => {
    await withAuth((auth) => {
        const created = auth.register({ handle: '  Owner  ', password: 'long-enough-password' });
        assert.equal(created.user.handle, 'owner');

        const same = auth.login('OWNER', 'long-enough-password');
        assert.equal(same.user.id, created.user.id);
    });
});

// --------------------------------------------------------------------- sessions

test('the raw session token is never stored, only its hash', async () => {
    await withAuth((auth, db) => {
        const { token } = auth.register({ handle: 'owner', password: 'long-enough-password' });

        const row = db.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string } | undefined;
        assert.ok(row);
        assert.notEqual(row.token_hash, token);
        assert.equal(row.token_hash.length, 64, 'expected a sha256 hex digest');
        assert.equal(JSON.stringify(db.prepare('SELECT * FROM sessions').all()).includes(token), false);
    });
});

test('login returns a working token and rejects wrong credentials', async () => {
    await withAuth((auth) => {
        auth.register({ handle: 'owner', password: 'long-enough-password' });

        const { token, user } = auth.login('owner', 'long-enough-password');
        assert.equal(user.handle, 'owner');
        assert.equal(auth.authenticate(token)?.id, user.id);

        assert.equal(throwsCode(() => auth.login('owner', 'wrong-password')), 'invalid_credentials');
        assert.equal(throwsCode(() => auth.login('nobody', 'long-enough-password')), 'invalid_credentials');
    });
});

test('unknown and malformed tokens do not authenticate', async () => {
    await withAuth((auth) => {
        assert.equal(auth.authenticate('not-a-real-token'), null);
        assert.equal(auth.authenticate(''), null);
    });
});

test('an expired session stops working and is cleaned up', async () => {
    let now = new Date('2026-09-21T10:00:00.000Z');

    await withAuth((auth, db) => {
        const { token } = auth.register({ handle: 'owner', password: 'long-enough-password' });
        assert.ok(auth.authenticate(token));

        // Move past the one-day TTL.
        now = new Date('2026-09-23T10:00:00.000Z');
        assert.equal(auth.authenticate(token), null);

        const remaining = db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number };
        assert.equal(Number(remaining.count), 0, 'an expired session should be deleted on use');
    }, { now: () => now });
});

test('logout revokes one session; disabling an account revokes them all', async () => {
    await withAuth((auth) => {
        const { user } = auth.register({ handle: 'owner', password: 'long-enough-password' });
        const first = auth.login('owner', 'long-enough-password');
        const second = auth.login('owner', 'long-enough-password');

        assert.equal(auth.logout(first.token), true);
        assert.equal(auth.authenticate(first.token), null);
        assert.ok(auth.authenticate(second.token), 'the other session must survive');
        assert.equal(auth.logout('never-issued'), false);

        auth.setStatus(user.id, 'disabled');
        assert.equal(auth.authenticate(second.token), null, 'disabling must revoke every session');
        assert.equal(throwsCode(() => auth.login('owner', 'long-enough-password')), 'account_disabled');
    });
});

test('re-enabling an account lets it log in again', async () => {
    await withAuth((auth) => {
        const { user } = auth.register({ handle: 'owner', password: 'long-enough-password' });
        auth.setStatus(user.id, 'disabled');
        auth.setStatus(user.id, 'active');

        const { token } = auth.login('owner', 'long-enough-password');
        assert.ok(auth.authenticate(token));
    });
});

test('users can be listed and looked up', async () => {
    await withAuth((auth) => {
        const owner = auth.register({ handle: 'owner', password: 'long-enough-password' }).user;
        auth.register({ handle: 'guest', password: 'long-enough-password' });

        assert.equal(auth.get(owner.id)?.handle, 'owner');
        assert.equal(auth.get('no-such-id'), null);
        assert.equal(auth.findByHandle('GUEST')?.handle, 'guest');
        assert.deepEqual(auth.list().map((entry) => entry.handle), ['owner', 'guest']);

        const disabled = auth.setStatus(owner.id, 'disabled');
        assert.equal(disabled.status, 'disabled');
        assert.equal(throwsCode(() => auth.setStatus('nope', 'active')), 'user_not_found');
    });
});

// ------------------------------------------------------- changing a password

test('changing a password needs the old one and logs every other session out', async () => {
    await withAuth((auth) => {
        const owner = auth.register({ handle: 'owner', password: 'first-long-password' });
        const kept = auth.register({ handle: 'nobody', password: 'other-long-password' });

        // A second session for the same account, as if from another browser.
        const thief = auth.login('owner', 'first-long-password');
        assert.ok(auth.authenticate(thief.token) !== null);

        // A live session is not enough to re-key the account: a stolen cookie must
        // not be able to lock the real owner out.
        assert.equal(throwsCode(() => auth.changePassword(owner.user.id, 'guess', 'brand-new-password')), 'invalid_credentials');

        const issued = auth.changePassword(owner.user.id, 'first-long-password', 'brand-new-password');
        assert.equal(issued.token !== owner.token, true, 'a fresh token comes back');

        // Everyone else is out — including the session that was stolen.
        assert.equal(auth.authenticate(thief.token), null);
        assert.equal(auth.authenticate(owner.token), null);
        assert.ok(auth.authenticate(issued.token) !== null, 'the caller stays signed in');

        // And the old password no longer opens the door.
        assert.equal(throwsCode(() => auth.login('owner', 'first-long-password')), 'invalid_credentials');
        assert.ok(auth.login('owner', 'brand-new-password').token.length > 0);

        // A password change is not an excuse to skip the rules.
        assert.equal(throwsCode(() => auth.changePassword(owner.user.id, 'brand-new-password', 'short')), 'invalid_password');

        // Other accounts are untouched.
        assert.ok(auth.authenticate(kept.token) !== null);
    });
});

test('an operator can reset a password, and that also clears the sessions', async () => {
    await withAuth((auth) => {
        const owner = auth.register({ handle: 'owner', password: 'first-long-password' });
        const inside = auth.login('owner', 'first-long-password');

        auth.resetPassword(owner.user.id, 'recovered-long-password');

        assert.equal(auth.authenticate(inside.token), null);
        assert.equal(throwsCode(() => auth.login('owner', 'first-long-password')), 'invalid_credentials');
        assert.ok(auth.login('owner', 'recovered-long-password').token.length > 0);
        assert.equal(throwsCode(() => auth.resetPassword('missing', 'whatever-long')), 'not_found');
    });
});

test('account counts add up to the listing', async () => {
    await withAuth((auth) => {
        assert.deepEqual(auth.counts(), { total: 0, active: 0, disabled: 0 });

        const owner = auth.register({ handle: 'owner', password: 'first-long-password' });
        const guest = auth.register({ handle: 'guest', password: 'other-long-password' });
        auth.setStatus(guest.user.id, 'disabled');

        assert.deepEqual(auth.counts(), { total: 2, active: 1, disabled: 1 });
        assert.equal(auth.counts().total, auth.list().length);
        assert.ok(owner.user.id.length > 0);
    });
});
