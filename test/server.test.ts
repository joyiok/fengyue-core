import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { cardFromPng } from '../src/cards/io.ts';
import { normalizeCard } from '../src/cards/types.ts';
import { Library } from '../src/library.ts';
import { createServer } from '../src/server.ts';
import { isPng } from '../src/png/chunks.ts';

const demoCard = normalizeCard({
    spec: 'chara_card_v2',
    data: { name: '林昭', description: '书店店主', first_mes: '来了。' },
});

async function withServer(run: (base: string, library: Library) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), 'story-server-'));
    const library = new Library(dir);
    await library.ensureDirs();

    const server = createServer(library);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
        await run(`http://127.0.0.1:${port}`, library);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(dir, { recursive: true, force: true });
    }
}

test('health reports the library root', async () => {
    await withServer(async (base, library) => {
        const response = await fetch(`${base}/health`);
        assert.equal(response.status, 200);

        const body = await response.json() as { ok: boolean; root: string };
        assert.equal(body.ok, true);
        assert.equal(body.root, library.root);
    });
});

test('a card can be POSTed, listed, fetched and exported over HTTP', async () => {
    await withServer(async (base) => {
        const created = await fetch(`${base}/api/v1/characters`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-filename': 'linzhao' },
            body: JSON.stringify(demoCard),
        });
        assert.equal(created.status, 201);

        const listed = await (await fetch(`${base}/api/v1/characters`)).json() as { characters: { id: string }[] };
        assert.deepEqual(listed.characters.map((entry) => entry.id), ['linzhao']);

        const fetched = await (await fetch(`${base}/api/v1/characters/linzhao`)).json() as { card: { data: { name: string } } };
        assert.equal(fetched.card.data.name, '林昭');

        // The exported PNG must be a real card file, not just bytes.
        const pngResponse = await fetch(`${base}/api/v1/characters/linzhao/card.png`);
        assert.equal(pngResponse.headers.get('content-type'), 'image/png');

        const png = Buffer.from(await pngResponse.arrayBuffer());
        assert.ok(isPng(png));
        assert.equal(cardFromPng(png).data.name, '林昭');
    });
});

test('unknown routes and unsafe ids are refused', async () => {
    await withServer(async (base) => {
        assert.equal((await fetch(`${base}/nope`)).status, 404);
        assert.equal((await fetch(`${base}/api/v1/characters/does-not-exist`)).status, 404);

        const traversal = await fetch(`${base}/api/v1/characters/${encodeURIComponent('../evil')}`);
        assert.equal(traversal.status, 400);
    });
});

test('missing HTTP methods fall through to 404 rather than crashing', async () => {
    await withServer(async (base) => {
        assert.equal((await fetch(`${base}/api/v1/characters`, { method: 'DELETE' })).status, 404);
        assert.equal((await fetch(`${base}/api/v1/worldbooks/x`, { method: 'POST', body: '{}' })).status, 404);
    });
});
