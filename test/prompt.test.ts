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
