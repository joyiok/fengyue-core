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
