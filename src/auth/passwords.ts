/**
 * Password hashing with scrypt from `node:crypto`.
 *
 * The stored value carries its own parameters (`scrypt$N$r$p$hash`), so the cost
 * can be raised later without invalidating existing passwords — the alternative,
 * a bare hash, silently breaks every login the day you tune the parameters.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export interface KdfParams {
    cost: number;
    blockSize: number;
    parallelization: number;
    keyLength: number;
}

export const DEFAULT_KDF: KdfParams = {
    cost: 16384,
    blockSize: 8,
    parallelization: 1,
    keyLength: 64,
};

/** Cheap parameters, for tests only. Never use these in production. */
export const FAST_KDF: KdfParams = {
    cost: 1024,
    blockSize: 8,
    parallelization: 1,
    keyLength: 64,
};

export const MIN_PASSWORD_LENGTH = 8;

export function hashPassword(password: string, params: KdfParams = DEFAULT_KDF): { hash: string; salt: string } {
    const salt = randomBytes(16).toString('base64');
    const derived = scryptSync(password, salt, params.keyLength, {
        N: params.cost,
        r: params.blockSize,
        p: params.parallelization,
    });

    return {
        hash: `scrypt$${params.cost}$${params.blockSize}$${params.parallelization}$${derived.toString('base64')}`,
        salt,
    };
}

export function verifyPassword(password: string, salt: string, stored: string): boolean {
    const parts = stored.split('$');

    if (parts.length !== 5 || parts[0] !== 'scrypt') {
        return false;
    }

    const [, cost, blockSize, parallelization, hashBase64] = parts;

    try {
        const expected = Buffer.from(hashBase64 as string, 'base64');
        const derived = scryptSync(password, salt, expected.length, {
            N: Number(cost),
            r: Number(blockSize),
            p: Number(parallelization),
        });

        return derived.length === expected.length && timingSafeEqual(derived, expected);
    } catch {
        // A malformed stored hash must read as "wrong password", not as a crash.
        return false;
    }
}

/** Returns a human-readable problem, or null when the password is acceptable. */
export function passwordProblem(password: string): string | null {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
        return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
    }

    if (password.length > 1024) {
        return 'password is too long';
    }

    return null;
}
