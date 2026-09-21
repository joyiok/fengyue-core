/**
 * Chat log reading and writing.
 *
 * Parsing tolerates files without a header line, because hand-edited or
 * third-party exports often drop it; serialising always writes one, matching
 * SillyTavern.
 */
import { readFile, writeFile } from 'node:fs/promises';

import { defaultHeader, type ChatHeader, type ChatMessage, type ParsedChat } from './types.ts';

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function looksLikeHeader(value: unknown): boolean {
    if (!isPlainObject(value)) {
        return false;
    }

    if ('mes' in value) {
        return false;
    }

    return 'chat_metadata' in value || 'user_name' in value || 'character_name' in value;
}

export function normalizeHeader(raw: unknown): ChatHeader {
    if (!isPlainObject(raw)) {
        return defaultHeader();
    }

    return {
        ...raw,
        chat_metadata: isPlainObject(raw.chat_metadata) ? raw.chat_metadata : {},
        user_name: typeof raw.user_name === 'string' ? raw.user_name : 'unused',
        character_name: typeof raw.character_name === 'string' ? raw.character_name : 'unused',
    };
}

export function normalizeMessage(raw: unknown): ChatMessage {
    const record = isPlainObject(raw) ? raw : {};

    const message: ChatMessage = {
        ...record,
        name: typeof record.name === 'string' ? record.name : '',
        is_user: record.is_user === true,
        send_date: (typeof record.send_date === 'string' || typeof record.send_date === 'number')
            ? record.send_date
            : new Date().toISOString(),
        mes: typeof record.mes === 'string' ? record.mes : '',
    };

    if (record.is_system === true) {
        message.is_system = true;
    }

    if (isPlainObject(record.extra)) {
        message.extra = record.extra;
    }

    return message;
}

export function parseChatJsonl(text: string): ParsedChat {
    const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');

    if (lines.length === 0) {
        return { header: defaultHeader(), messages: [] };
    }

    const parsed: unknown[] = lines.map((line, index) => {
        try {
            return JSON.parse(line);
        } catch (error) {
            throw new Error(`chat line ${index + 1} is not valid JSON: ${String(error)}`);
        }
    });

    let header = defaultHeader();
    let start = 0;

    if (looksLikeHeader(parsed[0])) {
        header = normalizeHeader(parsed[0]);
        start = 1;
    }

    return {
        header,
        messages: parsed.slice(start).map(normalizeMessage),
    };
}

export function serializeChatJsonl(chat: ParsedChat): string {
    const lines = [JSON.stringify(normalizeHeader(chat.header))];

    for (const message of chat.messages) {
        lines.push(JSON.stringify(normalizeMessage(message)));
    }

    return `${lines.join('\n')}\n`;
}

export async function readChatFile(filePath: string): Promise<ParsedChat> {
    return parseChatJsonl(await readFile(filePath, 'utf8'));
}

export async function writeChatFile(filePath: string, chat: ParsedChat): Promise<void> {
    await writeFile(filePath, serializeChatJsonl(chat), 'utf8');
}

export interface ChatSummary {
    name: string;
    messages: number;
    userMessages: number;
    lastMessageAt: string | number | null;
    bytes: number;
}

export function summarizeChat(name: string, chat: ParsedChat, bytes = 0): ChatSummary {
    const last = chat.messages[chat.messages.length - 1];

    return {
        name,
        messages: chat.messages.length,
        userMessages: chat.messages.filter((message) => message.is_user).length,
        lastMessageAt: last?.send_date ?? null,
        bytes,
    };
}
