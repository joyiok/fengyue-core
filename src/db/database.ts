/**
 * SQLite storage.
 *
 * Uses Node's built-in `node:sqlite`, so the project keeps its zero-dependency
 * property while still having real SQL, transactions, indexes and unique
 * constraints. Swapping to PostgreSQL later is a driver change behind the
 * services that use this class, not a rewrite of the API layer.
 *
 * (Node 22 prints an ExperimentalWarning for `node:sqlite`. The npm scripts pass
 * `--disable-warning=ExperimentalWarning`; the API itself is stable enough for
 * this use and the schema is plain SQL.)
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';

interface Migration {
    version: number;
    statements: string[];
}

const MIGRATIONS: Migration[] = [
    {
        version: 1,
        statements: [
            `CREATE TABLE IF NOT EXISTS users (
                id            TEXT PRIMARY KEY,
                handle        TEXT NOT NULL UNIQUE,
                display_name  TEXT NOT NULL DEFAULT '',
                password_hash TEXT NOT NULL,
                password_salt TEXT NOT NULL,
                role          TEXT NOT NULL DEFAULT 'user',
                status        TEXT NOT NULL DEFAULT 'active',
                created_at    TEXT NOT NULL
            )`,
            `CREATE TABLE IF NOT EXISTS sessions (
                token_hash   TEXT PRIMARY KEY,
                user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at   TEXT NOT NULL,
                expires_at   TEXT NOT NULL,
                last_used_at TEXT
            )`,
            `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
            `CREATE TABLE IF NOT EXISTS quota_policies (
                user_id                TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                daily_token_limit      INTEGER NOT NULL,
                monthly_token_limit    INTEGER NOT NULL,
                max_tokens_per_request INTEGER NOT NULL,
                updated_at             TEXT NOT NULL
            )`,
            // Immutable usage ledger. Every model call appends exactly one row;
            // balances and quotas are derived from it, never stored as a mutable
            // number that could drift.
            `CREATE TABLE IF NOT EXISTS usage_ledger (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                request_id        TEXT,
                chat_id           TEXT,
                model             TEXT NOT NULL,
                prompt_tokens     INTEGER NOT NULL,
                completion_tokens INTEGER NOT NULL,
                total_tokens      INTEGER NOT NULL,
                usage_source      TEXT NOT NULL,
                streamed          INTEGER NOT NULL DEFAULT 0,
                day               TEXT NOT NULL,
                month             TEXT NOT NULL,
                created_at        TEXT NOT NULL
            )`,
            // The partial unique index is what makes billing idempotent: retrying a
            // request id cannot be charged twice.
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_request
                ON usage_ledger(user_id, request_id) WHERE request_id IS NOT NULL`,
            `CREATE INDEX IF NOT EXISTS idx_ledger_user_day ON usage_ledger(user_id, day)`,
            `CREATE INDEX IF NOT EXISTS idx_ledger_user_month ON usage_ledger(user_id, month)`,
            `CREATE INDEX IF NOT EXISTS idx_ledger_day ON usage_ledger(day)`,
            `CREATE TABLE IF NOT EXISTS character_shares (
                character_id TEXT PRIMARY KEY,
                user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                visibility   TEXT NOT NULL DEFAULT 'private',
                updated_at   TEXT NOT NULL
            )`,
        ],
    },
    {
        version: 2,
        statements: [
            // User-facing currency. Separate from the token quota: the quota is an
            // operational ceiling, credits are the balance a user actually spends.
            `CREATE TABLE IF NOT EXISTS credit_ledger (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                amount     INTEGER NOT NULL,
                reason     TEXT NOT NULL,
                reference  TEXT,
                metadata   TEXT,
                day        TEXT NOT NULL,
                month      TEXT NOT NULL,
                created_at TEXT NOT NULL
            )`,
            // Idempotency: a check-in, an invite redemption or a turn can only be
            // charged or granted once.
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_reference
                ON credit_ledger(user_id, reason, reference) WHERE reference IS NOT NULL`,
            `CREATE INDEX IF NOT EXISTS idx_credit_user ON credit_ledger(user_id, id)`,
            // M4 created this keyed by character_id alone, which cannot be unique
            // across users (two people may both own "linzhao"). Nothing used the
            // table yet, so it is recreated with the right key plus the snapshot
            // columns the market lists from.
            `DROP TABLE IF EXISTS character_shares`,
            `CREATE TABLE IF NOT EXISTS character_shares (
                user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                character_id       TEXT NOT NULL,
                visibility         TEXT NOT NULL DEFAULT 'private',
                name               TEXT NOT NULL DEFAULT '',
                tags               TEXT NOT NULL DEFAULT '',
                description_length INTEGER NOT NULL DEFAULT 0,
                published_at       TEXT,
                updated_at         TEXT NOT NULL,
                PRIMARY KEY (user_id, character_id)
            )`,
            `CREATE INDEX IF NOT EXISTS idx_shares_public ON character_shares(visibility, published_at)`,
            `CREATE TABLE IF NOT EXISTS invite_codes (
                code       TEXT PRIMARY KEY,
                owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL,
                used_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
                used_at    TEXT
            )`,
            `CREATE INDEX IF NOT EXISTS idx_invite_owner ON invite_codes(owner_id)`,
            `CREATE TABLE IF NOT EXISTS character_favorites (
                user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                owner_id     TEXT NOT NULL,
                character_id TEXT NOT NULL,
                created_at   TEXT NOT NULL,
                PRIMARY KEY (user_id, owner_id, character_id)
            )`,
            // One row per character per day. Rankings read this instead of scanning
            // events, which is what keeps a windowed ranking cheap.
            `CREATE TABLE IF NOT EXISTS character_stats (
                owner_id     TEXT NOT NULL,
                character_id TEXT NOT NULL,
                day          TEXT NOT NULL,
                favorites    INTEGER NOT NULL DEFAULT 0,
                imports      INTEGER NOT NULL DEFAULT 0,
                views        INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (owner_id, character_id, day)
            )`,
            `CREATE INDEX IF NOT EXISTS idx_stats_day ON character_stats(day)`,
        ],
    },
    {
        version: 3,
        statements: [
            // Runtime configuration. Every key in settings/schema.ts has exactly
            // one row, written at start-up from the environment (or the shipped
            // default) and edited here afterwards. `boot_value` is what that row
            // was filled in with, kept so `changed` and `reset` mean the same to
            // every process — a CLI started without the deployment's environment
            // would otherwise compute a different "boot value" than the server
            // did, and `reset` would write the wrong thing back.
            //
            // Values are JSON so a number stays a number and a boolean stays a
            // boolean.
            `CREATE TABLE IF NOT EXISTS settings (
                key        TEXT PRIMARY KEY,
                value      TEXT NOT NULL,
                boot_value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )`,
        ],
    },
    {
        version: 4,
        statements: [
            // Reserved tokens used to live in a Map inside the process. That lost
            // them on a restart — and a restart in the middle of several
            // concurrent turns briefly *lowered* the guard the reservation exists
            // to provide, which is the opposite of what it is for. They are rows
            // now, with an expiry so a crashed turn cannot hold a quota open
            // forever.
            `CREATE TABLE IF NOT EXISTS reservations (
                id         TEXT PRIMARY KEY,
                user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                request_id TEXT,
                tokens     INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL
            )`,
            `CREATE INDEX IF NOT EXISTS idx_reservations_user ON reservations(user_id)`,
            `CREATE INDEX IF NOT EXISTS idx_reservations_expiry ON reservations(expires_at)`,
            // Moderation: a report against a published character. Deliberately not
            // a foreign key to users or to the listing — a report has to survive
            // the account being closed and the card being unpublished, otherwise
            // resolving one would destroy the record of what was resolved.
            `CREATE TABLE IF NOT EXISTS character_reports (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_id      TEXT NOT NULL,
                character_id  TEXT NOT NULL,
                reporter_id   TEXT NOT NULL,
                reason        TEXT NOT NULL,
                status        TEXT NOT NULL DEFAULT 'open',
                created_at    TEXT NOT NULL,
                resolved_at   TEXT,
                resolved_by   TEXT,
                action        TEXT
            )`,
            `CREATE INDEX IF NOT EXISTS idx_reports_status ON character_reports(status)`,
            `CREATE INDEX IF NOT EXISTS idx_reports_target ON character_reports(owner_id, character_id)`,

            // ---- the life of a published work -------------------------------
            // A work moves: submit -> review -> list -> withdraw. `published_at`
            // is when it was *first* published and never changes; `publish_time`
            // is what the rankings and the "new" sort actually read, because it
            // is the operator's lever (a scheduled release, a re-bump).
            //
            //   pending    submitted, waiting for a human
            //   approved   passed review, waiting for `scheduled_at` to arrive
            //   public     listed
            //   rejected   refused, with a note the author can read
            //   withdrawn  the author took it down
            `ALTER TABLE character_shares ADD COLUMN status TEXT NOT NULL DEFAULT 'public'`,
            `ALTER TABLE character_shares ADD COLUMN submitted_at TEXT`,
            `ALTER TABLE character_shares ADD COLUMN reviewed_at TEXT`,
            `ALTER TABLE character_shares ADD COLUMN reviewed_by TEXT`,
            `ALTER TABLE character_shares ADD COLUMN review_note TEXT`,
            `ALTER TABLE character_shares ADD COLUMN scheduled_at TEXT`,
            `ALTER TABLE character_shares ADD COLUMN publish_time TEXT`,
            `ALTER TABLE character_shares ADD COLUMN primary_version TEXT`,
            `ALTER TABLE character_shares ADD COLUMN anonymous INTEGER NOT NULL DEFAULT 0`,
            `ALTER TABLE character_shares ADD COLUMN rating TEXT NOT NULL DEFAULT 'explicit'`,
            `UPDATE character_shares SET publish_time = COALESCE(published_at, updated_at) WHERE publish_time IS NULL`,
            `DROP INDEX IF EXISTS idx_shares_public`,
            `CREATE INDEX IF NOT EXISTS idx_shares_listed ON character_shares(status, publish_time)`,
            `CREATE INDEX IF NOT EXISTS idx_shares_review ON character_shares(status, submitted_at)`,

            // Versions of one work. The bytes live as PNGs under `versions/` so
            // any version can be exported or played, exactly like the working
            // copy; this table is the metadata and the ordering.
            `CREATE TABLE IF NOT EXISTS character_versions (
                owner_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                character_id TEXT NOT NULL,
                version      TEXT NOT NULL,
                label        TEXT NOT NULL DEFAULT '',
                note         TEXT NOT NULL DEFAULT '',
                created_at   TEXT NOT NULL,
                PRIMARY KEY (owner_id, character_id, version)
            )`,

            // Mods: reusable pieces a player loads onto a work at play time. A
            // mod is a prompt fragment plus a world book's worth of entries and
            // optionally a style sheet.
            //
            // `scope` is the interesting one: `shared` (usable on any work) vs
            // `dedicated` (only selectable inside one work). Which mods a work
            // accepts is the *author's* call and lives with the card, not here —
            // see `extensions.story.mods` — because a card has to keep its rules
            // when it travels to another install.
            `CREATE TABLE IF NOT EXISTS mods (
                id                 TEXT PRIMARY KEY,
                owner_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name               TEXT NOT NULL,
                description        TEXT NOT NULL DEFAULT '',
                visibility         TEXT NOT NULL DEFAULT 'private',
                scope              TEXT NOT NULL DEFAULT 'shared',
                bound_character_id TEXT,
                system_prompt      TEXT NOT NULL DEFAULT '',
                post_history       TEXT NOT NULL DEFAULT '',
                worldbook          TEXT NOT NULL DEFAULT '{}',
                style              TEXT NOT NULL DEFAULT '',
                tags               TEXT NOT NULL DEFAULT '[]',
                uses               INTEGER NOT NULL DEFAULT 0,
                created_at         TEXT NOT NULL,
                updated_at         TEXT NOT NULL
            )`,
            `CREATE INDEX IF NOT EXISTS idx_mods_owner ON mods(owner_id)`,
            `CREATE INDEX IF NOT EXISTS idx_mods_gallery ON mods(visibility, scope)`,

            // What a reader does not want to see: whole tags, or words that must
            // not appear in a reply. Kept per user rather than global, because
            // "小众XP" is taste, not policy.
            `CREATE TABLE IF NOT EXISTS user_blocks (
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                kind    TEXT NOT NULL,
                value   TEXT NOT NULL,
                PRIMARY KEY (user_id, kind, value)
            )`,
        ],
    },
];

export class Database {
    readonly handle: DatabaseSync;
    #depth = 0;

    constructor(path: string) {
        this.handle = new DatabaseSync(path);

        // WAL keeps readers from blocking the writer; foreign keys are off by
        // default in SQLite and the schema relies on them.
        this.handle.exec('PRAGMA journal_mode = WAL');
        this.handle.exec('PRAGMA foreign_keys = ON');
        this.handle.exec('PRAGMA busy_timeout = 5000');

        this.migrate();
    }

    private migrate(): void {
        this.handle.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
            version    INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        )`);

        const row = this.handle.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
            | { version: number | bigint | null }
            | undefined;
        const current = row?.version === null || row?.version === undefined ? 0 : Number(row.version);

        for (const migration of MIGRATIONS) {
            if (migration.version <= current) {
                continue;
            }

            this.transaction(() => {
                for (const statement of migration.statements) {
                    this.handle.exec(statement);
                }
                this.handle.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
                    .run(migration.version, new Date().toISOString());
            });
        }
    }

    prepare(sql: string): StatementSync {
        return this.handle.prepare(sql);
    }

    /**
     * Run `fn` in a transaction. Nested calls use savepoints, so a service can
     * compose without knowing whether its caller already opened one.
     */
    transaction<T>(fn: () => T): T {
        const nested = this.#depth > 0;
        const name = `sp_${this.#depth}`;

        this.handle.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE');
        this.#depth += 1;

        try {
            const result = fn();
            this.#depth -= 1;
            this.handle.exec(nested ? `RELEASE ${name}` : 'COMMIT');
            return result;
        } catch (error) {
            this.#depth -= 1;
            try {
                this.handle.exec(nested ? `ROLLBACK TO ${name}` : 'ROLLBACK');
                if (nested) {
                    this.handle.exec(`RELEASE ${name}`);
                }
            } catch {
                // A failed rollback must not hide the original error.
            }
            throw error;
        }
    }

    close(): void {
        this.handle.close();
    }
}
