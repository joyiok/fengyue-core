import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ChatSession } from '../src/chat/session.ts';
import { normalizeCard } from '../src/cards/types.ts';
import type { ModelConfig } from '../src/gateway/types.ts';
import { Library } from '../src/library.ts';
import { startMockModel, respondWith } from './helpers/mock-model.ts';

const card = normalizeCard({
    spec: 'chara_card_v2',
    data: {
        name: '林昭',
        description: '林昭，独立书店「夜航」的店主。',
        personality: '话少，偶尔刻薄，但从不敷衍。',
        scenario: '深夜的书房，只开着一盏台灯。',
        first_mes: '（她把台灯调暗了一格）来了。坐吧。',
        alternate_greetings: ['（她头也不抬）书在左边第三排。'],
        post_history_instructions: '保持简短，不要长篇大论。',
    },
});

async function withLibrary(run: (library: Library, dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), 'story-session-'));

    try {
        const library = new Library(dir);
        await library.ensureDirs();
        await library.importCard(JSON.stringify(card), { filename: 'linzhao' });
        await run(library, dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

function configFor(endpoint: string): ModelConfig {
    return { endpoint, model: 'mock-model' };
}

test('creating a session writes the greeting to disk', async () => {
    await withLibrary(async (library) => {
        const session = await ChatSession.create(library, { cardId: 'linzhao', personaName: 'User', name: 'first' });

        assert.equal(session.name, 'first');
        assert.equal(session.messages.length, 1);
        assert.equal(session.messages[0]?.mes, card.data.first_mes);
        assert.equal(session.messages[0]?.is_user, false);

        const stored = await library.getChat('linzhao', 'first');
        assert.equal(stored.messages.length, 1);
        assert.equal(stored.header.character_name, '林昭');
        assert.equal(stored.header.user_name, 'User');
    });
});

test('an alternate greeting can be chosen', async () => {
    await withLibrary(async (library) => {
        const session = await ChatSession.create(library, {
            cardId: 'linzhao',
            personaName: 'User',
            name: 'alt',
            greetingIndex: 1,
        });

        assert.equal(session.messages[0]?.mes, card.data.alternate_greetings?.[0]);
    });
});

test('a duplicate chat name is refused instead of overwriting', async () => {
    await withLibrary(async (library) => {
        await ChatSession.create(library, { cardId: 'linzhao', personaName: 'User', name: 'dup' });

        await assert.rejects(
            ChatSession.create(library, { cardId: 'linzhao', personaName: 'User', name: 'dup' }),
            /already exists/,
        );
    });
});

test('a turn appends both messages and survives a reload', async () => {
    const mock = await startMockModel(respondWith('在。'));

    try {
        await withLibrary(async (library) => {
            const session = await ChatSession.create(library, { cardId: 'linzhao', personaName: 'User', name: 'turn' });
            const result = await session.send(configFor(mock.endpoint), '在吗');

            assert.equal(result.reply, '在。');
            assert.equal(result.usage.totalTokens, 18);
            assert.equal(session.messages.length, 3);
            assert.deepEqual(session.messages.slice(1).map((message) => [message.is_user, message.mes]), [
                [true, '在吗'],
                [false, '在。'],
            ]);

            const reloaded = await ChatSession.load(library, 'linzhao', 'turn', { personaName: 'User' });
            assert.equal(reloaded.messages.length, 3);
            assert.equal(reloaded.messages[2]?.mes, '在。');
        });
    } finally {
        await mock.close();
    }
});

test('a failed model call persists nothing', async () => {
    const mock = await startMockModel((_request, response) => {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'boom' } }));
    });

    try {
        await withLibrary(async (library) => {
            const session = await ChatSession.create(library, { cardId: 'linzhao', personaName: 'User', name: 'failed' });

            await assert.rejects(session.send(configFor(mock.endpoint), '在吗'));

            // The in-memory log and the file both still hold only the greeting.
            assert.equal(session.messages.length, 1);
            const stored = await library.getChat('linzhao', 'failed');
            assert.equal(stored.messages.length, 1);
        });
    } finally {
        await mock.close();
    }
});

test('preview builds the prompt without writing anything', async () => {
    await withLibrary(async (library) => {
        const session = await ChatSession.create(library, { cardId: 'linzhao', personaName: 'User', name: 'preview' });
        const preview = session.preview('在吗');

        assert.equal(preview.messages.at(-1)?.content, '在吗');
        assert.equal(session.messages.length, 1);

        // No second chat file appeared.
        const chats = await library.listChats('linzhao');
        assert.deepEqual(chats.map((chat) => chat.name), ['preview']);
    });
});

test('20 turns keep the character definition and a bounded window', async () => {
    // The mock replies with the exact prompt it received, so the test can assert on
    // what the model would have seen on every single turn.
    const mock = await startMockModel((request, response) => {
        const system = request.body?.messages?.find((message) => message.role === 'system')?.content ?? '';
        const marker = system.includes('书店') && system.includes('刻薄') && system.includes('台灯') ? 'ok' : 'LOST';
        respondWith(marker)(request, response);
    });

    try {
        await withLibrary(async (library) => {
            const session = await ChatSession.create(library, { cardId: 'linzhao', personaName: 'User', name: 'long' });
            session.promptOptions.historyTokenBudget = 200;

            for (let turn = 1; turn <= 20; turn++) {
                const result = await session.send(configFor(mock.endpoint), `第 ${turn} 句话，随便说点什么。`);
                assert.equal(result.reply, 'ok', `turn ${turn} lost the character definition`);
            }

            assert.equal(mock.requests.length, 20);

            for (const [index, request] of mock.requests.entries()) {
                const sent = request.body?.messages ?? [];
                const system = sent.find((message) => message.role === 'system');

                // 1. The definition is always present and stable.
                assert.ok(system, `turn ${index + 1} has no system message`);
                assert.match(system.content, /你在扮演「林昭」/);
                assert.match(system.content, /书店/);
                assert.match(system.content, /刻薄/);
                assert.match(system.content, /台灯/);

                // 2. post_history_instructions stays immediately before the new turn.
                assert.equal(sent.at(-1)?.role, 'user');
                assert.equal(sent.at(-1)?.content, `第 ${index + 1} 句话，随便说点什么。`);
                assert.equal(sent.at(-2)?.role, 'system');
                assert.match(sent.at(-2)?.content ?? '', /保持简短/);
            }

            // 3. The window is bounded: the full log is far longer than what is sent.
            assert.equal(session.messages.length, 41);
            const sentOnLastTurn = mock.requests[19]?.body?.messages?.length ?? 0;
            assert.ok(sentOnLastTurn < 41, `expected a trimmed window, got ${sentOnLastTurn} messages`);
            assert.ok(sentOnLastTurn >= 4, 'expected at least the definition, some history and the new turn');

            // 4. And the persisted log really does hold every turn.
            const stored = await library.getChat('linzhao', 'long');
            assert.equal(stored.messages.length, 41);
            const contents = stored.messages.map((message) => message.mes);
            assert.equal(contents[0], card.data.first_mes);
            assert.ok(contents.includes('第 1 句话，随便说点什么。'));
            assert.ok(contents.includes('第 20 句话，随便说点什么。'));
        });
    } finally {
        await mock.close();
    }
});

test('the persisted log is the SillyTavern JSONL shape', async () => {
    const mock = await startMockModel(respondWith('在。'));

    try {
        await withLibrary(async (library, dir) => {
            const session = await ChatSession.create(library, { cardId: 'linzhao', personaName: '小明', name: 'shape' });
            await session.send(configFor(mock.endpoint), '在吗');

            const file = path.join(dir, 'chats', 'linzhao', 'shape.jsonl');
            const lines = (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '');

            assert.equal(lines.length, 4); // header + greeting + user + reply

            const header = JSON.parse(lines[0] as string) as { chat_metadata: unknown; user_name: string; character_name: string };
            assert.equal(header.user_name, '小明');
            assert.equal(header.character_name, '林昭');
            assert.equal(typeof header.chat_metadata, 'object');

            const firstMessage = JSON.parse(lines[1] as string) as { mes: string; is_user: boolean; send_date: string };
            assert.equal(firstMessage.is_user, false);
            assert.equal(typeof firstMessage.send_date, 'string');
            assert.equal(firstMessage.mes, card.data.first_mes);
        });
    } finally {
        await mock.close();
    }
});
