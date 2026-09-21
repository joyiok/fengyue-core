import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadModelConfig } from '../src/gateway/config.ts';
import { createChatCompletion } from '../src/gateway/openai.ts';
import { ModelError, describeModelConfig, type ModelConfig } from '../src/gateway/types.ts';
import { startMockModel, respondWith } from './helpers/mock-model.ts';

const messages = [
    { role: 'system' as const, content: '你在扮演林昭。' },
    { role: 'user' as const, content: '在吗' },
];

function configFor(endpoint: string, extra: Partial<ModelConfig> = {}): ModelConfig {
    return { endpoint, model: 'mock-model', ...extra };
}

test('sends an OpenAI chat completion request and returns the reply', async () => {
    const mock = await startMockModel();

    try {
        const result = await createChatCompletion(configFor(mock.endpoint, {
            apiKey: 'sk-secret-value',
            temperature: 0.8,
            maxTokens: 256,
        }), { messages });

        assert.equal(result.content, '好的。');
        assert.equal(result.model, 'mock-model');
        assert.deepEqual(result.usage, { promptTokens: 11, completionTokens: 7, totalTokens: 18 });
        assert.equal(result.finishReason, 'stop');
        assert.ok(result.latencyMs >= 0);

        const sent = mock.requests[0];
        assert.ok(sent?.body);
        assert.equal(sent.body.model, 'mock-model');
        assert.equal(sent.body.stream, false);
        assert.equal(sent.body.temperature, 0.8);
        assert.equal(sent.body.max_tokens, 256);
        assert.deepEqual(sent.body.messages, [
            { role: 'system', content: '你在扮演林昭。' },
            { role: 'user', content: '在吗' },
        ]);
        assert.equal(sent.headers.authorization, 'Bearer sk-secret-value');
    } finally {
        await mock.close();
    }
});

test('no key configured means no Authorization header', async () => {
    const mock = await startMockModel();

    try {
        await createChatCompletion(configFor(mock.endpoint), { messages });
        assert.equal(mock.requests[0]?.headers.authorization, undefined);
    } finally {
        await mock.close();
    }
});

test('per-request overrides win over the configured defaults', async () => {
    const mock = await startMockModel();

    try {
        await createChatCompletion(configFor(mock.endpoint, { temperature: 0.2, maxTokens: 64, stop: ['\n\n'] }), {
            messages,
            overrides: { temperature: 1.1, maxTokens: 512 },
        });

        const sent = mock.requests[0]?.body;
        assert.equal(sent?.temperature, 1.1);
        assert.equal(sent?.max_tokens, 512);
        assert.deepEqual(sent?.stop, ['\n\n']);
    } finally {
        await mock.close();
    }
});

test('upstream rate limiting is surfaced with its status', async () => {
    const mock = await startMockModel((_request, response) => {
        response.writeHead(429, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'slow down' } }));
    });

    try {
        await assert.rejects(
            createChatCompletion(configFor(mock.endpoint, { apiKey: 'sk-secret-value' }), { messages }),
            (error: unknown) => {
                assert.ok(error instanceof ModelError);
                assert.equal(error.status, 429);
                assert.match(error.message, /HTTP 429/);
                // The key must not leak into error messages.
                assert.equal(error.message.includes('sk-secret-value'), false);
                assert.equal((error.body ?? '').includes('sk-secret-value'), false);
                return true;
            },
        );
    } finally {
        await mock.close();
    }
});

test('an unreachable endpoint becomes a ModelError without a status', async () => {
    // Port 1 is reserved and nothing listens there.
    await assert.rejects(
        createChatCompletion(configFor('http://127.0.0.1:1/v1/chat/completions', { timeoutMs: 2000 }), { messages }),
        (error: unknown) => {
            assert.ok(error instanceof ModelError);
            assert.equal(error.status, undefined);
            assert.match(error.message, /could not reach the model endpoint/);
            return true;
        },
    );
});

test('a response with no choices is an error, not an empty reply', async () => {
    const mock = await startMockModel((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [] }));
    });

    try {
        await assert.rejects(
            createChatCompletion(configFor(mock.endpoint), { messages }),
            /returned no choices/,
        );
    } finally {
        await mock.close();
    }
});

test('content returned as parts is joined into a single string', async () => {
    const mock = await startMockModel((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
            model: 'mock-model',
            choices: [{ message: { content: [{ type: 'text', text: '前半' }, { type: 'text', text: '后半' }] } }],
        }));
    });

    try {
        const result = await createChatCompletion(configFor(mock.endpoint), { messages });
        assert.equal(result.content, '前半后半');
    } finally {
        await mock.close();
    }
});

test('an explicit upstream error payload is reported', async () => {
    const mock = await startMockModel((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'content filtered' } }));
    });

    try {
        await assert.rejects(
            createChatCompletion(configFor(mock.endpoint), { messages }),
            /content filtered/,
        );
    } finally {
        await mock.close();
    }
});

test('configuration comes from the file and is overridden by the environment', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'story-config-'));
    const configPath = path.join(dir, 'story.config.json');

    try {
        await writeFile(configPath, JSON.stringify({
            model: { endpoint: 'https://file.example/v1', model: 'file-model', apiKey: 'file-key', temperature: 0.5 },
        }));

        const fromFile = await loadModelConfig({ configPath, env: {} });
        assert.equal(fromFile.endpoint, 'https://file.example/v1');
        assert.equal(fromFile.model, 'file-model');
        assert.equal(fromFile.apiKey, 'file-key');
        assert.equal(fromFile.temperature, 0.5);

        const fromEnv = await loadModelConfig({
            configPath,
            env: {
                STORY_MODEL_ENDPOINT: 'https://env.example/v1',
                STORY_MODEL_NAME: 'env-model',
                STORY_MODEL_API_KEY: 'env-key',
                STORY_MODEL_TEMPERATURE: '1.2',
            },
        });
        assert.equal(fromEnv.endpoint, 'https://env.example/v1');
        assert.equal(fromEnv.model, 'env-model');
        assert.equal(fromEnv.apiKey, 'env-key');
        assert.equal(fromEnv.temperature, 1.2);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('a missing endpoint or model is a clear error, and the key is never printed', async () => {
    await assert.rejects(
        loadModelConfig({ configPath: '/nonexistent/story.config.json', env: {} }),
        /no model endpoint configured/,
    );

    await assert.rejects(
        loadModelConfig({ configPath: '/nonexistent/story.config.json', env: { STORY_MODEL_ENDPOINT: 'https://x/v1' } }),
        /no model name configured/,
    );

    const described = describeModelConfig({ endpoint: 'https://x/v1', model: 'm', apiKey: 'sk-secret-value' });
    assert.equal(JSON.stringify(described).includes('sk-secret-value'), false);
    assert.equal(described.apiKey, '(set)');
    assert.equal(describeModelConfig({ endpoint: 'https://x/v1', model: 'm' }).apiKey, '(not set)');
});

test('a mock that echoes lets a caller inspect the assembled prompt', async () => {
    const mock = await startMockModel((request, response) => {
        const system = request.body?.messages?.find((message) => message.role === 'system')?.content ?? '';
        respondWith(`system length ${system.length}`)(request, response);
    });

    try {
        const result = await createChatCompletion(configFor(mock.endpoint), { messages });
        assert.equal(result.content, `system length ${'你在扮演林昭。'.length}`);
    } finally {
        await mock.close();
    }
});
