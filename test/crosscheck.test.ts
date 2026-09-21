/**
 * Cross-check against a real SillyTavern library. Opt-in, because the fixtures
 * are somebody else's files and must not be committed here:
 *
 *   SILLYTAVERN_LIBRARY=../../story-tavern/data/default-user npm test
 *
 * This proves the two directions that matter for M0:
 *   - we can read what SillyTavern wrote;
 *   - what we write keeps the same data.
 *
 * The remaining direction — SillyTavern reading a file this project wrote — needs
 * the SillyTavern runtime, so it lives in scripts/verify-with-sillytavern.sh.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { cardFromPng } from '../src/cards/io.ts';
import { Library } from '../src/library.ts';
import { decodePng, findTextChunk } from '../src/png/chunks.ts';

const libraryRoot = process.env.SILLYTAVERN_LIBRARY;

test('reads real SillyTavern cards, world books and chats', { skip: libraryRoot ? false : 'SILLYTAVERN_LIBRARY is not set' }, async () => {
    const library = new Library(libraryRoot as string);

    const characters = await library.listCharacters();
    assert.ok(characters.length > 0, 'expected at least one character card');

    const readable = characters.filter((entry) => entry.ok);
    assert.equal(readable.length, characters.length, 'every card in the library should parse');

    for (const entry of readable) {
        assert.ok(entry.name.length > 0, `card ${entry.id} has no name`);
    }

    // SillyTavern writes both chunks, so its own cards must show V3.
    assert.ok(
        readable.some((entry) => entry.hasV3Chunk),
        'expected at least one card written by SillyTavern to carry a ccv3 chunk',
    );

    // A card written by another tool may only carry the V2 `chara` chunk; that
    // must read just as well. Real libraries contain both shapes.
    const v2Only = readable.filter((entry) => !entry.hasV3Chunk);
    for (const entry of v2Only) {
        const v2Card = await library.getCard(entry.id);
        assert.equal(v2Card.data.name, entry.name);
    }

    const first = readable[0];
    assert.ok(first);

    const png = await library.readCardPng(first.id);
    const chunks = decodePng(png);
    assert.ok(findTextChunk(chunks, 'chara'), 'real card should have a chara chunk');
    assert.ok(findTextChunk(chunks, 'ccv3'), 'real card should have a ccv3 chunk');

    const card = await library.getCard(first.id);
    assert.equal(card.data.name, first.name);

    const worldbooks = await library.listWorldbooks();
    for (const summary of worldbooks) {
        const book = await library.getWorldbook(summary.id);
        assert.equal(Object.keys(book.entries).length, summary.entries);

        for (const entry of Object.values(book.entries)) {
            // Every entry read from a real book must come back complete.
            assert.ok(Array.isArray(entry.key));
            assert.equal(typeof entry.content, 'string');
            assert.equal(typeof entry.depth, 'number');
            assert.equal(typeof entry.useProbability, 'boolean');
        }
    }

    for (const character of await library.listChatCharacters()) {
        for (const chat of await library.listChats(character)) {
            const parsed = await library.getChat(character, chat.name);
            assert.equal(parsed.messages.length, chat.messages);
            for (const message of parsed.messages) {
                assert.equal(typeof message.mes, 'string');
                assert.equal(typeof message.is_user, 'boolean');
            }
        }
    }
});

test('re-exporting a real card preserves its data', { skip: libraryRoot ? false : 'SILLYTAVERN_LIBRARY is not set' }, async () => {
    const source = new Library(libraryRoot as string);
    const characters = (await source.listCharacters()).filter((entry) => entry.ok);
    const first = characters[0];
    assert.ok(first, 'expected at least one character card');

    const original = await source.getCard(first.id);
    const exported = await source.exportCardPng(first.id);

    // Fresh library: the exported PNG must import cleanly and keep every field.
    const dir = await mkdtemp(path.join(tmpdir(), 'story-crosscheck-'));
    try {
        const target = new Library(dir);
        await target.ensureDirs();
        const imported = await target.importCard(exported, { filename: first.id });
        const reloaded = await target.getCard(imported.id);

        assert.deepEqual(reloaded.data, original.data);
        assert.equal(reloaded.data.name, original.data.name);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }

    // And the bytes are still a card PNG with both chunks.
    const chunks = decodePng(exported);
    assert.ok(findTextChunk(chunks, 'chara'));
    assert.ok(findTextChunk(chunks, 'ccv3'));
    assert.equal(cardFromPng(exported).data.name, original.data.name);
});
