/**
 * World book (World Info) engine.
 *
 * A pure function over (entries, chat, options) → activated entries, plus explicit
 * sticky/cooldown state that the caller stores and hands back. Nothing here reads
 * the clock, the filesystem or a global; the random source is injectable, which is
 * what makes probability testable.
 *
 * Field semantics and enum values were taken from SillyTavern 1.19:
 *   position: 0 before · 1 after · 2 ANTop · 3 ANBottom · 4 atDepth · 5 EMTop · 6 EMBottom · 7 outlet
 *   logic:    0 AND_ANY · 1 NOT_ALL · 2 NOT_ANY · 3 AND_ALL
 *   role:     0 system · 1 user · 2 assistant (default system, only used at depth)
 *   defaults: scan depth 2, insertion depth 4, min activations 0
 *
 * Deliberate deviations, documented rather than hidden:
 *   - The budget is expressed in estimated tokens. SillyTavern's is a percentage
 *     of the context window; tokens are what this engine can actually measure.
 *   - Author's Note is not implemented, so ANTop/ANBottom collapse onto the
 *     history boundaries (just before / just after the chat history).
 *   - `outlet` (7) has no meaning here and is treated as `after`.
 *   - Group scoring (`group`, `groupWeight`, `useGroupScoring`) and vectorised
 *     retrieval are not implemented in M3.
 */
import type { ChatMessage } from '../chats/types.ts';
import type { Worldbook, WorldbookEntry } from '../worldbooks/types.ts';
import { estimateTokens } from './estimate.ts';
import { substituteNames, type ExampleNames } from './examples.ts';

export const POSITION = {
    before: 0,
    after: 1,
    ANTop: 2,
    ANBottom: 3,
    atDepth: 4,
    EMTop: 5,
    EMBottom: 6,
    outlet: 7,
} as const;

export const LOGIC = {
    AND_ANY: 0,
    NOT_ALL: 1,
    NOT_ANY: 2,
    AND_ALL: 3,
} as const;

export const ROLE = {
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
} as const;

export const DEFAULT_SCAN_DEPTH = 2;
export const DEFAULT_INSERTION_DEPTH = 4;
export const DEFAULT_TOKEN_BUDGET = 1500;
export const DEFAULT_MAX_RECURSION_STEPS = 3;

export type InsertionTarget =
    | 'before_definition'
    | 'after_definition'
    | 'before_examples'
    | 'after_examples'
    | 'before_history'
    | 'after_history'
    | 'at_depth';

export type MatchReason = 'constant' | 'key' | 'sticky';
export type PromptRoleName = 'system' | 'user' | 'assistant';

export interface WorldInfoConfig {
    /** How many recent messages each entry scans, unless it overrides this. */
    scanDepth?: number;
    /** Estimated-token ceiling for everything this scan injects. */
    tokenBudget?: number;
    /** Scan the content of activated entries for further activations. */
    recursive?: boolean;
    maxRecursionSteps?: number;
    caseSensitive?: boolean;
    matchWholeWords?: boolean;
    /** Injectable so probability can be tested deterministically. */
    random?: () => number;
    names?: ExampleNames;
}

/** Cross-turn state for sticky/cooldown, keyed by entry uid. */
export interface WorldInfoTimedEffect {
    /** Message index up to which the entry stays active after a hit. */
    stickyUntil?: number;
    /** Message index up to which the entry may not activate again. */
    cooldownUntil?: number;
}

export type WorldInfoState = Record<string, WorldInfoTimedEffect>;

export interface ActivatedWorldInfoEntry {
    uid: number;
    /** Which book it came from, so identities stay unique across books. */
    world: string;
    /** `<world>.<uid>`: the key its sticky/cooldown state lives under. */
    stateKey: string;
    comment: string;
    reason: MatchReason;
    matchedKeys: string[];
    target: InsertionTarget;
    depth: number;
    order: number;
    role: PromptRoleName;
    content: string;
    estimatedTokens: number;
}

export interface WorldInfoScanResult {
    activated: ActivatedWorldInfoEntry[];
    nextState: WorldInfoState;
    scannedMessages: number;
    candidates: number;
    skippedByDisabled: number;
    skippedByDelay: number;
    skippedByKeyLogic: number;
    skippedByProbability: number;
    skippedByCooldown: number;
    skippedByBudget: number;
    recursionSteps: number;
    estimatedTokens: number;
}

export interface WorldInfoScanInput {
    worldbook: Worldbook | null | undefined;
    history: ChatMessage[];
    userMessage: string;
    /** How many messages the conversation has, used by delay/sticky/cooldown. */
    messageIndex: number;
    state?: WorldInfoState;
    config?: WorldInfoConfig;
    /** Injected by tests; defaults to Math.random. */
    random?: () => number;
}

const REGEX_KEY = /^\/(.+)\/([a-z]*)$/;

/**
 * Identity of an entry for sticky/cooldown bookkeeping.
 *
 * Qualified by book name because uids are only unique inside one book — this is
 * the same composite key SillyTavern uses.
 */
function entryStateKey(entry: WorldbookEntry): string {
    const world = typeof entry.world === 'string' ? entry.world : '';
    return `${world}.${entry.uid}`;
}

/** Match one key against one message. Supports `/regex/flags` keys. */
export function keyMatches(
    key: string,
    text: string,
    options: { caseSensitive: boolean; matchWholeWords: boolean },
): boolean {
    const trimmed = key.trim();

    if (trimmed === '') {
        return false;
    }

    const regexForm = REGEX_KEY.exec(trimmed);
    if (regexForm) {
        const [, pattern, flags] = regexForm;
        try {
            return new RegExp(pattern as string, flags ?? '').test(text);
        } catch {
            // A broken regex in a card must not take down the whole scan.
            return false;
        }
    }

    if (!options.matchWholeWords) {
        return options.caseSensitive
            ? text.includes(trimmed)
            : text.toLowerCase().includes(trimmed.toLowerCase());
    }

    // Boundaries are Latin/digit only. CJK has no spaces, so treating CJK letters
    // as word characters would make whole-word matching useless on Chinese cards
    // (SillyTavern's `\b` based check has exactly that problem).
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundary = `(^|[^\\p{Script=Latin}\\p{N}_])${escaped}($|[^\\p{Script=Latin}\\p{N}_])`;

    try {
        return new RegExp(boundary, options.caseSensitive ? 'u' : 'ui').test(text);
    } catch {
        return text.includes(trimmed);
    }
}

function matchesAny(keys: string[], text: string, options: { caseSensitive: boolean; matchWholeWords: boolean }): string[] {
    return keys.filter((key) => keyMatches(key, text, options));
}

function insertionFor(entry: WorldbookEntry): { target: InsertionTarget; depth: number } {
    switch (entry.position) {
        case POSITION.before:
            return { target: 'before_definition', depth: 0 };
        case POSITION.after:
            return { target: 'after_definition', depth: 0 };
        case POSITION.ANTop:
            return { target: 'before_history', depth: 0 };
        case POSITION.ANBottom:
            return { target: 'after_history', depth: 0 };
        case POSITION.atDepth:
            return { target: 'at_depth', depth: typeof entry.depth === 'number' ? entry.depth : DEFAULT_INSERTION_DEPTH };
        case POSITION.EMTop:
            return { target: 'before_examples', depth: 0 };
        case POSITION.EMBottom:
            return { target: 'after_examples', depth: 0 };
        default:
            return { target: 'after_definition', depth: 0 };
    }
}

function roleFor(entry: WorldbookEntry): PromptRoleName {
    switch (entry.role) {
        case ROLE.USER:
            return 'user';
        case ROLE.ASSISTANT:
            return 'assistant';
        default:
            return 'system';
    }
}

/** `keysecondary` logic, evaluated only when the entry is `selective`. */
function secondarySatisfied(entry: WorldbookEntry, text: string, options: { caseSensitive: boolean; matchWholeWords: boolean }): boolean {
    const secondary = entry.keysecondary ?? [];

    if (secondary.length === 0) {
        return true;
    }

    const matched = matchesAny(secondary, text, options);

    switch (entry.selectiveLogic as number | undefined) {
        case LOGIC.AND_ALL:
            return matched.length === secondary.length;
        case LOGIC.NOT_ALL:
            return matched.length !== secondary.length;
        case LOGIC.NOT_ANY:
            return matched.length === 0;
        case LOGIC.AND_ANY:
        default:
            return matched.length > 0;
    }
}

function haystackFor(
    entry: WorldbookEntry,
    history: ChatMessage[],
    userMessage: string,
    globalScanDepth: number,
): string[] {
    const depth = typeof entry.scanDepth === 'number' && entry.scanDepth > 0 ? entry.scanDepth : globalScanDepth;
    const window = history.slice(Math.max(0, history.length - depth));

    return [...window.map((message) => message.mes), userMessage];
}

/**
 * Decide which entries fire, honouring constant keys, selective logic, delay,
 * probability, sticky/cooldown state and optional recursive scanning.
 */
export function scanWorldInfo(input: WorldInfoScanInput): WorldInfoScanResult {
    const config = input.config ?? {};
    const random = input.random ?? config.random ?? Math.random;
    const scanDepth = config.scanDepth ?? DEFAULT_SCAN_DEPTH;
    const budget = config.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    const recursive = config.recursive ?? false;
    const maxRecursionSteps = config.maxRecursionSteps ?? DEFAULT_MAX_RECURSION_STEPS;
    const caseSensitive = config.caseSensitive ?? false;
    const matchWholeWords = config.matchWholeWords ?? false;
    const names = config.names ?? { char: 'Character', user: 'User' };

    const matchOptions = { caseSensitive, matchWholeWords };
    const entries = Object.values(input.worldbook?.entries ?? {});
    const previousState = input.state ?? {};
    const nextState: WorldInfoState = { ...previousState };

    let scannedMessages = 0;
    let skippedByDisabled = 0;
    let skippedByDelay = 0;
    let skippedByKeyLogic = 0;
    let skippedByProbability = 0;
    let skippedByCooldown = 0;

    const activated: ActivatedWorldInfoEntry[] = [];
    const activatedUids = new Set<number>();
    /** Grows during recursion: content of entries that permit it. */
    const extraHaystack: string[] = [];
    let recursionSteps = 0;

    for (let level = 0; level <= (recursive ? maxRecursionSteps : 0); level++) {
        let firedThisLevel = 0;
        /**
         * Content is only visible to the NEXT pass. Letting siblings in the same
         * pass see it would make the result depend on entry order, and would make
         * `preventRecursion` mean nothing.
         */
        const pendingHaystack: string[] = [];

        for (const entry of entries) {
            const key = entryStateKey(entry);
            const timed = previousState[key] ?? {};

            if (entry.disable === true) {
                skippedByDisabled += 1;
                continue;
            }

            if (activatedUids.has(entry.uid)) {
                continue;
            }

            // Sticky entries stay active without re-checking their keys.
            const stickyUntil = timed.stickyUntil ?? -1;
            const isSticky = stickyUntil >= input.messageIndex;

            if (!isSticky) {
                const cooldownUntil = timed.cooldownUntil ?? -1;
                if (cooldownUntil >= input.messageIndex) {
                    skippedByCooldown += 1;
                    continue;
                }

                // `delay` counts chat messages from the start of the conversation.
                if (entry.delay > 0 && input.messageIndex < entry.delay) {
                    skippedByDelay += 1;
                    continue;
                }

                // Recursion-only entries wait for a recursive pass.
                if (entry.delayUntilRecursion) {
                    const required = entry.delayUntilRecursion === true ? 1 : Number(entry.delayUntilRecursion);
                    if (level < required) {
                        continue;
                    }
                } else if (level > 0 && entry.preventRecursion === true) {
                    continue;
                }
            }

            const haystack = [...haystackFor(entry, input.history, input.userMessage, scanDepth), ...extraHaystack];
            const text = haystack.join('\n');

            if (level === 0) {
                scannedMessages = Math.max(scannedMessages, haystack.length);
            }

            let reason: MatchReason | null = null;
            let matchedKeys: string[] = [];

            if (isSticky) {
                reason = 'sticky';
            } else if (entry.constant === true) {
                reason = 'constant';
            } else {
                matchedKeys = matchesAny(entry.key ?? [], text, matchOptions);

                if (matchedKeys.length === 0) {
                    skippedByKeyLogic += 1;
                    continue;
                }

                if (entry.selective === true && !secondarySatisfied(entry, text, matchOptions)) {
                    skippedByKeyLogic += 1;
                    continue;
                }

                reason = 'key';
            }

            if (reason !== 'sticky' && entry.useProbability === true && entry.probability < 100) {
                if (random() * 100 >= entry.probability) {
                    skippedByProbability += 1;
                    continue;
                }
            }

            const { target, depth } = insertionFor(entry);
            const content = substituteNames(entry.content, names);
            const estimatedTokens = estimateTokens(content);

            activated.push({
                uid: entry.uid,
                world: typeof entry.world === 'string' ? entry.world : '',
                stateKey: key,
                comment: entry.comment,
                reason,
                matchedKeys,
                target,
                depth,
                order: entry.order,
                role: roleFor(entry),
                content,
                estimatedTokens,
            });

            activatedUids.add(entry.uid);
            firedThisLevel += 1;

            if (entry.sticky > 0 || entry.cooldown > 0) {
                nextState[key] = {
                    ...(entry.sticky > 0 ? { stickyUntil: input.messageIndex + entry.sticky } : {}),
                    ...(entry.cooldown > 0
                        ? { cooldownUntil: input.messageIndex + entry.sticky + entry.cooldown }
                        : {}),
                };
            }

            if (recursive && entry.excludeRecursion !== true) {
                pendingHaystack.push(content);
            }
        }

        if (firedThisLevel === 0) {
            break;
        }

        recursionSteps = level + 1;

        if (!recursive) {
            break;
        }

        extraHaystack.push(...pendingHaystack);
    }

    // Budget: highest `order` wins, ties broken by uid so the result is stable.
    const byPriority = [...activated].sort((a, b) => (b.order - a.order) || (a.uid - b.uid));
    const kept: ActivatedWorldInfoEntry[] = [];
    let used = 0;
    let skippedByBudget = 0;

    for (const entry of byPriority) {
        if (used + entry.estimatedTokens > budget) {
            skippedByBudget += 1;
            continue;
        }

        kept.push(entry);
        used += entry.estimatedTokens;
    }

    // Anything dropped for budget must not keep its sticky bookkeeping.
    for (const entry of byPriority) {
        if (!kept.includes(entry)) {
            delete nextState[entry.stateKey];
        }
    }

    return {
        activated: kept.sort((a, b) => (a.order - b.order) || (a.uid - b.uid)),
        nextState,
        scannedMessages,
        candidates: entries.length,
        skippedByDisabled,
        skippedByDelay,
        skippedByKeyLogic,
        skippedByProbability,
        skippedByCooldown,
        skippedByBudget,
        recursionSteps,
        estimatedTokens: used,
    };
}

export { substituteNames };
