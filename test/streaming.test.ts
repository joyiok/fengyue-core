import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createChatCompletion, streamChatCompletion } from '../src/gateway/openai.ts';
import { ModelError, type ModelConfig } from '../src/gateway/types.ts';
import { respondSse, respondSseAndHang, startMockModel } from './helpers/mock-model.ts';

const messages = [
    { role: 'system' as const, content: '你在扮演林昭。' },
    { role: 'user' as const, content: '在吗' },
];

function configFor(endpoint: string, extra: Partial<ModelConfig> = {}): ModelConfig {
    return { endpoint, model: 'mock-model', ...extra };
}

async function collect(config: ModelConfig, signal?: AbortSignal): Promise<{ deltas: string[]; result: Awaited<ReturnType<typeof streamChatCompletion>> }> {
    const deltas: string[] = [];
    const result = await streamChatCompletion(
        config,
        { messages, ...(signal ? { signal } : {}) },
        (delta) => { deltas.push(delta); },
    );

    return { deltas, result };
}

test('deltas arrive in order and the reply is assembled from them', async () => {
    const mock = await startMockModel(respondSse('她把书合上了。'));

    try {
        const { deltas, result } = await collect(configFor(mock.endpoint));

        assert.deepEqual(deltas.join(''), '她把书合上了。');
        assert.ok(deltas.length > 1, 'expected the mock to send several deltas');
        assert.equal(result.content, '她把书合上了。');
        assert.equal(result.streamed, true);
        assert.equal(result.finishReason, 'stop');
        assert.equal(mock.requests[0]?.body?.stream, true);
    } finally {
        await mock.close();
    }
});

test('CRLF, keep-alive comments and junk lines are all tolerated', async () => {
    const mock = await startMockModel(respondSse('好的。', { crlf: true, noise: true }));

    try {
        const { result } = await collect(configFor(mock.endpoint));
        assert.equal(result.content, '好的。');
    } finally {
        await mock.close();
    }
});

test('streamed usage comes from the provider when it reports one', async () => {
    const mock = await startMockModel(respondSse('好的。', { usage: true }));

    try {
        const { result } = await collect(configFor(mock.endpoint));

        assert.equal(result.usageSource, 'provider');
        assert.deepEqual(result.usage, { promptTokens: 20, completionTokens: 5, totalTokens: 25 });
    } finally {
        await mock.close();
    }
});

test('without a reported usage the numbers are estimated and labelled as such', async () => {
    const mock = await startMockModel(respondSse('好的。'));

    try {
        const { result } = await collect(configFor(mock.endpoint));

        assert.equal(result.usageSource, 'estimated');
        assert.ok((result.usage.completionTokens ?? 0) > 0, 'expected an estimated completion count');
        assert.ok((result.usage.promptTokens ?? 0) > 0, 'expected an estimated prompt count');
        assert.equal((result.usage.promptTokens ?? 0) + (result.usage.completionTokens ?? 0), result.usage.totalTokens);
    } finally {
        await mock.close();
    }
});

test('include_usage is only requested when configured', async () => {
    const plain = await startMockModel(respondSse('x'));
    const asked = await startMockModel(respondSse('x'));

    try {
        await collect(configFor(plain.endpoint));
        await collect(configFor(asked.endpoint, { includeUsage: true }));

        assert.equal(plain.requests[0]?.body?.stream_options, undefined);
        assert.deepEqual(asked.requests[0]?.body?.stream_options, { include_usage: true });
    } finally {
        await plain.close();
        await asked.close();
    }
});

test('first token latency is recorded', async () => {
    const mock = await startMockModel(respondSse('一二三四'));

    try {
        const { result } = await collect(configFor(mock.endpoint));
        assert.equal(typeof result.firstTokenMs, 'number');
        assert.ok((result.firstTokenMs ?? -1) >= 0);
    } finally {
        await mock.close();
    }
});

test('aborting mid-stream throws AbortError and stops reading', async () => {
    const mock = await startMockModel(respondSseAndHang());
    const controller = new AbortController();

    try {
        const promise = collect(configFor(mock.endpoint), controller.signal);
        // Give the request a moment to reach the mock, then walk away.
        await new Promise((resolve) => setTimeout(resolve, 50));
        controller.abort();

        await assert.rejects(
            promise,
            (error: unknown) => {
                assert.equal((error as { name?: string }).name, 'AbortError');
                return true;
            },
        );
    } finally {
        await mock.close();
    }
});

test('a stream that fails before any delta reports the upstream status', async () => {
    const mock = await startMockModel((_request, response) => {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'bad key' } }));
    });

    try {
        await assert.rejects(
            collect(configFor(mock.endpoint, { apiKey: 'sk-secret-value' })),
            (error: unknown) => {
                assert.ok(error instanceof ModelError);
                assert.equal(error.status, 401);
                assert.equal(error.message.includes('sk-secret-value'), false);
                return true;
            },
        );
    } finally {
        await mock.close();
    }
});

test('an error frame in the middle of a stream is surfaced', async () => {
    const mock = await startMockModel((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '前半' } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ error: { message: 'content filtered' } })}\n\n`);
        response.end();
    });

    try {
        await assert.rejects(collect(configFor(mock.endpoint)), /content filtered/);
    } finally {
        await mock.close();
    }
});

test('the non-streaming path still works and reports its usage source', async () => {
    const mock = await startMockModel();

    try {
        const result = await createChatCompletion(configFor(mock.endpoint), { messages });
        assert.equal(result.streamed, false);
        assert.equal(result.usageSource, 'provider');
        assert.equal(result.usage.totalTokens, 18);
        assert.equal(result.firstTokenMs, undefined);
    } finally {
        await mock.close();
    }
});
