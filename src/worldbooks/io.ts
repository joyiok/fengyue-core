/**
 * World book reading and writing.
 *
 * Parsing is deliberately forgiving: entries written by other tools are often
 * missing fields, and a normalised entry keeps every consumer free of
 * `?? default` noise.
 */
import { readFile, writeFile } from 'node:fs/promises';

import { ENTRY_DEFAULTS, type Worldbook, type WorldbookEntry } from './types.ts';

function asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.filter((item): item is string => typeof item === 'string');
}

function asBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asNumberOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBooleanOrNull(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

export function normalizeEntry(raw: unknown, index: number): WorldbookEntry {
    const record = (raw !== null && typeof raw === 'object' && !Array.isArray(raw))
        ? raw as Record<string, unknown>
        : {};

    return {
        ...ENTRY_DEFAULTS,
        ...record,
        uid: asNumber(record.uid, index),
        displayIndex: asNumber(record.displayIndex, index),
        key: asStringArray(record.key),
        keysecondary: asStringArray(record.keysecondary),
        comment: typeof record.comment === 'string' ? record.comment : '',
        content: typeof record.content === 'string' ? record.content : '',
        constant: asBoolean(record.constant, ENTRY_DEFAULTS.constant),
        selective: asBoolean(record.selective, ENTRY_DEFAULTS.selective),
        order: asNumber(record.order, ENTRY_DEFAULTS.order),
        position: asNumber(record.position, ENTRY_DEFAULTS.position),
        disable: asBoolean(record.disable, ENTRY_DEFAULTS.disable),
        addMemo: asBoolean(record.addMemo, ENTRY_DEFAULTS.addMemo),
        group: typeof record.group === 'string' ? record.group : '',
        groupOverride: asBoolean(record.groupOverride, ENTRY_DEFAULTS.groupOverride),
        groupWeight: asNumber(record.groupWeight, ENTRY_DEFAULTS.groupWeight),
        sticky: asNumber(record.sticky, ENTRY_DEFAULTS.sticky),
        cooldown: asNumber(record.cooldown, ENTRY_DEFAULTS.cooldown),
        delay: asNumber(record.delay, ENTRY_DEFAULTS.delay),
        probability: asNumber(record.probability, ENTRY_DEFAULTS.probability),
        depth: asNumber(record.depth, ENTRY_DEFAULTS.depth),
        useProbability: asBoolean(record.useProbability, ENTRY_DEFAULTS.useProbability),
        role: asNumberOrNull(record.role),
        vectorized: asBoolean(record.vectorized, ENTRY_DEFAULTS.vectorized),
        excludeRecursion: asBoolean(record.excludeRecursion, ENTRY_DEFAULTS.excludeRecursion),
        preventRecursion: asBoolean(record.preventRecursion, ENTRY_DEFAULTS.preventRecursion),
        delayUntilRecursion: (typeof record.delayUntilRecursion === 'boolean' || typeof record.delayUntilRecursion === 'number')
            ? record.delayUntilRecursion
            : ENTRY_DEFAULTS.delayUntilRecursion,
        scanDepth: asNumberOrNull(record.scanDepth),
        caseSensitive: asBooleanOrNull(record.caseSensitive),
        matchWholeWords: asBooleanOrNull(record.matchWholeWords),
        useGroupScoring: asBooleanOrNull(record.useGroupScoring),
        automationId: typeof record.automationId === 'string' ? record.automationId : '',
    };
}

export function normalizeWorldbook(raw: unknown): Worldbook {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('world book is not an object');
    }

    const record = raw as Record<string, unknown>;
    const rawEntries = (record.entries !== null && typeof record.entries === 'object' && !Array.isArray(record.entries))
        ? record.entries as Record<string, unknown>
        : {};

    const entries: Record<string, WorldbookEntry> = {};
    let index = 0;

    for (const [key, value] of Object.entries(rawEntries)) {
        entries[key] = normalizeEntry(value, index);
        index += 1;
    }

    return { ...record, entries };
}

export function newEntry(overrides: Partial<WorldbookEntry> = {}): WorldbookEntry {
    return normalizeEntry({ ...ENTRY_DEFAULTS, ...overrides }, overrides.uid ?? 0);
}

export function worldbookFromJson(text: string): Worldbook {
    return normalizeWorldbook(JSON.parse(text));
}

export async function readWorldbookFile(filePath: string): Promise<Worldbook> {
    return worldbookFromJson(await readFile(filePath, 'utf8'));
}

export function worldbookToJson(book: Worldbook): string {
    return JSON.stringify(book, null, 2);
}

export async function writeWorldbookFile(filePath: string, book: Worldbook): Promise<void> {
    await writeFile(filePath, worldbookToJson(book), 'utf8');
}

export interface WorldbookSummary {
    id: string;
    entries: number;
    /** Entries that fire without a keyword match. */
    constantEntries: number;
    disabledEntries: number;
    bytes: number;
}

export function summarizeWorldbook(id: string, book: Worldbook, bytes = 0): WorldbookSummary {
    const list = Object.values(book.entries);

    return {
        id,
        entries: list.length,
        constantEntries: list.filter((entry) => entry.constant).length,
        disabledEntries: list.filter((entry) => entry.disable).length,
        bytes,
    };
}
