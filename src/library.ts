/**
 * A filesystem library over a SillyTavern-style user data directory:
 *
 *   <root>/characters/*.png        character cards
 *   <root>/worlds/*.json           world books
 *   <root>/chats/<character>/*.jsonl
 *
 * Keeping the same layout is the point of M0: users can point this at a
 * SillyTavern data directory and everything is already there, and anything this
 * layer writes can be read back by SillyTavern.
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { cardFromJson, cardFromPng, cardToPng, summarizeCard, type CardSummary } from './cards/io.ts';
import type { CharacterCard } from './cards/types.ts';
import { parseChatJsonl, serializeChatJsonl, summarizeChat, type ChatSummary } from './chats/jsonl.ts';
import type { ParsedChat } from './chats/types.ts';
import { isPng } from './png/chunks.ts';
import { normalizeWorldbook, summarizeWorldbook, worldbookToJson, type WorldbookSummary } from './worldbooks/io.ts';
import type { Worldbook, WorldbookEntry } from './worldbooks/types.ts';

export type CharacterListEntry =
    | ({ ok: true } & CardSummary)
    | { ok: false; id: string; error: string };

/** Reject anything that could escape the library root. */
export function assertSafeId(id: string): string {
    if (id === '' || id === '.' || id === '..' || id.includes('/') || id.includes('\\') || id.includes('\0')) {
        throw new Error(`unsafe id: ${JSON.stringify(id)}`);
    }

    return id;
}

export function safeJoin(root: string, ...parts: string[]): string {
    const base = path.resolve(root);
    const target = path.resolve(base, ...parts);

    if (target !== base && !target.startsWith(base + path.sep)) {
        throw new Error('path escapes the library root');
    }

    return target;
}

/**
 * Turn a card name into a file name. CJK is kept (Linux handles it fine and
 * users expect to recognise their own file); only characters that are unsafe in
 * a path are replaced.
 */
export function sanitizeFileName(input: string, fallback = 'character'): string {
    const cleaned = input
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/[/\\:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^\.+/, '');

    const limited = cleaned.slice(0, 80);

    return limited === '' ? fallback : limited;
}

async function exists(filePath: string): Promise<boolean> {
    try {
        await stat(filePath);
        return true;
    } catch {
        return false;
    }
}

export class Library {
    readonly root: string;
    readonly charactersDir: string;
    readonly worldsDir: string;
    readonly chatsDir: string;

    constructor(root: string) {
        this.root = path.resolve(root);
        this.charactersDir = path.join(this.root, 'characters');
        this.worldsDir = path.join(this.root, 'worlds');
        this.chatsDir = path.join(this.root, 'chats');
    }

    async ensureDirs(): Promise<void> {
        await mkdir(this.charactersDir, { recursive: true });
        await mkdir(this.worldsDir, { recursive: true });
        await mkdir(this.chatsDir, { recursive: true });
    }

    // ---------------------------------------------------------------- cards

    async listCharacters(): Promise<CharacterListEntry[]> {
        let names: string[];

        try {
            names = await readdir(this.charactersDir);
        } catch {
            return [];
        }

        const entries: CharacterListEntry[] = [];

        for (const name of names.filter((file) => path.extname(file).toLowerCase() === '.png').sort()) {
            const id = path.basename(name, '.png');

            try {
                const buffer = await readFile(safeJoin(this.charactersDir, name));
                entries.push({ ok: true, ...summarizeCard(id, cardFromPng(buffer), buffer) });
            } catch (error) {
                // A corrupt card must not take down the whole listing.
                entries.push({ ok: false, id, error: error instanceof Error ? error.message : String(error) });
            }
        }

        return entries;
    }

    async getCard(id: string): Promise<CharacterCard> {
        const buffer = await readFile(this.cardPath(id));
        return cardFromPng(buffer);
    }

    async readCardPng(id: string): Promise<Buffer> {
        return readFile(this.cardPath(id));
    }

    private cardPath(id: string): string {
        return safeJoin(this.charactersDir, `${assertSafeId(id)}.png`);
    }

    /**
     * Import a card from a PNG buffer or from JSON text/object. The avatar of an
     * imported PNG is preserved.
     */
    async importCard(
        input: Buffer | string | unknown,
        options: { filename?: string } = {},
    ): Promise<{ id: string; fileName: string; summary: CardSummary }> {
        await this.ensureDirs();

        let card: CharacterCard;
        let baseImage: Buffer | undefined;

        if (Buffer.isBuffer(input)) {
            if (isPng(input)) {
                card = cardFromPng(input);
                baseImage = input;
            } else {
                card = cardFromJson(input.toString('utf8'));
            }
        } else {
            card = cardFromJson(input);
        }

        const desired = options.filename
            ? path.basename(options.filename, path.extname(options.filename))
            : sanitizeFileName(card.data.name);

        const fileName = await this.uniqueFileName(desired);
        const png = cardToPng(card, baseImage);
        await writeFile(safeJoin(this.charactersDir, fileName), png);

        const id = path.basename(fileName, '.png');

        return { id, fileName, summary: summarizeCard(id, card, png) };
    }

    private async uniqueFileName(desired: string): Promise<string> {
        const base = sanitizeFileName(desired);

        for (let attempt = 1; attempt < 1000; attempt++) {
            const candidate = attempt === 1 ? `${base}.png` : `${base}-${attempt}.png`;
            if (!(await exists(safeJoin(this.charactersDir, candidate)))) {
                return candidate;
            }
        }

        throw new Error(`could not find a free file name for ${base}`);
    }

    /**
     * Re-encode a card as PNG. This is the export path that the M0 acceptance
     * test checks with SillyTavern's own parser: both `chara` and `ccv3` chunks
     * are written, and the original avatar is preserved.
     */
    async exportCardPng(id: string): Promise<Buffer> {
        const original = await this.readCardPng(id);
        return cardToPng(cardFromPng(original), original);
    }

    // ----------------------------------------------------------- world books

    async listWorldbooks(): Promise<WorldbookSummary[]> {
        let names: string[];

        try {
            names = await readdir(this.worldsDir);
        } catch {
            return [];
        }

        const summaries: WorldbookSummary[] = [];

        for (const name of names.filter((file) => path.extname(file).toLowerCase() === '.json').sort()) {
            const id = path.basename(name, '.json');

            try {
                const buffer = await readFile(safeJoin(this.worldsDir, name));
                summaries.push(summarizeWorldbook(id, normalizeWorldbook(JSON.parse(buffer.toString('utf8'))), buffer.length));
            } catch {
                summaries.push({ id, entries: 0, constantEntries: 0, disabledEntries: 0, bytes: 0 });
            }
        }

        return summaries;
    }

    async getWorldbook(id: string): Promise<Worldbook> {
        const text = await readFile(safeJoin(this.worldsDir, `${assertSafeId(id)}.json`), 'utf8');
        return normalizeWorldbook(JSON.parse(text));
    }

    /**
     * Write a world book. The input is normalised first, so callers can hand over
     * partial entries (which is what every importer naturally has) and still get
     * a complete file on disk.
     */
    /**
     * Load the world books that apply to a character and tag every entry with its
     * book name.
     *
     * The tag matters: entry uids are only unique inside one book, and sticky
     * bookkeeping is keyed by `<book>.<uid>`. Defaults to the card's primary world
     * (`data.extensions.world`), which is how SillyTavern links them.
     *
     * A book that was renamed or deleted is skipped rather than fatal: a broken
     * link must not make the chat unusable.
     */
    async resolveWorldbooks(card: CharacterCard, ids?: string[]): Promise<Worldbook | null> {
        const primary = card.data.extensions?.world;
        const requested = ids !== undefined && ids.length > 0
            ? ids
            : (typeof primary === 'string' && primary.trim() !== '' ? [primary.trim()] : []);

        if (requested.length === 0) {
            return null;
        }

        const entries: Record<string, WorldbookEntry> = {};
        let found = false;

        for (const id of requested) {
            try {
                const book = await this.getWorldbook(id);
                for (const [uid, entry] of Object.entries(book.entries)) {
                    entries[`${id}.${uid}`] = { ...entry, world: id };
                }
                found = true;
            } catch {
                // ignore: missing or unreadable book
            }
        }

        return found ? { id: requested.join(', '), entries } : null;
    }

    async putWorldbook(id: string, book: unknown): Promise<void> {
        await this.ensureDirs();
        await writeFile(safeJoin(this.worldsDir, `${assertSafeId(id)}.json`), worldbookToJson(normalizeWorldbook(book)), 'utf8');
    }

    // ----------------------------------------------------------------- chats

    /** Character names that have at least one chat folder. */
    async listChatCharacters(): Promise<string[]> {
        try {
            const entries = await readdir(this.chatsDir, { withFileTypes: true });
            return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
        } catch {
            return [];
        }
    }

    async listChats(character: string): Promise<ChatSummary[]> {
        const dir = safeJoin(this.chatsDir, assertSafeId(character));

        let names: string[];
        try {
            names = await readdir(dir);
        } catch {
            return [];
        }

        const summaries: ChatSummary[] = [];

        for (const name of names.filter((file) => path.extname(file).toLowerCase() === '.jsonl').sort()) {
            const id = path.basename(name, '.jsonl');

            try {
                const buffer = await readFile(safeJoin(dir, name));
                summaries.push(summarizeChat(id, parseChatJsonl(buffer.toString('utf8')), buffer.length));
            } catch {
                summaries.push({ name: id, messages: 0, userMessages: 0, lastMessageAt: null, bytes: 0 });
            }
        }

        return summaries;
    }

    async getChat(character: string, name: string): Promise<ParsedChat> {
        const filePath = safeJoin(this.chatsDir, assertSafeId(character), `${assertSafeId(name)}.jsonl`);
        return parseChatJsonl(await readFile(filePath, 'utf8'));
    }

    async putChat(character: string, name: string, chat: ParsedChat): Promise<void> {
        const dir = safeJoin(this.chatsDir, assertSafeId(character));
        await mkdir(dir, { recursive: true });
        await writeFile(safeJoin(dir, `${assertSafeId(name)}.jsonl`), serializeChatJsonl(chat), 'utf8');
    }
}
