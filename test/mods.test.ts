/**
 * Mods: what one is, what a card allows, and where the boundary actually is.
 *
 * The point of this file is the policy matrix. A card declares what may be
 * loaded onto it and that declaration lives in the PNG, so it has to hold when
 * the card travels — and it has to hold on the server, because hiding a button
 * is not a boundary.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FAST_KDF } from '../src/auth/passwords.ts';
import { AuthService } from '../src/auth/service.ts';
import { normalizeCard, type CharacterCard } from '../src/cards/types.ts';
import { ENTRY_DEFAULTS, type WorldbookEntry } from '../src/worldbooks/types.ts';
import { Database } from '../src/db/database.ts';
import { ModError, ModsService, cardModRules } from '../src/mods/service.ts';

async function withMods(
    run: (mods: ModsService, alice: string, bob: string) => void | Promise<void>,
): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), 'story-mods-'));
    const db = new Database(path.join(dir, 'test.sqlite'));

    try {
        // Real accounts: `mods.owner_id` is a foreign key on purpose — a mod has
        // to belong to somebody the policy can be checked against.
        const auth = new AuthService(db, { kdf: FAST_KDF });
        const alice = auth.register({ handle: 'alice', password: 'a-long-enough-password' }).user.id;
        const bob = auth.register({ handle: 'bob', password: 'a-long-enough-password' }).user.id;

        await run(new ModsService(db), alice, bob);
    } finally {
        db.close();
        await rm(dir, { recursive: true, force: true });
    }
}

/** A card carrying whatever `extensions.story` rules the test is about. */
function cardWith(rules: Record<string, unknown> | null, name = '林昭'): CharacterCard {
    return normalizeCard({
        spec: 'chara_card_v2',
        data: {
            name,
            description: '书店店主。',
            ...(rules === null ? {} : { extensions: { story: rules } }),
        },
    });
}

function throwsCode(fn: () => unknown): string {
    try {
        fn();
    } catch (error) {
        assert.ok(error instanceof ModError, `expected a ModError, got ${String(error)}`);
        return error.code;
    }
    assert.fail('expected a ModError to be thrown');
    return '';
}

// ------------------------------------------------------------------ the shape

test('a dedicated mod must name the one work it belongs to', async () => {
    await withMods((mods, alice, bob) => {
        assert.equal(throwsCode(() => mods.create(alice, { name: '   ' })), 'invalid');
        assert.equal(throwsCode(() => mods.create(alice, { name: '雨夜', scope: 'dedicated' })), 'invalid');

        const dedicated = mods.create(alice, { name: '雨夜', scope: 'dedicated', boundCharacterId: 'linzhao' });
        assert.equal(dedicated.scope, 'dedicated');
        assert.equal(dedicated.boundCharacterId, 'linzhao');
        assert.equal(dedicated.visibility, 'private', 'nothing is shared as a side effect of creating it');
    });
});

test('the gallery only carries what was put there on purpose', async () => {
    await withMods((mods, alice, bob) => {
        const quiet = mods.create(alice, { name: '悄悄写的' });
        const shared = mods.create(alice, { name: '公开的' });
        const bound = mods.create(alice, { name: '专用的', scope: 'dedicated', boundCharacterId: 'linzhao' });

        assert.deepEqual(mods.gallery({ ownerId: alice }).map((mod) => mod.name), []);

        mods.setVisibility(quiet.id, alice, 'public');
        mods.setVisibility(shared.id, alice, 'public');
        mods.setVisibility(bound.id, alice, 'public');

        // A shared mod goes anywhere; a dedicated one only inside its own work.
        assert.deepEqual(mods.gallery({ ownerId: bob }).map((mod) => mod.name), ['公开的', '悄悄写的']);
        assert.deepEqual(
            mods.gallery({ ownerId: 'b', characterId: 'linzhao' }).map((mod) => mod.name).sort(),
            ['专用的', '公开的', '悄悄写的'],
        );
        assert.deepEqual(
            mods.gallery({ ownerId: 'b', characterId: 'someone-else' }).map((mod) => mod.name).sort(),
            ['公开的', '悄悄写的'],
        );

        // Only the owner may edit or withdraw their own mod.
        assert.equal(throwsCode(() => mods.setVisibility(shared.id, bob, 'private')), 'forbidden');
        assert.equal(throwsCode(() => mods.remove(shared.id, bob)), 'forbidden');
    });
});

// ------------------------------------------------------------ the four tiers

test('a card decides what may be loaded onto it, and the default is the middle', () => {
    assert.equal(cardModRules(cardWith(null), 'fallback').policy, 'own-dedicated');
    assert.equal(cardModRules(cardWith({ mods: { policy: 'nonsense' } }), 'fallback').policy, 'own-dedicated');
    assert.equal(cardModRules(cardWith({ mods: { policy: 'all' } }), 'fallback').policy, 'all');
    assert.equal(cardModRules(cardWith(null), 'fallback').style, 'forbid', 'embedded CSS is off unless allowed');
    assert.equal(cardModRules(cardWith({ mods: { style: 'allow' } }), 'fallback').style, 'allow');

    // The author travels with the card, so the rules still mean something on
    // another install. Without it, the copy's owner is the author.
    assert.equal(cardModRules(cardWith({ authorId: 'original' }), 'fallback').authorId, 'original');
    assert.equal(cardModRules(cardWith(null), 'fallback').authorId, 'fallback');
});

test('none, own, own-dedicated and all are four different things', async () => {
    await withMods((mods, alice, bob) => {
        // `a` wrote the card and its mod; `b` is a stranger with both kinds.
        const mine = mods.create(alice, { name: '我的场景' });
        const theirs = mods.create(bob, { name: '别人的场景' });
        const mineDedicated = mods.create(alice, { name: '我的支线', scope: 'dedicated', boundCharacterId: 'linzhao' });
        const theirsDedicated = mods.create(bob, { name: '别人的支线', scope: 'dedicated', boundCharacterId: 'linzhao' });

        const none = cardWith({ mods: { policy: 'none' } });
        const own = cardWith({ mods: { policy: 'own' } });
        const middle = cardWith({ mods: { policy: 'own-dedicated' } });
        const all = cardWith({ mods: { policy: 'all' } });
        const ids = [mine.id, theirs.id, mineDedicated.id, theirsDedicated.id];

        // `none`: the card is just itself.
        assert.equal(throwsCode(() => mods.resolve(none, 'linzhao', [mine.id], alice)), 'policy');

        // `own`: only mods written by whoever wrote the card.
        assert.equal(mods.resolve(own, 'linzhao', [mine.id, mineDedicated.id], alice).length, 2);
        assert.equal(throwsCode(() => mods.resolve(own, 'linzhao', [theirs.id], alice)), 'policy');
        assert.equal(throwsCode(() => mods.resolve(own, 'linzhao', [theirsDedicated.id], alice)), 'policy');

        // The middle (and the default): shared mods are the point of the
        // platform, but a *dedicated* mod is somebody rewriting your character.
        assert.equal(mods.resolve(middle, 'linzhao', [mine.id, theirs.id], alice).length, 2);
        assert.equal(mods.resolve(middle, 'linzhao', [mineDedicated.id], alice).length, 1);
        assert.equal(throwsCode(() => mods.resolve(middle, 'linzhao', [theirsDedicated.id], alice)), 'policy');

        // `all`: anything goes.
        assert.equal(mods.resolve(all, 'linzhao', ids, alice).length, 4);

        assert.equal(throwsCode(() => mods.resolve(all, 'linzhao', ['missing'], alice)), 'not_found');
    });
});

test('a dedicated mod is only selectable inside its own work', async () => {
    await withMods((mods, alice, bob) => {
        const bound = mods.create(alice, { name: '林昭的支线', scope: 'dedicated', boundCharacterId: 'linzhao' });
        const open = cardWith({ mods: { policy: 'all' } });

        assert.equal(mods.resolve(open, 'linzhao', [bound.id], alice).length, 1);
        assert.equal(throwsCode(() => mods.resolve(cardWith({ mods: { policy: 'all' } }, '别人'), '别人', [bound.id], alice)), 'policy');
    });
});

// -------------------------------------------------------- what the payload is

test('the payloads land in the right places, and the memory preset is explicit', async () => {
    await withMods((mods, alice, bob) => {
        const loaded = mods.create(alice, {
            name: '雨夜',
            systemPrompt: '外面在下雨。',
            postHistory: '不要写旁白。',
            worldbook: { 0: { ...ENTRY_DEFAULTS, uid: 0, displayIndex: 0, key: ['雨'], content: '雨声。' } satisfies WorldbookEntry },
            style: 'body { background: black; }',
            memory: { messageThreshold: 20, keepRecent: 6 },
        });

        const state = mods.sessionState(cardWith(null), 'linzhao', [loaded.id], alice);

        assert.deepEqual(state.payloads, [{ name: '雨夜', system: '外面在下雨。', postHistory: '不要写旁白。' }]);
        assert.deepEqual(Object.keys(state.entries), [`${loaded.id}.0`], 'entries are namespaced so two mods cannot collide');
        assert.equal(state.entries[`${loaded.id}.0`]?.world, '雨夜');

        // The memory preset is policy, and it always says so: turning it on
        // means this session starts paying for summarization passes.
        assert.equal(state.memory.enabled, true);
        assert.equal(state.memory.messageThreshold, 20);
        assert.equal(state.memory.keepRecent, 6);

        // Most cards forbid embedded CSS, so it is dropped rather than loaded.
        assert.equal(state.style, '');

        // The card has to allow it before the stylesheet is kept at all.
        const allowing = mods.sessionState(cardWith({ mods: { style: 'allow' } }), 'linzhao', [loaded.id], alice);
        assert.equal(allowing.style, 'body { background: black; }');

        // And a mod that costs nothing carries nothing that costs.
        const free = mods.create(alice, { name: '免费的', systemPrompt: 'x' });
        assert.deepEqual(mods.sessionState(cardWith(null), 'linzhao', [free.id], alice).memory, {});
    });
});

test('the last memory preset loaded wins, and loading is counted', async () => {
    await withMods((mods, alice, bob) => {
        const first = mods.create(alice, { name: '一', memory: { keepRecent: 4, maxSummaryTokens: 100 } });
        const second = mods.create(alice, { name: '二', memory: { keepRecent: 9 } });

        const state = mods.sessionState(cardWith(null), 'linzhao', [first.id, second.id], alice);
        assert.equal(state.memory.keepRecent, 9, 'later loads override earlier ones');
        assert.equal(state.memory.maxSummaryTokens, 100, 'and merge rather than replace');

        assert.equal(mods.get(first.id)?.uses, 0, 'a load is only counted when it happens');
        mods.countLoad([first.id, second.id]);
        assert.equal(mods.get(first.id)?.uses, 1);
        assert.equal(mods.get(second.id)?.uses, 1);
    });
});
