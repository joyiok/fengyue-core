import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeCard } from '../src/cards/types.ts';
import type { ChatMessage } from '../src/chats/types.ts';
import { assemblePrompt } from '../src/prompt/assemble.ts';
import {
    DEFAULT_INSERTION_DEPTH,
    LOGIC,
    POSITION,
    ROLE,
    keyMatches,
    scanWorldInfo,
    type WorldInfoConfig,
    type WorldInfoState,
} from '../src/prompt/worldinfo.ts';
import { newEntry } from '../src/worldbooks/io.ts';
import type { Worldbook, WorldbookEntry } from '../src/worldbooks/types.ts';

function book(entries: Partial<WorldbookEntry>[]): Worldbook {
    const map: Record<string, WorldbookEntry> = {};
    entries.forEach((entry, index) => {
        map[String(index)] = newEntry({ uid: index, world: 'test', ...entry });
    });

    return { id: 'test', entries: map };
}

function message(mes: string, isUser: boolean): ChatMessage {
    return { name: isUser ? 'User' : '林昭', is_user: isUser, send_date: '2026-09-21T10:00:00.000Z', mes };
}

function scan(
    worldbook: Worldbook,
    history: ChatMessage[],
    userMessage: string,
    config: WorldInfoConfig = {},
    state: WorldInfoState = {},
): ReturnType<typeof scanWorldInfo> {
    return scanWorldInfo({ worldbook, history, userMessage, messageIndex: history.length, state, config });
}

const card = normalizeCard({
    spec: 'chara_card_v2',
    data: {
        name: '林昭',
        description: '书店店主',
        personality: '话少',
        scenario: '深夜的书房',
        first_mes: '来了。',
    },
});

// ---------------------------------------------------------------- matching

test('keys match case-insensitively by default and respect caseSensitive', () => {
    assert.equal(keyMatches('Eldoria', 'she walked into eldoria', { caseSensitive: false, matchWholeWords: false }), true);
    assert.equal(keyMatches('Eldoria', 'she walked into eldoria', { caseSensitive: true, matchWholeWords: false }), false);
    assert.equal(keyMatches('Eldoria', 'she walked into Eldoria', { caseSensitive: true, matchWholeWords: false }), true);
});

test('matchWholeWords does not fire on substrings', () => {
    assert.equal(keyMatches('cat', 'category theory', { caseSensitive: false, matchWholeWords: true }), false);
    assert.equal(keyMatches('cat', 'the cat sat', { caseSensitive: false, matchWholeWords: true }), true);
    // CJK has no word boundaries; the boundary check must still work on latin text around it.
    assert.equal(keyMatches('书店', '她回到书店里', { caseSensitive: false, matchWholeWords: true }), true);
});

test('a /regex/flags key is treated as a pattern, and a broken one is ignored', () => {
    assert.equal(keyMatches('/el(d|th)oria/i', 'ELDORIA', { caseSensitive: false, matchWholeWords: false }), true);
    assert.equal(keyMatches('/^abc/', 'xabc', { caseSensitive: false, matchWholeWords: false }), false);
    // Invalid regex in a card must not throw.
    assert.equal(keyMatches('/(unclosed/', 'anything', { caseSensitive: false, matchWholeWords: false }), false);
});

// --------------------------------------------------------------- activation

test('constant entries fire with no keyword, keyed entries need one', () => {
    const result = scan(
        book([
            { key: [], content: '常驻设定', constant: true },
            { key: ['eldoria'], content: '森林设定' },
        ]),
        [message('你好', true)],
        '今天天气不错',
    );

    assert.equal(result.activated.length, 1);
    assert.equal(result.activated[0]?.reason, 'constant');
    assert.equal(result.activated[0]?.content, '常驻设定');
    assert.equal(result.skippedByKeyLogic, 1);
});

test('keys are matched against the scan window and the new user message', () => {
    const worldbook = book([{ key: ['eldoria'], content: '森林' }]);

    assert.equal(scan(worldbook, [message('我们去 eldoria 吧', true)], '出发').activated.length, 1);
    // The new message counts too: world info must react to what you just said.
    assert.equal(scan(worldbook, [message('早上好', true)], 'eldoria 在哪').activated.length, 1);
    // Outside the default window of 2 messages it does not fire.
    const long = [message('eldoria', true), message('a', false), message('b', true), message('c', false)];
    assert.equal(scan(worldbook, long, '无关的话').activated.length, 0);
    assert.equal(scan(worldbook, long, '无关的话', { scanDepth: 5 }).activated.length, 1);
});

test('an entry can override the scan depth for itself', () => {
    const worldbook = book([{ key: ['eldoria'], content: '森林', scanDepth: 10 }]);
    const long = [message('eldoria', true), message('a', false), message('b', true), message('c', false)];

    assert.equal(scan(worldbook, long, '无关').activated.length, 1);
});

test('selective entries honour all four secondary logics', () => {
    const make = (logic: number): Worldbook => book([
        { key: ['森林'], keysecondary: ['夜晚', '雨'], selective: true, selectiveLogic: logic, content: 'x' },
    ]);

    const text = '森林';

    // AND_ANY: any secondary matches
    assert.equal(scan(make(LOGIC.AND_ANY), [message('森林 夜晚', true)], '嗯').activated.length, 1);
    assert.equal(scan(make(LOGIC.AND_ANY), [message(text, true)], '嗯').activated.length, 0);
    // AND_ALL: every secondary must match
    assert.equal(scan(make(LOGIC.AND_ALL), [message('森林 夜晚 雨', true)], '嗯').activated.length, 1);
    assert.equal(scan(make(LOGIC.AND_ALL), [message('森林 夜晚', true)], '嗯').activated.length, 0);
    // NOT_ANY: no secondary may match
    assert.equal(scan(make(LOGIC.NOT_ANY), [message('森林', true)], '嗯').activated.length, 1);
    assert.equal(scan(make(LOGIC.NOT_ANY), [message('森林 雨', true)], '嗯').activated.length, 0);
    // NOT_ALL: not every secondary matches
    assert.equal(scan(make(LOGIC.NOT_ALL), [message('森林 夜晚', true)], '嗯').activated.length, 1);
    assert.equal(scan(make(LOGIC.NOT_ALL), [message('森林 夜晚 雨', true)], '嗯').activated.length, 0);
});

test('disabled entries never fire', () => {
    const result = scan(book([{ key: ['森林'], content: 'x', disable: true }]), [message('森林', true)], '嗯');
    assert.equal(result.activated.length, 0);
    assert.equal(result.skippedByDisabled, 1);
});

test('delay holds an entry back until the conversation is long enough', () => {
    const worldbook = book([{ key: ['森林'], content: 'x', delay: 5 }]);

    const short = [message('森林', true)];
    assert.equal(scan(worldbook, short, '嗯').activated.length, 0);
    assert.equal(scan(worldbook, short, '嗯').skippedByDelay, 1);

    const long = Array.from({ length: 5 }, (_, index) => message('森林', index % 2 === 0));
    assert.equal(scan(worldbook, long, '嗯').activated.length, 1);
});

test('probability uses the injected random source', () => {
    const worldbook = book([{ key: ['森林'], content: 'x', useProbability: true, probability: 50 }]);

    assert.equal(scan(worldbook, [message('森林', true)], '嗯', { random: () => 0.1 }).activated.length, 1);
    assert.equal(scan(worldbook, [message('森林', true)], '嗯', { random: () => 0.9 }).activated.length, 0);
    assert.equal(scan(worldbook, [message('森林', true)], '嗯', { random: () => 0.9 }).skippedByProbability, 1);

    // probability 100 always fires, and useProbability false ignores the roll
    assert.equal(scan(worldbook, [message('森林', true)], '嗯', { random: () => 0.99 }).activated.length, 0);
    const always = book([{ key: ['森林'], content: 'x', useProbability: false, probability: 1 }]);
    assert.equal(scan(always, [message('森林', true)], '嗯', { random: () => 0.99 }).activated.length, 1);
});

test('sticky keeps an entry active, then cooldown holds it back', () => {
    const worldbook = book([{ key: ['森林'], content: 'x', sticky: 2, cooldown: 3 }]);
    const hit = [message('森林', true)];
    const miss = [message('无关', true)];

    // Activation at messageIndex 1 sets stickyUntil = 3 and cooldownUntil = 6.
    const first = scan(worldbook, hit, '嗯');
    assert.equal(first.activated.length, 1);
    assert.equal(first.activated[0]?.reason, 'key');
    const state = first.nextState;
    assert.equal(state['test.0']?.stickyUntil, 1 + 2);
    assert.equal(state['test.0']?.cooldownUntil, 1 + 2 + 3);

    // Still active without matching, and reported as sticky.
    const during = scanWorldInfo({ worldbook, history: miss, userMessage: '嗯', messageIndex: 2, state });
    assert.equal(during.activated.length, 1);
    assert.equal(during.activated[0]?.reason, 'sticky');

    // After the sticky window but inside cooldown: silent even though keys match.
    const cooling = scanWorldInfo({ worldbook, history: hit, userMessage: '嗯', messageIndex: 5, state });
    assert.equal(cooling.activated.length, 0);
    assert.equal(cooling.skippedByCooldown, 1);

    // Cooldown over: it can fire on a keyword again.
    const again = scanWorldInfo({ worldbook, history: hit, userMessage: '嗯', messageIndex: 7, state });
    assert.equal(again.activated.length, 1);
    assert.equal(again.activated[0]?.reason, 'key');
});

test('the budget keeps the highest order entries and reports the rest', () => {
    const worldbook = book([
        { key: ['森林'], content: '低优先级'.repeat(10), order: 1 },
        { key: ['森林'], content: '高优先级', order: 500 },
    ]);

    const result = scan(worldbook, [message('森林', true)], '嗯', { tokenBudget: 12 });

    assert.equal(result.activated.length, 1);
    assert.equal(result.activated[0]?.content, '高优先级');
    assert.equal(result.skippedByBudget, 1);
    assert.ok(result.estimatedTokens <= 12);
});

test('a budget-dropped entry does not keep its sticky window', () => {
    const worldbook = book([{ key: ['森林'], content: '很长'.repeat(20), sticky: 5, order: 1 }]);
    const result = scan(worldbook, [message('森林', true)], '嗯', { tokenBudget: 1 });

    assert.equal(result.activated.length, 0);
    assert.equal(result.skippedByBudget, 1);
    assert.deepEqual(result.nextState, {});
});

// ---------------------------------------------------------------- recursion

test('recursive scanning finds entries through the content of others', () => {
    const worldbook = book([
        { key: ['森林'], content: '那里的河水叫 Eldoria', order: 1 },
        { key: ['Eldoria'], content: 'Eldoria 是一座城', order: 2 },
    ]);

    // Without recursion the second entry never sees the first one's text.
    assert.equal(scan(worldbook, [message('森林', true)], '嗯').activated.length, 1);
    assert.equal(scan(worldbook, [message('森林', true)], '嗯', { recursive: true }).activated.length, 2);
});

test('excludeRecursion, preventRecursion and delayUntilRecursion are honoured', () => {
    // excludeRecursion: its text must not feed the next pass.
    const excluding = book([
        { key: ['森林'], content: 'Eldoria', excludeRecursion: true, order: 1 },
        { key: ['Eldoria'], content: 'city', order: 2 },
    ]);
    assert.equal(scan(excluding, [message('森林', true)], '嗯', { recursive: true }).activated.length, 1);

    // preventRecursion: it may only fire in the first pass, so a recursive-only match is ignored.
    const preventing = book([
        { key: ['森林'], content: 'Eldoria', order: 1 },
        { key: ['Eldoria'], content: 'city', preventRecursion: true, order: 2 },
    ]);
    assert.equal(scan(preventing, [message('森林', true)], '嗯', { recursive: true }).activated.length, 1);

    // delayUntilRecursion: only in a recursive pass.
    const delayed = book([
        { key: ['森林'], content: 'Eldoria', order: 1 },
        { key: ['森林'], content: '迟到的', delayUntilRecursion: 1, order: 2 },
    ]);
    assert.equal(scan(delayed, [message('森林', true)], '嗯').activated.length, 1);
    assert.equal(scan(delayed, [message('森林', true)], '嗯', { recursive: true }).activated.length, 2);
});

// -------------------------------------------------------------- insertion

test('before/after positions join the definition block in order', () => {
    const worldbook = book([
        { key: [], content: '前置一', constant: true, position: POSITION.before, order: 1 },
        { key: [], content: '前置二', constant: true, position: POSITION.before, order: 2 },
        { key: [], content: '后置', constant: true, position: POSITION.after, order: 1 },
    ]);

    const { messages } = assemblePrompt({
        card,
        history: [],
        userMessage: '嗯',
        options: { personaName: 'User' },
        worldbook,
    });

    const system = messages[0]?.content ?? '';
    assert.ok(system.indexOf('前置一') < system.indexOf('前置二'), 'lower order first');
    // SillyTavern's "before" is before the character description, so the role
    // instruction still comes first.
    assert.ok(system.indexOf('你在扮演') < system.indexOf('前置一'), 'the instruction precedes before-entries');
    assert.ok(system.indexOf('前置二') < system.indexOf('书店店主'), 'before entries precede the description');
    assert.ok(system.indexOf('书店店主') < system.indexOf('后置'), 'after entries follow the definition');
});

test('EMTop/EMBottom bracket the examples and ANTop/ANBottom bracket the history', () => {
    const withExamples = normalizeCard({
        spec: 'chara_card_v2',
        data: { name: 'A', description: 'D', mes_example: '{{user}}: 早\n{{char}}: 早。' },
    });

    const worldbook = book([
        { key: [], content: '示例前', constant: true, position: POSITION.EMTop },
        { key: [], content: '示例后', constant: true, position: POSITION.EMBottom },
        { key: [], content: '历史前', constant: true, position: POSITION.ANTop },
        { key: [], content: '历史后', constant: true, position: POSITION.ANBottom },
    ]);

    const { messages } = assemblePrompt({
        card: withExamples,
        history: [message('来了。', false), message('在吗', true)],
        userMessage: '嗯',
        options: { personaName: 'User' },
        worldbook,
    });

    const indexOf = (text: string): number => messages.findIndex((promptMessage) => promptMessage.content.includes(text));

    assert.equal(messages[indexOf('示例前')]?.role, 'system');
    assert.ok(indexOf('示例前') < indexOf('早。'));
    assert.ok(indexOf('早。') < indexOf('示例后'));
    assert.ok(indexOf('示例后') < indexOf('历史前'));
    assert.ok(indexOf('历史前') < indexOf('在吗'));
    assert.ok(indexOf('在吗') < indexOf('历史后'));
    assert.ok(indexOf('历史后') < messages.findIndex((promptMessage) => promptMessage.content === '嗯'));
});

test('at-depth entries land the requested number of messages from the end', () => {
    const worldbook = book([
        { key: [], content: '深度信息', constant: true, position: POSITION.atDepth, depth: 2, role: ROLE.USER },
    ]);

    const { messages } = assemblePrompt({
        card,
        history: [message('来了。', false), message('u1', true), message('a1', false), message('u2', true), message('a2', false)],
        userMessage: '嗯',
        options: { personaName: 'User' },
        worldbook,
    });

    const index = messages.findIndex((promptMessage) => promptMessage.content === '深度信息');
    assert.ok(index > 0, 'expected the entry to be injected');

    // Exactly two messages follow it, and it takes the entry's role.
    assert.equal(messages[index]?.role, 'user');
    assert.deepEqual(messages.slice(index + 1, index + 3).map((promptMessage) => promptMessage.content), ['u2', 'a2']);
});

test('a default insertion depth is used when the entry has none', () => {
    const worldbook = book([
        { key: [], content: '默认深度', constant: true, position: POSITION.atDepth, depth: DEFAULT_INSERTION_DEPTH },
    ]);

    const history = Array.from({ length: 8 }, (_, index) => message(`m${index}`, index % 2 === 0));
    const { messages } = assemblePrompt({ card, history, userMessage: '嗯', options: { personaName: 'User' }, worldbook });
    const index = messages.findIndex((promptMessage) => promptMessage.content === '默认深度');

    assert.equal(messages.length - 1 - index, DEFAULT_INSERTION_DEPTH + 1);
});

test('{{char}} and {{user}} are substituted inside world info content', () => {
    const worldbook = book([{ key: [], content: '{{char}} 认识 {{user}}', constant: true }]);

    const { messages } = assemblePrompt({
        card,
        history: [],
        userMessage: '嗯',
        options: { personaName: '小明' },
        worldbook,
    });

    assert.match(messages[0]?.content ?? '', /林昭 认识 小明/);
});

test('stats report what fired, what was skipped and the next state', () => {
    const worldbook = book([
        { key: ['森林'], content: '森林设定' },
        { key: ['沙漠'], content: '沙漠设定' },
        { key: ['森林'], content: '滴答', probability: 1, useProbability: true, sticky: 1 },
    ]);

    const { stats, nextWorldInfoState } = assemblePrompt({
        card,
        history: [],
        userMessage: '森林',
        options: { personaName: 'User' },
        worldbook,
    });

    assert.ok(stats.worldInfo);
    assert.equal(stats.worldInfo.candidates, 3);
    assert.equal(stats.worldInfo.activated.length, 1);
    assert.deepEqual(stats.worldInfo.activated[0]?.matchedKeys, ['森林']);
    assert.equal(stats.worldInfo.activated[0]?.world, 'test');
    assert.equal(stats.worldInfo.skippedByKeyLogic, 1);
    assert.equal(stats.worldInfo.skippedByProbability, 1);
    assert.ok(stats.sections.includes('world_info_before'));
    assert.deepEqual(nextWorldInfoState, {});
});

test('no world book means no world info section at all', () => {
    const { stats } = assemblePrompt({ card, history: [], userMessage: '嗯', options: { personaName: 'User' } });
    assert.equal(stats.worldInfo, null);
    assert.equal(stats.sections.some((section) => section.startsWith('world_info')), false);
});
