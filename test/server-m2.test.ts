import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { normalizeCard } from '../src/cards/types.ts';
import type { ModelConfig } from '../src/gateway/types.ts';
import { Library } from '../src/library.ts';
import { createServer } from '../src/server.ts';
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

interface SseFrame {
    type?: string;
    text?: string;
    reply?: string;
    error?: string;
    usageSource?: string;
    requestId?: string;
}

async function collectSse(response: Response): Promise<SseFrame[]> {
    const text = await response.text();

    return text
        .split('\n\n')
        .map((block) => block.trim())
        .filter((block) => block.startsWith('data:'))
        .map((block) => JSON.parse(block.slice(5).trim()) as SseFrame);
}

interface Harness {
    base: string;
    library: Library;
}

async function withServer(
    mockEndpoint: string,
    run: (harness: Harness) => Promise<void>,
    options: { configured?: boolean } = {},
): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), 'story-server-m2-'));
    const library = new Library(dir);
    await library.ensureDirs();
    await library.importCard(JSON.stringify(card), { filename: 'linzhao' });

    const config: ModelConfig = { endpoint: mockEndpoint, model: 'mock-model' };
    const server = createServer(library, {
        loadModelConfig: options.configured === false
            ? () => Promise.reject(new Error('no model endpoint configured'))
            : () => Promise.resolve(config),
        personaName: 'User',
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
        await run({ base: `http://127.0.0.1:${port}`, library });
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(dir, { recursive: true, force: true });
    }
}

async function createChat(base: string, name = 'http'): Promise<string> {
    const response = await fetch(`${base}/api/v1/chats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId: 'linzhao', name }),
    });

    assert.equal(response.status, 201);
    const body = await response.json() as { name: string };

    return body.name;
}

test('a streamed turn over HTTP emits delta frames then a done frame', async () => {
    const mock = await startMockModel(respondSse('她把书合上了。'));

    try {
        await withServer(mock.endpoint, async ({ base, library }) => {
            const name = await createChat(base);

            const response = await fetch(`${base}/api/v1/chats/linzhao/${name}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: '在吗', stream: true }),
            });

            assert.equal(response.status, 200);
            assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
            // Guards against a reverse proxy or CDN buffering the stream.
            assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform');
            assert.equal(response.headers.get('x-accel-buffering'), 'no');

            const frames = await collectSse(response);
            const deltas = frames.filter((frame) => frame.type === 'delta');
            const done = frames.find((frame) => frame.type === 'done');

            assert.ok(deltas.length > 1, 'expected several delta frames');
            assert.equal(deltas.map((frame) => frame.text).join(''), '她把书合上了。');
            assert.ok(done, 'expected a done frame');
            assert.equal(done.reply, '她把书合上了。');
            assert.ok(done.requestId);
            assert.equal(done.usageSource, 'estimated');

            // The turn was persisted.
            const stored = await library.getChat('linzhao', name);
            assert.equal(stored.messages.length, 3);
            assert.equal(stored.messages[2]?.mes, '她把书合上了。');
        });
    } finally {
        await mock.close();
    }
});

test('a client that disconnects mid-stream aborts the upstream and saves nothing', async () => {
    const mock = await startMockModel(respondSseAndHang());

    try {
        await withServer(mock.endpoint, async ({ base, library }) => {
            const name = await createChat(base, 'abort');
            const controller = new AbortController();

            const response = await fetch(`${base}/api/v1/chats/linzhao/${name}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: '在吗', stream: true }),
                signal: controller.signal,
            });

            const reader = response.body?.getReader();
            assert.ok(reader);
            await reader.read();
            controller.abort();

            // Give the server a moment to notice the disconnect.
            let abortedUpstream = false;
            for (let attempt = 0; attempt < 20; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 50));
                if (mock.requests[0]?.aborted === true) {
                    abortedUpstream = true;
                    break;
                }
            }

            assert.equal(abortedUpstream, true, 'the upstream request should have been aborted');

            // Nothing was persisted, so a retry starts from a clean log.
            const stored = await library.getChat('linzhao', name);
            assert.equal(stored.messages.length, 1);
            assert.equal(stored.messages[0]?.mes, card.data.first_mes);
        });
    } finally {
        await mock.close();
    }
});

test('regeneration over HTTP replaces the reply and keeps the log length', async () => {
    let call = 0;
    const handler: MockHandler = (request, response) => {
        call += 1;
        respondSse(call === 1 ? '第一版' : '第二版')(request, response);
    };
    const mock = await startMockModel(handler);

    try {
        await withServer(mock.endpoint, async ({ base, library }) => {
            const name = await createChat(base, 'regen');

            await fetch(`${base}/api/v1/chats/linzhao/${name}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: '在吗', stream: true }),
            }).then(collectSse);

            const before = await library.getChat('linzhao', name);
            assert.equal(before.messages.length, 3);
            assert.equal(before.messages[2]?.mes, '第一版');

            const frames = await fetch(`${base}/api/v1/chats/linzhao/${name}/regenerate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ stream: true }),
            }).then(collectSse);

            const done = frames.find((frame) => frame.type === 'done');
            assert.equal(done?.reply, '第二版');

            const after = await library.getChat('linzhao', name);
            assert.equal(after.messages.length, 3, 'regeneration must not append a message');
            assert.equal(after.messages[2]?.mes, '第二版');
        });
    } finally {
        await mock.close();
    }
});

test('regeneration can be asked to edit the last user message', async () => {
    const mock = await startMockModel(respondWith('好的。'));

    try {
        await withServer(mock.endpoint, async ({ base, library }) => {
            const name = await createChat(base, 'edit');

            await fetch(`${base}/api/v1/chats/linzhao/${name}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: '在吗' }),
            });

            const response = await fetch(`${base}/api/v1/chats/linzhao/${name}/regenerate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: '你到底在不在' }),
            });

            assert.equal(response.status, 200);
            const stored = await library.getChat('linzhao', name);
            assert.equal(stored.messages.length, 3);
            assert.equal(stored.messages[1]?.mes, '你到底在不在');
        });
    } finally {
        await mock.close();
    }
});

test('a non-streaming turn still works and reports usage', async () => {
    const mock = await startMockModel(respondWith('好的。'));

    try {
        await withServer(mock.endpoint, async ({ base }) => {
            const name = await createChat(base, 'plain');

            const response = await fetch(`${base}/api/v1/chats/linzhao/${name}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: '在吗' }),
            });

            assert.equal(response.status, 200);
            const body = await response.json() as { reply: string; usageSource: string; requestId: string; streamed: boolean };

            assert.equal(body.reply, '好的。');
            assert.equal(body.streamed, false);
            assert.equal(body.usageSource, 'provider');
            assert.ok(body.requestId);
        });
    } finally {
        await mock.close();
    }
});

test('without a configured model the stream route explains itself', async () => {
    const mock = await startMockModel(respondWith('x'));

    try {
        await withServer(mock.endpoint, async ({ base }) => {
            const name = await createChat(base, 'noconfig');

            const response = await fetch(`${base}/api/v1/chats/linzhao/${name}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: '在吗' }),
            });

            assert.equal(response.status, 503);
            const body = await response.json() as { error: string; hint: string };
            assert.match(body.error, /no model endpoint configured/);
            assert.match(body.hint, /STORY_MODEL_ENDPOINT/);
        }, { configured: false });
    } finally {
        await mock.close();
    }
});

test('an upstream failure mid-stream is reported as an error frame, not a broken connection', async () => {
    const mock = await startMockModel((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '前半' } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ error: { message: 'content filtered' } })}\n\n`);
        response.end();
    });

    try {
        await withServer(mock.endpoint, async ({ base, library }) => {
            const name = await createChat(base, 'midfail');

            const response = await fetch(`${base}/api/v1/chats/linzhao/${name}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: '在吗', stream: true }),
            });

            const frames = await collectSse(response);
            const error = frames.find((frame) => frame.type === 'error');

            assert.ok(error, 'expected an error frame');
            assert.match(error.error ?? '', /content filtered/);

            // A failed stream must not leave a partial reply behind.
            const stored = await library.getChat('linzhao', name);
            assert.equal(stored.messages.length, 1);
        });
    } finally {
        await mock.close();
    }
});
