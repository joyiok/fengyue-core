import assert from 'node:assert/strict';
import { test } from 'node:test';

import { crc32 } from '../src/png/crc32.ts';
import {
    createSolidPng,
    decodeImageData,
    decodePng,
    decodeTextChunk,
    encodeTextChunk,
    findTextChunk,
    isPng,
    removeTextChunk,
    upsertTextChunk,
} from '../src/png/chunks.ts';

test('crc32 matches the well-known IEND checksum', () => {
    // The IEND chunk of every PNG ends with this CRC; it is a free known vector.
    assert.equal(crc32(Buffer.from('IEND', 'latin1')), 0xae426082);
});

test('createSolidPng produces a decodable PNG with the requested pixels', () => {
    const png = createSolidPng(4, 2, [10, 20, 30]);

    assert.ok(isPng(png));

    const chunks = decodePng(png);
    assert.deepEqual(chunks.map((chunk) => chunk.name), ['IHDR', 'IDAT', 'IEND']);

    const raw = decodeImageData(chunks);
    // 4 pixels * 3 bytes + 1 filter byte per row, 2 rows.
    assert.equal(raw.length, (4 * 3 + 1) * 2);
    assert.equal(raw[0], 0);
    assert.deepEqual([...raw.subarray(1, 4)], [10, 20, 30]);
});

test('tEXt chunks round-trip and are replaced, not duplicated', () => {
    let chunks = decodePng(createSolidPng(2, 2, [0, 0, 0]));

    chunks = upsertTextChunk(chunks, 'chara', 'first');
    assert.equal(findTextChunk(chunks, 'chara'), 'first');

    chunks = upsertTextChunk(chunks, 'chara', 'second');
    assert.equal(findTextChunk(chunks, 'chara'), 'second');
    assert.equal(chunks.filter((chunk) => chunk.name === 'tEXt').length, 1);

    // The keyword lookup is case-insensitive, matching SillyTavern.
    assert.equal(findTextChunk(chunks, 'CHARA'), 'second');

    chunks = upsertTextChunk(chunks, 'ccv3', 'third');
    assert.equal(chunks.filter((chunk) => chunk.name === 'tEXt').length, 2);

    // The new chunk sits before IEND, which the format requires.
    assert.equal(chunks[chunks.length - 1]?.name, 'IEND');

    chunks = removeTextChunk(chunks, 'chara');
    assert.equal(findTextChunk(chunks, 'chara'), null);
    assert.equal(findTextChunk(chunks, 'ccv3'), 'third');
});

test('tEXt payloads use the keyword\\0text layout', () => {
    const payload = encodeTextChunk('chara', 'YWJj');
    assert.deepEqual([...payload], [...Buffer.from('chara\0YWJj', 'latin1')]);
    assert.deepEqual(decodeTextChunk(payload), { keyword: 'chara', text: 'YWJj' });
    assert.throws(() => decodeTextChunk(Buffer.from('noseparator', 'latin1')), /no keyword separator/);
});

test('decodePng rejects non-PNG input and corrupt chunks', () => {
    assert.throws(() => decodePng(Buffer.from('definitely not a png')), /bad signature/);

    const png = createSolidPng(2, 2, [1, 2, 3]);
    const corrupted = Buffer.from(png);
    // Flip a byte inside the IHDR payload: the CRC check must notice.
    corrupted[20] = corrupted[20]! ^ 0xff;

    assert.throws(() => decodePng(corrupted), /failed its CRC check/);
});
