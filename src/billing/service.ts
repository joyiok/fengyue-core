/**
 * Quotas and billing.
 *
 * Two rules shape this file:
 *
 *   1. Usage is an append-only ledger. Balances and quotas are derived from it by
 *      SUM, never written as a mutable counter that can drift out of sync with the
 *      calls that actually happened.
 *   2. A request is *reserved* before it starts. Checking quota and only recording
 *      usage afterwards lets ten parallel requests all pass the check and blow the
 *      budget together; reserving the worst case up front is what makes the limit
 *      real. The reservation is replaced by the actual numbers on settle.
 *
 * Reservations live in memory, which is correct for one process. Running several
 * instances needs them in Redis (documented, not hidden).
 */
import { randomUUID } from 'node:crypto';

import { live, type MaybeLive, type QuotaPolicy } from '../config.ts';
import type { Database } from '../db/database.ts';

export type QuotaScope = 'daily' | 'monthly' | 'global' | 'concurrency' | 'per_request';

export class QuotaError extends Error {
    readonly code: QuotaScope;
    readonly status: number;
    readonly details: Record<string, unknown>;

    constructor(code: QuotaScope, message: string, status: number, details: Record<string, unknown> = {}) {
        super(message);
        this.name = 'QuotaError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

export interface UsageTotals {
    tokens: number;
    requests: number;
}

export interface Reservation {
    id: string;
    userId: string;
    reservedTokens: number;
    requestId: string | null;
}

export interface SettleInput {
    requestId?: string;
    chatId?: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    usageSource: string;
    streamed: boolean;
}

export interface UsageSummary {
    policy: QuotaPolicy;
    day: { tokens: number; requests: number; limit: number; remaining: number; resetAt: string };
    month: { tokens: number; requests: number; limit: number; remaining: number; resetAt: string };
    global: { tokens: number; limit: number };
    inFlight: { requests: number; reservedTokens: number };
}

export interface UsageRecord {
    id: number;
    requestId: string | null;
    chatId: string | null;
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    usageSource: string;
    streamed: boolean;
    createdAt: string;
}

const UNLIMITED = 0;

function utcDay(at: Date): string {
    return at.toISOString().slice(0, 10);
}

function utcMonth(at: Date): string {
    return at.toISOString().slice(0, 7);
}

function nextDayReset(at: Date): string {
    const next = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1));
    return next.toISOString();
}

function nextMonthReset(at: Date): string {
    const next = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
    return next.toISOString();
}

export interface BillingServiceOptions {
    defaultQuota: MaybeLive<QuotaPolicy>;
    /** Circuit breaker across all users. 0 = unlimited. */
    globalDailyTokenLimit?: MaybeLive<number>;
    maxConcurrentStreamsPerUser?: MaybeLive<number>;
    now?: () => Date;
}

export class BillingService {
    readonly #db: Database;
    readonly #options: BillingServiceOptions;
    readonly #now: () => Date;
    /** userId -> reservationId -> reservation */
    readonly #reservations = new Map<string, Map<string, Reservation>>();

    constructor(db: Database, options: BillingServiceOptions) {
        this.#db = db;
        this.#options = options;
        this.#now = options.now ?? ((): Date => new Date());
    }

    // Read on every use rather than copied at construction: these are settings,
    // and an operator raising a limit expects it to apply to the next request.
    get #defaultQuota(): QuotaPolicy {
        return live(this.#options.defaultQuota);
    }

    get #globalLimit(): number {
        return live(this.#options.globalDailyTokenLimit ?? 0);
    }

    get #maxStreams(): number {
        return live(this.#options.maxConcurrentStreamsPerUser ?? 2);
    }

    policyFor(userId: string): QuotaPolicy {
        const row = this.#db.prepare(
            'SELECT daily_token_limit, monthly_token_limit, max_tokens_per_request FROM quota_policies WHERE user_id = ?',
        ).get(userId) as
            | { daily_token_limit: number | bigint; monthly_token_limit: number | bigint; max_tokens_per_request: number | bigint }
            | undefined;

        if (row === undefined) {
            return { ...this.#defaultQuota };
        }

        return {
            dailyTokenLimit: Number(row.daily_token_limit),
            monthlyTokenLimit: Number(row.monthly_token_limit),
            maxTokensPerRequest: Number(row.max_tokens_per_request),
        };
    }

    setPolicy(userId: string, policy: QuotaPolicy): QuotaPolicy {
        this.#db.prepare(
            `INSERT INTO quota_policies (user_id, daily_token_limit, monthly_token_limit, max_tokens_per_request, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (user_id) DO UPDATE SET
                daily_token_limit = excluded.daily_token_limit,
                monthly_token_limit = excluded.monthly_token_limit,
                max_tokens_per_request = excluded.max_tokens_per_request,
                updated_at = excluded.updated_at`,
        ).run(userId, policy.dailyTokenLimit, policy.monthlyTokenLimit, policy.maxTokensPerRequest, this.#now().toISOString());

        return this.policyFor(userId);
    }

    usageFor(userId: string, at: Date = this.#now()): { day: UsageTotals; month: UsageTotals } {
        const dayRow = this.#db.prepare(
            'SELECT COALESCE(SUM(total_tokens), 0) AS tokens, COUNT(*) AS requests FROM usage_ledger WHERE user_id = ? AND day = ?',
        ).get(userId, utcDay(at)) as { tokens: number | bigint; requests: number | bigint };

        const monthRow = this.#db.prepare(
            'SELECT COALESCE(SUM(total_tokens), 0) AS tokens, COUNT(*) AS requests FROM usage_ledger WHERE user_id = ? AND month = ?',
        ).get(userId, utcMonth(at)) as { tokens: number | bigint; requests: number | bigint };

        return {
            day: { tokens: Number(dayRow.tokens), requests: Number(dayRow.requests) },
            month: { tokens: Number(monthRow.tokens), requests: Number(monthRow.requests) },
        };
    }

    globalUsageFor(at: Date = this.#now()): UsageTotals {
        const row = this.#db.prepare(
            'SELECT COALESCE(SUM(total_tokens), 0) AS tokens, COUNT(*) AS requests FROM usage_ledger WHERE day = ?',
        ).get(utcDay(at)) as { tokens: number | bigint; requests: number | bigint };

        return { tokens: Number(row.tokens), requests: Number(row.requests) };
    }

    #inFlight(userId: string): { requests: number; reservedTokens: number } {
        const map = this.#reservations.get(userId);
        if (map === undefined) {
            return { requests: 0, reservedTokens: 0 };
        }

        let reservedTokens = 0;
        for (const reservation of map.values()) {
            reservedTokens += reservation.reservedTokens;
        }

        return { requests: map.size, reservedTokens };
    }

    /**
     * Reserve budget for one request, or throw QuotaError.
     *
     * The reservation is the worst case (prompt estimate + requested max tokens),
     * so concurrent requests cannot collectively overspend.
     */
    authorize(
        userId: string,
        input: { estimatedPromptTokens: number; requestedMaxTokens: number; requestId?: string },
    ): Reservation {
        const policy = this.policyFor(userId);

        if (input.requestedMaxTokens > policy.maxTokensPerRequest) {
            throw new QuotaError(
                'per_request',
                `max_tokens ${input.requestedMaxTokens} exceeds the per-request limit of ${policy.maxTokensPerRequest}`,
                400,
                { limit: policy.maxTokensPerRequest },
            );
        }

        const inFlight = this.#inFlight(userId);
        if (this.#maxStreams > 0 && inFlight.requests >= this.#maxStreams) {
            throw new QuotaError(
                'concurrency',
                `too many requests in flight (limit ${this.#maxStreams})`,
                429,
                { limit: this.#maxStreams },
            );
        }

        const reservedTokens = Math.max(0, Math.trunc(input.estimatedPromptTokens)) + Math.max(0, Math.trunc(input.requestedMaxTokens));
        const now = this.#now();
        const usage = this.usageFor(userId, now);

        if (policy.dailyTokenLimit > UNLIMITED) {
            const projected = usage.day.tokens + inFlight.reservedTokens + reservedTokens;
            if (projected > policy.dailyTokenLimit) {
                throw new QuotaError('daily', 'daily token quota exhausted', 402, {
                    limit: policy.dailyTokenLimit,
                    used: usage.day.tokens,
                    reserved: inFlight.reservedTokens,
                    resetAt: nextDayReset(now),
                });
            }
        }

        if (policy.monthlyTokenLimit > UNLIMITED) {
            const projected = usage.month.tokens + inFlight.reservedTokens + reservedTokens;
            if (projected > policy.monthlyTokenLimit) {
                throw new QuotaError('monthly', 'monthly token quota exhausted', 402, {
                    limit: policy.monthlyTokenLimit,
                    used: usage.month.tokens,
                    reserved: inFlight.reservedTokens,
                    resetAt: nextMonthReset(now),
                });
            }
        }

        if (this.#globalLimit > UNLIMITED) {
            const global = this.globalUsageFor(now);
            if (global.tokens + inFlight.reservedTokens + reservedTokens > this.#globalLimit) {
                throw new QuotaError('global', 'the service-wide daily token limit has been reached', 503, {
                    limit: this.#globalLimit,
                    used: global.tokens,
                    resetAt: nextDayReset(now),
                });
            }
        }

        const reservation: Reservation = {
            id: randomUUID(),
            userId,
            reservedTokens,
            requestId: input.requestId ?? null,
        };

        const map = this.#reservations.get(userId) ?? new Map<string, Reservation>();
        map.set(reservation.id, reservation);
        this.#reservations.set(userId, map);

        return reservation;
    }

    /**
     * Record what was actually used and drop the reservation.
     *
     * Idempotent by (user_id, request_id): a retry of the same request id can never
     * be charged twice, which is the billing half of the M2 request-id guarantee.
     * Returns whether a new row was written.
     */
    settle(reservation: Reservation, input: SettleInput): { recorded: boolean; totalTokens: number } {
        this.release(reservation);

        const promptTokens = Math.max(0, Math.trunc(input.promptTokens));
        const completionTokens = Math.max(0, Math.trunc(input.completionTokens));
        const totalTokens = promptTokens + completionTokens;
        const now = this.#now();
        const requestId = input.requestId ?? reservation.requestId;

        const result = this.#db.prepare(
            `INSERT OR IGNORE INTO usage_ledger
                (user_id, request_id, chat_id, model, prompt_tokens, completion_tokens, total_tokens,
                 usage_source, streamed, day, month, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            reservation.userId,
            requestId,
            input.chatId ?? null,
            input.model,
            promptTokens,
            completionTokens,
            totalTokens,
            input.usageSource,
            input.streamed ? 1 : 0,
            utcDay(now),
            utcMonth(now),
            now.toISOString(),
        );

        return { recorded: Number(result.changes) > 0, totalTokens };
    }

    /** Give the reservation back without recording anything (failed request). */
    release(reservation: Reservation): void {
        const map = this.#reservations.get(reservation.userId);
        if (map === undefined) {
            return;
        }

        map.delete(reservation.id);
        if (map.size === 0) {
            this.#reservations.delete(reservation.userId);
        }
    }

    /**
     * What the operator needs at a glance, across every account: how much has
     * gone through the gateway and what it is costing.
     *
     * Day and month are prefix scans off `created_at`, which is safe because the
     * timestamps are UTC ISO strings and the boundaries are UTC too.
     */
    overview(): {
        day: UsageTotals;
        month: UsageTotals;
        inFlight: { requests: number; reservedTokens: number };
        recent: { userId: string; chatId: string | null; model: string; totalTokens: number; usageSource: string; createdAt: string }[];
    } {
        const now = this.#now();

        const totals = (prefix: string): UsageTotals => {
            const row = this.#db.prepare(
                'SELECT COALESCE(SUM(total_tokens), 0) AS tokens, COUNT(*) AS requests FROM usage_ledger WHERE created_at >= ?',
            ).get(prefix) as { tokens: number | bigint; requests: number | bigint };
            return { tokens: Number(row.tokens), requests: Number(row.requests) };
        };

        let requests = 0;
        let reservedTokens = 0;
        for (const live of this.#reservations.values()) {
            requests += live.size;
            for (const reservation of live.values()) {
                reservedTokens += reservation.reservedTokens;
            }
        }

        const recent = (this.#db.prepare(
            `SELECT user_id, chat_id, model, total_tokens, usage_source, created_at
             FROM usage_ledger ORDER BY id DESC LIMIT 10`,
        ).all() as {
            user_id: string;
            chat_id: string | null;
            model: string;
            total_tokens: number | bigint;
            usage_source: string;
            created_at: string;
        }[]).map((row) => ({
            userId: row.user_id,
            chatId: row.chat_id,
            model: row.model,
            totalTokens: Number(row.total_tokens),
            usageSource: row.usage_source,
            createdAt: row.created_at,
        }));

        return {
            day: totals(utcDay(now)),
            month: totals(utcMonth(now)),
            inFlight: { requests, reservedTokens },
            recent,
        };
    }

    summary(userId: string): UsageSummary {
        const policy = this.policyFor(userId);
        const usage = this.usageFor(userId);
        const inFlight = this.#inFlight(userId);
        const now = this.#now();
        const global = this.globalUsageFor(now);

        const remaining = (limit: number, used: number): number => (limit === UNLIMITED ? -1 : Math.max(0, limit - used));

        return {
            policy,
            day: {
                ...usage.day,
                limit: policy.dailyTokenLimit,
                remaining: remaining(policy.dailyTokenLimit, usage.day.tokens),
                resetAt: nextDayReset(now),
            },
            month: {
                ...usage.month,
                limit: policy.monthlyTokenLimit,
                remaining: remaining(policy.monthlyTokenLimit, usage.month.tokens),
                resetAt: nextMonthReset(now),
            },
            global: { tokens: global.tokens, limit: this.#globalLimit },
            inFlight,
        };
    }

    /** Recent ledger rows, newest first — the raw material for a usage screen. */
    ledgerFor(userId: string, limit = 50): UsageRecord[] {
        const rows = this.#db.prepare(
            `SELECT id, request_id, chat_id, model, prompt_tokens, completion_tokens, total_tokens,
                    usage_source, streamed, created_at
             FROM usage_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
        ).all(userId, Math.max(1, Math.min(500, Math.trunc(limit)))) as {
            id: number | bigint;
            request_id: string | null;
            chat_id: string | null;
            model: string;
            prompt_tokens: number | bigint;
            completion_tokens: number | bigint;
            total_tokens: number | bigint;
            usage_source: string;
            streamed: number | bigint;
            created_at: string;
        }[];

        return rows.map((row) => ({
            id: Number(row.id),
            requestId: row.request_id,
            chatId: row.chat_id,
            model: row.model,
            promptTokens: Number(row.prompt_tokens),
            completionTokens: Number(row.completion_tokens),
            totalTokens: Number(row.total_tokens),
            usageSource: row.usage_source,
            streamed: Number(row.streamed) === 1,
            createdAt: row.created_at,
        }));
    }
}
