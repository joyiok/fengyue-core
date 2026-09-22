/**
 * What a reader does not want to see.
 *
 * Per user and not global: this is taste, not policy. Two kinds, applied in two
 * places — tags filter listings, words mask a reply once the model has spoken.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FAST_KDF } from '../src/auth/passwords.ts';
import { AuthService } from '../src/auth/service.ts';
import { BlockError, BlocksService } from '../src/blocks/service.ts';
import { Database } from '../src/db/database.ts';

async function withBlocks(run: (blocks: BlocksService, user: string) => void | Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), 'story-blocks-'));
    const db = new Database(path.join(dir, 'test.sqlite'));

    try {
        const auth = new AuthService(db, { kdf: FAST_KDF });
        const user = auth.register({ handle: 'reader', password: 'a-long-enough-password' }).user.id;
        await run(new BlocksService(db), user);
    } finally {
        db.close();
        await rm(dir, { recursive: true, force: true });
    }
}

test('blocking the same thing twice is one block', async () => {
    await withBlocks((blocks, user) => {
        assert.throws(() => blocks.add(user, 'tag', '   '), /cannot be empty/);

        blocks.add(user, 'tag', 'NTR');
        blocks.add(user, 'tag', 'ntr');
        blocks.add(user, 'word', '血');
        blocks.add(user, 'word', '暴力');

        // Case-insensitive and unique: a block is a set, not a list of grudges.
        assert.deepEqual(blocks.list(user), { tags: ['ntr'], words: ['暴力', '血'] });

        blocks.remove(user, 'tag', 'NTR');
        assert.deepEqual(blocks.list(user).tags, []);
    });
});

test('a tag filter matches whole tags and never a substring', () => {
    const blocked = ['cat'];

    assert.equal(BlocksService.isBlocked(['cat'], blocked), true);
    assert.equal(BlocksService.isBlocked(['CAT'], blocked), true);
    assert.equal(BlocksService.isBlocked(['category'], blocked), false, 'a tag filter is not a search');
    assert.equal(BlocksService.isBlocked(['anything'], []), false, 'nobody blocked anything');
});

test('a blocked word is masked, not refused, and user input is never a pattern', () => {
    const reply = '外面在下血，很血。Blood everywhere.';
    const { text, masked } = BlocksService.mask(reply, ['血', 'blood']);

    assert.equal(masked, 3);
    assert.equal(text.includes('血'), false);
    assert.equal(text.toLowerCase().includes('blood'), false);
    assert.equal(text.includes('▮▮'), true);

    // A blocked "word" is user data. If it were turned into a regex this would
    // be the injection instead of the defence.
    const tricky = BlocksService.mask('aaaa', ['a+']);
    assert.equal(tricky.masked, 0, 'a pattern character is a literal');
    assert.equal(tricky.text, 'aaaa');

    assert.deepEqual(BlocksService.mask('原样', []), { text: '原样', masked: 0 });
});
