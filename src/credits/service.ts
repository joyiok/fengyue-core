/**
 * Credits: the balance a user actually spends.
 *
 * Two different things guard spending, and they answer different questions:
 *   - the token quota (M4) is an operational ceiling — "this account cannot burn
 *     more than N tokens a day", which protects the operator from a runaway bill;
 *   - credits are the user's own money — "this account has nothing left to spend".
 *
 * Both are append-only ledgers. Nothing here mutates a balance column: the balance
 * is always SUM(amount), so it cannot drift away from the entries that produced it.
 *
 * Every entry carries an optional reference, and (user, reason, reference) is
 * unique, so a retried check-in, invite redemption or turn can only be granted or
 * charged once.
 */
import { randomBytes } from 'node:crypto';

import { live, type MaybeLive } from '../config.ts';
import type { Database } from '../db/database.ts';

export type CreditReason = 'signup' | 'checkin' | 'invite' | 'invitee' | 'turn' | 'admin';

export class CreditError extends Error {
    readonly code: 'insufficient_credits' | 'invalid_invite' | 'invite_already_used' | 'own_invite';
    readonly status: number;
    readonly details: Record<string, unknown>;

    constructor(
        code: CreditError['code'],
        message: string,
        status: number,
        details: Record<string, unknown> = {},
    ) {
        super(message);
        this.name = 'CreditError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

export interface CreditEntry {
    id: number;
    amount: number;
    reason: string;
    reference: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: string;
}

export interface CreditSummary {
    balance: number;
    granted: number;
    spent: number;
    today: { granted: number; spent: number };
    recent: CreditEntry[];
}

export interface CreditServiceOptions {
    /** Granted once, when an account is created. */
    initialGrant?: MaybeLive<number>;
    /** Granted once per UTC day by checking in. */
    checkinAmount?: MaybeLive<number>;
    /** Granted to the inviter when their code is redeemed. */
    inviteReward?: MaybeLive<number>;
    /** Granted to the person who redeems a code. */
    inviteeReward?: MaybeLive<number>;
    /** How many tokens one credit buys. */
    tokensPerCredit?: MaybeLive<number>;
    now?: () => Date;
}

export class CreditService {
    readonly #db: Database;
    readonly #options: CreditServiceOptions;
    readonly #now: () => Date;

    constructor(db: Database, options: CreditServiceOptions = {}) {
        this.#db = db;
        this.#options = options;
        this.#now = options.now ?? ((): Date => new Date());
    }

    // Read on every use: prices and rewards are settings, and changing one has
    // to apply to the next turn rather than the next restart.
    get #initialGrant(): number {
        return live(this.#options.initialGrant ?? 100);
    }

    get #checkinAmount(): number {
        return live(this.#options.checkinAmount ?? 10);
    }

    get #inviteReward(): number {
        return live(this.#options.inviteReward ?? 50);
    }

    get #inviteeReward(): number {
        return live(this.#options.inviteeReward ?? 50);
    }

    get #tokensPerCredit(): number {
        return Math.max(1, live(this.#options.tokensPerCredit ?? 1000));
    }

    get initialGrant(): number {
        return this.#initialGrant;
    }

    /** Exposed so a client can explain what a turn will roughly cost. */
    get tokensPerCredit(): number {
        return this.#tokensPerCredit;
    }

    balance(userId: string): number {
        const row = this.#db.prepare(
            'SELECT COALESCE(SUM(amount), 0) AS balance FROM credit_ledger WHERE user_id = ?',
        ).get(userId) as { balance: number | bigint };

        return Number(row.balance);
    }

    /** What a turn of this many tokens costs. */
    /** Everything granted and everything spent, across every account. */
    totals(): { granted: number; spent: number; balance: number } {
        const row = this.#db.prepare(
            `SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS granted,
                    COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS spent
             FROM credit_ledger`,
        ).get() as { granted: number | bigint; spent: number | bigint };

        const granted = Number(row.granted);
        const spent = Number(row.spent);
        return { granted, spent, balance: granted - spent };
    }

    costForTokens(tokens: number): number {
        if (!Number.isFinite(tokens) || tokens <= 0) {
            return 0;
        }

        return Math.max(1, Math.ceil(tokens / this.#tokensPerCredit));
    }

    grant(
        userId: string,
        amount: number,
        reason: CreditReason,
        reference?: string,
        metadata?: Record<string, unknown>,
    ): { recorded: boolean; balance: number } {
        const quantity = Math.max(0, Math.trunc(amount));
        if (quantity === 0) {
            return { recorded: false, balance: this.balance(userId) };
        }

        const recorded = this.#insert(userId, quantity, reason, reference, metadata);

        return { recorded, balance: this.balance(userId) };
    }

    /**
     * Charge a user. Refuses when the balance is too low — the check and the insert
     * share one transaction, so two concurrent spends cannot both pass.
     */
    spend(
        userId: string,
        amount: number,
        reason: CreditReason,
        reference?: string,
        metadata?: Record<string, unknown>,
    ): { recorded: boolean; balance: number; spent: number } {
        const quantity = Math.max(0, Math.trunc(amount));
        if (quantity === 0) {
            return { recorded: false, balance: this.balance(userId), spent: 0 };
        }

        return this.#db.transaction(() => {
            const balance = this.balance(userId);

            if (balance < quantity) {
                throw new CreditError('insufficient_credits', 'not enough credits for this request', 402, {
                    balance,
                    required: quantity,
                });
            }

            const recorded = this.#insert(userId, -quantity, reason, reference, metadata);

            // A duplicate reference means this spend already happened: the balance
            // is untouched and the caller is not charged twice.
            return { recorded, balance: this.balance(userId), spent: recorded ? quantity : 0 };
        });
    }

    #insert(
        userId: string,
        amount: number,
        reason: CreditReason,
        reference?: string,
        metadata?: Record<string, unknown>,
    ): boolean {
        const now = this.#now();
        const day = now.toISOString().slice(0, 10);

        const result = this.#db.prepare(
            `INSERT OR IGNORE INTO credit_ledger
                (user_id, amount, reason, reference, metadata, day, month, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            userId,
            amount,
            reason,
            reference ?? null,
            metadata === undefined ? null : JSON.stringify(metadata),
            day,
            day.slice(0, 7),
            now.toISOString(),
        );

        return Number(result.changes) > 0;
    }

    summary(userId: string, limit = 20): CreditSummary {
        const totals = this.#db.prepare(
            `SELECT
                COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS granted,
                COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS spent
             FROM credit_ledger WHERE user_id = ?`,
        ).get(userId) as { granted: number | bigint; spent: number | bigint };

        const today = this.#now().toISOString().slice(0, 10);
        const todayRow = this.#db.prepare(
            `SELECT
                COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS granted,
                COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS spent
             FROM credit_ledger WHERE user_id = ? AND day = ?`,
        ).get(userId, today) as { granted: number | bigint; spent: number | bigint };

        return {
            balance: this.balance(userId),
            granted: Number(totals.granted),
            spent: Number(totals.spent),
            today: { granted: Number(todayRow.granted), spent: Number(todayRow.spent) },
            recent: this.entries(userId, limit),
        };
    }

    entries(userId: string, limit = 20): CreditEntry[] {
        const rows = this.#db.prepare(
            `SELECT id, amount, reason, reference, metadata, created_at
             FROM credit_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
        ).all(userId, Math.max(1, Math.min(500, Math.trunc(limit)))) as unknown as {
            id: number | bigint;
            amount: number | bigint;
            reason: string;
            reference: string | null;
            metadata: string | null;
            created_at: string;
        }[];

        return rows.map((row) => ({
            id: Number(row.id),
            amount: Number(row.amount),
            reason: row.reason,
            reference: row.reference,
            metadata: row.metadata === null ? null : JSON.parse(row.metadata) as Record<string, unknown>,
            createdAt: row.created_at,
        }));
    }

    /** Once per UTC day; the reference makes a second call a no-op. */
    checkin(userId: string): { granted: boolean; amount: number; balance: number } {
        const day = this.#now().toISOString().slice(0, 10);
        const result = this.grant(userId, this.#checkinAmount, 'checkin', day);

        return { granted: result.recorded, amount: this.#checkinAmount, balance: result.balance };
    }

    /** A short, unambiguous code — no O/0 or I/1 to mistype. */
    createInvite(ownerId: string, count = 1): string[] {
        const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const codes: string[] = [];
        const now = this.#now().toISOString();

        for (let index = 0; index < Math.max(1, Math.min(20, count)); index++) {
            let code = '';
            const bytes = randomBytes(8);
            for (const byte of bytes) {
                code += alphabet[byte % alphabet.length];
            }

            this.#db.prepare('INSERT INTO invite_codes (code, owner_id, created_at) VALUES (?, ?, ?)')
                .run(code, ownerId, now);
            codes.push(code);
        }

        return codes;
    }

    listInvites(ownerId: string): { code: string; createdAt: string; usedBy: string | null; usedAt: string | null }[] {
        const rows = this.#db.prepare(
            'SELECT code, created_at, used_by, used_at FROM invite_codes WHERE owner_id = ? ORDER BY created_at DESC',
        ).all(ownerId) as unknown as { code: string; created_at: string; used_by: string | null; used_at: string | null }[];

        return rows.map((row) => ({
            code: row.code,
            createdAt: row.created_at,
            usedBy: row.used_by,
            usedAt: row.used_at,
        }));
    }

    /**
     * Redeem someone's invite. Both sides are rewarded, and the whole thing is one
     * transaction: a code can never pay out twice.
     */
    redeemInvite(userId: string, code: string): { reward: number; inviterReward: number; balance: number } {
        const normalized = String(code ?? '').trim().toUpperCase();

        return this.#db.transaction(() => {
            const row = this.#db.prepare(
                'SELECT code, owner_id, used_by FROM invite_codes WHERE code = ?',
            ).get(normalized) as { code: string; owner_id: string; used_by: string | null } | undefined;

            if (row === undefined) {
                throw new CreditError('invalid_invite', 'no such invite code', 404);
            }

            if (row.used_by !== null) {
                throw new CreditError('invite_already_used', 'this invite code has already been used', 409);
            }

            if (row.owner_id === userId) {
                throw new CreditError('own_invite', 'you cannot redeem your own invite code', 400);
            }

            this.#db.prepare('UPDATE invite_codes SET used_by = ?, used_at = ? WHERE code = ?')
                .run(userId, this.#now().toISOString(), normalized);

            this.grant(row.owner_id, this.#inviteReward, 'invite', normalized);
            this.grant(userId, this.#inviteeReward, 'invitee', normalized);

            return {
                reward: this.#inviteeReward,
                inviterReward: this.#inviteReward,
                balance: this.balance(userId),
            };
        });
    }
}
