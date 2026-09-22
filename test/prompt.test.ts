import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeCard } from '../src/cards/types.ts';
import type { ChatMessage } from '../src/chats/types.ts';
import { assemblePrompt } from '../src/prompt/assemble.ts';
import { estimateTokens } from '../src/prompt/estimate.ts';

const card = normalizeCard({
    spec: 'chara_card_v2',
    data: {
        name: '林昭',
        description: '书店店主',
        personality: '话少，有时刻薄',
        scenario: '深夜的书房',
        system_prompt: '',
        post_history_instructions: '保持简短。',
        mes_example: '{{user}}: 在吗\n{{char}}: 在。\n<START>\n{{user}}: 今天累\n{{char}}: 那就别说话，坐着。',
    },
});

function message(mes: string, isUser: boolean, at = '2026-09-21T10:00:00.000Z'): ChatMessage {
    return { name: isUser ? 'User' : '林昭', is_user: isUser, send_date: at, mes };
}

test('the definition block keeps a documented order and one system message', () => {
    const { messages, stats } = assemblePrompt({
        card,
        history: [],
        userMessage: '在吗',
        options: { personaName: 'User' },
    });

    assert.equal(messages[0]?.role, 'system');
    const system = messages[0]?.content ?? '';

    assert.match(system, /你在扮演「林昭」/);
    assert.ok(system.indexOf('书店店主') < system.indexOf('话少，有时刻薄'));
    assert.ok(system.indexOf('话少，有时刻薄') < system.indexOf('深夜的书房'));

    // Only one system message here: post_history_instructions comes later.
    assert.deepEqual(stats.sections, ['main', 'description', 'personality', 'scenario', 'examples', 'post_history_instructions']);
    assert.equal(messages[messages.length - 1]?.role, 'user');
    assert.equal(messages[messages.length - 1]?.content, '在吗');
});

test('the card system_prompt is folded in right after the role instruction', () => {
    const withSystemPrompt = normalizeCard({
        spec: 'chara_card_v2',
        data: { name: 'A', description: 'D', system_prompt: '只写动作，不写对白。' },
    });

    const { messages } = assemblePrompt({
        card: withSystemPrompt,
        history: [],
        userMessage: 'hi',
        options: { personaName: 'User' },
    });

    const system = messages[0]?.content ?? '';
    assert.ok(system.indexOf('你在扮演「A」') < system.indexOf('只写动作，不写对白。'));
    assert.ok(system.indexOf('只写动作，不写对白。') < system.indexOf('D'));
});

test('empty card fields contribute nothing at all', () => {
    const bare = normalizeCard({ spec: 'chara_card_v2', data: { name: 'Bare' } });

    const { messages, stats } = assemblePrompt({
        card: bare,
        history: [],
        userMessage: 'hi',
        options: { personaName: 'User' },
    });

    assert.deepEqual(stats.sections, ['main']);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.content.includes('\n\n\n'), false);
});

test('example dialogue becomes real turns with names substituted', () => {
    const { messages } = assemblePrompt({ card, history: [], userMessage: '在吗', options: { personaName: '小明' } });

    // Everything that is not the definition block, the trailing system message or
    // the final user turn is example dialogue.
    const examples = messages.filter((message) => message.role !== 'system').slice(0, -1);

    assert.deepEqual(examples.map((message) => message.role), ['user', 'assistant', 'user', 'assistant']);
    assert.equal(examples[0]?.content, '在吗');
    assert.equal(examples[3]?.content, '那就别说话，坐着。');
    assert.equal(examples.some((message) => message.content.includes('{{')), false);
});

test('post_history_instructions sits immediately before the user turn', () => {
    const { messages } = assemblePrompt({
        card,
        history: [message('在。', false), message('今天累', true)],
        userMessage: '嗯',
        options: { personaName: 'User' },
    });

    // The invariant that matters: it is the message right before the new turn.
    assert.equal(messages[messages.length - 1]?.role, 'user');
    assert.equal(messages[messages.length - 1]?.content, '嗯');
    assert.equal(messages[messages.length - 2]?.role, 'system');
    assert.equal(messages[messages.length - 2]?.content, '保持简短。');
});

test('recency beats the opening line, and the window never starts with the character', () => {
    const history: ChatMessage[] = [message('（她抬眼看你）来了。', false)];

    // 40 turns of realistic length (~30 tokens each).
    const line = '她把书合上，推到一边。';
    for (let turn = 0; turn < 40; turn++) {
        history.push(message(`${line} 第${turn}次`, true));
        history.push(message(`${line} 好的${turn}`, false));
    }

    const { messages, stats } = assemblePrompt({
        card,
        history,
        userMessage: '最后一句',
        options: { personaName: 'User', historyTokenBudget: 120 },
    });

    // [0] definition, [1..4] examples, then history, then post-history, then user.
    const historyPart = messages.slice(5, messages.length - 2);

    assert.ok(historyPart.length > 0, 'expected some history to survive');
    assert.equal(historyPart[0]?.content, '（她抬眼看你）来了。');
    // After the greeting the window must start with the user, not the character.
    assert.equal(historyPart[1]?.role, 'user');
    // And it must be recent, not ancient.
    assert.match(historyPart[historyPart.length - 1]?.content ?? '', /第39次|好的39/);

    assert.equal(stats.historyIncluded, historyPart.length);
    assert.ok(stats.historyDropped > 0, 'expected trimming to happen');
    assert.equal(stats.budgetExceeded, true);
});

test('a budget too small for both drops the greeting, not the recent turn', () => {
    const history: ChatMessage[] = [message('开场白。', false)];
    // ~29 estimated tokens: fits the 35 budget on its own, but not with the greeting.
    history.push(message('上一条消息'.repeat(5), true));

    const { messages, stats } = assemblePrompt({
        card,
        history,
        userMessage: '然后呢',
        options: { personaName: 'User', historyTokenBudget: 35, includeExamples: false },
    });

    const historyPart = messages.slice(1, messages.length - 1).filter((m) => m.role !== 'system');

    assert.equal(historyPart.length, 1);
    assert.equal(historyPart[0]?.role, 'user');
    assert.equal(historyPart[0]?.content, '上一条消息'.repeat(5));
    assert.equal(historyPart.some((m) => m.content === '开场白。'), false);
    assert.ok(stats.historyDropped >= 1);
});

test('a tight budget still produces a usable prompt', () => {
    const { messages, stats } = assemblePrompt({
        card,
        history: [message('在。', false), message('今天累', true)],
        userMessage: '嗯',
        options: { personaName: 'User', historyTokenBudget: 1, maxHistoryMessages: 1 },
    });

    assert.equal(messages[messages.length - 1]?.content, '嗯');
    assert.equal(messages[0]?.role, 'system');
    assert.ok(stats.estimatedTokens > 0);
});

test('examples can be turned off for cards with huge example blocks', () => {
    const { stats } = assemblePrompt({
        card,
        history: [],
        userMessage: 'hi',
        options: { personaName: 'User', includeExamples: false },
    });

    assert.equal(stats.sections.includes('examples'), false);
});

test('token estimation is CJK-aware and monotonic', () => {
    // Roughly one token per CJK character, one per four ASCII characters.
    assert.equal(estimateTokens('你好世界'), 4);
    assert.equal(estimateTokens('abcdefgh'), 2);
    assert.ok(estimateTokens('你好世界') > estimateTokens('abcdefgh'));
    assert.equal(estimateTokens(''), 0);
});

test('a custom main prompt replaces the default but keeps the placeholders working', () => {
    const { messages } = assemblePrompt({
        card,
        history: [],
        userMessage: 'hi',
        options: { personaName: '小明', mainPrompt: '你是 {{char}}，对 {{user}} 说话要客气。' },
    });

    assert.equal(messages[0]?.content.startsWith('你是 林昭，对 小明 说话要客气。'), true);
    assert.equal(messages[0]?.content.includes('你在扮演'), false);
});

// ------------------------------------------------------------------ mods

test('a mod extends the setting: after the card, before the examples, in order', () => {
    const card = normalizeCard({
        spec: 'chara_card_v2',
        data: {
            name: '林昭',
            description: '书店店主。',
            system_prompt: '保持角色。',
            first_mes: '来了。',
        },
    });

    const plain = assemblePrompt({
        card,
        history: [],
        userMessage: '在吗',
        options: { personaName: 'User' },
    });

    const modded = assemblePrompt({
        card,
        history: [],
        userMessage: '在吗',
        options: {
            personaName: 'User',
            mods: [
                { name: '雨夜', system: '外面在下雨。' },
                { name: '旧书店', system: '灯是暖的。', postHistory: '不要写旁白。' },
            ],
        },
    });

    // The card's own material is the body of the session and stays on top; a mod
    // extends the setting rather than overriding it.
    const system = String(modded.messages[0]?.content);
    assert.equal(system.indexOf('书店店主') < system.indexOf('保持角色'), false, 'card fields and card system prompt keep their place');
    assert.equal(system.indexOf('保持角色。') < system.indexOf('外面在下雨。'), true, 'a mod comes after the card');
    assert.equal(system.indexOf('外面在下雨。') < system.indexOf('灯是暖的。'), true, 'mods go in load order');

    // Every mod that added something is named in the sections, so the debug
    // panel can say what this turn actually carried.
    assert.deepEqual(
        modded.stats.sections.filter((section) => section.startsWith('mod:')),
        ['mod:雨夜', 'mod:旧书店'],
    );
    assert.equal(plain.stats.sections.some((section) => section.startsWith('mod:')), false);

    // A mod's post-history fragment lands in the same slot as the card's — right
    // before the user's message, which is where a lot of community cards depend
    // on it being.
    const postHistory = modded.messages.find((message, index) =>
        index > 0 && message.role === 'system' && String(message.content).includes('不要写旁白'));
    assert.ok(postHistory, 'the mod\'s post-history fragment was dropped');

    const last = modded.messages[modded.messages.length - 1];
    assert.equal(last?.role, 'user');
    assert.equal(modded.messages[modded.messages.length - 2]?.content, postHistory?.content,
        'post-history stays glued to the final user message');
});

test('a card asks, the reader answers, and the answers are in the text', async () => {
    const { applyVariables, substituteVariables, sanitizePanelHtml, cardPanel, assertVariableKey } = await import('../src/prompt/variables.ts');

    // Keys are `[A-Za-z_][A-Za-z0-9_]*` and no longer than 30 — the same rules
    // the panel that collects them has to live with. `{{名字}}` is not a name.
    assert.throws(() => assertVariableKey('名字'));
    assert.throws(() => assertVariableKey('1st'));
    assert.doesNotThrow(() => assertVariableKey('player_name'));

    // A hole is filled…
    assert.equal(substituteVariables('你好，{{ name }}。', { name: '阿槐' }), '你好，阿槐。');
    // …and a hole nobody declared is left alone. `{{user}}` is not this
    // mechanism's to fill: it gets the persona's real name later, and a silent
    // blank here would eat it.
    assert.equal(substituteVariables('写给 {{user}}', {}), '写给 {{user}}');

    const card = {
        data: {
            name: '晚照',
            first_mes: '「{{ greeting }}, 进来吧。」',
            system_prompt: '她叫{{ char_name }}。',
            description: '一间叫{{ shop }}的书店。',
            personality: '慢',
            scenario: '雨夜',
            post_history_instructions: '保持语气。',
            extensions: { story: { variables: [{ key: 'char_name', label: '她叫什么', default: '晚照' }], panel: '<p onclick="x">hi<script>steal()</script></p>' } },
        },
    };

    const filled = applyVariables(card, { char_name: '阿槐', greeting: '客人', shop: '晚照' });
    assert.equal(filled.data.first_mes, '「客人, 进来吧。」');
    assert.equal(filled.data.system_prompt, '她叫阿槐。');
    // The original is untouched — it is what the author wrote, and it stays that
    // way on disk and in the editor.
    assert.equal(card.data.first_mes, '「{{ greeting }}, 进来吧。」');

    // The panel is HTML we render, so it cannot be HTML that runs.
    assert.equal(sanitizePanelHtml('<p onclick="x">hi<script>steal()</script></p>'), '<p>hi</p>');
    assert.equal(cardPanel(card), '<p>hi</p>');
});
