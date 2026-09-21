/**
 * Prompt engine types.
 *
 * The engine is a pure function on purpose: prompt assembly is where all the
 * subtle behaviour lives (ordering, world info, trimming), and pure functions can
 * be regression-tested with snapshots. SillyTavern's own logic is spread across
 * ~1.5万行 of browser code; keeping ours side-effect free is how we avoid that.
 */
import type {
    InsertionTarget,
    MatchReason,
    PromptRoleName,
    WorldInfoConfig,
} from './worldinfo.ts';

export type PromptRole = 'system' | 'user' | 'assistant';

export interface PromptMessage {
    role: PromptRole;
    content: string;
}

export interface PromptOptions {
    /** Name used for `{{user}}` substitution. */
    personaName: string;
    /** Replaces the built-in role instruction. Supports {{char}} and {{user}}. */
    mainPrompt?: string;
    /** Rough ceiling for the chat history part of the prompt. */
    historyTokenBudget?: number;
    /** Hard cap on how many history messages may be included. */
    maxHistoryMessages?: number;
    /** Cards with huge example blocks can opt out. */
    includeExamples?: boolean;
    worldInfo?: WorldInfoConfig;
}

/** One world info entry that fired, trimmed for transport. */
export interface WorldInfoActivationSummary {
    uid: number;
    world: string;
    comment: string;
    reason: MatchReason;
    matchedKeys: string[];
    target: InsertionTarget;
    depth: number;
    order: number;
    role: PromptRoleName;
    estimatedTokens: number;
    /** First characters of the injected text, for debugging. */
    preview: string;
}

export interface WorldInfoStats {
    activated: WorldInfoActivationSummary[];
    candidates: number;
    scannedMessages: number;
    skippedByDisabled: number;
    skippedByDelay: number;
    skippedByKeyLogic: number;
    skippedByProbability: number;
    skippedByCooldown: number;
    skippedByBudget: number;
    recursionSteps: number;
    estimatedTokens: number;
}

export interface PromptStats {
    /** Which parts actually contributed a message. */
    sections: string[];
    /** History messages kept, and dropped from the front by the budget. */
    historyIncluded: number;
    historyDropped: number;
    /** Dropped because the window would otherwise start with the character. */
    historyDroppedForRoleOrder: number;
    estimatedTokens: number;
    estimatedHistoryTokens: number;
    estimatedOverheadTokens: number;
    budgetExceeded: boolean;
    /** Null when no world book was scanned at all. */
    worldInfo: WorldInfoStats | null;
}

export const DEFAULT_MAIN_PROMPT = [
    '你在扮演「{{char}}」。',
    '始终保持角色设定与说话风格，不要跳出角色。',
    '只写 {{char}} 的回复，不要代替 {{user}} 说话或行动。',
    '使用与 {{user}} 相同的语言回复。',
].join('\n');

export const DEFAULT_HISTORY_TOKEN_BUDGET = 1500;
