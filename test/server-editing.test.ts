/**
 * The routes the web client needs on top of M0–M6: edit a card in place, remove
 * a card / a conversation / a single message, page a long log, and serve a
 * published card's avatar.
 *
 * Each one is something a UI cannot work around. Without an in-place edit, the
 * only way to fix a typo in a card is delete and re-import — which throws away
 * the avatar and every conversation with it. Without message deletion, "say
 * something else" has no way to take back the last thing said.
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
import { cardToPng } from '../src/cards/io.ts';
import { normalizeCard } from '../src/cards/types.ts';
import { loadAppConfig, type AppConfig, type QuotaPolicy } from '../src/config.ts';
import { CreditService } from '../src/credits/service.ts';
import { Database } from '../src/db/database.ts';
import { Library } from '../src/library.ts';
import { MarketService } from '../src/market/service.ts';
import { createSolidPng, decodePng, isPng } from '../src/png/chunks.ts';
import { ModsService } from '../src/mods/service.ts';
import { createServer, type ServerContext } from '../src/server.ts';
import { VersionsService } from '../src/versions/service.ts';
import { respondWith, startMockModel } from './helpers/mock-model.ts';

const POLICY: QuotaPolicy = { dailyTokenLimit: 100_000, monthlyTokenLimit: 1_000_000, maxTokensPerRequest: 100 };
const PASSWORD = 'a-long-enough-password';

const card = normalizeCard({
    spec: 'chara_card_v2',
    data: {
        name: '林昭',
        description: '书店店主',
        personality: '话少',
        scenario: '书房',
        first_mes: '来了。',
        tags: ['演示'],
    },
});

function bearer(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

interface Harness {
    base: string;
    register: (handle: string) => Promise<{ token: string; user: { id: string; role: string } }>;
}

let MOCK_CALLS = 0;
const mockCount = (): number => MOCK_CALLS;


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

async function withServer(run: (harness: Harness) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), 'story-editing-'));
    const db = new Database(path.join(dir, 'test.sqlite'));
    const base = loadAppConfig({ STORY_AUTH: 'on' });

    const config: AppConfig = {
        ...base,
        dataRoot: path.join(dir, 'data'),
        databasePath: path.join(dir, 'test.sqlite'),
        authRequired: true,
        defaultQuota: POLICY,
        // Memory is off: these tests are about editing, not about summarizing.
        memory: { ...base.memory, enabled: false },
    };

    const auth = new AuthService(db, { kdf: FAST_KDF, sessionTtlDays: 1 });
    const billing = new BillingService(db, { defaultQuota: POLICY, maxConcurrentStreamsPerUser: 4 });
    const credits = new CreditService(db, { initialGrant: 100 });
    const market = new MarketService(db);

    // Every test has a working model behind it, so a route that happens to reach
    // the gateway gets a reply instead of a connection error.
    MOCK_CALLS = 0;
    const mock = await startMockModel((request, response) => {
        MOCK_CALLS += 1;
        respondWith('嗯。')(request, response);
    });

    const libraries = new Map<string, Library>();
    const context: ServerContext = {
        config,
        auth,
        billing,
        credits,
        market,
        mods: new ModsService(db),
        versions: new VersionsService(db),
        libraryFor: (userId: string): Library => {
            const root = path.join(config.dataRoot, 'users', userId);
            const existing = libraries.get(root) ?? new Library(root);
            libraries.set(root, existing);
            return existing;
        },
    };

    const server = createServer(context, {
        loadModelConfig: () => Promise.resolve({ endpoint: mock.endpoint, model: 'mock-model', maxTokens: 50 }),
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
                return JSON.parse(text) as { token: string; user: { id: string; role: string } };
            },
        });
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await mock.close();
        db.close();
        await rm(dir, { recursive: true, force: true });
    }
}

async function importCard(base: string, token: string, body: Buffer | string = JSON.stringify(card), name = 'linzhao'): Promise<void> {
    const response = await fetch(`${base}/api/v1/characters`, {
        method: 'POST',
        headers: {
            ...bearer(token),
            'x-filename': name,
            'Content-Type': typeof body === 'string' ? 'application/json' : 'image/png',
        },
        body,
    });
    const text = await response.text();
    assert.equal(response.status, 201, text);
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

// ------------------------------------------------------------- character edit

test('editing a card updates the fields in place and keeps id, avatar and the rest', async () => {
    await withServer(async ({ base, register }) => {
        const owner = await register('owner');

        // A real avatar, so "kept" is a claim about bytes and not just about code.
        const avatar = createSolidPng(32, 48, [9, 9, 9]);
        await importCard(base, owner.token, cardToPng(card, avatar));
        await newChat(base, owner.token);

        const put = await fetch(`${base}/api/v1/characters/linzhao`, {
            method: 'PUT',
            headers: bearer(owner.token),
            body: JSON.stringify({ description: '旧书店的店主', tags: [] }),
        });
        const text = await put.text();
        assert.equal(put.status, 200, text);

        const updated = await fetch(`${base}/api/v1/characters/linzhao`, { headers: bearer(owner.token) });
        const data = (await updated.json() as { card: { data: Record<string, unknown> } }).card.data;
        assert.equal(data.description, '旧书店的店主');
        assert.deepEqual(data.tags, []);

        // Untouched fields survive a partial patch: that is the whole point of a
        // merge instead of a replace.
        assert.equal(data.personality, '话少');
        assert.equal(data.first_mes, '来了。');
        assert.equal(data.name, '林昭');

        const png = Buffer.from(await (await fetch(`${base}/api/v1/characters/linzhao/card.png`, { headers: bearer(owner.token) })).arrayBuffer());
        const ihdr = decodePng(png).find((chunk) => chunk.name === 'IHDR');
        assert.equal(ihdr?.data.readUInt32BE(0), 32, 'the avatar was replaced instead of kept');
        assert.equal(ihdr?.data.readUInt32BE(4), 48);
    });
});

test('the avatar can be swapped without touching a single field', async () => {
    await withServer(async ({ base, register }) => {
        const owner = await register('owner');
        await importCard(base, owner.token, cardToPng(card, createSolidPng(32, 48, [9, 9, 9])));

        // A plain photograph: no card chunks in it at all.
        const photo = createSolidPng(120, 160, [200, 30, 30]);
        const put = await fetch(`${base}/api/v1/characters/linzhao/avatar`, {
            method: 'PUT',
            headers: { ...bearer(owner.token), 'Content-Type': 'image/png' },
            body: photo,
        });
        assert.equal(put.status, 200, await put.text());

        const png = Buffer.from(await (await fetch(`${base}/api/v1/characters/linzhao/card.png`, { headers: bearer(owner.token) })).arrayBuffer());
        const ihdr = decodePng(png).find((chunk) => chunk.name === 'IHDR');
        assert.equal(ihdr?.data.readUInt32BE(0), 120);
        assert.equal(ihdr?.data.readUInt32BE(4), 160);

        // The card is still a card: the chunks were re-written on top.
        const detail = await (await fetch(`${base}/api/v1/characters/linzhao`, { headers: bearer(owner.token) })).json() as {
            card: { data: { description: string } };
        };
        assert.equal(detail.card.data.description, '书店店主');
    });
});

test('a card name cannot be edited to empty', async () => {
    await withServer(async ({ base, register }) => {
        const owner = await register('owner');
        await importCard(base, owner.token);

        const put = await fetch(`${base}/api/v1/characters/linzhao`, {
            method: 'PUT',
            headers: bearer(owner.token),
            body: JSON.stringify({ name: '   ' }),
        });
        assert.equal(put.status, 400);
    });
});

test('deleting a character removes the card and the conversations that need it', async () => {
    await withServer(async ({ base, register }) => {
        const owner = await register('owner');
        await importCard(base, owner.token);
        await newChat(base, owner.token, 'one');
        await newChat(base, owner.token, 'two');

        const remove = await fetch(`${base}/api/v1/characters/linzhao`, { method: 'DELETE', headers: bearer(owner.token) });
        const text = await remove.text();
        assert.equal(remove.status, 200, text);
        assert.deepEqual(JSON.parse(text), { id: 'linzhao', deleted: true, chatsRemoved: 2 });

        const list = await fetch(`${base}/api/v1/characters`, { headers: bearer(owner.token) });
        assert.deepEqual((await list.json() as { characters: unknown[] }).characters, []);

        // The chats went with it: an orphan log would be listed but unopenable.
        const chats = await fetch(`${base}/api/v1/chats/linzhao`, { headers: bearer(owner.token) });
        assert.deepEqual((await chats.json() as { chats: unknown[] }).chats, []);
    });
});

// --------------------------------------------------------------- world books

test('world books can be written and removed over HTTP', async () => {
    await withServer(async ({ base, register }) => {
        const owner = await register('owner');

        const put = await fetch(`${base}/api/v1/worldbooks/Eldoria`, {
            method: 'PUT',
            headers: bearer(owner.token),
            body: JSON.stringify({ entries: { 0: { uid: 0, key: ['eldoria'], content: '一片古老森林。' } } }),
        });
        const text = await put.text();
        assert.equal(put.status, 200, text);

        // Normalisation fills the remaining 20-odd fields, so a hand-written entry
        // behaves like one SillyTavern wrote.
        const book = (JSON.parse(text) as { worldbook: { entries: Record<string, { order: number; content: string }> } }).worldbook;
        assert.equal(book.entries[0]?.content, '一片古老森林。');
        assert.equal(book.entries[0]?.order, 100);

        const listed = await fetch(`${base}/api/v1/worldbooks`, { headers: bearer(owner.token) });
        assert.equal((await listed.json() as { worldbooks: { id: string }[] }).worldbooks[0]?.id, 'Eldoria');

        const remove = await fetch(`${base}/api/v1/worldbooks/Eldoria`, { method: 'DELETE', headers: bearer(owner.token) });
        assert.equal(remove.status, 200);

        const after = await fetch(`${base}/api/v1/worldbooks`, { headers: bearer(owner.token) });
        assert.deepEqual((await after.json() as { worldbooks: unknown[] }).worldbooks, []);
    });
});

// ------------------------------------------------------- conversation editing

test('a whole conversation can be deleted without touching the others', async () => {
    await withServer(async ({ base, register }) => {
        const owner = await register('owner');
        await importCard(base, owner.token);
        await newChat(base, owner.token, 'keep');
        await newChat(base, owner.token, 'drop');

        const remove = await fetch(`${base}/api/v1/chats/linzhao/drop`, { method: 'DELETE', headers: bearer(owner.token) });
        assert.equal(remove.status, 200);

        const chats = await fetch(`${base}/api/v1/chats/linzhao`, { headers: bearer(owner.token) });
        assert.deepEqual(
            (await chats.json() as { chats: { name: string }[] }).chats.map((chat) => chat.name),
            ['keep'],
        );
    });
});

test('one message can be deleted and the rest of the log stays intact', async () => {
    await withServer(async ({ base, register }) => {
        const owner = await register('owner');
        await importCard(base, owner.token);
        await newChat(base, owner.token);

        // Two real turns, so the log is greeting / user / reply / user / reply.
        for (const message of ['在吗', '今天怎么样']) {
            const turn = await fetch(`${base}/api/v1/chats/linzhao/session/messages`, {
                method: 'POST',
                headers: bearer(owner.token),
                body: JSON.stringify({ message }),
            });
            assert.equal(turn.status, 200, await turn.text());
        }

        const before = await (await fetch(`${base}/api/v1/chats/linzhao/session`, { headers: bearer(owner.token) })).json() as {
            chat: { messages: { mes: string }[] };
        };
        assert.equal(before.chat.messages.length, 5);

        const remove = await fetch(`${base}/api/v1/chats/linzhao/session/messages/3`, { method: 'DELETE', headers: bearer(owner.token) });
        const text = await remove.text();
        assert.equal(remove.status, 200, text);
        assert.deepEqual(JSON.parse(text), {
            character: 'linzhao',
            name: 'session',
            removed: { name: 'User', isUser: true },
            messages: 4,
        });

        const after = await (await fetch(`${base}/api/v1/chats/linzhao/session`, { headers: bearer(owner.token) })).json() as {
            chat: { messages: { mes: string }[] };
        };
        assert.deepEqual(after.chat.messages.map((message) => message.mes), ['来了。', '在吗', '嗯。', '嗯。']);
    });
});

test('deleting a message that is not there is a 404 and changes nothing', async () => {
    await withServer(async ({ base, register }) => {
        const owner = await register('owner');
        await importCard(base, owner.token);
        await newChat(base, owner.token);

        const outOfRange = await fetch(`${base}/api/v1/chats/linzhao/session/messages/9`, { method: 'DELETE', headers: bearer(owner.token) });
        assert.equal(outOfRange.status, 404);

        const notANumber = await fetch(`${base}/api/v1/chats/linzhao/session/messages/last`, { method: 'DELETE', headers: bearer(owner.token) });
        assert.equal(notANumber.status, 400);

        const chat = await (await fetch(`${base}/api/v1/chats/linzhao/session`, { headers: bearer(owner.token) })).json() as {
            chat: { messages: unknown[] };
        };
        assert.equal(chat.chat.messages.length, 1);
    });
});

test('a long log can be paged, and the total is always the full length', async () => {
    await withServer(async ({ base, register }) => {
        const owner = await register('owner');
        await importCard(base, owner.token);
        await newChat(base, owner.token);

        const whole = await (await fetch(`${base}/api/v1/chats/linzhao/session`, { headers: bearer(owner.token) })).json() as {
            total: number;
            chat: { messages: unknown[] };
        };
        assert.equal(whole.total, 1);
        assert.equal(whole.chat.messages.length, 1);

        const page = await (await fetch(`${base}/api/v1/chats/linzhao/session?offset=0&limit=0`, { headers: bearer(owner.token) })).json() as {
            total: number;
            chat: { messages: unknown[] };
        };

        // A zero-length page is how a client asks "how long is this?" before
        // deciding how much to pull.
        assert.equal(page.total, 1);
        assert.deepEqual(page.chat.messages, []);
    });
});

// ------------------------------------------------------------------ market

test('a published card serves its avatar to anyone who can see the listing', async () => {
    await withServer(async ({ base, register }) => {
        const owner = await register('owner');
        const reader = await register('reader');

        await importCard(base, owner.token, cardToPng(card, createSolidPng(32, 48, [9, 9, 9])));

        const publish = await fetch(`${base}/api/v1/characters/linzhao/publish`, { method: 'POST', headers: bearer(owner.token) });
        assert.equal(publish.status, 201, await publish.text());
        await approve(base, owner.token, owner.user.id, 'linzhao');

        const image = await fetch(`${base}/api/v1/market/${owner.user.id}/linzhao/card.png`, { headers: bearer(reader.token) });
        assert.equal(image.status, 200);
        assert.equal(image.headers.get('content-type'), 'image/png');

        const png = Buffer.from(await image.arrayBuffer());
        assert.ok(isPng(png));
        const ihdr = decodePng(png).find((chunk) => chunk.name === 'IHDR');
        assert.equal(ihdr?.data.readUInt32BE(0), 32);
        assert.equal(ihdr?.data.readUInt32BE(4), 48);

        // Unpublished means gone, avatar included.
        const drop = await fetch(`${base}/api/v1/characters/linzhao/publish`, { method: 'DELETE', headers: bearer(owner.token) });
        assert.equal(drop.status, 200);

        const gone = await fetch(`${base}/api/v1/market/${owner.user.id}/linzhao/card.png`, { headers: bearer(reader.token) });
        assert.notEqual(gone.status, 200);

        const goneJson = await fetch(`${base}/api/v1/market/${owner.user.id}/linzhao/card.json`, { headers: bearer(reader.token) });
        assert.notEqual(goneJson.status, 200);
    });
});

test('a published card can be read before it is imported', async () => {
    await withServer(async ({ base, register }) => {
        const owner = await register('owner');
        const reader = await register('reader');
        await importCard(base, owner.token);

        const publish = await fetch(`${base}/api/v1/characters/linzhao/publish`, { method: 'POST', headers: bearer(owner.token) });
        assert.equal(publish.status, 201, await publish.text());
        await approve(base, owner.token, owner.user.id, 'linzhao');

        // A market listing is a snapshot (name, tags, description length) so the
        // grid never reads anyone's directory. Reading the card is what tells a
        // reader what the character is about before they commit to importing it.
        const detail = await fetch(`${base}/api/v1/market/${owner.user.id}/linzhao/card.json`, { headers: bearer(reader.token) });
        const detailText = await detail.text();
        assert.equal(detail.status, 200, detailText);
        const card = JSON.parse(detailText) as { data: { name: string; first_mes: string } };
        assert.equal(card.data.name, '林昭');
        assert.equal(card.data.first_mes, '来了。');
    });
});

test('a message can be rewritten in place without asking the model anything', async () => {
    await withServer(async ({ base, register }) => {
        const owner = await register('owner');
        await importCard(base, owner.token);
        await newChat(base, owner.token);

        // One real turn, so there is an assistant reply to edit.
        const before = mockCount();
        const turn = await fetch(`${base}/api/v1/chats/linzhao/session/messages`, {
            method: 'POST',
            headers: bearer(owner.token),
            body: JSON.stringify({ message: '在吗' }),
        });
        assert.equal(turn.status, 200, await turn.text());

        const patch = await fetch(`${base}/api/v1/chats/linzhao/session/messages/2`, {
            method: 'PATCH',
            headers: bearer(owner.token),
            body: JSON.stringify({ message: '（她把书合上了）' }),
        });
        const text = await patch.text();
        assert.equal(patch.status, 200, text);
        assert.deepEqual(JSON.parse(text), {
            character: 'linzhao',
            name: 'session',
            index: 2,
            message: { name: '林昭', isUser: false, mes: '（她把书合上了）' },
        });

        // A log edit is not a turn: nothing new appeared and the model was not
        // asked for anything.
        const chat = await (await fetch(`${base}/api/v1/chats/linzhao/session`, { headers: bearer(owner.token) })).json() as {
            chat: { messages: { mes: string }[] };
        };
        assert.equal(chat.chat.messages.length, 3);
        assert.equal(chat.chat.messages[2]?.mes, '（她把书合上了）');
        assert.equal(mockCount(), before + 1, 'exactly the one turn called the model');

        // Bad indices and empty text are refused without touching the log.
        assert.equal((await fetch(`${base}/api/v1/chats/linzhao/session/messages/9`, {
            method: 'PATCH',
            headers: bearer(owner.token),
            body: JSON.stringify({ message: 'x' }),
        })).status, 404);
        assert.equal((await fetch(`${base}/api/v1/chats/linzhao/session/messages/0`, {
            method: 'PATCH',
            headers: bearer(owner.token),
            body: JSON.stringify({ message: '' }),
        })).status, 400);
    });
});

test('a card\'s mod policy is enforced at POST /chats, not by hiding a button', async () => {
    await withServer(async ({ base, register }) => {
        const owner = await register('owner');
        const stranger = await register('stranger');

        // `stranger` writes a mod and puts it on the gallery.
        const made = await fetch(`${base}/api/v1/mods`, {
            method: 'POST',
            headers: bearer(stranger.token),
            body: JSON.stringify({ name: '别人的场景', systemPrompt: '外面在下雨。' }),
        });
        const modId = ((await made.json()) as { mod: { id: string } }).mod.id;
        await fetch(`${base}/api/v1/mods/${encodeURIComponent(modId)}/visibility`, {
            method: 'POST',
            headers: bearer(stranger.token),
            body: JSON.stringify({ visibility: 'public' }),
        });

        // A card that forbids mods entirely.
        await importCard(base, owner.token, JSON.stringify(normalizeCard({
            spec: 'chara_card_v2',
            data: { name: 'linzhao', description: 'x', extensions: { story: { mods: { policy: 'none' } } } },
        })));

        const refused = await fetch(`${base}/api/v1/chats`, {
            method: 'POST',
            headers: bearer(owner.token),
            body: JSON.stringify({ cardId: 'linzhao', modIds: [modId] }),
        });
        const text = await refused.text();
        assert.equal(refused.status, 403, text);
        assert.equal(JSON.parse(text).error, 'policy');

        // And one that allows anything takes it: the same request, one field
        // different, is a different decision.
        await importCard(base, owner.token, JSON.stringify(normalizeCard({
            spec: 'chara_card_v2',
            data: { name: 'open', description: 'x', extensions: { story: { mods: { policy: 'all' } } } },
        })), 'open');

        const allowed = await fetch(`${base}/api/v1/chats`, {
            method: 'POST',
            headers: bearer(owner.token),
            body: JSON.stringify({ cardId: 'open', modIds: [modId] }),
        });
        const ok = await allowed.text();
        assert.equal(allowed.status, 201, ok);
    });
});

test('a released version survives later edits, and the listing pins the primary', async () => {
    await withServer(async ({ base, register }) => {
        const owner = await register('owner');
        await importCard(base, owner.token);

        // Snapshot the working copy as it is now.
        const made = await fetch(`${base}/api/v1/characters/linzhao/versions`, {
            method: 'POST',
            headers: bearer(owner.token),
            body: JSON.stringify({ version: 'v1', label: '首发', note: '第一版' }),
        });
        const text = await made.text();
        assert.equal(made.status, 201, text);
        assert.equal((JSON.parse(text) as { version: { version: string } }).version.version, 'v1');

        // Now change the working copy completely.
        await fetch(`${base}/api/v1/characters/linzhao`, {
            method: 'PUT',
            headers: bearer(owner.token),
            body: JSON.stringify({ data: { description: '完全重写了。' } }),
        });

        // The released version still says what it said — that is the point of
        // releasing one instead of just editing.
        const png = Buffer.from(await (await fetch(`${base}/api/v1/characters/linzhao/versions/v1`, {
            headers: bearer(owner.token),
        })).arrayBuffer());
        assert.equal(isPng(png), true);

        const listed = await (await fetch(`${base}/api/v1/characters/linzhao/versions`, {
            headers: bearer(owner.token),
        })).json() as { versions: { version: string; label: string }[]; primary: string | null };
        assert.deepEqual(listed.versions.map((entry) => entry.version), ['v1']);
        assert.equal(listed.versions[0]?.label, '首发');
        assert.equal(listed.primary, null, 'nothing points anywhere until the listing does');

        // Pin the listing to v1 and it becomes undeletable: the listing points
        // there, and moving a listing silently is how a ranking changes for no
        // visible reason.
        await fetch(`${base}/api/v1/characters/linzhao/publish`, {
            method: 'POST',
            headers: bearer(owner.token),
            body: JSON.stringify({ primaryVersion: 'v1' }),
        });
        assert.equal((await (await fetch(`${base}/api/v1/characters/linzhao/versions`, {
            headers: bearer(owner.token),
        })).json() as { primary: string | null }).primary, 'v1');

        const refused = await fetch(`${base}/api/v1/characters/linzhao/versions/v1`, {
            method: 'DELETE',
            headers: bearer(owner.token),
        });
        assert.equal(refused.status, 409);

        const again = await fetch(`${base}/api/v1/characters/linzhao/versions`, {
            method: 'POST',
            headers: bearer(owner.token),
            body: JSON.stringify({ version: 'v2', label: '修好了' }),
        });
        assert.equal(again.status, 201);

        // Point the listing elsewhere and the old one can go.
        await fetch(`${base}/api/v1/characters/linzhao/publish`, {
            method: 'POST',
            headers: bearer(owner.token),
            body: JSON.stringify({ primaryVersion: 'v2' }),
        });
        assert.equal((await fetch(`${base}/api/v1/characters/linzhao/versions/v1`, {
            method: 'DELETE',
            headers: bearer(owner.token),
        })).status, 200);
    });
});
