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
