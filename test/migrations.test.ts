/**
 * Migrations are append-only.
 *
 * Twice now a statement has been added to a migration that had *already run* on
 * a deployed database: `mods`, then `character_shares`'s lifecycle columns. Both
 * times every test was green — the test database is new and runs every migration
 * in order — and both times the deployed database silently missed it. The first
 * was found by checking the tables; the second by three 500s in a browser.
 *
 * The failure mode is not a wrong statement. It is a *rewritten history*. So
 * this file holds a fingerprint of each version and refuses to change: if you
 * are here because it went red, the fix is to add a new version, not to edit an
 * old one.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Database, MIGRATIONS } from '../src/db/database.ts';

/** Each migration, reduced to its statements. SQL and code are both hashed. */
function fingerprint(migration: (typeof MIGRATIONS)[number]): string {
    const body = migration.statements
        .map((statement) => (typeof statement === 'string' ? statement : `<code:${statement.name}:${statement.length}>`))
        .join('\n---\n');
    return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

/**
 * Recorded history. A change here is a change to something that has already run
 * on somebody's database.
 */
// (There is no 5: one was started and folded into 4 before it ever shipped.
// Version numbers are history, not a sequence to keep tidy.)
const FROZEN: Record<number, string> = {
    1: '3e08d259f4504c8c',
    2: 'bc925b48b583f1f5',
    3: '2cdcf2069d7977e6',
    4: '79e3f7ad52bf7ccc',
    6: '08f77498d16c99d1',
    7: '3d4bd2f4c59c2eca',
    8: '18c0d957c5dd5aa9',
};

test('a migration that has shipped is frozen: add a version, do not edit one', () => {
    for (const migration of MIGRATIONS) {
        const expected = FROZEN[migration.version];
        assert.ok(expected !== undefined, `migration ${migration.version} is new — record its fingerprint`);
        assert.equal(
            fingerprint(migration),
            expected,
            `migration ${migration.version} changed. It has already run on deployed databases `
            + 'and will not run again. Undo the edit and add a new version instead.',
        );
    }
});

test('a fresh database ends up with everything the code expects', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'story-migrations-'));

    try {
        const db = new Database(path.join(dir, 'test.sqlite'));
        const tables = (db.handle.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table'",
        ).all() as unknown as { name: string }[]).map((row) => row.name);

        for (const table of ['settings', 'mods', 'character_versions', 'user_blocks', 'reservations', 'character_reports']) {
            assert.ok(tables.includes(table), `missing table: ${table}`);
        }

        // The columns whose absence produced those 500s.
        const shares = (db.handle.prepare('PRAGMA table_info(character_shares)').all() as unknown as { name: string }[])
            .map((row) => row.name);
        for (const column of ['status', 'publish_time', 'primary_version', 'anonymous', 'rating']) {
            assert.ok(shares.includes(column), `missing column on character_shares: ${column}`);
        }

        db.close();
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('adding a column that is already there is a no-op, not an error', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'story-migrations-'));

    try {
        // Running migrations twice over the same database is exactly what a
        // repair does. `addColumnIfMissing` has to be safe both ways — SQLite
        // has no `IF NOT EXISTS` for columns.
        const first = new Database(path.join(dir, 'test.sqlite'));
        first.close();
        const second = new Database(path.join(dir, 'test.sqlite'));
        second.close();
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
