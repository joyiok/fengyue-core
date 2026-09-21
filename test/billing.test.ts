import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FAST_KDF } from '../src/auth/passwords.ts';
import { AuthService } from '../src/auth/service.ts';
import { BillingService, QuotaError } from '../src/billing/service.ts';
import type { QuotaPolicy } from '../src/config.ts';
import { Database } from '../src/db/database.ts';

const POLICY: QuotaPolicy = { dailyTokenLimit: 1000, monthlyTokenLimit: 10_000, maxTokensPerRequest: 500 };

interface Harness {
    billing: BillingService;
    auth: AuthService;
    db: Database;
    userId: string;
    secondUserId: string;
}

async function withBilling(
    run: (harness: Harness) => void | Promise<void>,
    options: { policy?: QuotaPolicy; global?: number; maxStreams?: number; now?: () => Date } = {},
): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), 'story-billing-'));
    const db = new Database(path.join(dir, 'test.sqlite'));

    try {
        const auth = new AuthService(db, { kdf: FAST_KDF });
        const billing = new BillingService(db, {
            defaultQuota: options.policy ?? POLICY,
            globalDailyTokenLimit: options.global ?? 0,
            maxConcurrentStreamsPerUser: options.maxStreams ?? 2,
            ...(options.now ? { now: options.now } : {}),
        });

        const userId = auth.register({ handle: 'owner', password: 'long-enough-password' }).user.id;
        const secondUserId = auth.register({ handle: 'guest', password: 'long-enough-password' }).user.id;

        await run({ billing, auth, db, userId, secondUserId });
    } finally {
        db.close();
        await rm(dir, { recursive: true, force: true });
    }
}

function quotaCode(error: unknown): { code: string; status: number } {
    assert.ok(error instanceof QuotaError, `expected a QuotaError, got ${String(error)}`);
    return { code: error.code, status: error.status };
}

function expectQuota(fn: () => unknown): { code: string; status: number } {
    try {
        fn();
    } catch (error) {
        return quotaCode(error);
    }

    assert.fail('expected a QuotaError to be thrown');
}

const settle = (billing: BillingService, reservation: ReturnType<BillingService['authorize']>, tokens: number, requestId?: string) =>
    billing.settle(reservation, {
        model: 'mock-model',
        promptTokens: Math.floor(tokens / 2),
        completionTokens: Math.ceil(tokens / 2),
        usageSource: 'provider',
        streamed: false,
        ...(requestId !== undefined ? { requestId } : {}),
    });

// ------------------------------------------------------------------- policies

test('the default policy applies until one is set for a user', async () => {
    await withBilling(({ billing, userId }) => {
        assert.deepEqual(billing.policyFor(userId), POLICY);

        const updated = billing.setPolicy(userId, { dailyTokenLimit: 5, monthlyTokenLimit: 50, maxTokensPerRequest: 7 });
        assert.deepEqual(updated, { dailyTokenLimit: 5, monthlyTokenLimit: 50, maxTokensPerRequest: 7 });
        assert.deepEqual(billing.policyFor(userId), { dailyTokenLimit: 5, monthlyTokenLimit: 50, maxTokensPerRequest: 7 });
    });
});

// ------------------------------------------------------------------- authorize

test('a request above the per-request ceiling is refused', async () => {
    await withBilling(({ billing, userId }) => {
        assert.deepEqual(
            expectQuota(() => billing.authorize(userId, { estimatedPromptTokens: 10, requestedMaxTokens: 501 })),
            { code: 'per_request', status: 400 },
        );
    });
});

test('concurrent requests are capped per user', async () => {
    await withBilling(({ billing, userId, secondUserId }) => {
        billing.authorize(userId, { estimatedPromptTokens: 1, requestedMaxTokens: 1 });
        billing.authorize(userId, { estimatedPromptTokens: 1, requestedMaxTokens: 1 });

        // Third in flight for the same user is refused...
        assert.deepEqual(
            expectQuota(() => billing.authorize(userId, { estimatedPromptTokens: 1, requestedMaxTokens: 1 })),
            { code: 'concurrency', status: 429 },
        );

        // ...but another user is unaffected.
        billing.authorize(secondUserId, { estimatedPromptTokens: 1, requestedMaxTokens: 1 });
    }, { maxStreams: 2 });
});

test('an in-flight reservation counts against the limit', async () => {
    await withBilling(({ billing, userId }) => {
        // 400 estimated + 500 max = 900 reserved of a 1000 day.
        const first = billing.authorize(userId, { estimatedPromptTokens: 400, requestedMaxTokens: 500 });

        // The second request would project 1800 > 1000, so it must be refused even
        // though nothing has been *recorded* yet. This is the whole point of
        // reserving: otherwise parallel requests all pass and blow the budget.
        assert.deepEqual(
            expectQuota(() => billing.authorize(userId, { estimatedPromptTokens: 400, requestedMaxTokens: 500 })),
            { code: 'daily', status: 402 },
        );

        // Releasing gives the budget back, because nothing was consumed.
        billing.release(first);
        const second = billing.authorize(userId, { estimatedPromptTokens: 400, requestedMaxTokens: 500 });

        // Settling is what actually spends it, and then the same request is refused
        // for real rather than merely reserved.
        settle(billing, second, 900);
        assert.deepEqual(
            expectQuota(() => billing.authorize(userId, { estimatedPromptTokens: 400, requestedMaxTokens: 500 })),
            { code: 'daily', status: 402 },
        );
    });
});

test('the daily limit refuses with the numbers a client needs', async () => {
    await withBilling(({ billing, userId }) => {
        const reservation = billing.authorize(userId, { estimatedPromptTokens: 100, requestedMaxTokens: 100 });
        settle(billing, reservation, 950);

        try {
            billing.authorize(userId, { estimatedPromptTokens: 100, requestedMaxTokens: 100 });
            assert.fail('expected the daily quota to be exhausted');
        } catch (error) {
            const quota = quotaCode(error);
            assert.equal(quota.code, 'daily');
            assert.equal(quota.status, 402);
            assert.equal(error instanceof QuotaError ? error.details.limit : null, 1000);
            assert.equal(error instanceof QuotaError ? error.details.used : null, 950);
            assert.match(String(error instanceof QuotaError ? error.details.resetAt : ''), /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
        }
    });
});

test('the monthly limit is checked as well as the daily one', async () => {
    await withBilling(({ billing, userId }) => {
        const reservation = billing.authorize(userId, { estimatedPromptTokens: 10, requestedMaxTokens: 10 });
        settle(billing, reservation, 900);

        // Raise the daily ceiling so only the month can be the reason.
        billing.setPolicy(userId, { dailyTokenLimit: 100_000, monthlyTokenLimit: 1000, maxTokensPerRequest: 500 });

        assert.deepEqual(
            expectQuota(() => billing.authorize(userId, { estimatedPromptTokens: 100, requestedMaxTokens: 100 })),
            { code: 'monthly', status: 402 },
        );
    });
});

test('the global daily cap stops everyone, including other users', async () => {
    await withBilling(({ billing, userId, secondUserId }) => {
        const reservation = billing.authorize(userId, { estimatedPromptTokens: 10, requestedMaxTokens: 10 });
        settle(billing, reservation, 990);

        assert.equal(billing.globalUsageFor().tokens, 990);
        assert.deepEqual(
            expectQuota(() => billing.authorize(secondUserId, { estimatedPromptTokens: 50, requestedMaxTokens: 50 })),
            { code: 'global', status: 503 },
        );
    }, { global: 1000 });
});

test('a limit of zero means unlimited', async () => {
    await withBilling(({ billing, userId }) => {
        billing.setPolicy(userId, { dailyTokenLimit: 0, monthlyTokenLimit: 0, maxTokensPerRequest: 500 });

        const reservation = billing.authorize(userId, { estimatedPromptTokens: 100, requestedMaxTokens: 500 });
        settle(billing, reservation, 1_000_000);

        // Still allowed after a huge spend.
        billing.authorize(userId, { estimatedPromptTokens: 100, requestedMaxTokens: 500 });
        assert.equal(billing.summary(userId).day.remaining, -1);
    });
});

// ---------------------------------------------------------------------- ledger

test('settling records one ledger row and frees the reservation', async () => {
    await withBilling(({ billing, userId, db }) => {
        const reservation = billing.authorize(userId, { estimatedPromptTokens: 100, requestedMaxTokens: 200 });
        assert.deepEqual(billing.summary(userId).inFlight, { requests: 1, reservedTokens: 300 });

        const result = billing.settle(reservation, {
            chatId: 'linzhao/session-1',
            model: 'deepseek-chat',
            promptTokens: 120,
            completionTokens: 80,
            usageSource: 'estimated',
            streamed: true,
        });

        assert.equal(result.recorded, true);
        assert.equal(result.totalTokens, 200);
        assert.deepEqual(billing.summary(userId).inFlight, { requests: 0, reservedTokens: 0 });

        const row = db.prepare('SELECT * FROM usage_ledger').get() as Record<string, unknown>;
        assert.equal(row.user_id, userId);
        assert.equal(row.chat_id, 'linzhao/session-1');
        assert.equal(row.model, 'deepseek-chat');
        assert.equal(Number(row.prompt_tokens), 120);
        assert.equal(Number(row.completion_tokens), 80);
        assert.equal(Number(row.total_tokens), 200);
        assert.equal(row.usage_source, 'estimated');
        assert.equal(Number(row.streamed), 1);
        assert.match(String(row.day), /^\d{4}-\d{2}-\d{2}$/);
        assert.match(String(row.month), /^\d{4}-\d{2}$/);
    });
});

test('billing the same request id twice charges once', async () => {
    await withBilling(({ billing, userId }) => {
        const first = billing.authorize(userId, { estimatedPromptTokens: 10, requestedMaxTokens: 10, requestId: 'req-1' });
        const second = billing.authorize(userId, { estimatedPromptTokens: 10, requestedMaxTokens: 10, requestId: 'req-1' });

        const settledFirst = billing.settle(first, {
            requestId: 'req-1',
            model: 'm',
            promptTokens: 100,
            completionTokens: 100,
            usageSource: 'provider',
            streamed: false,
        });

        // The retry settles the same request id: no second row, no second charge.
        const settledSecond = billing.settle(second, {
            requestId: 'req-1',
            model: 'm',
            promptTokens: 100,
            completionTokens: 100,
            usageSource: 'provider',
            streamed: false,
        });

        assert.equal(settledFirst.recorded, true);
        assert.equal(settledSecond.recorded, false);
        assert.equal(billing.usageFor(userId).day.requests, 1);
        assert.equal(billing.usageFor(userId).day.tokens, 200);
    });
});

test('releasing a reservation records nothing', async () => {
    await withBilling(({ billing, userId, db }) => {
        const reservation = billing.authorize(userId, { estimatedPromptTokens: 100, requestedMaxTokens: 100 });
        billing.release(reservation);

        assert.deepEqual(billing.usageFor(userId).day, { tokens: 0, requests: 0 });
        assert.deepEqual(billing.summary(userId).inFlight, { requests: 0, reservedTokens: 0 });
        assert.equal(Number((db.prepare('SELECT COUNT(*) AS c FROM usage_ledger').get() as { c: number }).c), 0);

        // And the freed budget can be used again.
        billing.authorize(userId, { estimatedPromptTokens: 100, requestedMaxTokens: 400 });
    });
});

test('usage is counted per day and per month, and resets on the UTC boundary', async () => {
    let now = new Date('2026-09-21T23:00:00.000Z');

    await withBilling(({ billing, userId }) => {
        const policy: QuotaPolicy = { dailyTokenLimit: 100_000, monthlyTokenLimit: 100_000, maxTokensPerRequest: 500 };
        billing.setPolicy(userId, policy);

        settle(billing, billing.authorize(userId, { estimatedPromptTokens: 10, requestedMaxTokens: 10 }), 300);
        assert.deepEqual(billing.usageFor(userId, now).day, { tokens: 300, requests: 1 });

        // Cross into the next UTC day: the day resets, the month does not.
        now = new Date('2026-09-22T00:30:00.000Z');
        assert.deepEqual(billing.usageFor(userId, now).day, { tokens: 0, requests: 0 });
        assert.deepEqual(billing.usageFor(userId, now).month, { tokens: 300, requests: 1 });

        // Cross into the next month: both reset.
        now = new Date('2026-10-01T00:10:00.000Z');
        assert.deepEqual(billing.usageFor(userId, now).month, { tokens: 0, requests: 0 });
    }, { now: () => now });
});

test('the summary reports remaining budget and the reset moments', async () => {
    await withBilling(({ billing, userId }) => {
        const reservation = billing.authorize(userId, { estimatedPromptTokens: 10, requestedMaxTokens: 10 });
        settle(billing, reservation, 250);

        const summary = billing.summary(userId);
        assert.equal(summary.policy.dailyTokenLimit, 1000);
        assert.equal(summary.day.tokens, 250);
        assert.equal(summary.day.remaining, 750);
        assert.equal(summary.month.tokens, 250);
        assert.equal(summary.month.remaining, 9750);
        assert.equal(summary.global.limit, 0);
        assert.equal(summary.inFlight.requests, 0);
        assert.match(summary.day.resetAt, /T00:00:00\.000Z$/);
        assert.match(summary.month.resetAt, /T00:00:00\.000Z$/);
    });
});

test('the ledger can be listed newest first', async () => {
    await withBilling(({ billing, userId }) => {
        for (let index = 0; index < 3; index++) {
            const reservation = billing.authorize(userId, { estimatedPromptTokens: 10, requestedMaxTokens: 10 });
            settle(billing, reservation, 10 * (index + 1), `req-${index}`);
        }

        const recent = billing.ledgerFor(userId, 2);
        assert.equal(recent.length, 2);
        assert.deepEqual(recent.map((row) => row.requestId), ['req-2', 'req-1']);
        assert.ok((recent[0]?.id ?? 0) > (recent[1]?.id ?? 0));
    });
});

test('one user cannot spend another user budget or see their usage', async () => {
    await withBilling(({ billing, userId, secondUserId }) => {
        settle(billing, billing.authorize(userId, { estimatedPromptTokens: 10, requestedMaxTokens: 10 }), 900);

        assert.equal(billing.usageFor(userId).day.tokens, 900);
        assert.equal(billing.usageFor(secondUserId).day.tokens, 0);

        // The second user still has their own full allowance.
        billing.authorize(secondUserId, { estimatedPromptTokens: 100, requestedMaxTokens: 400 });
    });
});
