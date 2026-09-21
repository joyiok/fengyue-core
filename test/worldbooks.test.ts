import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    newEntry,
    normalizeEntry,
    normalizeWorldbook,
    summarizeWorldbook,
    worldbookFromJson,
    worldbookToJson,
} from '../src/worldbooks/io.ts';

test('a minimal entry is filled with SillyTavern defaults', () => {
    const entry = normalizeEntry({ key: ['eldoria'], content: 'magical forest' }, 3);

    assert.deepEqual(entry.key, ['eldoria']);
    assert.equal(entry.content, 'magical forest');
    assert.equal(entry.uid, 3);
    assert.equal(entry.displayIndex, 3);
    // Defaults that matter for prompt assembly later.
    assert.equal(entry.constant, false);
    assert.equal(entry.selective, true);
    assert.equal(entry.order, 100);
    assert.equal(entry.depth, 4);
    assert.equal(entry.probability, 100);
    assert.equal(entry.useProbability, true);
    assert.equal(entry.role, null);
    assert.deepEqual(entry.keysecondary, []);
    assert.equal(entry.disable, false);
});

test('entry values of the wrong type fall back instead of leaking through', () => {
    const entry = normalizeEntry({ key: 'not-an-array', order: 'nope', constant: 'yes', depth: null }, 0);

    assert.deepEqual(entry.key, []);
    assert.equal(entry.order, 100);
    assert.equal(entry.constant, false);
    assert.equal(entry.depth, 4);
});

test('unknown fields survive a normalise round-trip', () => {
    const entry = normalizeEntry({ key: ['a'], futureField: { nested: true } }, 0);
    assert.deepEqual(entry.futureField, { nested: true });
});

test('a full world book round-trips through JSON', () => {
    const book = normalizeWorldbook({
        entries: {
            0: { uid: 0, key: ['eldoria'], content: 'forest', constant: true },
            1: { uid: 1, key: ['sword'], content: 'blade', disable: true },
        },
    });

    assert.equal(Object.keys(book.entries).length, 2);

    const reread = worldbookFromJson(worldbookToJson(book));
    assert.deepEqual(reread.entries['0']?.key, ['eldoria']);
    assert.equal(reread.entries['0']?.constant, true);
    assert.equal(reread.entries['1']?.disable, true);
});

test('newEntry takes overrides and summarising counts flags', () => {
    const entry = newEntry({ key: ['x'], constant: true, uid: 7 });
    assert.equal(entry.uid, 7);
    assert.equal(entry.constant, true);

    const book = normalizeWorldbook({
        entries: {
            0: { constant: true },
            1: { disable: true },
            2: {},
        },
    });

    const summary = summarizeWorldbook('eldoria', book, 1234);
    assert.deepEqual(summary, {
        id: 'eldoria',
        entries: 3,
        constantEntries: 1,
        disabledEntries: 1,
        bytes: 1234,
    });
});

test('normalizeWorldbook rejects non-objects and tolerates a missing entries map', () => {
    assert.throws(() => normalizeWorldbook([1, 2]), /not an object/);
    assert.deepEqual(normalizeWorldbook({ name: 'empty' }).entries, {});
});
