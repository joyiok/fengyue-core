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
import { Database } from '../src/db/database.ts';
import type { ModelConfig } from '../src/gateway/types.ts';
import { Library } from '../src/library.ts';
import { createAppContext, createServer, type ServerContext } from '../src/server.ts';
import { respondWith, respondSse, startMockModel, type MockUsage } from './helpers/mock-model.ts';

const POLICY: QuotaPolicy = { dailyTokenLimit: 100_000, monthlyTokenLimit: 1_000_000, maxTokensPerRequest: 100 };

const card = normalizeCard({
    spec: 'chara_card_v2',
    data: { name: '林昭', description: '书店店主', personality: '话少', scenario: '书房', first_mes: '来了。' },
});

interface Harness {
    base: string;
    dir: string;
    auth: AuthService;
    billing: BillingService;
    db: Database;
    register: (handle: string) => Promise<{ token: string; user: { id: string; role: string } }>;
    close: () => Promise<void>;
}

async function withServer(
    endpoint: string,
    run: (harness: Harness) => Promise<void>,
    options: { quota?: QuotaPolicy; global?: number; allowRegistration?: boolean; maxStreams?: number } = {},
): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), 'story-server-m4-'));
    const db = new Database(path.join(dir, 'test.sqlite'));
    const config: AppConfig = {
        ...loadAppConfig({ STORY_AUTH: 'on' }),
        dataRoot: path.join(dir, 'data'),
        databasePath: path.join(dir, 'test.sqlite'),
        authRequired: true,
        allowRegistration: options.allowRegistration ?? true,
        defaultQuota: options.quota ?? POLICY,
        globalDailyTokenLimit: options.global ?? 0,
        maxConcurrentStreamsPerUser: options.maxStreams ?? 4,
    };

    const auth = new AuthService(db, { kdf: FAST_KDF, sessionTtlDays: 1 });
    const billing = new BillingService(db, {
        defaultQuota: config.defaultQuota,
        globalDailyTokenLimit: config.globalDailyTokenLimit,
        maxConcurrentStreamsPerUser: config.maxConcurrentStreamsPerUser,
    });

    const libraries = new Map<string, Library>();
    const context: ServerContext = {
        config,
        auth,
        billing,
        // This suite is about quotas; credits and the market have their own.
        credits: null,
        market: null,
        libraryFor: (userId: string) => {
            const root = path.join(config.dataRoot, 'users', userId);
            const existing = libraries.get(root) ?? new Library(root);
            libraries.set(root, existing);
            return existing;
        },
    };

    const modelConfig: ModelConfig = { endpoint, model: 'mock-model', maxTokens: 50 };
    const server = createServer(context, { loadModelConfig: () => Promise.resolve(modelConfig), personaName: 'User' });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const register = async (handle: string): Promise<{ token: string; user: { id: string; role: string } }> => {
        const response = await fetch(`${base}/api/v1/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ handle, password: `${handle}-long-enough-password` }),
        });

        // Read the body once: an `await response.text()` inside the assertion
        // message would consume it before json() runs.
        const text = await response.text();
        assert.equal(response.status, 201, `registration of ${handle} failed: ${text}`);
        const body = JSON.parse(text) as { token: string; user: { id: string; role: string } };

        return { token: body.token, user: body.user };
    };

    try {
        await run({
            base,
            dir,
            auth,
            billing,
            db,
            register,
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

// ------------------------------------------------------------------- accounts

test('the first account is an admin and gets a usable token', async () => {
    const mock = await startMockModel();

    try {
        await withServer(mock.endpoint, async ({ base, register }) => {
            const owner = await register('owner');
            assert.equal(owner.user.role, 'admin');

            const health = await (await fetch(`${base}/health`)).json() as { auth: boolean };
            assert.equal(health.auth, true);

            const me = await fetch(`${base}/api/v1/me`, { headers: bearer(owner.token) });
            assert.equal(me.status, 200);
            const body = await me.json() as { user: { handle: string }; usage: { policy: QuotaPolicy } };
            assert.equal(body.user.handle, 'owner');
            assert.equal(body.usage.policy.maxTokensPerRequest, 100);
        });
    } finally {
        await mock.close();
    }
});

test('protected routes require a token and reject a bad one', async () => {
    const mock = await startMockModel();

    try {
        await withServer(mock.endpoint, async ({ base, register }) => {
            const owner = await register('owner');

            assert.equal((await fetch(`${base}/api/v1/characters`)).status, 401);
            assert.equal((await fetch(`${base}/api/v1/characters`, { headers: bearer('nonsense') })).status, 401);
            assert.equal((await fetch(`${base}/api/v1/characters`, { headers: bearer(owner.token) })).status, 200);

            // /health stays public so a load balancer can probe it.
            assert.equal((await fetch(`${base}/health`)).status, 200);
        });
    } finally {
        await mock.close();
    }
});

test('login works and a wrong password does not', async () => {
    const mock = await startMockModel();

    try {
        await withServer(mock.endpoint, async ({ base, register }) => {
            await register('owner');

            const ok = await fetch(`${base}/api/v1/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ handle: 'owner', password: 'owner-long-enough-password' }),
            });
            assert.equal(ok.status, 200);
            assert.ok((await ok.json() as { token: string }).token);

            const bad = await fetch(`${base}/api/v1/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ handle: 'owner', password: 'not-the-password' }),
            });
            assert.equal(bad.status, 401);
            assert.equal((await bad.json() as { error: string }).error, 'invalid_credentials');
        });
    } finally {
        await mock.close();
    }
});

test('registration can be closed once the owner exists', async () => {
    const mock = await startMockModel();

    try {
        await withServer(mock.endpoint, async ({ base, register }) => {
            await register('owner');

            const closed = await fetch(`${base}/api/v1/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ handle: 'stranger', password: 'stranger-long-enough-password' }),
            });

            assert.equal(closed.status, 403);
            assert.equal((await closed.json() as { error: string }).error, 'registration_closed');
        }, { allowRegistration: false });
    } finally {
        await mock.close();
    }
});

test('the first account is still possible when registration is closed', async () => {
    const mock = await startMockModel();

    try {
        await withServer(mock.endpoint, async ({ register }) => {
            // Bootstrap must not be locked out by the flag.
            const owner = await register('owner');
            assert.equal(owner.user.role, 'admin');
        }, { allowRegistration: false });
    } finally {
        await mock.close();
    }
});

test('disabling an account immediately stops its tokens', async () => {
    const mock = await startMockModel();

    try {
        await withServer(mock.endpoint, async ({ base, register, auth }) => {
            const owner = await register('owner');
            const guest = await register('guest');

            assert.equal((await fetch(`${base}/api/v1/characters`, { headers: bearer(guest.token) })).status, 200);

            auth.setStatus(guest.user.id, 'disabled');

            assert.equal((await fetch(`${base}/api/v1/characters`, { headers: bearer(guest.token) })).status, 401);
            assert.equal((await fetch(`${base}/api/v1/characters`, { headers: bearer(owner.token) })).status, 200);
        });
    } finally {
        await mock.close();
    }
});

// ------------------------------------------------------------------ isolation

test('each account gets its own library and cannot see the others', async () => {
    const mock = await startMockModel();

    try {
        await withServer(mock.endpoint, async ({ base, register, dir }) => {
            const alice = await register('alice');
            const bob = await register('bob');

            await importCard(base, alice.token, 'alice-card');

            const aliceList = await (await fetch(`${base}/api/v1/characters`, { headers: bearer(alice.token) })).json() as { characters: { id: string }[] };
            assert.deepEqual(aliceList.characters.map((entry) => entry.id), ['alice-card']);

            const bobList = await (await fetch(`${base}/api/v1/characters`, { headers: bearer(bob.token) })).json() as { characters: { id: string }[] };
            assert.deepEqual(bobList.characters, [], 'bob must not see alice cards');

            // Even knowing the id, bob cannot fetch it: the path does not exist in
            // his own tree.
            assert.equal((await fetch(`${base}/api/v1/characters/alice-card`, { headers: bearer(bob.token) })).status, 404);
            assert.equal((await fetch(`${base}/api/v1/characters/alice-card`, { headers: bearer(alice.token) })).status, 200);

            // And the isolation is a real filesystem boundary.
            const aliceDir = path.join(dir, 'data', 'users', alice.user.id, 'characters');
            const bobDir = path.join(dir, 'data', 'users', bob.user.id, 'characters');
            assert.notEqual(aliceDir, bobDir);
            assert.deepEqual(await libraryFiles(aliceDir), ['alice-card.png']);
            assert.deepEqual(await libraryFiles(bobDir), []);
        });
    } finally {
        await mock.close();
    }
});

async function libraryFiles(dir: string): Promise<string[]> {
    const { readdir } = await import('node:fs/promises');
    try {
        return (await readdir(dir)).sort();
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------- quotas

test('a turn is billed and shows up in the usage ledger', async () => {
    const mock = await startMockModel(respondWith('在。', { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 }));

    try {
        await withServer(mock.endpoint, async ({ base, register }) => {
            const owner = await register('owner');
            await importCard(base, owner.token);
            const name = await newChat(base, owner.token);

            const response = await fetch(`${base}/api/v1/chats/linzhao/${name}/messages`, {
                method: 'POST',
                headers: bearer(owner.token),
                body: JSON.stringify({ message: '在吗', requestId: 'req-1' }),
            });
            assert.equal(response.status, 200);

            const usage = await (await fetch(`${base}/api/v1/me/usage`, { headers: bearer(owner.token) })).json() as {
                usage: { day: { tokens: number; requests: number; remaining: number } };
                recent: { requestId: string; totalTokens: number; usageSource: string; chatId: string }[];
            };

            assert.equal(usage.usage.day.requests, 1);
            assert.equal(usage.usage.day.tokens, 50);
            assert.equal(usage.usage.day.remaining, POLICY.dailyTokenLimit - 50);
            assert.equal(usage.recent.length, 1);
            assert.equal(usage.recent[0]?.requestId, 'req-1');
            assert.equal(usage.recent[0]?.totalTokens, 50);
            assert.equal(usage.recent[0]?.usageSource, 'provider');
            assert.equal(usage.recent[0]?.chatId, 'linzhao/session');
        });
    } finally {
        await mock.close();
    }
});

test('retrying a request id is served from the log and not billed twice', async () => {
    const mock = await startMockModel(respondWith('在。', { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 }));

    try {
        await withServer(mock.endpoint, async ({ base, register }) => {
            const owner = await register('owner');
            await importCard(base, owner.token);
            const name = await newChat(base, owner.token);

            const send = async (): Promise<{ fromCache: boolean }> => {
                const response = await fetch(`${base}/api/v1/chats/linzhao/${name}/messages`, {
                    method: 'POST',
                    headers: bearer(owner.token),
                    body: JSON.stringify({ message: '在吗', requestId: 'req-1' }),
                });
                assert.equal(response.status, 200);
                return response.json() as Promise<{ fromCache: boolean }>;
            };

            assert.equal((await send()).fromCache, false);
            assert.equal((await send()).fromCache, true);

            const usage = await (await fetch(`${base}/api/v1/me/usage`, { headers: bearer(owner.token) })).json() as {
                usage: { day: { tokens: number; requests: number } };
            };

            assert.equal(mock.requests.length, 1, 'the model must only be called once');
            assert.equal(usage.usage.day.requests, 1);
            assert.equal(usage.usage.day.tokens, 50);
        });
    } finally {
        await mock.close();
    }
});

test('asking for more than the per-request ceiling is refused with the limit', async () => {
    const mock = await startMockModel();

    try {
        await withServer(mock.endpoint, async ({ base, register }) => {
            const owner = await register('owner');
            await importCard(base, owner.token);
            const name = await newChat(base, owner.token);

            const response = await fetch(`${base}/api/v1/chats/linzhao/${name}/messages`, {
                method: 'POST',
                headers: bearer(owner.token),
                body: JSON.stringify({ message: '在吗', overrides: { maxTokens: 5000 } }),
            });

            assert.equal(response.status, 400);
            const body = await response.json() as { error: string; limit: number };
            assert.equal(body.error, 'per_request');
            assert.equal(body.limit, 100);
            assert.equal(mock.requests.length, 0, 'nothing should have been sent upstream');
        });
    } finally {
        await mock.close();
    }
});

test('an exhausted daily quota refuses the next turn with the numbers to show', async () => {
    const mock = await startMockModel(respondWith('在。', { prompt_tokens: 400, completion_tokens: 100, total_tokens: 500 }));

    try {
        await withServer(mock.endpoint, async ({ base, register }) => {
            const owner = await register('owner');
            await importCard(base, owner.token);
            const name = await newChat(base, owner.token);

            const first = await fetch(`${base}/api/v1/chats/linzhao/${name}/messages`, {
                method: 'POST',
                headers: bearer(owner.token),
                body: JSON.stringify({ message: '第一句' }),
            });
            assert.equal(first.status, 200);

            const second = await fetch(`${base}/api/v1/chats/linzhao/${name}/messages`, {
                method: 'POST',
                headers: bearer(owner.token),
                body: JSON.stringify({ message: '第二句' }),
            });

            assert.equal(second.status, 402);
            const body = await second.json() as { error: string; limit: number; used: number; resetAt: string };
            assert.equal(body.error, 'daily');
            assert.equal(body.limit, 400);
            assert.equal(body.used, 500);
            assert.match(body.resetAt, /T00:00:00\.000Z$/);
            assert.equal(mock.requests.length, 1, 'the refused turn must not reach the model');
        }, { quota: { dailyTokenLimit: 400, monthlyTokenLimit: 100_000, maxTokensPerRequest: 100 } });
    } finally {
        await mock.close();
    }
});

test('the global cap refuses everyone with 503', async () => {
    const mock = await startMockModel(respondWith('在。', { prompt_tokens: 400, completion_tokens: 100, total_tokens: 500 }));

    try {
        await withServer(mock.endpoint, async ({ base, register }) => {
            const owner = await register('owner');
            const guest = await register('guest');

            await importCard(base, owner.token);
            const ownerChat = await newChat(base, owner.token, 'owner-chat');
            await importCard(base, guest.token);
            const guestChat = await newChat(base, guest.token, 'guest-chat');

            const first = await fetch(`${base}/api/v1/chats/linzhao/${ownerChat}/messages`, {
                method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ message: 'hi' }),
            });
            assert.equal(first.status, 200);

            const second = await fetch(`${base}/api/v1/chats/linzhao/${guestChat}/messages`, {
                method: 'POST', headers: bearer(guest.token), body: JSON.stringify({ message: 'hi' }),
            });

            assert.equal(second.status, 503);
            assert.equal((await second.json() as { error: string }).error, 'global');
        }, { global: 400, quota: { dailyTokenLimit: 100_000, monthlyTokenLimit: 100_000, maxTokensPerRequest: 100 } });
    } finally {
        await mock.close();
    }
});

test('a streamed turn is billed once, after it completes', async () => {
    const mock = await startMockModel(respondSse('她把书合上了。'));

    try {
        await withServer(mock.endpoint, async ({ base, register }) => {
            const owner = await register('owner');
            await importCard(base, owner.token);
            const name = await newChat(base, owner.token);

            const response = await fetch(`${base}/api/v1/chats/linzhao/${name}/messages`, {
                method: 'POST',
                headers: bearer(owner.token),
                body: JSON.stringify({ message: '在吗', stream: true }),
            });

            await response.text();

            const usage = await (await fetch(`${base}/api/v1/me/usage`, { headers: bearer(owner.token) })).json() as {
                usage: { day: { requests: number }; inFlight: { requests: number } };
                recent: { streamed: boolean; usageSource: string }[];
            };

            assert.equal(usage.usage.day.requests, 1);
            assert.equal(usage.usage.inFlight.requests, 0, 'the reservation must have been settled');
            assert.equal(usage.recent[0]?.streamed, true);
            // The mock sends no usage on the stream, so the estimate is labelled.
            assert.equal(usage.recent[0]?.usageSource, 'estimated');
        });
    } finally {
        await mock.close();
    }
});

// --------------------------------------------------------------------- admin

test('admin routes are closed to normal users and open to admins', async () => {
    const mock = await startMockModel();

    try {
        await withServer(mock.endpoint, async ({ base, register }) => {
            const owner = await register('owner');
            const guest = await register('guest');

            assert.equal((await fetch(`${base}/api/v1/users`, { headers: bearer(guest.token) })).status, 403);

            const list = await fetch(`${base}/api/v1/users`, { headers: bearer(owner.token) });
            assert.equal(list.status, 200);
            const users = (await list.json() as { users: { handle: string; usage: unknown }[] }).users;
            assert.deepEqual(users.map((entry) => entry.handle), ['owner', 'guest']);
            assert.ok(users[0]?.usage);

            const quota = await fetch(`${base}/api/v1/users/${guest.user.id}/quota`, {
                method: 'PUT',
                headers: bearer(owner.token),
                body: JSON.stringify({ dailyTokenLimit: 42, monthlyTokenLimit: 43, maxTokensPerRequest: 44 }),
            });
            assert.equal(quota.status, 200);
            assert.deepEqual((await quota.json() as { policy: QuotaPolicy }).policy, {
                dailyTokenLimit: 42, monthlyTokenLimit: 43, maxTokensPerRequest: 44,
            });

            // The new policy is what the guest is now held to.
            await importCard(base, guest.token);
            const name = await newChat(base, guest.token);
            const turn = await fetch(`${base}/api/v1/chats/linzhao/${name}/messages`, {
                method: 'POST',
                headers: bearer(guest.token),
                body: JSON.stringify({ message: 'hi', overrides: { maxTokens: 44 } }),
            });
            assert.notEqual(turn.status, 400, 'exactly the ceiling must be allowed');

            const overLimit = await fetch(`${base}/api/v1/chats/linzhao/${name}/messages`, {
                method: 'POST',
                headers: bearer(guest.token),
                body: JSON.stringify({ message: 'hi', overrides: { maxTokens: 45 } }),
            });
            assert.equal(overLimit.status, 400);
        });
    } finally {
        await mock.close();
    }
});

test('the status route disables and re-enables an account', async () => {
    const mock = await startMockModel();

    try {
        await withServer(mock.endpoint, async ({ base, register }) => {
            const owner = await register('owner');
            const guest = await register('guest');

            const disable = await fetch(`${base}/api/v1/users/${guest.user.id}/status`, {
                method: 'PUT',
                headers: bearer(owner.token),
                body: JSON.stringify({ status: 'disabled' }),
            });
            assert.equal(disable.status, 200);
            assert.equal((await fetch(`${base}/api/v1/me`, { headers: bearer(guest.token) })).status, 401);

            const enable = await fetch(`${base}/api/v1/users/${guest.user.id}/status`, {
                method: 'PUT',
                headers: bearer(owner.token),
                body: JSON.stringify({ status: 'active' }),
            });
            assert.equal(enable.status, 200);
            assert.equal((await fetch(`${base}/api/v1/me`, { headers: bearer(guest.token) })).status, 401, 'the old token stays revoked');
        });
    } finally {
        await mock.close();
    }
});

// -------------------------------------------------------------- single user

test('a single-user server needs no accounts and reports auth off', async () => {
    const mock = await startMockModel();

    try {
        const dir = await mkdtemp(path.join(tmpdir(), 'story-single-'));
        const library = new Library(dir);
        await library.ensureDirs();
        await library.importCard(JSON.stringify(card), { filename: 'linzhao' });

        const server = createServer(library, {
            loadModelConfig: () => Promise.resolve({ endpoint: mock.endpoint, model: 'mock-model' }),
            personaName: 'User',
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address() as AddressInfo;
        const base = `http://127.0.0.1:${port}`;

        try {
            const health = await (await fetch(`${base}/health`)).json() as { auth: boolean };
            assert.equal(health.auth, false);

            // No token required, and no quota is charged.
            const characters = await fetch(`${base}/api/v1/characters`);
            assert.equal(characters.status, 200);

            const created = await fetch(`${base}/api/v1/chats`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cardId: 'linzhao', name: 'solo' }),
            });
            assert.equal(created.status, 201);

            const turn = await fetch(`${base}/api/v1/chats/linzhao/solo/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: '在吗' }),
            });
            assert.equal(turn.status, 200);

            // Account routes explain themselves instead of pretending to work.
            const register = await fetch(`${base}/api/v1/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ handle: 'owner', password: 'long-enough-password' }),
            });
            assert.equal(register.status, 400);
            assert.equal((await register.json() as { error: string }).error, 'auth_disabled');
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(dir, { recursive: true, force: true });
        }
    } finally {
        await mock.close();
    }
});

test('createAppContext wires a database, accounts and per-user roots', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'story-context-'));

    try {
        const config: AppConfig = {
            ...loadAppConfig({ STORY_AUTH: 'on' }),
            dataRoot: path.join(dir, 'data'),
            databasePath: path.join(dir, 'app.sqlite'),
            authRequired: true,
        };

        const context = createAppContext(config);
        try {
            assert.ok(context.auth);
            assert.ok(context.billing);
            assert.equal(context.auth.count(), 0);

            const first = context.auth.register({ handle: 'owner', password: 'long-enough-password' });
            assert.equal(first.user.role, 'admin');

            const root = (await context.libraryFor(first.user.id)).root;
            assert.equal(root, path.join(dir, 'data', 'users', first.user.id));
        } finally {
            context.close();
        }

        // A second context reopens the same database rather than starting over.
        const reopened = createAppContext(config);
        try {
            assert.equal(reopened.auth?.count(), 1);
        } finally {
            reopened.close();
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('an unused import keeps the MockUsage type exported for callers', () => {
    // Documents the helper signature: respondWith(content, usage).
    const usage: MockUsage = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 };
    assert.equal(usage.total_tokens, 3);
});
