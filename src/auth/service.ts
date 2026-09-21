/**
 * Accounts and sessions.
 *
 * Sessions are opaque random tokens whose SHA-256 is stored — a leaked database
 * does not hand out working sessions. Opaque tokens over JWT on purpose: logging
 * someone out must actually revoke access, and there is no key to rotate.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { Database } from '../db/database.ts';
import { DEFAULT_KDF, hashPassword, passwordProblem, verifyPassword, type KdfParams } from './passwords.ts';

export type UserRole = 'user' | 'admin';
export type UserStatus = 'active' | 'disabled';

export interface User {
    id: string;
    handle: string;
    displayName: string;
    role: UserRole;
    status: UserStatus;
    createdAt: string;
}

export interface LoginResult {
    user: User;
    token: string;
    expiresAt: string;
}

export interface RegisterInput {
    handle: string;
    password: string;
    displayName?: string;
    role?: UserRole;
}

export class AuthError extends Error {
    readonly code: string;
    readonly status: number;

    constructor(code: string, message: string, status: number) {
        super(message);
        this.name = 'AuthError';
        this.code = code;
        this.status = status;
    }
}

const HANDLE_PATTERN = /^[a-z0-9_-]{3,32}$/;

interface UserRow {
    id: string;
    handle: string;
    display_name: string;
    role: string;
    status: string;
    created_at: string;
}

interface CredentialRow extends UserRow {
    password_hash: string;
    password_salt: string;
}

function toUser(row: UserRow): User {
    return {
        id: row.id,
        handle: row.handle,
        displayName: row.display_name,
        role: row.role === 'admin' ? 'admin' : 'user',
        status: row.status === 'disabled' ? 'disabled' : 'active',
        createdAt: row.created_at,
    };
}

export function normalizeHandle(handle: string): string {
    return String(handle ?? '').trim().toLowerCase();
}

export interface AuthServiceOptions {
    sessionTtlDays?: number;
    /** Injected by tests to keep password hashing fast. */
    kdf?: KdfParams;
    now?: () => Date;
}

export class AuthService {
    readonly #db: Database;
    readonly #ttlDays: number;
    readonly #kdf: KdfParams;
    readonly #now: () => Date;

    constructor(db: Database, options: AuthServiceOptions = {}) {
        this.#db = db;
        this.#ttlDays = options.sessionTtlDays ?? 30;
        this.#kdf = options.kdf ?? DEFAULT_KDF;
        this.#now = options.now ?? ((): Date => new Date());
    }

    #hashToken(token: string): string {
        return createHash('sha256').update(token).digest('hex');
    }

    register(input: RegisterInput): LoginResult {
        const handle = normalizeHandle(input.handle);

        if (!HANDLE_PATTERN.test(handle)) {
            throw new AuthError('invalid_handle', 'handle must be 3-32 characters of a-z, 0-9, _ or -', 400);
        }

        const problem = passwordProblem(input.password);
        if (problem !== null) {
            throw new AuthError('invalid_password', problem, 400);
        }

        const existing = this.#db.prepare('SELECT id FROM users WHERE handle = ?').get(handle);
        if (existing !== undefined) {
            throw new AuthError('handle_taken', 'that handle is already registered', 409);
        }

        // Bootstrap: whoever creates the first account owns the instance, otherwise
        // there would be no way to get an admin at all.
        const role: UserRole = input.role ?? (this.count() === 0 ? 'admin' : 'user');

        const id = randomUUID();
        const createdAt = this.#now().toISOString();
        const { hash, salt } = hashPassword(input.password, this.#kdf);

        this.#db.prepare(
            `INSERT INTO users (id, handle, display_name, password_hash, password_salt, role, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
        ).run(id, handle, input.displayName ?? handle, hash, salt, role, createdAt);

        const user = this.get(id);
        if (user === null) {
            throw new AuthError('registration_failed', 'the account could not be read back after creation', 500);
        }

        return { user, ...this.#issueToken(id) };
    }

    login(handle: string, password: string): LoginResult {
        const normalized = normalizeHandle(handle);
        const row = this.#db.prepare(
            `SELECT id, handle, display_name, role, status, created_at, password_hash, password_salt
             FROM users WHERE handle = ?`,
        ).get(normalized) as CredentialRow | undefined;

        // Same error and roughly the same work whether the account exists or not.
        if (row === undefined) {
            hashPassword(String(password ?? ''), this.#kdf);
            throw new AuthError('invalid_credentials', 'wrong handle or password', 401);
        }

        if (!verifyPassword(String(password ?? ''), row.password_salt, row.password_hash)) {
            throw new AuthError('invalid_credentials', 'wrong handle or password', 401);
        }

        if (row.status === 'disabled') {
            throw new AuthError('account_disabled', 'this account is disabled', 403);
        }

        return { user: toUser(row), ...this.#issueToken(row.id) };
    }

    #issueToken(userId: string): { token: string; expiresAt: string } {
        const token = randomBytes(32).toString('base64url');
        const createdAt = this.#now();
        const expiresAt = new Date(createdAt.getTime() + this.#ttlDays * 24 * 60 * 60 * 1000);

        this.#db.prepare(
            'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?)',
        ).run(this.#hashToken(token), userId, createdAt.toISOString(), expiresAt.toISOString(), createdAt.toISOString());

        return { token, expiresAt: expiresAt.toISOString() };
    }

    /** Returns the user for a token, or null when it is unknown or expired. */
    authenticate(token: string): User | null {
        if (typeof token !== 'string' || token === '') {
            return null;
        }

        const row = this.#db.prepare(
            `SELECT u.id, u.handle, u.display_name, u.role, u.status, u.created_at, s.expires_at
             FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ?`,
        ).get(this.#hashToken(token)) as (UserRow & { expires_at: string }) | undefined;

        if (row === undefined) {
            return null;
        }

        if (new Date(row.expires_at).getTime() <= this.#now().getTime()) {
            this.#db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(this.#hashToken(token));
            return null;
        }

        if (row.status === 'disabled') {
            return null;
        }

        this.#db.prepare('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?')
            .run(this.#now().toISOString(), this.#hashToken(token));

        return toUser(row);
    }

    logout(token: string): boolean {
        if (typeof token !== 'string' || token === '') {
            return false;
        }

        const result = this.#db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(this.#hashToken(token));
        return Number(result.changes) > 0;
    }

    /** Revoke every session of a user (password change, ban, incident). */
    logoutAll(userId: string): number {
        const result = this.#db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
        return Number(result.changes);
    }

    get(id: string): User | null {
        const row = this.#db.prepare(
            'SELECT id, handle, display_name, role, status, created_at FROM users WHERE id = ?',
        ).get(id) as UserRow | undefined;

        return row === undefined ? null : toUser(row);
    }

    findByHandle(handle: string): User | null {
        const row = this.#db.prepare(
            'SELECT id, handle, display_name, role, status, created_at FROM users WHERE handle = ?',
        ).get(normalizeHandle(handle)) as UserRow | undefined;

        return row === undefined ? null : toUser(row);
    }

    list(): User[] {
        const rows = this.#db.prepare(
            'SELECT id, handle, display_name, role, status, created_at FROM users ORDER BY created_at',
        ).all() as unknown as UserRow[];

        return rows.map(toUser);
    }

    count(): number {
        const row = this.#db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number | bigint } | undefined;
        return row === undefined ? 0 : Number(row.count);
    }

    setStatus(userId: string, status: UserStatus): User {
        const result = this.#db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, userId);
        if (Number(result.changes) === 0) {
            throw new AuthError('user_not_found', `no user with id ${userId}`, 404);
        }

        if (status === 'disabled') {
            this.logoutAll(userId);
        }

        const user = this.get(userId);
        if (user === null) {
            throw new AuthError('user_not_found', `no user with id ${userId}`, 404);
        }

        return user;
    }
}
