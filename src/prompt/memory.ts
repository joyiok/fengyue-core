/**
 * Rolling summary memory.
 *
 * The history window (M1) keeps recent turns verbatim; this keeps what fell out
 * of it. Older messages are compressed into one summary that is injected as
 * context, and each pass merges the previous summary with the next chunk, so the
 * block stays a constant size instead of growing with the conversation.
 *
 * Everything here is pure: deciding what to summarize, formatting the transcript
 * and building the request are all testable without a model.
 */
import type { ChatMessage } from '../chats/types.ts';

export interface MemoryState {
    /** The rolling summary injected into prompts. Empty when nothing is summarized. */
    text: string;
    /** How many messages of the log it covers. */
    upTo: number;
    updatedAt: string;
    /** How many summarization passes produced it — an audit trail for the operator. */
    passes: number;
    /** Which model wrote it. */
    model?: string;
}

export const EMPTY_MEMORY: MemoryState = {
    text: '',
    upTo: 0,
    updatedAt: '',
    passes: 0,
};

export interface MemoryConfig {
    enabled?: boolean;
    /** Un-summarized messages needed before a pass runs. */
    messageThreshold?: number;
    /** Messages that always stay verbatim, however long the chat gets. */
    keepRecent?: number;
    /** Ceiling for the summary block in the prompt (estimated tokens). */
    maxSummaryTokens?: number;
    /** Replaces the built-in summarization instruction. */
    instruction?: string;
}

export const DEFAULT_MEMORY_CONFIG = {
    enabled: true,
    messageThreshold: 40,
    keepRecent: 12,
    maxSummaryTokens: 500,
} as const;

export const DEFAULT_SUMMARY_INSTRUCTION = [
    '你是对话摘要助手。把给你的角色扮演对话压缩成一段前情摘要。',
    '必须保留：人物关系与称呼、已经发生的关键事件、尚未完成的约定或伏笔、用户透露的偏好与设定。',
    '不要逐句复述，不要编造没有出现过的信息，不要写对白。',
    '用第三人称陈述，中文，200 字以内。',
].join('\n');

/**
 * How many messages the summary may cover.
 *
 * Returns the index to summarize up to, or null when there is nothing worth
 * doing. A pass never touches the last `keepRecent` messages, which is what keeps
 * the summary from chasing the conversation.
 */
export function planSummaryUpTo(
    state: MemoryState,
    messageCount: number,
    config: MemoryConfig = {},
): number | null {
    const enabled = config.enabled ?? DEFAULT_MEMORY_CONFIG.enabled;
    if (!enabled) {
        return null;
    }

    const threshold = Math.max(1, config.messageThreshold ?? DEFAULT_MEMORY_CONFIG.messageThreshold);
    const keepRecent = Math.max(1, config.keepRecent ?? DEFAULT_MEMORY_CONFIG.keepRecent);

    const upTo = Math.max(0, state.upTo);
    const available = messageCount - upTo - keepRecent;

    if (available < threshold) {
        return null;
    }

    return upTo + available;
}

/** Render the messages being summarized, with speaker names. */
export function formatTranscript(messages: ChatMessage[]): string {
    return messages
        .map((message) => `${message.is_user ? '用户' : message.name || '角色'}：${message.mes}`)
        .join('\n');
}

export interface SummaryRequestInput {
    previous: string;
    upTo: number;
    messages: ChatMessage[];
    config?: MemoryConfig;
}

/**
 * Build the summarization request. When a previous summary exists the model is
 * asked to merge it with the new material rather than summarize from scratch, so
 * nothing that was already compressed is lost.
 */
export function buildSummaryRequest(input: SummaryRequestInput): {
    messages: { role: 'system' | 'user'; content: string }[];
    maxTokens: number;
} {
    const instruction = input.config?.instruction ?? DEFAULT_SUMMARY_INSTRUCTION;
    const transcript = formatTranscript(input.messages);

    const user = input.previous.trim() === ''
        ? `请为下面这段对话写前情摘要（共 ${input.messages.length} 条消息）：\n\n${transcript}`
        : [
            '这是已有的前情摘要：',
            input.previous,
            '',
            `下面是之后的 ${input.messages.length} 条新对话：`,
            transcript,
            '',
            '请把两者合并成一段新的前情摘要，保留原有摘要里仍然重要的信息。',
        ].join('\n');

    return {
        messages: [
            { role: 'system', content: instruction },
            { role: 'user', content: user },
        ],
        maxTokens: Math.max(64, input.config?.maxSummaryTokens ?? DEFAULT_MEMORY_CONFIG.maxSummaryTokens),
    };
}

/** Apply a finished summary pass. */
export function applySummary(
    state: MemoryState,
    summary: string,
    upTo: number,
    details: { model?: string; now?: Date } = {},
): MemoryState {
    return {
        text: summary.trim(),
        upTo,
        updatedAt: (details.now ?? new Date()).toISOString(),
        passes: state.passes + 1,
        ...(details.model !== undefined ? { model: details.model } : {}),
    };
}

/** Read a memory state out of chat metadata, tolerating anything malformed. */
export function readMemoryState(metadata: Record<string, unknown>): MemoryState {
    const story = metadata.story;
    if (story === null || typeof story !== 'object') {
        return { ...EMPTY_MEMORY };
    }

    const memory = (story as { memory?: unknown }).memory;
    if (memory === null || typeof memory !== 'object') {
        return { ...EMPTY_MEMORY };
    }

    const record = memory as Record<string, unknown>;

    return {
        text: typeof record.text === 'string' ? record.text : '',
        upTo: typeof record.upTo === 'number' && Number.isFinite(record.upTo) ? Math.max(0, Math.trunc(record.upTo)) : 0,
        updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
        passes: typeof record.passes === 'number' && Number.isFinite(record.passes) ? Math.max(0, Math.trunc(record.passes)) : 0,
        ...(typeof record.model === 'string' ? { model: record.model } : {}),
    };
}
