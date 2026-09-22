/**
 * What a reader does not want to see: whole tags, or words that must not appear
 * in a reply.
 *
 * Per user and not global, because this is taste rather than policy — "小众XP"
 * is exactly the case: one person's must-see is another's never-show-me. The
 * platform's own line (what may not exist here at all) is a different thing and
 * lives in review, not here.
 *
 * Two kinds, two places they are applied:
 *
 *   - `tag`  filters listings and rankings, before anything is shown;
 *   - `word` masks a generated reply, after the model has spoken — the only
 *     place a word can still turn up once a session is running.
 */
import type { Database } from '../db/database.ts';

export type BlockKind = 'tag' | 'word';

export interface Blocks {
    tags: string[];
    words: string[];
}

export class BlockError extends Error {
    readonly code: 'invalid' | 'not_found';
    readonly status: number;

    constructor(code: BlockError['code'], message: string, status: number) {
        super(message);
        this.name = 'BlockError';
        this.code = code;
        this.status = status;
    }
}

export class BlocksService {
    readonly #db: Database;

    constructor(db: Database) {
        this.#db = db;
    }

    add(userId: string, kind: BlockKind, value: string): Blocks {
        const clean = String(value ?? '').trim();
        if (clean === '') {
            throw new BlockError('invalid', 'a blocked value cannot be empty', 400);
        }
        if (kind !== 'tag' && kind !== 'word') {
            throw new BlockError('invalid', 'kind must be "tag" or "word"', 400);
        }

        // Unique on (user, kind, value): blocking the same thing twice is the
        // same block, not a second one.
        this.#db.prepare(
            'INSERT OR IGNORE INTO user_blocks (user_id, kind, value) VALUES (?, ?, ?)',
        ).run(userId, kind, clean.toLowerCase());

        return this.list(userId);
    }

    remove(userId: string, kind: BlockKind, value: string): Blocks {
        this.#db.prepare('DELETE FROM user_blocks WHERE user_id = ? AND kind = ? AND value = ?')
            .run(userId, kind, String(value ?? '').trim().toLowerCase());
        return this.list(userId);
    }

    list(userId: string): Blocks {
        const rows = this.#db.prepare('SELECT kind, value FROM user_blocks WHERE user_id = ? ORDER BY value')
            .all(userId) as unknown as { kind: string; value: string }[];

        return {
            tags: rows.filter((row) => row.kind === 'tag').map((row) => row.value),
            words: rows.filter((row) => row.kind === 'word').map((row) => row.value),
        };
    }

    blockedTags(userId: string): string[] {
        return this.list(userId).tags;
    }

    blockedWords(userId: string): string[] {
        return this.list(userId).words;
    }

    /** True when this work carries anything the reader has blocked. */
    static isBlocked(tags: string[], blocked: string[]): boolean {
        if (blocked.length === 0) {
            return false;
        }
        const mine = new Set(tags.map((tag) => tag.trim().toLowerCase()));
        return blocked.some((tag) => mine.has(tag));
    }

    /**
     * Blank out blocked words in a reply.
     *
     * Masking rather than refusing: the model has already spoken, and refusing
     * now would throw away a whole turn over one word. What the reader sees is
     * what is saved, so the log and the screen cannot disagree.
     */
    static mask(text: string, words: string[]): { text: string; masked: number } {
        let out = text;
        let masked = 0;

        for (const raw of words) {
            const needle = raw.trim().toLowerCase();
            if (needle === '') {
                continue;
            }

            // Case-insensitive without a regex: a blocked word is data, and
            // building a pattern out of user input is how this becomes the
            // injection instead of the defence.
            let at = out.toLowerCase().indexOf(needle);
            while (at !== -1) {
                out = `${out.slice(0, at)}${'▮'.repeat(Array.from(needle).length)}${out.slice(at + needle.length)}`;
                masked += 1;
                at = out.toLowerCase().indexOf(needle);
            }
        }

        return { text: out, masked };
    }
}
