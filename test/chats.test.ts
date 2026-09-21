import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseChatJsonl, serializeChatJsonl, summarizeChat } from '../src/chats/jsonl.ts';
import { defaultHeader } from '../src/chats/types.ts';

const headerLine = JSON.stringify({ chat_metadata: { integrity: 'abc' }, user_name: 'unused', character_name: 'unused' });

test('a chat with a header line parses into header plus messages', () => {
    const text = [
        headerLine,
        JSON.stringify({ name: '林昭', is_user: false, send_date: '2026-09-21T10:00:00.000Z', mes: '来了。' }),
        JSON.stringify({ name: 'User', is_user: true, send_date: '2026-09-21T10:00:05.000Z', mes: '在吗' }),
    ].join('\n');

    const chat = parseChatJsonl(text);

    assert.equal(chat.header.user_name, 'unused');
    assert.deepEqual(chat.header.chat_metadata, { integrity: 'abc' });
    assert.equal(chat.messages.length, 2);
    assert.equal(chat.messages[0]?.mes, '来了。');
    assert.equal(chat.messages[0]?.is_user, false);
    assert.equal(chat.messages[1]?.is_user, true);
});

test('a chat file without a header still parses', () => {
    const text = JSON.stringify({ name: 'A', is_user: true, mes: 'no header here' });

    const chat = parseChatJsonl(text);

    assert.deepEqual(chat.header, defaultHeader());
    assert.equal(chat.messages.length, 1);
    assert.equal(chat.messages[0]?.mes, 'no header here');
});

test('messages are normalised so consumers get the fields they expect', () => {
    const chat = parseChatJsonl(JSON.stringify({ mes: 'bare' }));
    const message = chat.messages[0];

    assert.ok(message);
    assert.equal(message.name, '');
    assert.equal(message.is_user, false);
    assert.equal(message.mes, 'bare');
    // A timestamp is synthesised when the file has none.
    assert.equal(typeof message.send_date, 'string');
});

test('serialise then parse is lossless, and always writes a header', () => {
    const chat = {
        header: defaultHeader({ character_name: '林昭' }),
        messages: [
            { name: '林昭', is_user: false, send_date: 1, mes: '第一句' },
            { name: 'User', is_user: true, send_date: 2, mes: '第二句', is_system: true },
        ],
    };

    const text = serializeChatJsonl(chat);
    assert.equal(text.split('\n').filter(Boolean).length, 3);

    const reread = parseChatJsonl(text);
    assert.equal(reread.header.character_name, '林昭');
    assert.deepEqual(reread.messages, chat.messages);
});

test('an empty file is an empty chat, a broken line is an error with its number', () => {
    assert.deepEqual(parseChatJsonl('').messages, []);
    assert.deepEqual(parseChatJsonl('\n\n').messages, []);

    assert.throws(
        () => parseChatJsonl(`${headerLine}\n{not json}`),
        /chat line 2 is not valid JSON/,
    );
});

test('summaries count messages and find the newest timestamp', () => {
    const chat = parseChatJsonl([
        headerLine,
        JSON.stringify({ mes: 'a', is_user: false, send_date: '2026-09-21T10:00:00.000Z' }),
        JSON.stringify({ mes: 'b', is_user: true, send_date: '2026-09-21T10:01:00.000Z' }),
    ].join('\n'));

    const summary = summarizeChat('session-1', chat, 512);
    assert.equal(summary.name, 'session-1');
    assert.equal(summary.messages, 2);
    assert.equal(summary.userMessages, 1);
    assert.equal(summary.lastMessageAt, '2026-09-21T10:01:00.000Z');
    assert.equal(summary.bytes, 512);
});
