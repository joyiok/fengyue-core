import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ChatSession } from '../src/chat/session.ts';
import { normalizeCard } from '../src/cards/types.ts';
import type { ModelConfig } from '../src/gateway/types.ts';
import { Library } from '../src/library.ts';
import { respondSse, respondSseAndHang, respondWith, startMockModel, type MockHandler } from './helpers/mock-model.ts';

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

async function withLibrary(run: (library: Library) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), 'story-m2-'));

    try {
        const library = new Library(dir);
        await library.ensureDirs();
        await library.importCard(JSON.stringify(card), { filename: 'linzhao' });
        await run(library);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

function configFor(endpoint: string): ModelConfig {
    return { endpoint, model: 'mock-model' };
}

/** Answers with a different reply on each call, so regeneration is observable. */
function sequentialReplies(replies: string[]): MockHandler {
    let call = 0;

    return (request, response) => {
        const reply = replies[Math.min(call, replies.length - 1)] ?? '';
        call += 1;
        respondWith(reply)(request, response);
    };
}

test('a streamed turn forwards deltas and persists once complete', async () => {
    const mock = await startMockModel(respondSse('她把书合上了。'));

    try {
        await withLibrary(async (library) => {
            const session = await ChatSession.create(library, { cardId: 'linzhao', personaName: 'User', name: 'stream' });
            const deltas: string[] = [];

            const result = await session.send(configFor(mock.endpoint), '在吗', {
                onDelta: (delta) => { deltas.push(delta); },
            });

            assert.equal(deltas.join(''), '她把书合上了。');
            assert.equal(result.streamed, true);
            assert.equal(result.reply, '她把书合上了。');
            assert.equal(result.usageSource, 'estimated');

            // Persisted exactly once and complete.
            assert.equal(session.messages.length, 3);
            const stored = await library.getChat('linzhao', 'stream');
            assert.equal(stored.messages.length, 3);
            assert.equal(stored.messages[2]?.mes, '她把书合上了。');
        });
    } finally {
        await mock.close();
    }
});

test('an aborted stream persists nothing, so the retry is a single clean turn', async () => {
    let call = 0;
    const mock = await startMockModel((request, response) => {
        call += 1;
        if (call === 1) {
            respondSseAndHang()(request, response);
            return;
        }
        respondWith('这次成功了。')(request, response);
    });

    try {
        await withLibrary(async (library) => {
            const session = await ChatSession.create(library, { cardId: 'linzhao', personaName: 'User', name: 'abort' });
            const controller = new AbortController();

            const pending = session.send(configFor(mock.endpoint), '在吗', { signal: controller.signal });
            await new Promise((resolve) => setTimeout(resolve, 50));
            controller.abort();

            await assert.rejects(pending, (error: unknown) => (error as { name?: string }).name === 'AbortError');

            // Nothing was written: neither in memory nor on disk.
            assert.equal(session.messages.length, 1);
            assert.equal((await library.getChat('linzhao', 'abort')).messages.length, 1);

            // And the retry produces exactly one user/assistant pair.
            const retry = await session.send(configFor(mock.endpoint), '在吗');
            assert.equal(retry.reply, '这次成功了。');
            assert.equal(session.messages.length, 3);
            assert.equal(mock.requests[1]?.body?.messages?.length, 3);
        });
    } finally {
        await mock.close();
    }
});

test('re-sending the same requestId returns the stored reply without calling the model', async () => {
    const mock = await startMockModel(respondWith('只调一次。'));

    try {
        await withLibrary(async (library) => {
            const session = await ChatSession.create(library, { cardId: 'linzhao', personaName: 'User', name: 'idem' });

            const first = await session.send(configFor(mock.endpoint), '在吗', { requestId: 'req-1' });
            assert.equal(first.fromCache, false);
            assert.equal(mock.requests.length, 1);

            // The ambiguous case: the client never saw the end and retries.
            const second = await session.send(configFor(mock.endpoint), '在吗', { requestId: 'req-1' });

            assert.equal(second.fromCache, true);
            assert.equal(second.reply, '只调一次。');
            assert.equal(second.requestId, 'req-1');
            assert.equal(mock.requests.length, 1, 'the model must not be called twice for one request id');

            // And the log still holds a single exchange.
            assert.equal(session.messages.length, 3);
        });
    } finally {
        await mock.close();
    }
});

test('a different requestId is a new turn', async () => {
    const mock = await startMockModel(respondWith('好的。'));

    try {
        await withLibrary(async (library) => {
            const session = await ChatSession.create(library, { cardId: 'linzhao', personaName: 'User', name: 'two' });

            await session.send(configFor(mock.endpoint), '第一句', { requestId: 'req-1' });
            await session.send(configFor(mock.endpoint), '第二句', { requestId: 'req-2' });

            assert.equal(mock.requests.length, 2);
            assert.equal(session.messages.length, 5);
        });
    } finally {
        await mock.close();
    }
});

test('regenerating replaces the reply instead of appending one', async () => {
    const mock = await startMockModel(sequentialReplies(['第一版', '第二版']));

    try {
        await withLibrary(async (library) => {
            const session = await ChatSession.create(library, { cardId: 'linzhao', personaName: 'User', name: 'regen' });
            await session.send(configFor(mock.endpoint), '在吗');
            assert.equal(session.messages[2]?.mes, '第一版');

            const result = await session.regenerate(configFor(mock.endpoint));

            assert.equal(result.reply, '第二版');
            // Same number of messages: the reply was replaced, not added.
            assert.equal(session.messages.length, 3);
            assert.equal(session.messages[2]?.mes, '第二版');
            assert.equal(session.messages[1]?.mes, '在吗');

            // The replaced reply is kept for reference rather than thrown away.
            const extra = session.messages[2]?.extra as { story?: { previousReplies?: string[] } } | undefined;
            assert.deepEqual(extra?.story?.previousReplies, ['第一版']);

            // And the file matches memory.
            const stored = await library.getChat('linzhao', 'regen');
            assert.equal(stored.messages.length, 3);
            assert.equal(stored.messages[2]?.mes, '第二版');
        });
    } finally {
        await mock.close();
    }
});

test('regenerating with an edited user message updates both messages', async () => {
    const mock = await startMockModel(sequentialReplies(['第一版', '换个回答']));

    try {
        await withLibrary(async (library) => {
            const session = await ChatSession.create(library, { cardId: 'linzhao', personaName: 'User', name: 'edit' });
            await session.send(configFor(mock.endpoint), '在吗');

            await session.regenerate(configFor(mock.endpoint), { userMessageOverride: '你到底在不在' });

            assert.equal(session.messages.length, 3);
            assert.equal(session.messages[1]?.mes, '你到底在不在');
            assert.equal(session.messages[2]?.mes, '换个回答');

            // The prompt sent on regeneration used the edited text.
            const sent = mock.requests[1]?.body?.messages;
            assert.equal(sent?.at(-1)?.content, '你到底在不在');
        });
    } finally {
        await mock.close();
    }
});

test('a failed regeneration restores the original turn', async () => {
    let call = 0;
    const mock = await startMockModel((request, response) => {
        call += 1;
        if (call === 1) {
            respondWith('原来的回答')(request, response);
            return;
        }
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'boom' } }));
    });

    try {
        await withLibrary(async (library) => {
            const session = await ChatSession.create(library, { cardId: 'linzhao', personaName: 'User', name: 'failregen' });
            await session.send(configFor(mock.endpoint), '在吗');

            await assert.rejects(session.regenerate(configFor(mock.endpoint)));

            // Nothing lost, nothing duplicated.
            assert.equal(session.messages.length, 3);
            assert.equal(session.messages[1]?.mes, '在吗');
            assert.equal(session.messages[2]?.mes, '原来的回答');

            const stored = await library.getChat('linzhao', 'failregen');
            assert.equal(stored.messages.length, 3);
            assert.equal(stored.messages[2]?.mes, '原来的回答');
        });
    } finally {
        await mock.close();
    }
});

test('regenerating a chat with no reply yet is refused', async () => {
    const mock = await startMockModel(respondWith('x'));

    try {
        await withLibrary(async (library) => {
            const session = await ChatSession.create(library, { cardId: 'linzhao', personaName: 'User', name: 'empty' });
            await assert.rejects(session.regenerate(configFor(mock.endpoint)), /nothing to regenerate/);
            assert.equal(session.messages.length, 1);
        });
    } finally {
        await mock.close();
    }
});

test('reloading a chat restores the conversation exactly', async () => {
    const mock = await startMockModel(sequentialReplies(['第一句回答', '第二句回答']));

    try {
        await withLibrary(async (library) => {
            const session = await ChatSession.create(library, { cardId: 'linzhao', personaName: 'User', name: 'restore' });
            await session.send(configFor(mock.endpoint), '第一句');
            await session.send(configFor(mock.endpoint), '第二句');

            const before = JSON.stringify(session.messages);
            const reloaded = await ChatSession.load(library, 'linzhao', 'restore', { personaName: 'User' });

            assert.equal(JSON.stringify(reloaded.messages), before);
            assert.equal(reloaded.messages.length, 5);
            assert.equal(reloaded.header.user_name, 'User');
            assert.equal(reloaded.header.character_name, '林昭');
        });
    } finally {
        await mock.close();
    }
});
