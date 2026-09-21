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
import { ChatSession } from '../src/chat/session.ts';
import type { ChatMessage } from '../src/chats/types.ts';
import { loadAppConfig, type AppConfig } from '../src/config.ts';
import { Database } from '../src/db/database.ts';
import type { ModelConfig } from '../src/gateway/types.ts';
import { Library } from '../src/library.ts';
import { assemblePrompt } from '../src/prompt/assemble.ts';
import {
    EMPTY_MEMORY,
    applySummary,
    buildSummaryRequest,
    formatTranscript,
    planSummaryUpTo,
    readMemoryState,
    type MemoryState,
} from '../src/prompt/memory.ts';
import { createServer, type ServerContext } from '../src/server.ts';
import { respondWith, startMockModel, type CapturedRequest, type MockHandler } from './helpers/mock-model.ts';

const card = normalizeCard({
    spec: 'chara_card_v2',
    data: {
        name: '林昭',
        description: '书店店主',
        personality: '话少',
        scenario: '深夜的书房',
        first_mes: '来了。',
    },
});

function message(mes: string, isUser: boolean): ChatMessage {
    return { name: isUser ? 'User' : '林昭', is_user: isUser, send_date: '2026-09-21T10:00:00.000Z', mes };
}

// ---------------------------------------------------------------- pure logic

test('nothing is summarized until the threshold is crossed', () => {
    assert.equal(planSummaryUpTo(EMPTY_MEMORY, 10, { messageThreshold: 40, keepRecent: 12 }), null);
    assert.equal(planSummaryUpTo(EMPTY_MEMORY, 51, { messageThreshold: 40, keepRecent: 12 }), null);

    // 52 messages, keep the last 12, 40 remain: exactly the threshold.
    assert.equal(planSummaryUpTo(EMPTY_MEMORY, 52, { messageThreshold: 40, keepRecent: 12 }), 40);
    assert.equal(planSummaryUpTo(EMPTY_MEMORY, 60, { messageThreshold: 40, keepRecent: 12 }), 48);
});

test('a pass only covers the delta since the last one, and never the recent tail', () => {
    const state: MemoryState = { ...EMPTY_MEMORY, text: '之前发生过的事', upTo: 40, passes: 1 };

    assert.equal(planSummaryUpTo(state, 60, { messageThreshold: 40, keepRecent: 12 }), null);
    assert.equal(planSummaryUpTo(state, 95, { messageThreshold: 40, keepRecent: 12 }), 83);
});

test('memory can be switched off, and the settings are clamped to sane values', () => {
    assert.equal(planSummaryUpTo(EMPTY_MEMORY, 1000, { enabled: false }), null);
    // keepRecent is clamped to at least 1, so a pass can never swallow the whole
    // conversation and leave the prompt with no verbatim history at all.
    assert.equal(planSummaryUpTo(EMPTY_MEMORY, 100, { messageThreshold: 10, keepRecent: 0 }), 99);
    assert.equal(planSummaryUpTo(EMPTY_MEMORY, 100, { messageThreshold: 0, keepRecent: 12 }), 88);
});

test('the transcript is rendered with speakers', () => {
    const transcript = formatTranscript([message('在吗', true), message('在。', false)]);
    assert.equal(transcript, '用户：在吗\n林昭：在。');
});

test('the first pass summarizes directly, later passes merge with the previous summary', () => {
    const first = buildSummaryRequest({ previous: '', upTo: 10, messages: [message('第一件事', true)] });
    assert.equal(first.messages[0]?.role, 'system');
    assert.match(first.messages[1]?.content ?? '', /请为下面这段对话写前情摘要/);
    assert.equal((first.messages[1]?.content ?? '').includes('已有的前情摘要'), false);
    assert.equal(first.maxTokens, 500);

    const merge = buildSummaryRequest({
        previous: '她提到要考试',
        upTo: 20,
        messages: [message('考完了', true)],
        config: { maxSummaryTokens: 128, instruction: '压缩' },
    });

    assert.equal(merge.messages[0]?.content, '压缩');
    assert.equal(merge.maxTokens, 128);
    assert.match(merge.messages[1]?.content ?? '', /已有的前情摘要/);
    assert.match(merge.messages[1]?.content ?? '', /她提到要考试/);
    assert.match(merge.messages[1]?.content ?? '', /考完了/);
});

test('applying a summary advances the watermark and counts the pass', () => {
    const applied = applySummary(EMPTY_MEMORY, '  她说了很多事。  ', 40, {
        model: 'mock-model',
        now: new Date('2026-09-21T12:00:00.000Z'),
    });

    assert.equal(applied.text, '她说了很多事。');
    assert.equal(applied.upTo, 40);
    assert.equal(applied.passes, 1);
    assert.equal(applied.model, 'mock-model');
    assert.equal(applied.updatedAt, '2026-09-21T12:00:00.000Z');
});

test('a malformed memory state in the chat file is tolerated', () => {
    assert.deepEqual(readMemoryState({}), EMPTY_MEMORY);
    assert.deepEqual(readMemoryState({ story: 'nonsense' }), EMPTY_MEMORY);
    assert.deepEqual(readMemoryState({ story: { memory: { upTo: -5, passes: 'x' } } }), EMPTY_MEMORY);

    const partial = readMemoryState({ story: { memory: { text: '摘要', upTo: 12.7, passes: 2 } } });
    assert.equal(partial.text, '摘要');
    assert.equal(partial.upTo, 12);
    assert.equal(partial.passes, 2);
});

// ------------------------------------------------------------------ assembly

test('the summary replaces the messages it covers instead of duplicating them', () => {
    const history = [
        message('很早说过的事', true),
        message('我记得', false),
        message('后来的事', true),
        message('嗯', false),
    ];

    const withoutMemory = assemblePrompt({ card, history, userMessage: '继续', options: { personaName: 'User' } });
    assert.equal(withoutMemory.stats.memory, null);
    assert.equal(withoutMemory.messages.some((entry) => entry.content.includes('很早说过的事')), true);

    const memory: MemoryState = { text: '用户早前提过一件事。', upTo: 2, updatedAt: 'now', passes: 1 };
    const withMemory = assemblePrompt({ card, history, userMessage: '继续', options: { personaName: 'User' }, memory });

    // The covered messages are gone from the prompt...
    assert.equal(withMemory.messages.some((entry) => entry.content.includes('很早说过的事')), false);
    // ...replaced by one system block, placed before the history.
    const summaryIndex = withMemory.messages.findIndex((entry) => entry.content.startsWith('【前情摘要】'));
    const historyIndex = withMemory.messages.findIndex((entry) => entry.content === '后来的事');

    assert.ok(summaryIndex > 0);
    assert.ok(summaryIndex < historyIndex);
    assert.equal(withMemory.messages[summaryIndex]?.role, 'system');
    assert.match(withMemory.messages[summaryIndex]?.content ?? '', /用户早前提过一件事。/);

    assert.ok(withMemory.stats.memory);
    assert.equal(withMemory.stats.memory.summarizedMessages, 2);
    assert.equal(withMemory.stats.memory.passes, 1);
    assert.ok(withMemory.stats.sections.includes('memory'));
    // Only the two uncovered messages remain as history.
    assert.equal(withMemory.stats.historyIncluded, 2);
});

test('a watermark past the end of the log cannot break the prompt', () => {
    const memory: MemoryState = { text: '摘要', upTo: 999, updatedAt: 'now', passes: 3 };
    const { messages, stats } = assemblePrompt({
        card,
        history: [message('一', true)],
        userMessage: '二',
        options: { personaName: 'User' },
        memory,
    });

    assert.equal(messages.at(-1)?.content, '二');
    assert.ok(stats.memory);
    assert.equal(stats.memory.summarizedMessages, 1);
});

// ------------------------------------------------------------------- session

async function withSession(
    run: (context: { library: Library; dir: string; model: ModelConfig; mock: Awaited<ReturnType<typeof startMockModel>> }) => Promise<void>,
    handler: MockHandler,
    options: { memory?: Record<string, unknown> } = {},
): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), 'story-memory-'));
    const mock = await startMockModel(handler);

    try {
        const library = new Library(dir);
        await library.ensureDirs();
        await library.importCard(JSON.stringify(card), { filename: 'linzhao' });

        await run({
            library,
            dir,
            model: { endpoint: mock.endpoint, model: 'mock-model' },
            mock,
        });
    } finally {
        await mock.close();
        await rm(dir, { recursive: true, force: true });
    }
}

/** Answers normally, or with a summary when the request is a summarization one. */
function summarizeAwareHandler(summaryText = '摘要：用户早前提过要考试。'): MockHandler {
    return (request: CapturedRequest, response) => {
        const system = request.body?.messages?.find((entry) => entry.role === 'system')?.content ?? '';
        respondWith(system.includes('摘要助手') ? summaryText : '在。')(request, response);
    };
}

test('a long conversation gets summarized and the state is persisted', async () => {
    await withSession(async ({ library, model, mock }) => {
        const session = await ChatSession.create(library, {
            cardId: 'linzhao',
            personaName: 'User',
            name: 'long',
            memory: { messageThreshold: 6, keepRecent: 2 },
        });

        // Greeting plus four turns of two messages each: 9 messages, and with the
        // last two kept verbatim that leaves 7 to summarize — over the threshold.
        for (let turn = 1; turn <= 4; turn++) {
            await session.send(model, `第 ${turn} 句`);
        }

        const plan = session.summaryPlan();
        assert.ok(plan, 'expected a summary to be due');
        assert.equal(plan.messages, 7);

        const summary = await session.summarize(model);
        assert.ok(summary);
        assert.equal(summary.upTo, 7);
        assert.equal(summary.passes, 1);
        assert.equal(summary.text, '摘要：用户早前提过要考试。');

        // Persisted, so a reload keeps it.
        const stored = await library.getChat('linzhao', 'long');
        const memory = readMemoryState(stored.header.chat_metadata);
        assert.equal(memory.upTo, 7);
        assert.equal(memory.passes, 1);

        const reloaded = await ChatSession.load(library, 'linzhao', 'long', {
            personaName: 'User',
            memory: { messageThreshold: 6, keepRecent: 2 },
        });
        assert.equal(reloaded.memoryState.upTo, 7);
        assert.equal(reloaded.summaryPlan(), null, 'nothing new to summarize right after a pass');

        // The next prompt carries the summary and drops the covered messages.
        const preview = reloaded.preview('继续');
        const summaryMessage = preview.messages.find((entry) => entry.content.startsWith('【前情摘要】'));
        assert.ok(summaryMessage);
        assert.match(summaryMessage.content, /要考试/);
        assert.equal(preview.messages.some((entry) => entry.content.includes('第 1 句')), false);
        assert.ok(preview.stats.memory);
    }, summarizeAwareHandler());
});

test('the summarizer receives the early messages, which is what makes them survivable', async () => {
    await withSession(async ({ library, model, mock }) => {
        const session = await ChatSession.create(library, {
            cardId: 'linzhao',
            personaName: 'User',
            name: 'feed',
            memory: { messageThreshold: 4, keepRecent: 2 },
        });

        await session.send(model, '我下个月要考试');
        for (let turn = 0; turn < 3; turn++) {
            await session.send(model, '随便说点');
        }

        await session.summarize(model);

        // The request the mock received as a summarization call must contain the
        // early fact: a summary can only preserve what it was shown.
        const summaryRequest = mock.requests.find((request) =>
            (request.body?.messages?.find((entry) => entry.role === 'system')?.content ?? '').includes('摘要助手'));
        assert.ok(summaryRequest, 'expected a summarization call');
        assert.match(summaryRequest.body?.messages?.[1]?.content ?? '', /我下个月要考试/);
    }, summarizeAwareHandler());
});

test('a chat shorter than the threshold never calls the summarizer', async () => {
    await withSession(async ({ library, model, mock }) => {
        const session = await ChatSession.create(library, {
            cardId: 'linzhao',
            personaName: 'User',
            name: 'short',
            memory: { messageThreshold: 100, keepRecent: 10 },
        });

        await session.send(model, '就一句');
        await session.send(model, '再一句');

        assert.equal(session.summaryPlan(), null);
        assert.equal(await session.summarize(model), null);
        assert.equal(mock.requests.length, 2, 'only the two turns should have called the model');
    }, summarizeAwareHandler());
});

test('memory can be switched off per session', async () => {
    await withSession(async ({ library, model, mock }) => {
        const session = await ChatSession.create(library, {
            cardId: 'linzhao',
            personaName: 'User',
            name: 'off',
            memory: { enabled: false, messageThreshold: 2, keepRecent: 1 },
        });

        for (let turn = 0; turn < 3; turn++) {
            await session.send(model, '一句');
        }

        assert.equal(session.summaryPlan(), null);
        assert.equal(await session.summarize(model), null);
        assert.equal(session.memoryState.text, '');
        assert.equal(mock.requests.length, 3);
    }, summarizeAwareHandler());
});

// -------------------------------------------------------------------- server

interface Harness {
    base: string;
    token: string;
    library: Library;
    billing: BillingService;
    userId: string;
    db: Database;
}

async function withServer(run: (harness: Harness) => Promise<void>, handler: MockHandler): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), 'story-memory-srv-'));
    const db = new Database(path.join(dir, 'test.sqlite'));
    const mock = await startMockModel(handler);

    const config: AppConfig = {
        ...loadAppConfig({ STORY_AUTH: 'on' }),
        dataRoot: path.join(dir, 'data'),
        databasePath: path.join(dir, 'test.sqlite'),
        authRequired: true,
        defaultQuota: { dailyTokenLimit: 1_000_000, monthlyTokenLimit: 1_000_000, maxTokensPerRequest: 512 },
        memory: { enabled: true, messageThreshold: 4, keepRecent: 2, maxSummaryTokens: 128 },
    };

    const auth = new AuthService(db, { kdf: FAST_KDF });
    const billing = new BillingService(db, { defaultQuota: config.defaultQuota, maxConcurrentStreamsPerUser: 4 });
    const libraries = new Map<string, Library>();
    const context: ServerContext = {
        config,
        auth,
        billing,
        // Memory is the subject here; credits and the market are tested separately.
        credits: null,
        market: null,
        libraryFor: (userId) => {
            const root = path.join(config.dataRoot, 'users', userId);
            const existing = libraries.get(root) ?? new Library(root);
            libraries.set(root, existing);
            return existing;
        },
    };

    const server = createServer(context, {
        loadModelConfig: () => Promise.resolve({ endpoint: mock.endpoint, model: 'mock-model', maxTokens: 64 }),
        personaName: 'User',
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    try {
        const registered = await fetch(`${base}/api/v1/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ handle: 'owner', password: 'owner-long-enough-password' }),
        });
        const { token, user } = await registered.json() as { token: string; user: { id: string } };

        await fetch(`${base}/api/v1/characters`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-filename': 'linzhao' },
            body: JSON.stringify(card),
        });

        const created = await fetch(`${base}/api/v1/chats`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ cardId: 'linzhao', name: 'session' }),
        });
        assert.equal(created.status, 201);

        await run({
            base,
            token,
            library: context.libraryFor(user.id) as Library,
            billing,
            userId: user.id,
            db,
        });
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await mock.close();
        db.close();
        await rm(dir, { recursive: true, force: true });
    }
}

test('the automatic summary is a real model call and is billed separately', async () => {
    await withServer(async ({ base, token, billing, userId, library }) => {
        const send = async (text: string): Promise<Response> => fetch(`${base}/api/v1/chats/linzhao/session/messages`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text }),
        });

        // Three turns: greeting + 6 messages crosses the threshold of 4.
        for (let turn = 0; turn < 3; turn++) {
            assert.equal((await send(`第 ${turn} 句`)).status, 200);
        }

        const usage = billing.ledgerFor(userId, 10);
        const summaryRows = usage.filter((row) => row.requestId?.includes(':summary'));

        assert.equal(summaryRows.length, 1, 'the summarization call must appear in the ledger');
        assert.ok((summaryRows[0]?.totalTokens ?? 0) > 0);

        const chat = await library.getChat('linzhao', 'session');
        const memory = readMemoryState(chat.header.chat_metadata);
        assert.equal(memory.passes, 1);
        assert.ok(memory.upTo > 0);
    }, summarizeAwareHandler());
});

test('summarization can be forced, which is the retry path after a failed pass', async () => {
    let summarizationCalls = 0;

    // The first summarization attempt fails; the forced one succeeds. That is the
    // situation this endpoint exists for.
    const handler: MockHandler = (request, response) => {
        const system = request.body?.messages?.find((entry) => entry.role === 'system')?.content ?? '';

        if (system.includes('摘要助手')) {
            summarizationCalls += 1;
            if (summarizationCalls === 1) {
                response.writeHead(500, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ error: { message: 'summarizer down' } }));
                return;
            }
            respondWith('摘要：用户早前提过要考试。')(request, response);
            return;
        }

        respondWith('在。')(request, response);
    };

    await withServer(async ({ base, token, library }) => {
        const send = async (text: string): Promise<Response> => fetch(`${base}/api/v1/chats/linzhao/session/messages`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text }),
        });

        for (let turn = 0; turn < 3; turn++) {
            assert.equal((await send(`第 ${turn} 句`)).status, 200);
        }

        // The automatic pass failed, so nothing has been summarized yet...
        assert.equal(readMemoryState((await library.getChat('linzhao', 'session')).header.chat_metadata).passes, 0);

        // ...and forcing it retries the same work.
        const response = await fetch(`${base}/api/v1/chats/linzhao/session/summarize`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: '{}',
        });

        assert.equal(response.status, 200);
        const body = await response.json() as { summarized: boolean; memory: MemoryState };
        assert.equal(body.summarized, true);
        assert.match(body.memory.text, /要考试/);
        assert.equal(body.memory.passes, 1);

        // With nothing new to cover, forcing again is a no-op rather than an error.
        const again = await fetch(`${base}/api/v1/chats/linzhao/session/summarize`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: '{}',
        });
        assert.equal((await again.json() as { summarized: boolean }).summarized, false);

        assert.equal(readMemoryState((await library.getChat('linzhao', 'session')).header.chat_metadata).passes, 1);
    }, handler);
});

test('a failing summarizer never fails the turn that triggered it', async () => {
    const handler: MockHandler = (request, response) => {
        const system = request.body?.messages?.find((entry) => entry.role === 'system')?.content ?? '';

        if (system.includes('摘要助手')) {
            response.writeHead(500, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: { message: 'summarizer down' } }));
            return;
        }

        respondWith('在。')(request, response);
    };

    await withServer(async ({ base, token, library }) => {
        const send = async (text: string): Promise<Response> => fetch(`${base}/api/v1/chats/linzhao/session/messages`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text }),
        });

        for (let turn = 0; turn < 3; turn++) {
            const response = await send(`第 ${turn} 句`);
            assert.equal(response.status, 200, 'the turn must still succeed');
            assert.equal((await response.json() as { reply: string }).reply, '在。');
        }

        // The conversation is intact, just without a summary.
        const chat = await library.getChat('linzhao', 'session');
        assert.equal(chat.messages.length, 7);
        assert.equal(readMemoryState(chat.header.chat_metadata).passes, 0);
    }, handler);
});
