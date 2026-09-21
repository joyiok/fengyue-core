import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cardFromJson, cardFromPng, cardToJson, cardToPng, summarizeCard } from '../src/cards/io.ts';
import { isV1Card, normalizeCard, toV2Json } from '../src/cards/types.ts';
import { decodePng, findTextChunk, upsertTextChunk, encodePng, createSolidPng } from '../src/png/chunks.ts';

const v2Card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
        name: '林昭',
        description: '书店店主',
        personality: '话少',
        first_mes: '来了。',
        tags: ['演示'],
        alternate_greetings: ['另一个开场'],
    },
};

test('a flat V1 card is detected and wrapped into V2', () => {
    const v1 = { name: 'Old Card', description: 'from 2023', first_mes: 'hi' };

    assert.equal(isV1Card(v1), true);
    assert.equal(isV1Card(v2Card), false);

    const card = normalizeCard(v1);
    assert.equal(card.spec, 'chara_card_v2');
    assert.equal(card.data.name, 'Old Card');
    assert.equal(card.data.description, 'from 2023');
    assert.deepEqual(card.data.tags, []);
    assert.deepEqual(card.data.extensions, {});
});

test('normalizeCard fills missing fields so consumers need no defaults', () => {
    const card = normalizeCard({ spec: 'chara_card_v2', data: { name: 'Bare' } });

    assert.equal(card.data.description, '');
    assert.equal(card.data.first_mes, '');
    assert.deepEqual(card.data.alternate_greetings, []);
    assert.equal(card.data.character_version, '1.0');
});

test('normalizeCard rejects things that cannot be a card', () => {
    assert.throws(() => normalizeCard(null), /not an object/);
    assert.throws(() => normalizeCard([1, 2, 3]), /not an object/);
    assert.throws(() => normalizeCard({ unrelated: true }), /neither a spec\/data wrapper nor V1 fields/);
});

test('card survives a PNG round-trip and writes both chunks', () => {
    const card = normalizeCard(v2Card);
    const png = cardToPng(card);
    const chunks = decodePng(png);

    // Both chunks are present: `chara` for V2 readers, `ccv3` for V3 readers.
    const chara = findTextChunk(chunks, 'chara');
    const ccv3 = findTextChunk(chunks, 'ccv3');
    assert.ok(chara, 'chara chunk missing');
    assert.ok(ccv3, 'ccv3 chunk missing');

    assert.equal(JSON.parse(Buffer.from(chara, 'base64').toString('utf8')).spec, 'chara_card_v2');
    assert.equal(JSON.parse(Buffer.from(ccv3, 'base64').toString('utf8')).spec, 'chara_card_v3');

    const reread = cardFromPng(png);
    assert.deepEqual(reread.data, card.data);
    // V3 takes precedence on read, so the spec reports V3.
    assert.equal(reread.spec, 'chara_card_v3');
});

test('V3 wins when both chunks exist, and a card-less PNG is rejected', () => {
    let chunks = decodePng(createSolidPng(2, 2, [0, 0, 0]));
    chunks = upsertTextChunk(chunks, 'chara', Buffer.from(toV2Json(normalizeCard({ name: 'FromChara' }))).toString('base64'));
    chunks = upsertTextChunk(chunks, 'ccv3', Buffer.from(JSON.stringify({
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: { name: 'FromCcv3' },
    })).toString('base64'));

    assert.equal(cardFromPng(encodePng(chunks)).data.name, 'FromCcv3');

    assert.throws(() => cardFromPng(createSolidPng(2, 2, [0, 0, 0])), /no character data/);
});

test('an existing avatar image is preserved on write', () => {
    const avatar = createSolidPng(96, 144, [7, 8, 9]);
    const png = cardToPng(normalizeCard(v2Card), avatar);

    const ihdr = decodePng(png).find((chunk) => chunk.name === 'IHDR');
    assert.ok(ihdr);
    assert.equal(ihdr.data.readUInt32BE(0), 96);
    assert.equal(ihdr.data.readUInt32BE(4), 144);
    assert.equal(cardFromPng(png).data.name, '林昭');
});

test('JSON in, JSON out, and summaries report what the UI needs', () => {
    const card = cardFromJson(JSON.stringify(v2Card));
    assert.equal(card.data.name, '林昭');
    assert.equal(JSON.parse(cardToJson(card)).data.name, '林昭');

    const summary = summarizeCard('linzhao', card, cardToPng(card));
    assert.equal(summary.id, 'linzhao');
    assert.equal(summary.name, '林昭');
    assert.deepEqual(summary.tags, ['演示']);
    assert.equal(summary.descriptionLength, 4);
    assert.equal(summary.hasV3Chunk, true);
});
