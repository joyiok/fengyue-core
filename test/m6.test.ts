/**
 * M6: credits (the user-facing balance) and the character market.
 *
 * Unit tests drive the services directly with an injected clock — the only way to
 * test a per-day check-in and a windowed ranking without waiting a day. The HTTP
 * tests then check the wiring: that a completed turn charges the balance, that an
 * empty balance is refused *before* the model is called, and that a published card
 * can be discovered, favorited and imported by another account.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { FAST_KDF } from '../src/auth/passwords.ts';
import { AuthService } from '../src/auth/service.ts';
import { BillingService } from '../src/billing/service.ts';
import { normalizeCard } from '../src/cards/types.ts';
import { loadAppConfig, type AppConfig, type QuotaPolicy } from '../src/config.ts';
import { CreditError, CreditService } from '../src/credits/service.ts';
import { Database } from '../src/db/database.ts';
import { Library } from '../src/library.ts';
import { MarketError, MarketService } from '../src/market/service.ts';
import { createServer, type ServerContext } from '../src/server.ts';
import { respondWith, startMockModel } from './helpers/mock-model.ts';

const POLICY: QuotaPolicy = { dailyTokenLimit: 100_000, monthlyTokenLimit: 1_000_000, maxTokensPerRequest: 100 };
const PASSWORD = 'a-long-enough-password';

const card = normalizeCard({
    spec: 'chara_card_v2',
    data: { name: '林昭', description: '书店店主', personality: '话少', scenario: '书房', first_mes: '来了。' },
});

/** A clock the test can move, so "once per day" and ranking windows are testable. */
function clock(iso: string): { now: () => Date; set: (next: string) => void } {
    let current = new Date(iso);
    return {
        now: () => current,
        set: (next: string): void => {
            current = new Date(next);
        },
    };
}

async function withDb(run: (db: Database, auth: AuthService) => Promise<void> | void): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), 'story-m6-'));
    const db = new Database(path.join(dir, 'test.sqlite'));

    try {
        await run(db, new AuthService(db, { kdf: FAST_KDF }));
    } finally {
        db.close();
        await rm(dir, { recursive: true, force: true });
    }
}

function register(db: Database, handle: string): string {
    return new AuthService(db, { kdf: FAST_KDF }).register({ handle, password: PASSWORD }).user.id;
}

function expectCreditError(code: string, status: number): (error: unknown) => boolean {
    return (error: unknown) => {
        assert.ok(error instanceof CreditError, `expected a CreditError, got ${String(error)}`);
        assert.equal(error.code, code);
        assert.equal(error.status, status);
        return true;
    };
}

// ------------------------------------------------------------------- credits

test('a balance is derived from the ledger and spending cannot go below zero', async () => {
    await withDb((db) => {
        const user = register(db, 'spender');
        const credits = new CreditService(db, { now: clock('2025-01-01T00:00:00.000Z').now });

        assert.equal(credits.balance(user), 0);
        assert.deepEqual(credits.grant(user, 10, 'signup'), { recorded: true, balance: 10 });
        assert.equal(credits.balance(user), 10);

        assert.deepEqual(credits.spend(user, 4, 'turn', 'req-1'), { recorded: true, balance: 6, spent: 4 });

        // The same reference is the same charge: a retry is never billed twice.
        assert.deepEqual(credits.spend(user, 4, 'turn', 'req-1'), { recorded: false, balance: 6, spent: 0 });

        assert.throws(() => credits.spend(user, 7, 'turn', 'req-2'), expectCreditError('insufficient_credits', 402))
        ;

        // The refused spend left nothing behind.
        assert.equal(credits.balance(user), 6);

        const summary = credits.summary(user);
        assert.equal(summary.balance, 6);
        assert.equal(summary.granted, 10);
        assert.equal(summary.spent, 4);
        assert.equal(summary.today.spent, 4);
        assert.equal(summary.recent.length, 2);
        assert.equal(summary.recent[0]?.reference, 'req-1');
        assert.equal(summary.recent[0]?.amount, -4);
        assert.equal(summary.recent[1]?.reason, 'signup');
    });
});

test('tokens convert to credits, rounding up', async () => {
    await withDb((db) => {
        const credits = new CreditService(db, { tokensPerCredit: 1000 });

        assert.equal(credits.tokensPerCredit, 1000);
        assert.equal(credits.costForTokens(0), 0);
        assert.equal(credits.costForTokens(-5), 0);
        assert.equal(credits.costForTokens(1), 1);
        assert.equal(credits.costForTokens(1000), 1);
        assert.equal(credits.costForTokens(1001), 2);
    });
});

test('check-in pays once per UTC day', async () => {
    await withDb((db) => {
        const user = register(db, 'daily');
        const time = clock('2025-03-01T23:00:00.000Z');
        const credits = new CreditService(db, { checkinAmount: 10, now: time.now });

        assert.deepEqual(credits.checkin(user), { granted: true, amount: 10, balance: 10 });
        assert.deepEqual(credits.checkin(user), { granted: false, amount: 10, balance: 10 });

        // Still the same UTC day, just before the boundary.
        time.set('2025-03-01T23:59:59.000Z');
        assert.equal(credits.checkin(user).granted, false);

        time.set('2025-03-02T00:00:01.000Z');
        assert.deepEqual(credits.checkin(user), { granted: true, amount: 10, balance: 20 });
    });
});

test('an invite pays both sides exactly once', async () => {
    await withDb((db) => {
        const inviter = register(db, 'inviter');
        const guest = register(db, 'guest');
        const credits = new CreditService(db, { inviteReward: 50, inviteeReward: 20 });

        const [code] = credits.createInvite(inviter);
        assert.ok(code !== undefined);
        assert.match(code, /^[A-Z2-9]{8}$/);
        assert.equal(credits.listInvites(inviter)[0]?.usedBy, null);

        // Case-insensitive on input, so a code can be typed by hand.
        assert.deepEqual(credits.redeemInvite(guest, code.toLowerCase()), { reward: 20, inviterReward: 50, balance: 20 });
        assert.equal(credits.balance(inviter), 50);
        assert.equal(credits.listInvites(inviter)[0]?.usedBy, guest);
        assert.equal(credits.balance(guest), 20);

        assert.throws(() => credits.redeemInvite(guest, code), expectCreditError('invite_already_used', 409));
        assert.throws(() => credits.redeemInvite(guest, 'NOPE2345'), expectCreditError('invalid_invite', 404));

        // Redeeming your own code would be free money.
        const [own] = credits.createInvite(inviter);
        assert.ok(own !== undefined);
        assert.throws(() => credits.redeemInvite(inviter, own), expectCreditError('own_invite', 400));
    });
});

test('the ledger reconciles: granted minus spent is the balance', async () => {
    await withDb((db) => {
        const user = register(db, 'audit');
        const guest = register(db, 'guest');
        const time = clock('2025-08-01T00:00:00.000Z');
        const credits = new CreditService(db, {
            initialGrant: 60,
            checkinAmount: 5,
            inviteReward: 40,
            inviteeReward: 40,
            tokensPerCredit: 100,
            now: time.now,
        });

        credits.grant(user, 60, 'signup');
        credits.checkin(user);
        const [code] = credits.createInvite(user);
        assert.ok(code !== undefined);
        credits.redeemInvite(guest, code);
        credits.spend(user, 3, 'turn', 'req-a');
        credits.spend(user, 2, 'turn', 'req-b');

        const summary = credits.summary(user, 500);
        assert.equal(summary.granted, 60 + 5 + 40);
        assert.equal(summary.spent, 5);
        assert.equal(summary.balance, summary.granted - summary.spent);

        // Nothing is hidden between the totals and the entries themselves.
        assert.equal(summary.recent.reduce((total, entry) => total + entry.amount, 0), summary.balance);
        assert.equal(credits.entries(user, 2).length, 2);
        assert.equal(credits.balance(guest), 40);
    });
});

// -------------------------------------------------------------------- market

test('publishing snapshots a card and republishing keeps the original date', async () => {
    await withDb((db) => {
        const owner = register(db, 'owner');
        const time = clock('2025-05-01T10:00:00.000Z');
        const market = new MarketService(db, { now: time.now });

        // Private until published: nothing is discoverable by guessing an id.
        assert.equal(market.get(owner, 'linzhao'), null);
        assert.deepEqual(market.list(), []);
        assert.equal(market.isPublic(owner, 'linzhao'), false);

        const entry = market.publish(owner, 'linzhao', { name: '林昭', tags: ['书店', '治愈'], descriptionLength: 120 });
        assert.equal(entry.name, '林昭');
        assert.deepEqual(entry.tags, ['书店', '治愈']);
        assert.equal(entry.descriptionLength, 120);
        assert.equal(entry.publishedAt, '2025-05-01T10:00:00.000Z');
        assert.equal(entry.stats.score, 0);
        assert.equal(entry.favorited, false);
        assert.equal(market.isPublic(owner, 'linzhao'), true);

        // The owner brought by someone else reports favorited=false, and re-publishing
        // refreshes the snapshot without jumping the "new" ordering.
        time.set('2025-05-03T10:00:00.000Z');
        const again = market.publish(owner, 'linzhao', { name: '林昭 v2', tags: [], descriptionLength: 200 });
        assert.equal(again.name, '林昭 v2');
        assert.deepEqual(again.tags, []);
        assert.equal(again.publishedAt, '2025-05-01T10:00:00.000Z');

        assert.equal(market.unpublish(owner, 'linzhao'), true);
        assert.equal(market.unpublish(owner, 'linzhao'), false);
        assert.equal(market.get(owner, 'linzhao'), null);
    });
});

test('rankings weight favorites over imports over views and respect the window', async () => {
    await withDb((db) => {
        const owner = register(db, 'owner');
        const fan = register(db, 'fan');
        const time = clock('2025-06-10T12:00:00.000Z');
        const market = new MarketService(db, { now: time.now });

        market.publish(owner, 'linzhao', { name: '林昭', tags: ['治愈'], descriptionLength: 10 });
        market.publish(owner, 'yeyu', { name: '夜雨', tags: ['悬疑'], descriptionLength: 10 });

        // An older burst of views that must fall out of the day/week/month windows.
        time.set('2025-04-01T12:00:00.000Z');
        market.recordView(owner, 'yeyu');
        market.recordView(owner, 'yeyu');
        market.recordView(owner, 'yeyu');

        time.set('2025-06-10T12:00:00.000Z');
        market.recordView(owner, 'linzhao');
        market.recordImport(owner, 'linzhao');
        market.setFavorite(fan, owner, 'linzhao', true);

        const day = market.rankings('day', 10);
        assert.equal(day.length, 2);
        assert.equal(day[0]?.characterId, 'linzhao');
        assert.equal(day[0]?.rank, 1);
        assert.deepEqual(day[0]?.stats, { favorites: 1, imports: 1, views: 1, score: 6 });
        assert.equal(day[1]?.characterId, 'yeyu');
        assert.equal(day[1]?.stats.score, 0);

        const week = market.rankings('week', 10);
        assert.equal(week[1]?.stats.views, 0);

        const month = market.rankings('month', 10);
        assert.equal(month[1]?.stats.views, 0);

        // All time does include it: 3 views and nothing else.
        const all = market.rankings('all', 10);
        const yeyu = all.find((row) => row.characterId === 'yeyu');
        assert.deepEqual(yeyu?.stats, { favorites: 0, imports: 0, views: 3, score: 3 });

        // Unpublishing removes it from the ranking entirely.
        market.unpublish(owner, 'yeyu');
        assert.deepEqual(market.rankings('all', 10).map((row) => row.characterId), ['linzhao']);
    });
});

test('views and imports of an unpublished card are not counted', async () => {
    await withDb((db) => {
        const owner = register(db, 'owner');
        const market = new MarketService(db);

        market.recordView(owner, 'ghost');
        market.recordImport(owner, 'ghost');
        assert.deepEqual(market.statsFor(owner, 'ghost'), { favorites: 0, imports: 0, views: 0, score: 0 });

        assert.throws(() => market.setFavorite(owner, owner, 'ghost', true), (error: unknown) => {
            assert.ok(error instanceof MarketError);
            assert.equal(error.code, 'not_published');
            assert.equal(error.status, 404);
            return true;
        });
    });
});

test('favorites toggle, survive repetition and are listed per user', async () => {
    await withDb((db) => {
        const owner = register(db, 'owner');
        const fan = register(db, 'fan');
        const market = new MarketService(db);

        market.publish(owner, 'linzhao', { name: '林昭', tags: [], descriptionLength: 5 });

        assert.deepEqual(market.setFavorite(fan, owner, 'linzhao', true), { favorited: true, favorites: 1 });
        // Asking for the same state twice must not double-count.
        assert.deepEqual(market.setFavorite(fan, owner, 'linzhao', true), { favorited: true, favorites: 1 });

        const listed = market.favoritesFor(fan);
        assert.equal(listed.length, 1);
        assert.equal(listed[0]?.characterId, 'linzhao');
        assert.equal(listed[0]?.favorited, true);

        assert.deepEqual(market.setFavorite(fan, owner, 'linzhao', false), { favorited: false, favorites: 0 });
        assert.deepEqual(market.favoritesFor(fan), []);

        // Un-favoriting something that was never favorited is not an error.
        assert.deepEqual(market.setFavorite(fan, owner, 'linzhao', false), { favorited: false, favorites: 0 });
    });
});

test('search, tag filter and sort read the published snapshot', async () => {
    await withDb((db) => {
        const owner = register(db, 'owner');
        const time = clock('2025-07-01T00:00:00.000Z');
        const market = new MarketService(db, { now: time.now });

        market.publish(owner, 'linzhao', { name: '林昭', tags: ['cat', 'cozy'], descriptionLength: 5 });
        time.set('2025-07-02T00:00:00.000Z');
        market.publish(owner, 'yeyu', { name: '夜雨', tags: ['category'], descriptionLength: 5 });
        time.set('2025-07-03T00:00:00.000Z');
        market.publish(owner, 'anan', { name: '安安', tags: ['治愈'], descriptionLength: 5 });

        // A tag filter matches whole tags: "cat" must not match "category".
        assert.deepEqual(market.list({ tag: 'cat' }).map((entry) => entry.characterId), ['linzhao']);
        assert.deepEqual(market.list({ tag: 'category' }).map((entry) => entry.characterId), ['yeyu']);

        // Search covers the name and the tags.
        assert.deepEqual(market.list({ q: '夜' }).map((entry) => entry.characterId), ['yeyu']);
        assert.deepEqual(market.list({ q: '治愈' }).map((entry) => entry.characterId), ['anan']);

        assert.deepEqual(market.list({ sort: 'new' }).map((entry) => entry.characterId), ['anan', 'yeyu', 'linzhao']);
        // By display name, which for CJK means codepoint order: 夜 < 安 < 林.
        assert.deepEqual(market.list({ sort: 'name' }).map((entry) => entry.characterId), ['yeyu', 'anan', 'linzhao']);

        // Hot puts the most-favorited first and breaks ties by name.
        market.recordView(owner, 'yeyu');
        assert.deepEqual(market.list({ sort: 'hot' }).map((entry) => entry.characterId), ['yeyu', 'anan', 'linzhao']);

        assert.deepEqual(market.list({ limit: 1, offset: 1, sort: 'new' }).map((entry) => entry.characterId), ['yeyu']);
    });
});

// ---------------------------------------------------------------------- HTTP

interface Harness {
    base: string;
    register: (handle: string) => Promise<{ token: string; user: { id: string; role: string }; credits: { balance: number } | null }>;
    creditsOf: (token: string) => Promise<{
        tokensPerCredit: number;
        credits: {
            balance: number;
            granted: number;
            spent: number;
            today: { granted: number; spent: number };
            recent: { amount: number; reason: string; reference: string | null; metadata: Record<string, unknown> | null }[];
        };
    }>;
    close: () => Promise<void>;
}


/** A submission is not listed until somebody approves it. */
async function approve(base: string, token: string, ownerId: string, characterId: string): Promise<void> {
    const response = await fetch(`${base}/api/v1/admin/reviews`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({ ownerId, characterId, decision: 'approve' }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
}

async function withServer(
    endpoint: string,
    run: (harness: Harness) => Promise<void>,
    options: { initialGrant?: number; market?: boolean } = {},
): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), 'story-m6-srv-'));
    const db = new Database(path.join(dir, 'test.sqlite'));

    const base = loadAppConfig({ STORY_AUTH: 'on' });
    const config: AppConfig = {
        ...base,
        dataRoot: path.join(dir, 'data'),
        databasePath: path.join(dir, 'test.sqlite'),
        authRequired: true,
        defaultQuota: POLICY,
        // Memory is off so a turn charges exactly one ledger row.
        memory: { ...base.memory, enabled: false },
        credits: { ...base.credits, initialGrant: options.initialGrant ?? 100 },
    };

    const auth = new AuthService(db, { kdf: FAST_KDF, sessionTtlDays: 1 });
    const billing = new BillingService(db, { defaultQuota: POLICY, maxConcurrentStreamsPerUser: 4 });
    const credits = new CreditService(db, {
        initialGrant: config.credits.initialGrant,
        checkinAmount: config.credits.checkinAmount,
        inviteReward: config.credits.inviteReward,
        inviteeReward: config.credits.inviteeReward,
        tokensPerCredit: config.credits.tokensPerCredit,
    });
    const market = options.market === false ? null : new MarketService(db);

    const libraries = new Map<string, Library>();
    const context: ServerContext = {
        config,
        auth,
        billing,
        credits,
        market,
        libraryFor: (userId: string) => {
            const root = path.join(config.dataRoot, 'users', userId);
            const existing = libraries.get(root) ?? new Library(root);
            libraries.set(root, existing);
            return existing;
        },
    };

    const server = createServer(context, {
        loadModelConfig: () => Promise.resolve({ endpoint, model: 'mock-model', maxTokens: 50 }),
        personaName: 'User',
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;

    try {
        await run({
            base: origin,
            register: async (handle) => {
                const response = await fetch(`${origin}/api/v1/auth/register`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ handle, password: PASSWORD }),
                });

                const text = await response.text();
                assert.equal(response.status, 201, `registration of ${handle} failed: ${text}`);
                return JSON.parse(text) as { token: string; user: { id: string; role: string }; credits: { balance: number } | null };
            },
            creditsOf: async (token) => {
                const response = await fetch(`${origin}/api/v1/me/credits`, { headers: bearer(token) });
                const text = await response.text();
                assert.equal(response.status, 200, text);
                return JSON.parse(text) as Awaited<ReturnType<Harness['creditsOf']>>;
            },
            close: async () => {
                await new Promise<void>((resolve) => server.close(() => resolve()));
            },
        });
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        db.close();
        await rm(dir, { recursive: true, force: true });
    }
}

function bearer(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function importCard(base: string, token: string, name = 'linzhao'): Promise<void> {
    const response = await fetch(`${base}/api/v1/characters`, {
        method: 'POST',
        headers: { ...bearer(token), 'x-filename': name },
        body: JSON.stringify(card),
    });
    assert.equal(response.status, 201);
}

async function newChat(base: string, token: string, name = 'session'): Promise<string> {
    const response = await fetch(`${base}/api/v1/chats`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({ cardId: 'linzhao', name }),
    });
    const text = await response.text();
    assert.equal(response.status, 201, text);
    return (JSON.parse(text) as { name: string }).name;
}

test('a new account starts with a balance and can check in once a day', async () => {
    const mock = await startMockModel();

    try {
        await withServer(mock.endpoint, async ({ base, register, creditsOf }) => {
            const owner = await register('owner');
            assert.equal(owner.credits?.balance, 100);

            const before = await creditsOf(owner.token);
            assert.equal(before.tokensPerCredit, 1000);
            assert.equal(before.credits.balance, 100);
            assert.equal(before.credits.granted, 100);

            const first = await (await fetch(`${base}/api/v1/me/checkin`, { method: 'POST', headers: bearer(owner.token) })).json() as
                { granted: boolean; amount: number; balance: number; credits: { balance: number } };
            assert.equal(first.granted, true);
            assert.equal(first.amount, 10);
            assert.equal(first.balance, 110);
            assert.equal(first.credits.balance, 110);

            const second = await (await fetch(`${base}/api/v1/me/checkin`, { method: 'POST', headers: bearer(owner.token) })).json() as
                { granted: boolean; balance: number };
            assert.equal(second.granted, false);
            assert.equal(second.balance, 110);

            const me = await (await fetch(`${base}/api/v1/me`, { headers: bearer(owner.token) })).json() as
                { credits: { balance: number } };
            assert.equal(me.credits.balance, 110);
        });
    } finally {
        await mock.close();
    }
});

test('an invite rewards both sides over HTTP', async () => {
    const mock = await startMockModel();

    try {
        await withServer(mock.endpoint, async ({ base, register, creditsOf }) => {
            const inviter = await register('inviter');
            const guest = await register('guest');

            const created = await fetch(`${base}/api/v1/me/invites`, {
                method: 'POST',
                headers: bearer(inviter.token),
                body: JSON.stringify({ count: 1 }),
            });
            assert.equal(created.status, 201);
            const { codes } = await created.json() as { codes: string[] };
            assert.equal(codes.length, 1);

            const redeem = await fetch(`${base}/api/v1/me/invites/redeem`, {
                method: 'POST',
                headers: bearer(guest.token),
                body: JSON.stringify({ code: codes[0] }),
            });
            const body = await redeem.json() as { reward: number; inviterReward: number; balance: number; credits: { balance: number } };
            assert.equal(redeem.status, 200);
            assert.equal(body.reward, 50);
            assert.equal(body.inviterReward, 50);
            assert.equal(body.balance, 150);
            assert.equal(body.credits.balance, 150);

            assert.equal((await creditsOf(inviter.token)).credits.balance, 150);

            // A second attempt is a conflict, and the guest is not paid again.
            const again = await fetch(`${base}/api/v1/me/invites/redeem`, {
                method: 'POST',
                headers: bearer(guest.token),
                body: JSON.stringify({ code: codes[0] }),
            });
            assert.equal(again.status, 409);
            assert.equal((await creditsOf(guest.token)).credits.balance, 150);

            const unknown = await fetch(`${base}/api/v1/me/invites/redeem`, {
                method: 'POST',
                headers: bearer(guest.token),
                body: JSON.stringify({ code: 'NOPE2345' }),
            });
            assert.equal(unknown.status, 404);
        });
    } finally {
        await mock.close();
    }
});

test('a completed turn charges credits against its request id', async () => {
    const mock = await startMockModel(respondWith('嗯。', { prompt_tokens: 900, completion_tokens: 300, total_tokens: 1200 }));

    try {
        await withServer(mock.endpoint, async ({ base, register, creditsOf }) => {
            const owner = await register('owner');
            await importCard(base, owner.token);
            const chat = await newChat(base, owner.token);

            const turn = await fetch(`${base}/api/v1/chats/linzhao/${chat}/messages`, {
                method: 'POST',
                headers: bearer(owner.token),
                body: JSON.stringify({ message: '你好', requestId: 'turn-1' }),
            });
            const text = await turn.text();
            assert.equal(turn.status, 200, text);

            // 1200 tokens at 1000 tokens per credit rounds up to 2.
            const after = await creditsOf(owner.token);
            assert.equal(after.credits.balance, 98);
            assert.equal(after.credits.spent, 2);
            assert.equal(after.credits.today.spent, 2);
            assert.equal(after.credits.recent.length, 2);
            assert.equal(after.credits.recent[0]?.reason, 'turn');
            assert.equal(after.credits.recent[0]?.reference, 'turn-1');
            assert.equal(after.credits.recent[0]?.amount, -2);
            assert.equal(after.credits.recent[0]?.metadata?.tokens, 1200);

            // Retrying the same request id runs again but is not charged again.
            const retry = await fetch(`${base}/api/v1/chats/linzhao/${chat}/messages`, {
                method: 'POST',
                headers: bearer(owner.token),
                body: JSON.stringify({ message: '你好', requestId: 'turn-1' }),
            });
            assert.equal(retry.status, 200);
            assert.equal((await creditsOf(owner.token)).credits.balance, 98);
        });
    } finally {
        await mock.close();
    }
});

test('an account with no credits is refused before the model is called', async () => {
    const mock = await startMockModel();

    try {
        await withServer(mock.endpoint, async ({ base, register, creditsOf }) => {
            const owner = await register('broke');
            assert.equal(owner.credits?.balance, 0);

            await importCard(base, owner.token);
            const chat = await newChat(base, owner.token);

            const turn = await fetch(`${base}/api/v1/chats/linzhao/${chat}/messages`, {
                method: 'POST',
                headers: bearer(owner.token),
                body: JSON.stringify({ message: '你好' }),
            });
            const text = await turn.text();
            assert.equal(turn.status, 402, text);

            const body = JSON.parse(text) as { error: string; balance: number };
            assert.equal(body.error, 'insufficient_credits');
            assert.equal(body.balance, 0);

            // The point of the gate: nothing was spent upstream.
            assert.equal(mock.requests.length, 0);
            assert.equal((await creditsOf(owner.token)).credits.balance, 0);

            // An admin top-up reopens the door. The first account is the admin, so
            // this is the owner granting to herself.
            const granted = await fetch(`${base}/api/v1/admin/users/${owner.user.id}/credits`, {
                method: 'POST',
                headers: bearer(owner.token),
                body: JSON.stringify({ amount: 5 }),
            });
            assert.equal(granted.status, 200);
            assert.equal((await creditsOf(owner.token)).credits.balance, 5);

            const allowed = await fetch(`${base}/api/v1/chats/linzhao/${chat}/messages`, {
                method: 'POST',
                headers: bearer(owner.token),
                body: JSON.stringify({ message: '你好' }),
            });
            assert.equal(allowed.status, 200);
        }, { initialGrant: 0 });
    } finally {
        await mock.close();
    }
});

test('only an admin can grant credits', async () => {
    const mock = await startMockModel();

    try {
        await withServer(mock.endpoint, async ({ base, register, creditsOf }) => {
            const admin = await register('admin');
            const member = await register('member');

            const forbidden = await fetch(`${base}/api/v1/admin/users/${member.user.id}/credits`, {
                method: 'POST',
                headers: bearer(member.token),
                body: JSON.stringify({ amount: 500 }),
            });
            assert.equal(forbidden.status, 403);

            const grant = (): Promise<Response> => fetch(`${base}/api/v1/admin/users/${member.user.id}/credits`, {
                method: 'POST',
                headers: bearer(admin.token),
                body: JSON.stringify({ amount: 500, reference: 'goodwill' }),
            });

            const first = await grant();
            assert.equal(first.status, 200);
            assert.deepEqual(await first.json(), { userId: member.user.id, recorded: true, balance: 600 });

            // The same reference is the same grant, even for an admin.
            const second = await grant();
            assert.deepEqual(await second.json(), { userId: member.user.id, recorded: false, balance: 600 });
            assert.equal((await creditsOf(member.token)).credits.balance, 600);

            const zero = await fetch(`${base}/api/v1/admin/users/${member.user.id}/credits`, {
                method: 'POST',
                headers: bearer(admin.token),
                body: JSON.stringify({ amount: 0 }),
            });
            assert.equal(zero.status, 400);
        });
    } finally {
        await mock.close();
    }
});

test('publishing, favoriting and importing round-trip through the market', async () => {
    const mock = await startMockModel();

    try {
        await withServer(mock.endpoint, async ({ base, register }) => {
            const alice = await register('alice');
            const bob = await register('bob');
            await importCard(base, alice.token);

            // Private until published, and invisible to everyone else.
            const status = await fetch(`${base}/api/v1/characters/linzhao/publish`, { headers: bearer(alice.token) });
            assert.deepEqual(await status.json(), { status: null, published: false, character: null });
            assert.deepEqual(
                ((await (await fetch(`${base}/api/v1/market`, { headers: bearer(bob.token) })).json()) as { characters: unknown[] }).characters,
                [],
            );

            const publish = await fetch(`${base}/api/v1/characters/linzhao/publish`, {
                method: 'POST',
                headers: bearer(alice.token),
            });
            // Submitting is not listing: the response is the submission.
            const submitted = await publish.json() as { status: string; character: { name: string; stats: { score: number } } };
            assert.equal(publish.status, 201);
            assert.equal(submitted.status, 'pending', 'submitting does not list it');
            assert.equal(submitted.character.name, '林昭');

            await approve(base, alice.token, alice.user.id, 'linzhao');
            const now = (await (await fetch(`${base}/api/v1/characters/linzhao/publish`, { headers: bearer(alice.token) })).json()) as {
                status: string;
                published: boolean;
                character: { name: string; stats: { score: number } };
            };
            assert.equal(now.published, true);
            const published = now;

            const listing = await (await fetch(`${base}/api/v1/market?sort=new`, { headers: bearer(bob.token) })).json() as
                { characters: { ownerId: string; characterId: string; favorited: boolean }[] };
            assert.equal(listing.characters.length, 1);
            assert.equal(listing.characters[0]?.ownerId, alice.user.id);
            assert.equal(listing.characters[0]?.favorited, false);

            // The listing is public to a logged-in reader, but not to nobody.
            assert.equal((await fetch(`${base}/api/v1/market`)).status, 401);

            // Someone other than the owner viewing it counts as a view.
            const detail = await fetch(`${base}/api/v1/market/${alice.user.id}/linzhao`, { headers: bearer(bob.token) });
            assert.equal(detail.status, 200);
            assert.equal(((await detail.json()) as { character: { stats: { views: number } } }).character.stats.views, 1);

            const favorite = await fetch(`${base}/api/v1/market/${alice.user.id}/linzhao/favorite`, {
                method: 'POST',
                headers: bearer(bob.token),
            });
            assert.deepEqual(await favorite.json(), { favorited: true, favorites: 1 });

            const favorites = await (await fetch(`${base}/api/v1/me/favorites`, { headers: bearer(bob.token) })).json() as
                { characters: { characterId: string; favorited: boolean }[] };
            assert.deepEqual(favorites.characters.map((entry) => [entry.characterId, entry.favorited]), [['linzhao', true]]);

            // Import copies the card into bob's library; alice keeps hers.
            const imported = await fetch(`${base}/api/v1/market/${alice.user.id}/linzhao/import`, {
                method: 'POST',
                headers: bearer(bob.token),
            });
            assert.equal(imported.status, 201);
            assert.equal(((await imported.json()) as { imported: { id: string } }).imported.id, 'linzhao');

            const ids = async (token: string): Promise<string[]> =>
                ((await (await fetch(`${base}/api/v1/characters`, { headers: bearer(token) })).json()) as { characters: { id: string }[] })
                    .characters.map((entry) => entry.id);

            assert.deepEqual(await ids(bob.token), ['linzhao']);
            assert.deepEqual(await ids(alice.token), ['linzhao']);

            // Importing your own listing would just create a duplicate.
            const selfImport = await fetch(`${base}/api/v1/market/${alice.user.id}/linzhao/import`, {
                method: 'POST',
                headers: bearer(alice.token),
            });
            assert.equal(selfImport.status, 400);
            assert.equal(((await selfImport.json()) as { error: string }).error, 'own_character');

            const ranking = await (await fetch(`${base}/api/v1/rankings?window=day`, { headers: bearer(bob.token) })).json() as
                { window: string; characters: { characterId: string; rank: number; stats: { favorites: number; imports: number; views: number; score: number } }[] };
            assert.equal(ranking.window, 'day');
            assert.equal(ranking.characters[0]?.rank, 1);
            assert.equal(ranking.characters[0]?.characterId, 'linzhao');
            assert.deepEqual(ranking.characters[0]?.stats, { favorites: 1, imports: 1, views: 1, score: 6 });

            // The owner looking at her own listing must not inflate it.
            await fetch(`${base}/api/v1/market/${alice.user.id}/linzhao`, { headers: bearer(alice.token) });
            const after = await (await fetch(`${base}/api/v1/rankings?window=all`, { headers: bearer(bob.token) })).json() as
                { characters: { stats: { views: number } }[] };
            assert.equal(after.characters[0]?.stats.views, 1);

            // A bad window falls back to day rather than erroring.
            assert.equal(
                ((await (await fetch(`${base}/api/v1/rankings?window=nonsense`, { headers: bearer(bob.token) })).json()) as { window: string }).window,
                'day',
            );

            // Withdrawing it removes it everywhere, including further imports.
            const unpublish = await fetch(`${base}/api/v1/characters/linzhao/publish`, {
                method: 'DELETE',
                headers: bearer(alice.token),
            });
            assert.deepEqual((await unpublish.json()) as unknown, { withdrawn: true, status: 'withdrawn' });
            assert.equal((await fetch(`${base}/api/v1/market/${alice.user.id}/linzhao`, { headers: bearer(bob.token) })).status, 404);
            assert.deepEqual(
                ((await (await fetch(`${base}/api/v1/market`, { headers: bearer(bob.token) })).json()) as { characters: unknown[] }).characters,
                [],
            );
            assert.deepEqual(
                ((await (await fetch(`${base}/api/v1/rankings?window=all`, { headers: bearer(bob.token) })).json()) as { characters: unknown[] }).characters,
                [],
            );
            assert.equal(
                (await fetch(`${base}/api/v1/market/${alice.user.id}/linzhao/import`, {
                    method: 'POST',
                    headers: bearer(bob.token),
                })).status,
                404,
            );
        });
    } finally {
        await mock.close();
    }
});

test('the market can be switched off without disabling accounts', async () => {
    const mock = await startMockModel();

    try {
        await withServer(mock.endpoint, async ({ base, register }) => {
            const owner = await register('owner');

            const listing = await fetch(`${base}/api/v1/market`, { headers: bearer(owner.token) });
            assert.equal(listing.status, 400);
            assert.equal(((await listing.json()) as { error: string }).error, 'market_disabled');

            assert.equal((await fetch(`${base}/api/v1/rankings`, { headers: bearer(owner.token) })).status, 400);
            assert.equal((await fetch(`${base}/api/v1/me/favorites`, { headers: bearer(owner.token) })).status, 400);

            // Credits are a separate feature and keep working.
            assert.equal((await fetch(`${base}/api/v1/me/credits`, { headers: bearer(owner.token) })).status, 200);
        }, { market: false });
    } finally {
        await mock.close();
    }
});

test('a chat name containing spaces and CJK survives the URL', async () => {
    const mock = await startMockModel();

    try {
        await withServer(mock.endpoint, async ({ base, register }) => {
            const owner = await register('owner');
            await importCard(base, owner.token);

            const name = '雨夜 的 对话';
            assert.equal(await newChat(base, owner.token, name), name);

            const segment = encodeURIComponent(name);

            const loaded = await fetch(`${base}/api/v1/chats/linzhao/${segment}`, { headers: bearer(owner.token) });
            assert.equal(loaded.status, 200);
            const body = await loaded.json() as { name: string; chat: { header: { character_name: string }; messages: unknown[] } };
            assert.equal(body.name, name);
            assert.equal(body.chat.header.character_name, '林昭');
            assert.equal(body.chat.messages.length, 1);

            // The turn path reads the same segment, so it has to decode too.
            const turn = await fetch(`${base}/api/v1/chats/linzhao/${segment}/messages`, {
                method: 'POST',
                headers: bearer(owner.token),
                body: JSON.stringify({ message: '在吗' }),
            });
            const text = await turn.text();
            assert.equal(turn.status, 200, text);
        });
    } finally {
        await mock.close();
    }
});

// ----------------------------------------------------------------- moderation

test('a report is recorded, and resolving one is not the same as deleting it', async () => {
    await withDb((db) => {
        const auth = new AuthService(db, { kdf: FAST_KDF });
        const market = new MarketService(db);
        const owner = auth.register({ handle: 'owner', password: PASSWORD }).user.id;
        const reader = auth.register({ handle: 'reader', password: PASSWORD }).user.id;

        market.publish(owner, 'linzhao', { name: '林昭', tags: ['现代'], descriptionLength: 4 });

        const first = market.report(owner, 'linzhao', reader, '这张卡里有别人的真实信息');
        assert.equal(first.status, 'open');

        // The button means "look at this", not a counter a grudge can inflate.
        const again = market.report(owner, 'linzhao', reader, '再说一次');
        assert.equal(again.id, first.id, 'a second open report from the same person is the same one');
        assert.equal(market.reports('open').length, 1);

        const other = auth.register({ handle: 'other', password: PASSWORD }).user.id;
        market.report(owner, 'linzhao', other, '也不合适');
        assert.equal(market.reports('open').length, 2);

        // Taking it down resolves every open report against it and keeps the
        // record of who said what and who decided.
        const resolved = market.resolveReport(first.id, owner, 'unpublish');
        assert.equal(resolved.unpublished, true);
        assert.equal(market.isPublic(owner, 'linzhao'), false);

        const kept = market.reports('all').find((report) => report.id === first.id);
        assert.equal(kept?.status, 'resolved');
        assert.equal(kept?.action, 'unpublish');
        assert.equal(kept?.reporterId, reader, 'the record survives the takedown');
        assert.equal(kept?.reason, '这张卡里有别人的真实信息');
        assert.equal(market.reports('open').length, 1, 'only the one that was resolved left the queue');

        market.resolveReport(market.reports('open')[0]!.id, owner, 'dismiss');
        assert.deepEqual(market.reports('open'), []);
        assert.equal(market.reports('all').length, 2, 'resolving empties the queue, not the history');
    });
});

test('a report is refused against something that is not published', async () => {
    await withDb((db) => {
        const auth = new AuthService(db, { kdf: FAST_KDF });
        const market = new MarketService(db);
        const owner = auth.register({ handle: 'owner', password: PASSWORD }).user.id;
        const reader = auth.register({ handle: 'reader', password: PASSWORD }).user.id;

        assert.throws(() => market.resolveReport(999, owner, 'dismiss'), /no such report/);
        market.report(owner, 'linzhao', reader, 'never published');
        assert.equal(market.reports('open').length, 1, 'the report is taken; it is the listing check that the route owns');
        assert.equal(market.isPublic(owner, 'linzhao'), false);
    });
});

// ------------------------------------------------------- the life of a work

test('a work goes submit -> review -> list, and being refused is not being deleted', async () => {
    await withDb((db) => {
        const auth = new AuthService(db, { kdf: FAST_KDF });
        const market = new MarketService(db);
        const owner = auth.register({ handle: 'owner', password: PASSWORD }).user.id;
        const reviewer = auth.register({ handle: 'reviewer', password: PASSWORD }).user.id;
        const snapshot = { name: '林昭', tags: ['现代'], descriptionLength: 4 };

        // Submitting is not publishing. Nothing is listed by writing a row.
        market.submit(owner, 'linzhao', snapshot);
        assert.equal(market.stateOf(owner, 'linzhao'), 'pending');
        assert.equal(market.get(owner, 'linzhao', reviewer), null, 'a submission is not on the market');
        assert.equal(market.reviewQueue('pending').length, 1);

        // Being refused keeps the reason, which is the point of a review rather
        // than a silent delete: the author has to be able to fix it.
        const rejected = market.review(owner, 'linzhao', reviewer, 'reject', '设定里有别人的真实信息');
        assert.equal(rejected.status, 'rejected');
        assert.equal(rejected.reviewNote, '设定里有别人的真实信息');
        assert.equal(market.get(owner, 'linzhao', reviewer), null);
        assert.equal(market.reviewQueue('pending').length, 0, 'a decision empties the queue');

        // Fixing it and resubmitting goes round again.
        market.submit(owner, 'linzhao', { ...snapshot, descriptionLength: 5 });
        const listed = market.review(owner, 'linzhao', reviewer, 'approve');
        assert.equal(listed.status, 'public');
        assert.equal(market.get(owner, 'linzhao', reviewer)?.name, '林昭');
        assert.equal(listed.publishedAt !== null, true);

        // A withdrawal is reversible: it can be submitted again.
        assert.equal(market.withdraw(owner, 'linzhao'), true);
        assert.equal(market.stateOf(owner, 'linzhao'), 'withdrawn');
        assert.equal(market.get(owner, 'linzhao', reviewer), null);
    });
});

test('a timed release waits for its moment, and the listing clock is the lever', async () => {
    let clock = new Date('2026-03-01T00:00:00.000Z');

    await withDb((db) => {
        const auth = new AuthService(db, { kdf: FAST_KDF });
        const market = new MarketService(db, { now: () => clock });
        const owner = auth.register({ handle: 'owner', password: PASSWORD }).user.id;
        const reviewer = auth.register({ handle: 'reviewer', password: PASSWORD }).user.id;

        market.submit(owner, 'linzhao', { name: '林昭', tags: [], descriptionLength: 1 }, {
            scheduledAt: '2026-03-08T00:00:00.000Z',
            anonymous: true,
            rating: 'adult',
        });

        // Review passes, but the author asked for a later release: it waits.
        const approved = market.review(owner, 'linzhao', reviewer, 'approve');
        assert.equal(approved.status, 'approved');
        assert.equal(market.get(owner, 'linzhao', reviewer), null, 'not listed before its time');
        assert.equal(approved.anonymous, true, 'anonymity travels with the listing');
        assert.equal(approved.rating, 'adult');

        // There is no timer to be running: the read paths release what is due.
        clock = new Date('2026-03-09T00:00:00.000Z');
        const listed = market.reviewQueue('pending');
        assert.equal(listed.length, 0, 'it is no longer awaiting anything');
        assert.equal(market.get(owner, 'linzhao', reviewer)?.status, 'public');

        // `published_at` is when it was first released and never moves. The
        // listing clock is the operator's lever and does.
        const first = market.get(owner, 'linzhao', reviewer)!;
        assert.equal(first.publishedAt, '2026-03-09T00:00:00.000Z');

        clock = new Date('2026-04-01T00:00:00.000Z');
        const bumped = market.setPublishTime(owner, 'linzhao', '2026-04-01T00:00:00.000Z');
        assert.equal(bumped.publishTime, '2026-04-01T00:00:00.000Z');
        assert.equal(bumped.publishedAt, '2026-03-09T00:00:00.000Z', 'the record of a first release survives a re-bump');
    });
});
