/**
 * A single-user chat session: one character card, one chat log, persisted in the
 * SillyTavern JSONL format so the conversation stays portable.
 *
 * Two properties matter here and are covered by tests:
 *
 *   - A turn is atomic. The user message and the reply are appended and saved
 *     together, so a failed or aborted model call leaves the log untouched and the
 *     next attempt is a clean single turn rather than a half-written one.
 *   - Every assistant message records the request id that produced it. Retrying
 *     with the same id returns the stored reply without calling the model again,
 *     which is what stops an ambiguous failure (the client never saw the stream
 *     end, but the server finished and saved) from being paid for twice.
 */
import { randomUUID } from 'node:crypto';

import type { CharacterCard } from '../cards/types.ts';
import type { ChatMessage, ParsedChat } from '../chats/types.ts';
import { defaultHeader } from '../chats/types.ts';
import { createChatCompletion, streamChatCompletion } from '../gateway/openai.ts';
import { estimateMessagesTokens } from '../prompt/estimate.ts';
import type { CompletionUsage, ModelConfig, SamplingOverrides, UsageSource } from '../gateway/types.ts';
import { ModelError } from '../gateway/types.ts';
import type { Library } from '../library.ts';
import type { Worldbook, WorldbookEntry } from '../worldbooks/types.ts';
import { assemblePrompt } from '../prompt/assemble.ts';
import {
    EMPTY_MEMORY,
    applySummary,
    buildSummaryRequest,
    planSummaryUpTo,
    readMemoryState,
    type MemoryConfig,
    type MemoryState,
} from '../prompt/memory.ts';
import type { PromptOptions, PromptStats } from '../prompt/types.ts';
import { DEFAULT_HISTORY_TOKEN_BUDGET, DEFAULT_MAIN_PROMPT } from '../prompt/types.ts';
import type { WorldInfoState } from '../prompt/worldinfo.ts';

export interface SessionOptions {
    personaName: string;
    prompt?: Omit<PromptOptions, 'personaName'>;
    /**
     * World book ids to activate. Defaults to the card's primary world
     * (`data.extensions.world`), which is how SillyTavern links them.
     */
    worldbookIds?: string[];
    /** Start on a released version rather than the working copy. */
    version?: string;
    /** Rolling summary memory. */
    memory?: MemoryConfig;
    /**
     * Entries loaded mods contribute to the world book scan. Tagged by the
     * caller with the mod's id, so `sticky` state cannot collide across mods.
     */
    extraEntries?: Record<string, WorldbookEntry>;
}

export interface CreateSessionOptions extends SessionOptions {
    cardId: string;
    name?: string;
    /** 0 = first_mes, 1..n = alternate_greetings[n-1]. */
    greetingIndex?: number;
}

export interface SendResult {
    reply: string;
    stats: PromptStats;
    usage: CompletionUsage;
    usageSource: UsageSource;
    latencyMs: number;
    firstTokenMs?: number;
    model: string;
    streamed: boolean;
    requestId: string;
    /** True when the reply came from the log instead of a new model call. */
    fromCache: boolean;
}

interface TurnOptions {
    requestId?: string;
    overrides?: SamplingOverrides;
    signal?: AbortSignal;
    onDelta?: (delta: string) => void | Promise<void>;
    /** Replies this one replaces, kept for reference. */
    previousReplies?: string[];
}

export interface RegenerateOptions extends Omit<TurnOptions, 'previousReplies'> {
    /** Replace the last user message before regenerating. */
    userMessageOverride?: string;
}

interface StoryExtra {
    requestId?: string;
    usage?: CompletionUsage;
    usageSource?: UsageSource;
    latencyMs?: number;
    firstTokenMs?: number;
    streamed?: boolean;
    previousReplies?: string[];
    greetingIndex?: number;
    personaName?: string;
}

function storyExtra(message: ChatMessage | undefined): StoryExtra {
    const extra = message?.extra;
    if (extra === null || typeof extra !== 'object' || !('story' in extra)) {
        return {};
    }

    const value = (extra as { story?: unknown }).story;
    return value !== null && typeof value === 'object' ? value as StoryExtra : {};
}

function readWorldInfoState(metadata: Record<string, unknown>): WorldInfoState {
    const story = metadata.story;
    if (story === null || typeof story !== 'object') {
        return {};
    }

    const state = (story as { worldInfo?: unknown }).worldInfo;
    return state !== null && typeof state === 'object' ? state as WorldInfoState : {};
}

function defaultPromptOptions(): Omit<PromptOptions, 'personaName'> {
    return {
        mainPrompt: DEFAULT_MAIN_PROMPT,
        historyTokenBudget: DEFAULT_HISTORY_TOKEN_BUDGET,
    };
}

function timestampName(): string {
    const now = new Date();
    const pad = (value: number): string => String(value).padStart(2, '0');

    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
        + `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

export class ChatSession {
    readonly cardId: string;
    readonly name: string;
    readonly card: CharacterCard;
    readonly personaName: string;
    readonly promptOptions: Omit<PromptOptions, 'personaName'>;
    private readonly memoryOptions: MemoryConfig;

    private readonly library: Library;
    private readonly log: ChatMessage[];
    private metadata: Record<string, unknown>;
    private readonly worldbook: Worldbook | null;
    private worldInfoState: WorldInfoState;
    private memory: MemoryState;

    private constructor(
        library: Library,
        cardId: string,
        name: string,
        card: CharacterCard,
        options: SessionOptions,
        log: ChatMessage[],
        metadata: Record<string, unknown>,
        worldbook: Worldbook | null,
        worldInfoState: WorldInfoState,
        memory: MemoryState,
    ) {
        this.library = library;
        this.cardId = cardId;
        this.name = name;
        this.card = card;
        this.personaName = options.personaName;
        this.promptOptions = { ...defaultPromptOptions(), ...options.prompt };
        this.memoryOptions = { ...options.memory };
        this.log = log;
        this.metadata = metadata;
        this.worldbook = worldbook;
        this.worldInfoState = worldInfoState;
        this.memory = memory;
    }

    /** Which world books are active, for reporting and debugging. */
    get worldbookId(): string | null {
        return this.worldbook?.id ?? null;
    }

    static async create(library: Library, options: CreateSessionOptions): Promise<ChatSession> {
        // A conversation can start on an older release: that is what makes a
        // version worth having for the player and not only for the author.
        const card = options.version === undefined
            ? await library.getCard(options.cardId)
            : await library.getVersionCard(options.cardId, options.version);
        const name = options.name ?? timestampName();

        const existing = await library.listChats(options.cardId);
        if (existing.some((chat) => chat.name === name)) {
            throw new Error(`a chat named "${name}" already exists for ${options.cardId}`);
        }

        const greetingIndex = options.greetingIndex ?? 0;
        const greetings = [card.data.first_mes ?? '', ...(card.data.alternate_greetings ?? [])];
        const greeting = greetings[greetingIndex] ?? '';

        const log: ChatMessage[] = [];
        if (greeting.trim() !== '') {
            log.push({
                name: card.data.name,
                is_user: false,
                send_date: new Date().toISOString(),
                mes: greeting,
                extra: { story: { greetingIndex, personaName: options.personaName } satisfies StoryExtra },
            });
        }

        const worldbook = await library.resolveWorldbooks(card, options.worldbookIds);
        const withMods = mergeEntries(worldbook, options.extraEntries);

        const session = new ChatSession(
            library,
            options.cardId,
            name,
            card,
            options,
            log,
            { story: { greetingIndex, personaName: options.personaName, ...(options.version === undefined ? {} : { version: options.version }) } },
            withMods,
            {},
            { ...EMPTY_MEMORY },
        );

        await session.save();

        return session;
    }

    static async load(library: Library, cardId: string, name: string, options: SessionOptions): Promise<ChatSession> {
        const [card, chat] = await Promise.all([
            library.getCard(cardId),
            library.getChat(cardId, name),
        ]);

        const worldbook = await library.resolveWorldbooks(card, options.worldbookIds);

        return new ChatSession(
            library,
            cardId,
            name,
            card,
            options,
            chat.messages,
            { ...chat.header.chat_metadata },
            worldbook,
            readWorldInfoState(chat.header.chat_metadata),
            readMemoryState(chat.header.chat_metadata),
        );
    }

    get messages(): readonly ChatMessage[] {
        return this.log;
    }

    get header(): ParsedChat['header'] {
        return defaultHeader({
            character_name: this.card.data.name,
            user_name: this.personaName,
            chat_metadata: this.metadata,
        });
    }

    /** Look up a reply by request id, for retries that must not be charged twice. */
    private findCachedReply(requestId: string): { message: ChatMessage; stats: PromptStats } | null {
        for (let index = this.log.length - 1; index >= 0; index--) {
            const message = this.log[index];
            if (message === undefined || message.is_user) {
                continue;
            }

            if (storyExtra(message).requestId === requestId) {
                return { message, stats: this.preview(message.mes).stats };
            }
        }

        return null;
    }

    private async runTurn(config: ModelConfig, userMessage: string, options: TurnOptions): Promise<SendResult> {
        const requestId = options.requestId ?? randomUUID();

        if (options.requestId !== undefined) {
            const cached = this.findCachedReply(requestId);
            if (cached) {
                const extra = storyExtra(cached.message);
                return {
                    reply: cached.message.mes,
                    stats: cached.stats,
                    usage: extra.usage ?? {},
                    usageSource: extra.usageSource ?? 'provider',
                    latencyMs: extra.latencyMs ?? 0,
                    ...(extra.firstTokenMs !== undefined ? { firstTokenMs: extra.firstTokenMs } : {}),
                    model: (cached.message.extra?.model as string | undefined) ?? config.model,
                    streamed: extra.streamed ?? false,
                    requestId,
                    fromCache: true,
                };
            }
        }

        const assembled = assemblePrompt({
            card: this.card,
            history: this.log,
            userMessage,
            options: { personaName: this.personaName, ...this.promptOptions },
            worldbook: this.worldbook,
            worldInfoState: this.worldInfoState,
            messageIndex: this.log.length,
            memory: this.memory,
        });

        const request = {
            messages: assembled.messages,
            ...(options.overrides ? { overrides: options.overrides } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
        };

        const completion = options.onDelta
            ? await streamChatCompletion(config, request, options.onDelta)
            : await createChatCompletion(config, request);

        // Nothing is written until the model call has fully succeeded, so an
        // abort or a failure leaves the log exactly as it was.
        const now = new Date().toISOString();
        const extra: StoryExtra = {
            requestId,
            usage: completion.usage,
            usageSource: completion.usageSource,
            latencyMs: completion.latencyMs,
            streamed: completion.streamed,
            ...(completion.firstTokenMs !== undefined ? { firstTokenMs: completion.firstTokenMs } : {}),
            ...(options.previousReplies && options.previousReplies.length > 0
                ? { previousReplies: options.previousReplies }
                : {}),
        };

        // Sticky/cooldown state only advances when the turn actually lands, so a
        // failed call does not silently consume a sticky window.
        this.worldInfoState = assembled.nextWorldInfoState;
        this.persistMetadata();

        this.log.push({ name: this.personaName, is_user: true, send_date: now, mes: userMessage });
        this.log.push({
            name: this.card.data.name,
            is_user: false,
            send_date: now,
            mes: completion.content,
            extra: { model: completion.model, story: extra },
        });

        await this.save();

        return {
            reply: completion.content,
            stats: assembled.stats,
            usage: completion.usage,
            usageSource: completion.usageSource,
            latencyMs: completion.latencyMs,
            ...(completion.firstTokenMs !== undefined ? { firstTokenMs: completion.firstTokenMs } : {}),
            model: completion.model,
            streamed: completion.streamed,
            requestId,
            fromCache: false,
        };
    }

    /**
     * One turn. With `onDelta` the reply is streamed; the turn is still only
     * persisted once the stream has completed.
     *
     * This does NOT summarize. Memory maintenance is a second, separately billed
     * model call, so the caller decides when to pay for it: the server authorizes
     * it against the quota, and the CLI does it after the turn. Use
     * `summaryPlan()` to ask whether one is due and `summarize()` to run it.
     */
    async send(config: ModelConfig, userMessage: string, options: TurnOptions = {}): Promise<SendResult> {
        return this.runTurn(config, userMessage, options);
    }

    /**
     * Replace the last reply, optionally editing the user message it answered.
     *
     * The replaced reply is kept on the new message rather than discarded, and the
     * original turn is restored if the model call fails.
     */
    async regenerate(config: ModelConfig, options: RegenerateOptions = {}): Promise<SendResult> {
        const lastIndex = this.log.length - 1;
        const assistant = this.log[lastIndex];
        const user = this.log[lastIndex - 1];

        if (!assistant || assistant.is_user) {
            throw new Error('the last message is not a character reply; nothing to regenerate');
        }

        if (!user || !user.is_user) {
            throw new Error('no user turn before the last reply; nothing to regenerate');
        }

        const previousReplies = [...(storyExtra(assistant).previousReplies ?? []), assistant.mes];

        // Remove both messages and let runTurn append them again, so the log stays
        // a clean user/assistant pair no matter how this turns out.
        this.log.pop();
        this.log.pop();

        const userMessage = options.userMessageOverride ?? user.mes;

        try {
            return await this.runTurn(config, userMessage, {
                ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
                ...(options.overrides !== undefined ? { overrides: options.overrides } : {}),
                ...(options.signal !== undefined ? { signal: options.signal } : {}),
                ...(options.onDelta !== undefined ? { onDelta: options.onDelta } : {}),
                previousReplies,
            });
        } catch (error) {
            this.log.push(user, assistant);
            throw error;
        }
    }

    get memoryState(): MemoryState {
        return { ...this.memory };
    }

    /**
     * Replace the text of one message.
     *
     * A log edit rather than a turn: nothing is asked of the model and nothing
     * is charged. It is how "the bot said what I meant, differently" gets fixed
     * without deleting the exchange and retyping it.
     *
     * Rewording and *rerolling* are different actions: to change what the last
     * reply answers, use `regenerate` with `userMessageOverride`, which keeps the
     * replaced reply in `previousReplies` instead of dropping it.
     */
    editMessage(index: number, text: string): ChatMessage {
        const message = this.log[index];
        if (message === undefined) {
            throw new Error(`no message at index ${index}`);
        }

        message.mes = text;
        return message;
    }

    /**
     * Remove one message from the log.
     *
     * Editing is not a separate operation: change the user message and use
     * `regenerate` with `userMessageOverride`, which keeps the replaced reply in
     * `previousReplies` instead of dropping it on the floor.
     *
     * The rolling summary can only stand in for messages that still exist, so its
     * watermark is clamped to the new log length.
     */
    deleteMessage(index: number): ChatMessage {
        if (!Number.isInteger(index) || index < 0 || index >= this.log.length) {
            throw new Error(`no message at index ${index}`);
        }

        const removed = this.log.splice(index, 1)[0] as ChatMessage;

        if (this.memory.upTo > this.log.length) {
            this.memory = { ...this.memory, upTo: this.log.length };
        }

        this.persistMetadata();
        return removed;
    }

    get memoryConfig(): MemoryConfig {
        return { ...this.memoryOptions };
    }

    /**
     * What a summarization pass would do, without doing it.
     *
     * Exposed so a caller can authorize the extra model call against the quota
     * before it happens: a summary is a real call and must be billed like one.
     */
    summaryPlan(): { upTo: number; messages: number; estimatedPromptTokens: number; maxTokens: number } | null {
        const upTo = planSummaryUpTo(this.memory, this.log.length, this.memoryOptions);
        if (upTo === null) {
            return null;
        }

        const chunk = this.log.slice(this.memory.upTo, upTo);
        if (chunk.length === 0) {
            return null;
        }

        const request = buildSummaryRequest({
            previous: this.memory.text,
            upTo,
            messages: chunk,
            config: this.memoryOptions,
        });

        return {
            upTo,
            messages: chunk.length,
            estimatedPromptTokens: estimateMessagesTokens(request.messages),
            maxTokens: request.maxTokens,
        };
    }

    /**
     * Merge the next chunk of history into the rolling summary and persist it.
     * Returns null when there is nothing to summarize.
     */
    async summarize(config: ModelConfig): Promise<{
        upTo: number;
        passes: number;
        text: string;
        model: string;
        usage: CompletionUsage;
        usageSource: UsageSource;
    } | null> {
        const plan = this.summaryPlan();
        if (plan === null) {
            return null;
        }

        const chunk = this.log.slice(this.memory.upTo, plan.upTo);
        const request = buildSummaryRequest({
            previous: this.memory.text,
            upTo: plan.upTo,
            messages: chunk,
            config: this.memoryOptions,
        });

        // Cheap and literal: a summary is a compression task, not a writing one.
        const completion = await createChatCompletion(config, {
            messages: request.messages,
            overrides: { maxTokens: request.maxTokens, temperature: 0.3 },
        });

        this.memory = applySummary(this.memory, completion.content, plan.upTo, { model: completion.model });
        this.persistMetadata();
        await this.save();

        return {
            upTo: this.memory.upTo,
            passes: this.memory.passes,
            text: this.memory.text,
            model: completion.model,
            usage: completion.usage,
            usageSource: completion.usageSource,
        };
    }

    /** Preview the prompt for the next message without calling the model. */
    preview(userMessage: string): ReturnType<typeof assemblePrompt> {
        return assemblePrompt({
            card: this.card,
            history: this.log,
            userMessage,
            options: { personaName: this.personaName, ...this.promptOptions },
            worldbook: this.worldbook,
            worldInfoState: this.worldInfoState,
            messageIndex: this.log.length,
            memory: this.memory,
        });
    }

    /** Write the current world info and memory state back into the chat metadata. */
    private persistMetadata(): void {
        this.metadata = {
            ...this.metadata,
            story: {
                ...(this.metadata.story as Record<string, unknown> | undefined ?? {}),
                worldInfo: this.worldInfoState,
                memory: this.memory,
            },
        };
    }

    async save(): Promise<void> {
        await this.library.putChat(this.cardId, this.name, {
            header: this.header,
            messages: this.log,
        });
    }
}

export { ModelError };

/** Fold a loaded mod's entries into the same scan as the card's own books. */
function mergeEntries(
    worldbook: Worldbook | null,
    extra: Record<string, WorldbookEntry> | undefined,
): Worldbook | null {
    if (extra === undefined || Object.keys(extra).length === 0) {
        return worldbook;
    }

    return {
        ...(worldbook ?? { entries: {} }),
        entries: { ...(worldbook?.entries ?? {}), ...extra },
    };
}
