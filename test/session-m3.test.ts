import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ChatSession } from '../src/chat/session.ts';
import { normalizeCard } from '../src/cards/types.ts';
import type { ModelConfig } from '../src/gateway/types.ts';
import { Library } from '../src/library.ts';
import { respondWith, startMockModel, type CapturedRequest } from './helpers/mock-model.ts';

function cardWithWorld(world: string): ReturnType<typeof normalizeCard> {
    return normalizeCard({
        spec: 'chara_card_v2',
        data: {
            name: '林昭',
            description: '书店店主',
            personality: '话少',
            scenario: '深夜的书房',
            first_mes: '来了。',
            extensions: { world },
        },
    });
}

async function withLibrary(run: (library: Library, dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), 'story-m3-'));

    try {
        const library = new Library(dir);
        await library.ensureDirs();
        await run(library, dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

function systemOf(request: CapturedRequest | undefined): string {
    return request?.body?.messages?.find((message) => message.role === 'system')?.content ?? '';
}

function configFor(endpoint: string): ModelConfig {
    return { endpoint, model: 'mock-model' };
}

test('the card primary world is loaded and its entries reach the prompt', async () => {
    const mock = await startMockModel(respondWith('在。'));

    try {
        await withLibrary(async (library) => {
            await library.importCard(JSON.stringify(cardWithWorld('eldoria')), { filename: 'linzhao' });
            await library.putWorldbook('eldoria', {
                entries: {
                    0: { uid: 0, key: [], content: '这里是夜航书店。', constant: true },
                    1: { uid: 1, key: ['考试'], content: '她记得你下个月要考试。' },
                },
            });

            const session = await ChatSession.create(library, { cardId: 'linzhao', personaName: 'User', name: 'm3' });
            assert.equal(session.worldbookId, 'eldoria');

            await session.send(configFor(mock.endpoint), '我最近压力好大');

            // The constant entry is in the definition block...
            assert.match(systemOf(mock.requests[0]), /夜航书店/);
            // ...and the keyword one is not, because nothing matched it yet.
            assert.equal(systemOf(mock.requests[0]).includes('考试'), false);

            // Now mention the keyword.
            const result = await session.send(configFor(mock.endpoint), '考试快到了');
            assert.match(systemOf(mock.requests[1]), /她记得你下个月要考试/);
            assert.ok(result.stats.worldInfo);
            assert.equal(result.stats.worldInfo.activated.length, 2);
        });
    } finally {
        await mock.close();
    }
});

test('sticky state survives a reload and expires on schedule', async () => {
    const mock = await startMockModel(respondWith('在。'));

    try {
        await withLibrary(async (library) => {
            await library.importCard(JSON.stringify(cardWithWorld('eldoria')), { filename: 'linzhao' });
            await library.putWorldbook('eldoria', {
                entries: {
                    0: { uid: 0, key: ['下雨'], content: '窗外正在下雨。', sticky: 6 },
                },
            });

            const session = await ChatSession.create(library, { cardId: 'linzhao', personaName: 'User', name: 'sticky' });

            // Turn 1 mentions the keyword: the entry fires and starts its window.
            await session.send(configFor(mock.endpoint), '外面下雨了吗');
            assert.match(systemOf(mock.requests[0]), /窗外正在下雨/);

            // Turn 2 says nothing about it: sticky keeps it in.
            await session.send(configFor(mock.endpoint), '嗯');
            assert.match(systemOf(mock.requests[1]), /窗外正在下雨/);

            // A fresh process must see the same thing: the state lives in the file.
            const reloaded = await ChatSession.load(library, 'linzhao', 'sticky', { personaName: 'User' });
            await reloaded.send(configFor(mock.endpoint), '继续');
            assert.match(systemOf(mock.requests[2]), /窗外正在下雨/);

            // The chat metadata really carries it.
            const stored = await library.getChat('linzhao', 'sticky');
            const metadata = stored.header.chat_metadata as { story?: { worldInfo?: Record<string, { stickyUntil?: number }> } };
            assert.ok(metadata.story?.worldInfo);
            assert.equal(typeof metadata.story.worldInfo['eldoria.0']?.stickyUntil, 'number');
        });
    } finally {
        await mock.close();
    }
});

test('a world book named by the card but missing from the library is harmless', async () => {
    const mock = await startMockModel(respondWith('在。'));

    try {
        await withLibrary(async (library) => {
            await library.importCard(JSON.stringify(cardWithWorld('does-not-exist')), { filename: 'linzhao' });

            const session = await ChatSession.create(library, { cardId: 'linzhao', personaName: 'User', name: 'missing' });
            assert.equal(session.worldbookId, null);

            const result = await session.send(configFor(mock.endpoint), '在吗');
            assert.equal(result.stats.worldInfo, null);
            assert.equal(result.reply, '在。');
        });
    } finally {
        await mock.close();
    }
});

test('an explicit worldbookIds overrides the card primary', async () => {
    const mock = await startMockModel(respondWith('在。'));

    try {
        await withLibrary(async (library) => {
            await library.importCard(JSON.stringify(cardWithWorld('eldoria')), { filename: 'linzhao' });
            await library.putWorldbook('eldoria', { entries: { 0: { uid: 0, content: '来自 eldoria', constant: true } } });
            await library.putWorldbook('other', { entries: { 0: { uid: 0, content: '来自 other', constant: true } } });

            const session = await ChatSession.create(library, {
                cardId: 'linzhao',
                personaName: 'User',
                name: 'override',
                worldbookIds: ['other'],
            });

            assert.equal(session.worldbookId, 'other');
            await session.send(configFor(mock.endpoint), '在吗');

            const system = systemOf(mock.requests[0]);
            assert.match(system, /来自 other/);
            assert.equal(system.includes('来自 eldoria'), false);
        });
    } finally {
        await mock.close();
    }
});

test('entries from two books keep separate sticky state', async () => {
    const mock = await startMockModel(respondWith('在。'));

    try {
        await withLibrary(async (library) => {
            await library.importCard(JSON.stringify(cardWithWorld('book-a')), { filename: 'linzhao' });
            // Same uid in both books: the state key must not collide.
            await library.putWorldbook('book-a', { entries: { 0: { uid: 0, key: ['森林'], content: 'A 的森林', sticky: 4 } } });
            await library.putWorldbook('book-b', { entries: { 0: { uid: 0, key: ['沙漠'], content: 'B 的沙漠' } } });

            const session = await ChatSession.create(library, {
                cardId: 'linzhao',
                personaName: 'User',
                name: 'twobooks',
                worldbookIds: ['book-a', 'book-b'],
            });

            await session.send(configFor(mock.endpoint), '森林');

            const stored = await library.getChat('linzhao', 'twobooks');
            const metadata = stored.header.chat_metadata as { story?: { worldInfo?: Record<string, unknown> } };
            const keys = Object.keys(metadata.story?.worldInfo ?? {});

            assert.deepEqual(keys, ['book-a.0']);
        });
    } finally {
        await mock.close();
    }
});
