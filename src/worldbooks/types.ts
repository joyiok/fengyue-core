/**
 * World book (World Info / Lorebook) types.
 *
 * Field list taken from a real SillyTavern world book: all four default entries
 * carry these 31 keys. Optional extras are allowed through the index signature
 * so newer SillyTavern versions do not break parsing.
 */

/**
 * The known fields, kept in their own interface without an index signature.
 *
 * This matters: `Omit<WorldbookEntry, ...>` on a type that HAS an index
 * signature collapses to just the index signature and loses every concrete
 * field type (so `ENTRY_DEFAULTS.constant` would be `unknown`). Splitting the
 * fields out keeps the defaults typed while still allowing unknown extras.
 */
export interface WorldbookEntryFields {
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
    displayIndex: number;
    addMemo: boolean;
    group: string;
    groupOverride: boolean;
    groupWeight: number;
    sticky: number;
    cooldown: number;
    delay: number;
    probability: number;
    depth: number;
    useProbability: boolean;
    role: number | null;
    vectorized: boolean;
    excludeRecursion: boolean;
    preventRecursion: boolean;
    /** true = the first recursive pass; a number = that recursion level. */
    delayUntilRecursion: boolean | number;
    scanDepth: number | null;
    caseSensitive: boolean | null;
    matchWholeWords: boolean | null;
    useGroupScoring: boolean | null;
    automationId: string;
}

/** A stored entry: every known field, plus whatever a newer version added. */
export type WorldbookEntry = WorldbookEntryFields & Record<string, unknown>;

export interface Worldbook {
    entries: Record<string, WorldbookEntry>;
    /** Book name, normally the file name without its extension. */
    id?: string;
    [key: string]: unknown;
}

/**
 * Defaults match SillyTavern's own, so a normalised book behaves the same as one
 * it wrote itself.
 */
export const ENTRY_DEFAULTS: Omit<WorldbookEntryFields, 'uid' | 'displayIndex'> = {
    key: [],
    keysecondary: [],
    comment: '',
    content: '',
    constant: false,
    selective: true,
    order: 100,
    position: 0,
    disable: false,
    addMemo: true,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    probability: 100,
    depth: 4,
    useProbability: true,
    role: null,
    vectorized: false,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: false,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
};
