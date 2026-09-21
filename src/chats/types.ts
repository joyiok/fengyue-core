/**
 * Chat log types.
 *
 * SillyTavern stores one JSONL file per conversation: the first line is a header
 * (chat_metadata / user_name / character_name) and every following line is a
 * message. Keeping this shape means a backend can serve existing history
 * unchanged, and users can move conversations between the two.
 */

export interface ChatHeader {
    chat_metadata: Record<string, unknown>;
    user_name: string;
    character_name: string;
    [key: string]: unknown;
}

export interface ChatMessage {
    name: string;
    is_user: boolean;
    is_system?: boolean;
    send_date: string | number;
    mes: string;
    extra?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface ParsedChat {
    header: ChatHeader;
    messages: ChatMessage[];
}

export function defaultHeader(overrides: Partial<ChatHeader> = {}): ChatHeader {
    return {
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
        ...overrides,
    };
}
