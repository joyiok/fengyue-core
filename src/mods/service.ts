/**
 * Mods: reusable pieces a player loads onto a work at play time.
 *
 * A mod is content, not a plugin — see `docs/mods.md`. The boundary worth
 * repeating here, because it is the one this class has to respect: a mod may
 * carry *policy* (a memory preset) but never *behaviour* (a network call), or
 * `assemblePrompt` stops being a pure function and every snapshot test with it.
 *
 * The interesting rules are the card's, not the mod's. A card declares what may
 * be loaded onto it, and that declaration lives in the PNG (`extensions.story`)
 * rather than here — a card keeps its rules when it travels to another install.
 */
import type { CharacterCard } from '../cards/types.ts';
import type { Database } from '../db/database.ts';
import type { MemoryConfig } from '../prompt/memory.ts';
import type { ModPayload } from '../prompt/types.ts';
import type { WorldbookEntry } from '../worldbooks/types.ts';

export type ModVisibility = 'private' | 'public';
export type ModScope = 'shared' | 'dedicated';

/** What a card allows to be loaded onto it. */
export type ModPolicy = 'none' | 'own' | 'own-dedicated' | 'all';

export interface Mod {
    id: string;
    ownerId: string;
    name: string;
    description: string;
    visibility: ModVisibility;
    scope: ModScope;
    /** `dedicated` mods are only selectable inside this one work. */
    boundCharacterId: string | null;
    systemPrompt: string;
    postHistory: string;
    worldbook: Record<string, WorldbookEntry>;
    style: string;
    /** A memory preset: content (the instruction) plus policy (the numbers). */
    memory: Partial<MemoryConfig> | null;
    tags: string[];
    uses: number;
    createdAt: string;
    updatedAt: string;
}

export interface ModInput {
    name: string;
    description?: string;
    scope?: ModScope;
    boundCharacterId?: string | null;
    systemPrompt?: string;
    postHistory?: string;
    worldbook?: Record<string, WorldbookEntry>;
    style?: string;
    memory?: Partial<MemoryConfig> | null;
    tags?: string[];
}

export class ModError extends Error {
    readonly code: 'not_found' | 'forbidden' | 'policy' | 'invalid';
    readonly status: number;

    constructor(code: ModError['code'], message: string, status: number) {
        super(message);
        this.name = 'ModError';
        this.code = code;
        this.status = status;
    }
}

interface ModRow {
    id: string;
    owner_id: string;
    name: string;
    description: string;
    visibility: string;
    scope: string;
    bound_character_id: string | null;
    system_prompt: string;
    post_history: string;
    worldbook: string;
    style: string;
    memory: string;
    tags: string;
    uses: number | bigint;
    created_at: string;
    updated_at: string;
}

function parse<T>(json: string, fallback: T): T {
    try {
        const value = JSON.parse(json) as T;
        return value === null || typeof value !== 'object' ? fallback : value;
    } catch {
        return fallback;
    }
}

function toMod(row: ModRow): Mod {
    return {
        id: row.id,
        ownerId: row.owner_id,
        name: row.name,
        description: row.description,
        visibility: row.visibility === 'public' ? 'public' : 'private',
        scope: row.scope === 'dedicated' ? 'dedicated' : 'shared',
        boundCharacterId: row.bound_character_id,
        systemPrompt: row.system_prompt,
        postHistory: row.post_history,
        worldbook: parse<Record<string, WorldbookEntry>>(row.worldbook, {}),
        style: row.style,
        memory: row.memory === '' ? null : parse<Partial<MemoryConfig>>(row.memory, {}),
        tags: parse<string[]>(row.tags, []),
        uses: Number(row.uses),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/** What a card says about being modified. Defaults are the safe-but-open middle. */
export interface CardModRules {
    policy: ModPolicy;
    /** Embedded CSS can restyle the whole page, so it is off unless allowed. */
    style: 'forbid' | 'allow';
    /** Who wrote the card. Falls back to whoever owns the copy. */
    authorId: string | null;
}

export function cardModRules(card: CharacterCard, fallbackAuthorId: string): CardModRules {
    const story = (card.data.extensions?.story ?? {}) as { mods?: unknown; authorId?: unknown };
    const rules = (story.mods ?? {}) as { policy?: unknown; style?: unknown };

    const policy = rules.policy;
    const style = rules.style;

    return {
        // `own-dedicated` is the middle: shared mods are the point of the
        // platform, but a *dedicated* mod is somebody rewriting your character,
        // and that needs you to have written it.
        policy: policy === 'none' || policy === 'own' || policy === 'all' ? policy : 'own-dedicated',
        style: style === 'allow' ? 'allow' : 'forbid',
        authorId: typeof story.authorId === 'string' && story.authorId !== '' ? story.authorId : fallbackAuthorId,
    };
}

export class ModsService {
    readonly #db: Database;
    readonly #now: () => Date;

    constructor(db: Database, options: { now?: () => Date } = {}) {
        this.#db = db;
        this.#now = options.now ?? ((): Date => new Date());
    }

    create(ownerId: string, input: ModInput): Mod {
        const name = String(input.name ?? '').trim();
        if (name === '') {
            throw new ModError('invalid', 'a mod needs a name', 400);
        }

        const scope: ModScope = input.scope === 'dedicated' ? 'dedicated' : 'shared';
        const bound = scope === 'dedicated' ? String(input.boundCharacterId ?? '') : '';
        if (scope === 'dedicated' && bound === '') {
            throw new ModError('invalid', 'a dedicated mod must name the one work it belongs to', 400);
        }

        const id = `${slug(name)}-${this.#now().getTime().toString(36)}`;
        const stamp = this.#now().toISOString();

        this.#db.prepare(
            `INSERT INTO mods (id, owner_id, name, description, visibility, scope, bound_character_id,
                               system_prompt, post_history, worldbook, style, memory, tags, uses, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'private', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        ).run(
            id,
            ownerId,
            name,
            String(input.description ?? ''),
            scope,
            bound === '' ? null : bound,
            String(input.systemPrompt ?? ''),
            String(input.postHistory ?? ''),
            JSON.stringify(input.worldbook ?? {}),
            String(input.style ?? ''),
            input.memory === undefined || input.memory === null ? '' : JSON.stringify(input.memory),
            JSON.stringify(input.tags ?? []),
            stamp,
            stamp,
        );

        return this.require(id);
    }

    update(id: string, ownerId: string, patch: ModInput): Mod {
        const existing = this.require(id);
        this.#assertOwner(existing, ownerId);

        this.#db.prepare(
            `UPDATE mods SET name = ?, description = ?, system_prompt = ?, post_history = ?,
                             worldbook = ?, style = ?, memory = ?, tags = ?, updated_at = ?
             WHERE id = ?`,
        ).run(
            String(patch.name ?? existing.name),
            String(patch.description ?? existing.description),
            String(patch.systemPrompt ?? existing.systemPrompt),
            String(patch.postHistory ?? existing.postHistory),
            JSON.stringify(patch.worldbook ?? existing.worldbook),
            String(patch.style ?? existing.style),
            patch.memory === undefined
                ? (existing.memory === null ? '' : JSON.stringify(existing.memory))
                : (patch.memory === null ? '' : JSON.stringify(patch.memory)),
            JSON.stringify(patch.tags ?? existing.tags),
            this.#now().toISOString(),
            id,
        );

        return this.require(id);
    }

    remove(id: string, ownerId: string): boolean {
        this.#assertOwner(this.require(id), ownerId);
        return Number(this.#db.prepare('DELETE FROM mods WHERE id = ?').run(id).changes) > 0;
    }

    /** Uploading to the gallery is explicit; nothing is shared as a side effect. */
    setVisibility(id: string, ownerId: string, visibility: ModVisibility): Mod {
        this.#assertOwner(this.require(id), ownerId);
        this.#db.prepare('UPDATE mods SET visibility = ?, updated_at = ? WHERE id = ?')
            .run(visibility, this.#now().toISOString(), id);
        return this.require(id);
    }

    get(id: string): Mod | null {
        const row = this.#db.prepare('SELECT * FROM mods WHERE id = ?').get(id) as unknown as ModRow | undefined;
        return row === undefined ? null : toMod(row);
    }

    require(id: string): Mod {
        const mod = this.get(id);
        if (mod === null) {
            throw new ModError('not_found', 'no such mod', 404);
        }
        return mod;
    }

    /** Everything this account owns, gallery visibility included. */
    listFor(ownerId: string): Mod[] {
        const rows = this.#db.prepare('SELECT * FROM mods WHERE owner_id = ? ORDER BY updated_at DESC')
            .all(ownerId) as unknown as ModRow[];
        return rows.map(toMod);
    }

    /**
     * The gallery: what a player may pick from for a given work. Shared mods
     * from everyone, plus dedicated mods bound to *this* work — a dedicated mod
     * is only ever selectable inside the one work it was written for.
     */
    gallery(options: { ownerId: string; characterId?: string; query?: string }): Mod[] {
        const rows = this.#db.prepare(
            'SELECT * FROM mods WHERE visibility = ? ORDER BY uses DESC, updated_at DESC LIMIT 200',
        ).all('public') as unknown as ModRow[];

        const needle = (options.query ?? '').trim().toLowerCase();

        const forThisWork = rows.map(toMod).filter((mod) =>
            mod.scope === 'shared'
            || (options.characterId !== undefined && mod.boundCharacterId === options.characterId));

        return forThisWork.filter((mod) =>
            needle === ''
            || mod.name.toLowerCase().includes(needle)
            || mod.description.toLowerCase().includes(needle)
            || mod.tags.some((tag) => tag.toLowerCase().includes(needle)));
    }

    /**
     * Check a card's rules and produce what the prompt layer should fold in.
     *
     * This is the enforcement point. Hiding a button in the UI is not a
     * boundary; anything that reaches `POST /chats` goes through here.
     */
    resolve(card: CharacterCard, cardId: string, modIds: string[], libraryOwnerId: string): ModPayload[] {
        const rules = cardModRules(card, libraryOwnerId);
        const payloads: ModPayload[] = [];

        for (const id of modIds) {
            const mod = this.get(id);
            if (mod === null) {
                throw new ModError('not_found', `no such mod: ${id}`, 404);
            }

            // A dedicated mod is only selectable inside its one work, and the
            // work is named by its *id* — the file name — not by `card.data.name`,
            // which is a display string an author can change at will.
            if (mod.scope === 'dedicated' && mod.boundCharacterId !== cardId) {
                throw new ModError('policy', `「${mod.name}」是别的作品的专用 Mod`, 403);
            }

            const mine = mod.ownerId === rules.authorId;

            if (rules.policy === 'none') {
                throw new ModError('policy', '这张卡不允许加载任何 Mod', 403);
            }
            if (rules.policy === 'own' && !mine) {
                throw new ModError('policy', '这张卡只允许加载作者自己的 Mod', 403);
            }
            if (rules.policy === 'own-dedicated' && mod.scope === 'dedicated' && !mine) {
                throw new ModError('policy', '这张卡不允许别人给它写专用 Mod', 403);
            }

            payloads.push({
                name: mod.name,
                ...(mod.systemPrompt.trim() === '' ? {} : { system: mod.systemPrompt }),
                ...(mod.postHistory.trim() === '' ? {} : { postHistory: mod.postHistory }),
            });
        }

        return payloads;
    }

    /** Everything a session has to remember about what it loaded. */
    sessionState(card: CharacterCard, cardId: string, modIds: string[], libraryOwnerId: string): {
        ids: string[];
        payloads: ModPayload[];
        entries: Record<string, WorldbookEntry>;
        memory: Partial<MemoryConfig>;
        style: string;
    } {
        const rules = cardModRules(card, libraryOwnerId);
        const loaded = modIds.map((id) => this.require(id));

        // `resolve` is what enforces; this reuses it so the two cannot drift.
        const payloads = this.resolve(card, cardId, modIds, libraryOwnerId);

        // A memory preset is policy, so the last one loaded wins — and it is
        // visible, because turning memory on means this session starts paying
        // for summarization passes.
        const memory: Partial<MemoryConfig> = {};
        const entries: Record<string, WorldbookEntry> = {};
        let style = '';

        for (const mod of loaded) {
            // A mod's world book merges into the same scan as the card's, tagged
            // with the mod's name so sticky bookkeeping cannot collide with
            // another mod's uids (`<world>.<uid>` is only unique inside a book).
            for (const [uid, entry] of Object.entries(mod.worldbook)) {
                entries[`${mod.id}.${uid}`] = { ...entry, world: mod.name };
            }

            if (mod.memory !== null) {
                Object.assign(memory, mod.memory, { enabled: true });
            }
            if (rules.style === 'allow' && mod.style.trim() !== '') {
                style = mod.style;
            }
        }

        return { ids: modIds, payloads, entries, memory, style };
    }

    /** Count a load. A statistic, not a charge: a mod is content, not a call. */
    countLoad(ids: string[]): void {
        const stamp = this.#now().toISOString();
        void stamp;
        for (const id of ids) {
            this.#db.prepare('UPDATE mods SET uses = uses + 1 WHERE id = ?').run(id);
        }
    }

    #assertOwner(mod: Mod, ownerId: string): void {
        if (mod.ownerId !== ownerId) {
            throw new ModError('forbidden', 'that is not your mod', 403);
        }
    }
}

function slug(name: string): string {
    const cleaned = name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '');
    return (cleaned === '' ? 'mod' : cleaned).slice(0, 32);
}
