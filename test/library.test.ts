import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { cardToPng } from '../src/cards/io.ts';
import { normalizeCard } from '../src/cards/types.ts';
import { defaultHeader } from '../src/chats/types.ts';
import { Library, assertSafeId, safeJoin, sanitizeFileName } from '../src/library.ts';
import { createSolidPng, decodePng, findTextChunk, isPng } from '../src/png/chunks.ts';

async function withLibrary(run: (library: Library) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), 'story-test-'));
    try {
        const library = new Library(dir);
        await library.ensureDirs();
        await run(library);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

const demoCard = normalizeCard({
    spec: 'chara_card_v2',
    data: { name: '林昭', description: '书店店主', first_mes: '来了。', tags: ['演示'] },
});

test('importing a JSON card creates a PNG that lists and reads back', async () => {
    await withLibrary(async (library) => {
        const result = await library.importCard(JSON.stringify(demoCard));

        assert.equal(result.id, '林昭');
        assert.equal(result.fileName, '林昭.png');

        const files = await readdir(library.charactersDir);
        assert.deepEqual(files, ['林昭.png']);

        const list = await library.listCharacters();
        assert.equal(list.length, 1);
        assert.equal(list[0]?.ok, true);
        assert.equal(list[0]?.ok === true ? list[0].name : null, '林昭');

        const card = await library.getCard('林昭');
        assert.equal(card.data.description, '书店店主');
    });
});

test('importing a PNG keeps the original avatar', async () => {
    await withLibrary(async (library) => {
        const avatar = createSolidPng(96, 144, [3, 4, 5]);
        const png = cardToPng(demoCard, avatar);

        const result = await library.importCard(png, { filename: 'custom-name.png' });
        assert.equal(result.id, 'custom-name');

        const stored = await library.readCardPng('custom-name');
        const ihdr = decodePng(stored).find((chunk) => chunk.name === 'IHDR');
        assert.equal(ihdr?.data.readUInt32BE(0), 96);
        assert.equal(ihdr?.data.readUInt32BE(4), 144);
    });
});

test('a name collision gets a numeric suffix instead of overwriting', async () => {
    await withLibrary(async (library) => {
        const first = await library.importCard(JSON.stringify(demoCard));
        const second = await library.importCard(JSON.stringify(demoCard));
        const third = await library.importCard(JSON.stringify(demoCard));

        assert.equal(first.id, '林昭');
        assert.equal(second.id, '林昭-2');
        assert.equal(third.id, '林昭-3');
        assert.equal((await library.listCharacters()).length, 3);
    });
});

test('exported cards carry both the chara and ccv3 chunks', async () => {
    await withLibrary(async (library) => {
        await library.importCard(JSON.stringify(demoCard));

        const exported = await library.exportCardPng('林昭');
        assert.ok(isPng(exported));

        const chunks = decodePng(exported);
        assert.ok(findTextChunk(chunks, 'chara'));
        assert.ok(findTextChunk(chunks, 'ccv3'));
    });
});

test('a corrupt card is reported without breaking the listing', async () => {
    await withLibrary(async (library) => {
        await library.importCard(JSON.stringify(demoCard));
        await writeFile(path.join(library.charactersDir, 'broken.png'), 'this is not a png');

        const list = await library.listCharacters();
        assert.equal(list.length, 2);

        const broken = list.find((entry) => entry.id === 'broken');
        assert.equal(broken?.ok, false);
        assert.match(broken?.ok === false ? broken.error : '', /bad signature/);
    });
});

test('ids that could escape the library are rejected', async () => {
    assert.throws(() => assertSafeId('../evil'), /unsafe id/);
    assert.throws(() => assertSafeId('a/b'), /unsafe id/);
    assert.throws(() => assertSafeId(''), /unsafe id/);
    assert.equal(assertSafeId('林昭-2'), '林昭-2');

    assert.throws(() => safeJoin('/tmp/root', '..', 'evil'), /escapes the library root/);
    assert.equal(safeJoin('/tmp/root', 'characters', 'a.png'), '/tmp/root/characters/a.png');

    await withLibrary(async (library) => {
        await assert.rejects(library.getCard('../outside'), /unsafe id/);
    });
});

test('file names are sanitised but keep CJK', () => {
    assert.equal(sanitizeFileName('林昭'), '林昭');
    assert.equal(sanitizeFileName('a/b\\c:d'), 'a_b_c_d');
    assert.equal(sanitizeFileName('   '), 'character');
    assert.equal(sanitizeFileName('../../etc/passwd'), '.._.._etc_passwd'.replace(/^\.+/, ''));
});

test('world books can be written, listed and read back', async () => {
    await withLibrary(async (library) => {
        await library.putWorldbook('eldoria', {
            entries: {
                0: { key: ['eldoria'], content: 'forest', constant: true },
            },
        });

        const list = await library.listWorldbooks();
        assert.equal(list.length, 1);
        assert.equal(list[0]?.id, 'eldoria');
        assert.equal(list[0]?.entries, 1);
        assert.equal(list[0]?.constantEntries, 1);

        const book = await library.getWorldbook('eldoria');
        assert.equal(book.entries['0']?.content, 'forest');
        // Defaults are applied on read, so the entry is complete.
        assert.equal(book.entries['0']?.depth, 4);
    });
});

test('chats can be written, listed and read back', async () => {
    await withLibrary(async (library) => {
        await library.putChat('林昭', 'session-1', {
            header: defaultHeader({ character_name: '林昭' }),
            messages: [
                { name: '林昭', is_user: false, send_date: '2026-09-21T10:00:00.000Z', mes: '来了。' },
                { name: 'User', is_user: true, send_date: '2026-09-21T10:00:05.000Z', mes: '在吗' },
            ],
        });

        assert.deepEqual(await library.listChatCharacters(), ['林昭']);

        const chats = await library.listChats('林昭');
        assert.equal(chats.length, 1);
        assert.equal(chats[0]?.messages, 2);

        const chat = await library.getChat('林昭', 'session-1');
        assert.equal(chat.messages[1]?.mes, '在吗');
    });
});
