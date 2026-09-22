/**
 * Response shapes of the story-core API.
 *
 * These mirror `story-core/src/**` exactly rather than defining an idealised
 * contract: the client must be able to render whatever the server actually
 * returns, and a mismatch here would only be discovered at runtime.
 */

export interface User {
    id: string;
    handle: string;
    displayName: string;
    role: 'admin' | 'user';
    status: string;
    createdAt: string;
}

// ------------------------------------------------------------------ cards

export interface CardSummary {
    id: string;
    name: string;
    spec: string;
    tags: string[];
    descriptionLength: number;
    firstMessageLength: number;
    hasV3Chunk: boolean;
    avatarBytes: number;
}

export type CharacterListEntry =
    | ({ ok: true } & CardSummary)
    | { ok: false; id: string; error: string };

export interface CharacterCardData {
    name: string;
    description?: string;
    personality?: string;
    scenario?: string;
    first_mes?: string;
    mes_example?: string;
    creator_notes?: string;
    system_prompt?: string;
    post_history_instructions?: string;
    alternate_greetings?: string[];
    tags?: string[];
    creator?: string;
    character_version?: string;
    extensions?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface CharacterCard {
    spec: string;
    spec_version: string;
    data: CharacterCardData;
}

export interface ImportedCard {
    id: string;
    fileName: string;
    summary: CardSummary;
}

// ------------------------------------------------------------------- chats

export interface ChatMessage {
    name: string;
    is_user: boolean;
    is_system?: boolean;
    send_date: string | number;
    mes: string;
    extra?: Record<string, unknown>;
}

export interface ChatHeader {
    chat_metadata: Record<string, unknown>;
    user_name: string;
    character_name: string;
}

export interface ParsedChat {
    header: ChatHeader;
    messages: ChatMessage[];
}

export interface ChatSummary {
    name: string;
    messages: number;
    userMessages: number;
    lastMessageAt: string | number | null;
    bytes: number;
}

// -------------------------------------------------------------- world books

export interface WorldbookEntry {
    uid: number;
    key: string[];
    keysecondary: string[];
    comment: string;
    content: string;
    constant: boolean;
    selective: boolean;
    order: number;
    position: number;
    disable: boolean;
    sticky: number;
    cooldown: number;
    delay: number;
    probability: number;
    depth: number;
    scanDepth: number | null;
    role: number | null;
    [key: string]: unknown;
}

export interface Worldbook {
    entries: Record<string, WorldbookEntry>;
    id?: string;
    [key: string]: unknown;
}

export interface WorldbookSummary {
    id: string;
    entries: number;
    constantEntries: number;
    disabledEntries: number;
    bytes: number;
}

// ------------------------------------------------------------------ prompt

export interface WorldInfoActivation {
    uid: number;
    world: string;
    comment: string;
    reason: string;
    matchedKeys: string[];
    target: string;
    depth: number;
    order: number;
    role: string;
    estimatedTokens: number;
    preview: string;
}

export interface WorldInfoStats {
    activated: WorldInfoActivation[];
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

export interface MemoryStats {
    summarizedMessages: number;
    passes: number;
    estimatedTokens: number;
    updatedAt: string;
    preview: string;
}

export interface PromptStats {
    sections: string[];
    historyIncluded: number;
    historyDropped: number;
    historyDroppedForRoleOrder: number;
    estimatedTokens: number;
    estimatedHistoryTokens: number;
    estimatedOverheadTokens: number;
    budgetExceeded: boolean;
    worldInfo: WorldInfoStats | null;
    memory: MemoryStats | null;
}

export interface CompletionUsage {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
}

// ----------------------------------------------------------------- account

// ----------------------------------------------------------------- settings

export type SettingValue = number | boolean | string;

export interface SettingEntry {
    key: string;
    type: 'number' | 'boolean' | 'string';
    group: 'auth' | 'server' | 'model' | 'quota' | 'credits' | 'market' | 'memory' | 'chat';
    description: string;
    secret: boolean;
    /** Read once at start-up: a change needs a restart. */
    restart: boolean;
    default: SettingValue;
    bootValue: SettingValue;
    /** Masked when `secret`. */
    value: SettingValue;
    secretSet?: boolean;
    changed: boolean;
    env?: string;
}

// ------------------------------------------------------------------- admin

export interface AdminOverview {
    accounts: { total: number; active: number; disabled: number };
    usage: {
        day: { tokens: number; requests: number };
        month: { tokens: number; requests: number };
        inFlight: { requests: number; reservedTokens: number };
        recent: {
            userId: string;
            chatId: string | null;
            model: string;
            totalTokens: number;
            usageSource: string;
            createdAt: string;
        }[];
    } | null;
    credits: { granted: number; spent: number; balance: number } | null;
    market: { published: number; favorites: number } | null;
    model: { configured: boolean; name?: string; endpoint?: string };
}

// ------------------------------------------------------------------ account

export interface QuotaPolicy {
    dailyTokenLimit: number;
    monthlyTokenLimit: number;
    maxTokensPerRequest: number;
}

export interface UsageSummary {
    policy: QuotaPolicy;
    day: { tokens: number; requests: number; limit: number; remaining: number; resetAt: string };
    month: { tokens: number; requests: number; limit: number; remaining: number; resetAt: string };
    global: { tokens: number; limit: number };
    inFlight: { requests: number; reservedTokens: number };
}

export interface UsageRecord {
    id: number;
    requestId: string | null;
    chatId: string | null;
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    usageSource: string;
    streamed: boolean;
    createdAt: string;
}

export interface CreditEntry {
    id: number;
    amount: number;
    reason: string;
    reference: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: string;
}

export interface CreditSummary {
    balance: number;
    granted: number;
    spent: number;
    today: { granted: number; spent: number };
    recent: CreditEntry[];
}

export interface Invite {
    code: string;
    createdAt: string;
    usedBy: string | null;
    usedAt: string | null;
}

export interface Me {
    user: User;
    usage: UsageSummary | null;
    credits: CreditSummary | null;
}

export interface LoginResult {
    user: User;
    token: string;
    expiresAt: string;
    credits?: { balance: number } | null;
}

// ------------------------------------------------------------------ market

export interface MarketStats {
    favorites: number;
    imports: number;
    views: number;
    score: number;
}

export interface MarketEntry {
    ownerId: string;
    characterId: string;
    name: string;
    tags: string[];
    descriptionLength: number;
    publishedAt: string | null;
    stats: MarketStats;
    favorited: boolean;
}

export interface RankingRow {
    rank: number;
    ownerId: string;
    characterId: string;
    name: string;
    tags: string[];
    stats: MarketStats;
    publishedAt: string | null;
}

// ------------------------------------------------------------------ turns

export interface TurnResult {
    cardId: string;
    name: string;
    reply: string;
    stats: PromptStats;
    usage: CompletionUsage;
    usageSource: string;
    latencyMs: number;
    firstTokenMs?: number;
    model: string;
    streamed: boolean;
    requestId: string;
    fromCache: boolean;
}
