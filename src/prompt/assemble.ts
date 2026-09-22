/**
 * The prompt engine: card + world book + history + the new user message becomes a
 * `messages` array.
 *
 * Documented order (see the architecture plan §2.2, extended in M3):
 *   1. world info pinned before the definition
 *   2. role instruction (main prompt)
 *   3. the card's own system_prompt
 *   4. description / personality / scenario
 *   5. world info pinned after the definition
 *   6. world info pinned around the examples, examples
 *   7. world info pinned around the history, chat history, world info at depth
 *   8. post_history_instructions — its own system message, right before the user
 *   9. the new user message
 *
 * 2–4 are one system message (most compatible), which is why world info at
 * `before`/`after` joins that same message: it belongs to the character
 * definition block.
 */
import type { CharacterCard } from '../cards/types.ts';
import type { ChatMessage } from '../chats/types.ts';
import { estimateMessagesTokens, estimateTokens } from './estimate.ts';
import { parseExampleMessages, substituteNames, type ExampleNames } from './examples.ts';
import { EMPTY_MEMORY, type MemoryState } from './memory.ts';
import {
    DEFAULT_HISTORY_TOKEN_BUDGET,
    DEFAULT_MAIN_PROMPT,
    type ModPayload,
    type PromptMessage,
    type PromptOptions,
    type PromptStats,
    type WorldInfoActivationSummary,
} from './types.ts';
import { scanWorldInfo, type ActivatedWorldInfoEntry, type WorldInfoState } from './worldinfo.ts';

const DEFAULT_MAX_HISTORY_MESSAGES = 200;

export interface AssembleInput {
    card: CharacterCard;
    history: ChatMessage[];
    userMessage: string;
    options: PromptOptions;
    /** World book to scan; normally the card's primary world. */
    worldbook?: import('../worldbooks/types.ts').Worldbook | null;
    /** Sticky/cooldown state carried across turns. */
    worldInfoState?: WorldInfoState;
    /** How many messages the conversation has, for delay/sticky/cooldown. */
    messageIndex?: number;
    /** Rolling summary that stands in for older messages. */
    memory?: MemoryState | null;
}

export interface AssembleResult {
    messages: PromptMessage[];
    stats: PromptStats;
    /** Callers persist this and hand it back on the next turn. */
    nextWorldInfoState: WorldInfoState;
}

interface HistorySelection {
    messages: PromptMessage[];
    included: number;
    droppedByBudget: number;
    droppedForRoleOrder: number;
}

function toPromptMessage(message: ChatMessage): PromptMessage {
    return {
        role: message.is_user ? 'user' : 'assistant',
        content: message.mes,
    };
}

/**
 * Choose which history messages fit.
 *
 * Priority order, which is the whole point of this function:
 *   1. Recency — the messages just before the new turn matter most, so they are
 *      taken first, from the end backwards.
 *   2. The opening line — pinned only if it still fits afterwards. A small budget
 *      should cost you the greeting, never the conversation you are in the middle
 *      of.
 *   3. Role order — the window must not start with the character's own turn,
 *      which happens whenever a trim lands mid-exchange and makes models answer
 *      themselves. The greeting is exempt: it is a legitimate opening.
 */
function selectHistory(history: ChatMessage[], budget: number, maxMessages: number): HistorySelection {
    const converted = history.map(toPromptMessage);

    const first = converted[0];
    const greeting = first?.role === 'assistant' ? first : null;
    const rest = greeting ? converted.slice(1) : converted;

    const kept: PromptMessage[] = [];
    let used = 0;

    for (let index = rest.length - 1; index >= 0; index--) {
        const candidate = rest[index];
        if (candidate === undefined) {
            break;
        }

        if (kept.length >= maxMessages) {
            break;
        }

        const cost = estimateMessagesTokens([candidate]);
        if (used + cost > budget) {
            break;
        }

        kept.unshift(candidate);
        used += cost;
    }

    let droppedByBudget = rest.length - kept.length;
    let hasGreeting = false;

    if (greeting) {
        const cost = estimateMessagesTokens([greeting]);

        // Make room by evicting the oldest kept turn, but never the most recent
        // one: the conversation you are in the middle of outranks the opening.
        while (used + cost > budget && kept.length > 1) {
            const evicted = kept.shift();
            if (evicted === undefined) {
                break;
            }
            used -= estimateMessagesTokens([evicted]);
            droppedByBudget += 1;
        }

        if (kept.length < maxMessages && used + cost <= budget) {
            kept.unshift(greeting);
            used += cost;
            hasGreeting = true;
        } else {
            droppedByBudget += 1;
        }
    }

    let droppedForRoleOrder = 0;
    const startIndex = hasGreeting ? 1 : 0;

    while (kept.length > startIndex && kept[startIndex]?.role === 'assistant') {
        kept.splice(startIndex, 1);
        droppedForRoleOrder += 1;
    }

    return {
        messages: kept,
        included: kept.length,
        droppedByBudget,
        droppedForRoleOrder,
    };
}

/** The character definition block, in order, skipping empty parts. */
function buildDefinition(
    card: CharacterCard,
    names: ExampleNames,
    mainPrompt: string,
    before: string[],
    after: string[],
    mods: ModPayload[],
): { content: string; sections: string[] } {
    const parts: string[] = [];
    const sections: string[] = [];

    parts.push(substituteNames(mainPrompt, names));
    sections.push('main');

    const cardSystemPrompt = (card.data.system_prompt ?? '').trim();
    if (cardSystemPrompt !== '') {
        parts.push(substituteNames(cardSystemPrompt, names));
        sections.push('card_system_prompt');
    }

    // `position: before` means "before the character description", which is where
    // SillyTavern puts it: after the main instruction, before the card fields.
    parts.push(...before);
    if (before.length > 0) {
        sections.push('world_info_before');
    }

    const fields: [keyof typeof card.data & string, string][] = [
        ['description', 'description'],
        ['personality', 'personality'],
        ['scenario', 'scenario'],
    ];

    for (const [field, label] of fields) {
        const value = card.data[field];
        if (typeof value === 'string' && value.trim() !== '') {
            parts.push(substituteNames(value.trim(), names));
            sections.push(label);
        }
    }

    parts.push(...after);
    if (after.length > 0) {
        sections.push('world_info_after');
    }

    // Mods last. They are loaded by the player and extend the setting; the
    // card's own material is the body of this session and stays on top.
    for (const mod of mods) {
        const text = (mod.system ?? '').trim();
        if (text !== '') {
            parts.push(substituteNames(text, names));
            sections.push(`mod:${mod.name}`);
        }
    }

    return { content: parts.join('\n\n'), sections };
}

/** Insert at-depth entries so that `depth` history messages follow each one. */
function insertAtDepth(
    history: PromptMessage[],
    entries: ActivatedWorldInfoEntry[],
): PromptMessage[] {
    if (entries.length === 0) {
        return history;
    }

    const byIndex = new Map<number, ActivatedWorldInfoEntry[]>();

    for (const entry of entries) {
        const index = Math.max(0, history.length - entry.depth);
        const bucket = byIndex.get(index);
        if (bucket) {
            bucket.push(entry);
        } else {
            byIndex.set(index, [entry]);
        }
    }

    const result: PromptMessage[] = [];

    for (let index = 0; index <= history.length; index++) {
        for (const entry of byIndex.get(index) ?? []) {
            result.push({ role: entry.role, content: entry.content });
        }

        const message = history[index];
        if (message) {
            result.push(message);
        }
    }

    return result;
}

function summarizeActivations(entries: ActivatedWorldInfoEntry[]): WorldInfoActivationSummary[] {
    return entries.map((entry) => ({
        uid: entry.uid,
        world: entry.world,
        comment: entry.comment,
        reason: entry.reason,
        matchedKeys: entry.matchedKeys,
        target: entry.target,
        depth: entry.depth,
        order: entry.order,
        role: entry.role,
        estimatedTokens: entry.estimatedTokens,
        preview: entry.content.slice(0, 80),
    }));
}

export function assemblePrompt(input: AssembleInput): AssembleResult {
    const { card, history, userMessage, options } = input;

    const names: ExampleNames = {
        char: card.data.name.trim() === '' ? 'Character' : card.data.name.trim(),
        user: options.personaName.trim() === '' ? 'User' : options.personaName.trim(),
    };

    const mods = options.mods ?? [];
    const budget = options.historyTokenBudget ?? DEFAULT_HISTORY_TOKEN_BUDGET;
    const maxMessages = options.maxHistoryMessages ?? DEFAULT_MAX_HISTORY_MESSAGES;
    const includeExamples = options.includeExamples ?? true;
    const messageIndex = input.messageIndex ?? history.length;

    // Messages already covered by the summary are not sent again: the summary
    // replaces them rather than adding to them.
    const memory = input.memory ?? EMPTY_MEMORY;
    const summarizedUpTo = Math.min(Math.max(0, memory.upTo), history.length);
    const liveHistory = summarizedUpTo > 0 ? history.slice(summarizedUpTo) : history;

    const scan = scanWorldInfo({
        worldbook: input.worldbook ?? null,
        history: liveHistory,
        userMessage,
        messageIndex,
        state: input.worldInfoState ?? {},
        config: { ...options.worldInfo, names },
    });

    const byTarget = (target: ActivatedWorldInfoEntry['target']): ActivatedWorldInfoEntry[] =>
        scan.activated.filter((entry) => entry.target === target);

    const definition = buildDefinition(
        card,
        names,
        options.mainPrompt ?? DEFAULT_MAIN_PROMPT,
        byTarget('before_definition').map((entry) => entry.content),
        byTarget('after_definition').map((entry) => entry.content),
        mods,
    );
    const selection = selectHistory(liveHistory, budget, maxMessages);

    const messages: PromptMessage[] = [{ role: 'system', content: definition.content }];
    const sections = [...definition.sections];

    const asMessages = (target: ActivatedWorldInfoEntry['target']): PromptMessage[] =>
        byTarget(target).map((entry) => ({ role: entry.role, content: entry.content }));

    const beforeExamples = asMessages('before_examples');
    if (beforeExamples.length > 0) {
        messages.push(...beforeExamples);
        sections.push('world_info_before_examples');
    }

    if (includeExamples) {
        const examples = parseExampleMessages(card.data.mes_example ?? '', names);
        if (examples.length > 0) {
            messages.push(...examples);
            sections.push('examples');
        }
    }

    const afterExamples = asMessages('after_examples');
    if (afterExamples.length > 0) {
        messages.push(...afterExamples);
        sections.push('world_info_after_examples');
    }

    const beforeHistory = asMessages('before_history');
    if (beforeHistory.length > 0) {
        messages.push(...beforeHistory);
        sections.push('world_info_before_history');
    }

    const summary = memory.text.trim();
    if (summary !== '') {
        messages.push({ role: 'system', content: `【前情摘要】\n${summary}` });
        sections.push('memory');
    }

    if (selection.messages.length > 0) {
        messages.push(...insertAtDepth(selection.messages, byTarget('at_depth')));
        sections.push('history');
        if (byTarget('at_depth').length > 0) {
            sections.push('world_info_at_depth');
        }
    } else {
        messages.push(...asMessages('at_depth'));
    }

    const afterHistory = asMessages('after_history');
    if (afterHistory.length > 0) {
        messages.push(...afterHistory);
        sections.push('world_info_after_history');
    }

    const postHistory = [
        (card.data.post_history_instructions ?? '').trim(),
        ...mods.map((mod) => (mod.postHistory ?? '').trim()).filter((text) => text !== ''),
    ].filter((text) => text !== '').join('\n\n');

    if (postHistory !== '') {
        messages.push({ role: 'system', content: substituteNames(postHistory, names) });
        sections.push('post_history_instructions');
    }

    messages.push({ role: 'user', content: userMessage });

    const historyTokens = estimateMessagesTokens(selection.messages);
    const total = estimateMessagesTokens(messages);

    return {
        messages,
        nextWorldInfoState: scan.nextState,
        stats: {
            sections,
            historyIncluded: selection.included,
            historyDropped: selection.droppedByBudget + selection.droppedForRoleOrder,
            historyDroppedForRoleOrder: selection.droppedForRoleOrder,
            estimatedTokens: total,
            estimatedHistoryTokens: historyTokens,
            estimatedOverheadTokens: total - historyTokens,
            budgetExceeded: selection.droppedByBudget > 0,
            memory: summary === ''
                ? null
                : {
                    summarizedMessages: summarizedUpTo,
                    passes: memory.passes,
                    estimatedTokens: estimateTokens(summary),
                    updatedAt: memory.updatedAt,
                    preview: summary.slice(0, 80),
                },
            worldInfo: scan.candidates === 0
                ? null
                : {
                    activated: summarizeActivations(scan.activated),
                    candidates: scan.candidates,
                    scannedMessages: scan.scannedMessages,
                    skippedByDisabled: scan.skippedByDisabled,
                    skippedByDelay: scan.skippedByDelay,
                    skippedByKeyLogic: scan.skippedByKeyLogic,
                    skippedByProbability: scan.skippedByProbability,
                    skippedByCooldown: scan.skippedByCooldown,
                    skippedByBudget: scan.skippedByBudget,
                    recursionSteps: scan.recursionSteps,
                    estimatedTokens: scan.estimatedTokens,
                },
        },
    };
}

export { estimateTokens };
