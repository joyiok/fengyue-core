/**
 * Versions of one work, and which of them is the *primary* one.
 *
 * Two ideas kept apart on purpose:
 *
 *   - a **version** is a snapshot of the card as it was released, so an author
 *     can fix a typo without erasing what players are already enjoying, and a
 *     player can start a chat on an older one;
 *   - the **primary version** is what the listing points at. Changing it moves
 *     the listing — and the listing is what the rankings read — so it is a
 *     decision, not a side effect of editing.
 *
 * The bytes live as PNGs in the library (a version has to be exportable like any
 * other card); this holds what the author wrote about them.
 */
import type { Database } from '../db/database.ts';

export interface VersionInfo {
    version: string;
    label: string;
    note: string;
    createdAt: string;
}

interface VersionRow {
    version: string;
    label: string;
    note: string;
    created_at: string;
}

export class VersionError extends Error {
    readonly code: 'not_found' | 'invalid' | 'in_use';
    readonly status: number;

    constructor(code: VersionError['code'], message: string, status: number) {
        super(message);
        this.name = 'VersionError';
        this.code = code;
        this.status = status;
    }
}

export class VersionsService {
    readonly #db: Database;
    readonly #now: () => Date;

    constructor(db: Database, options: { now?: () => Date } = {}) {
        this.#db = db;
        this.#now = options.now ?? ((): Date => new Date());
    }

    /**
     * Name a snapshot. The caller has already written the bytes; this records
     * what the author meant by it.
     */
    record(ownerId: string, characterId: string, input: { version: string; label?: string; note?: string }): VersionInfo {
        const version = String(input.version ?? '').trim();
        if (version === '') {
            throw new VersionError('invalid', 'a version needs a name', 400);
        }

        const stamp = this.#now().toISOString();

        this.#db.prepare(
            `INSERT INTO character_versions (owner_id, character_id, version, label, note, created_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (owner_id, character_id, version) DO UPDATE SET
                label = excluded.label, note = excluded.note`,
        ).run(ownerId, characterId, version, String(input.label ?? ''), String(input.note ?? ''), stamp);

        return { version, label: String(input.label ?? ''), note: String(input.note ?? ''), createdAt: stamp };
    }

    list(ownerId: string, characterId: string): VersionInfo[] {
        const rows = this.#db.prepare(
            `SELECT version, label, note, created_at FROM character_versions
             WHERE owner_id = ? AND character_id = ? ORDER BY created_at DESC`,
        ).all(ownerId, characterId) as unknown as VersionRow[];

        return rows.map((row) => ({ version: row.version, label: row.label, note: row.note, createdAt: row.created_at }));
    }

    remove(ownerId: string, characterId: string, version: string): boolean {
        const primary = this.primaryOf(ownerId, characterId);
        if (primary === version) {
            // The listing points here. Point it somewhere else first — silently
            // moving a listing is how a ranking changes for no visible reason.
            throw new VersionError('in_use', 'this is the primary version; point the listing somewhere else first', 409);
        }

        return Number(this.#db.prepare(
            'DELETE FROM character_versions WHERE owner_id = ? AND character_id = ? AND version = ?',
        ).run(ownerId, characterId, version).changes) > 0;
    }

    /** Which version the listing points at. */
    primaryOf(ownerId: string, characterId: string): string | null {
        const row = this.#db.prepare(
            'SELECT primary_version FROM character_shares WHERE user_id = ? AND character_id = ?',
        ).get(ownerId, characterId) as { primary_version: string | null } | undefined;

        return row?.primary_version ?? null;
    }
}
