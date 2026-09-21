/**
 * The character market: publishing, browsing, favorites and rankings.
 *
 * Three decisions worth stating up front:
 *
 *   1. **The listing reads from the database, not from disk.** A published card is
 *      snapshotted into `character_shares` (name, tags, description length) at
 *      publish time. Browsing therefore never walks every user's directory — which
 *      is the only way a market page stays fast once there is more than one user.
 *      The snapshot can go stale if the owner edits the card; republishing refreshes
 *      it, and that is the documented tradeoff.
 *   2. **Rankings aggregate per day.** `character_stats` holds one row per character
 *      per day, so a windowed ranking is a range scan over a small table instead of
 *      a scan over every raw view/import event.
 *   3. **Public means public.** `get`/`list` expose only `visibility = 'public'`
 *      rows. A private character is invisible to everyone but its owner, no matter
 *      how the id is guessed.
 */
import type { Database } from '../db/database.ts';

export type RankingWindow = 'day' | 'week' | 'month' | 'all';
export type MarketSort = 'hot' | 'new' | 'name';

/** Favorites signal intent more strongly than a view, an import sits in between. */
export const RANKING_WEIGHTS = { favorite: 3, import: 2, view: 1 } as const;

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

export interface PublishSnapshot {
    name: string;
    tags: string[];
    descriptionLength: number;
}

export interface MarketServiceOptions {
    now?: () => Date;
}

export class MarketError extends Error {
    readonly code: 'not_published';
    readonly status: number;

    constructor(code: MarketError['code'], message: string, status: number) {
        super(message);
        this.name = 'MarketError';
        this.code = code;
        this.status = status;
    }
}

function emptyStats(): MarketStats {
    return { favorites: 0, imports: 0, views: 0, score: 0 };
}

export function scoreOf(stats: { favorites: number; imports: number; views: number }): number {
    return stats.favorites * RANKING_WEIGHTS.favorite + stats.imports * RANKING_WEIGHTS.import + stats.views * RANKING_WEIGHTS.view;
}

function windowStart(window: RankingWindow, at: Date): string | null {
    if (window === 'all') {
        return null;
    }

    const days = window === 'day' ? 1 : window === 'week' ? 7 : 30;
    const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - (days - 1)));

    return start.toISOString().slice(0, 10);
}

function parseTags(raw: string): string[] {
    return raw.split(',').map((tag) => tag.trim()).filter((tag) => tag.length > 0);
}

export class MarketService {
    readonly #db: Database;
    readonly #now: () => Date;

    constructor(db: Database, options: MarketServiceOptions = {}) {
        this.#db = db;
        this.#now = options.now ?? ((): Date => new Date());
    }

    /** Publish (or refresh the snapshot of) one of the caller's own characters. */
    publish(ownerId: string, characterId: string, snapshot: PublishSnapshot): MarketEntry {
        const now = this.#now().toISOString();

        this.#db.prepare(
            `INSERT INTO character_shares
                (user_id, character_id, visibility, name, tags, description_length, published_at, updated_at)
             VALUES (?, ?, 'public', ?, ?, ?, ?, ?)
             ON CONFLICT (user_id, character_id) DO UPDATE SET
                visibility = 'public',
                name = excluded.name,
                tags = excluded.tags,
                description_length = excluded.description_length,
                -- keep the original publish time so re-publishing does not jump the
                -- character to the top of "new"
                published_at = COALESCE(character_shares.published_at, excluded.published_at),
                updated_at = excluded.updated_at`,
        ).run(
            ownerId,
            characterId,
            snapshot.name,
            snapshot.tags.join(','),
            Math.max(0, Math.trunc(snapshot.descriptionLength)),
            now,
            now,
        );

        const entry = this.get(ownerId, characterId, ownerId);
        if (entry === null) {
            throw new MarketError('not_published', 'character could not be published', 500);
        }

        return entry;
    }

    unpublish(ownerId: string, characterId: string): boolean {
        const result = this.#db.prepare(
            `UPDATE character_shares SET visibility = 'private', updated_at = ?
             WHERE user_id = ? AND character_id = ? AND visibility = 'public'`,
        ).run(this.#now().toISOString(), ownerId, characterId);

        return Number(result.changes) > 0;
    }

    isPublic(ownerId: string, characterId: string): boolean {
        const row = this.#db.prepare(
            `SELECT 1 AS ok FROM character_shares
             WHERE user_id = ? AND character_id = ? AND visibility = 'public'`,
        ).get(ownerId, characterId) as { ok: number | bigint } | undefined;

        return row !== undefined;
    }

    /** Published characters of one owner. `requesterId` decides whether `favorited` is meaningful. */
    listByOwner(ownerId: string, requesterId?: string): MarketEntry[] {
        const rows = this.#db.prepare(
            `SELECT character_id, name, tags, description_length, published_at
             FROM character_shares WHERE user_id = ? AND visibility = 'public'
             ORDER BY published_at DESC, character_id ASC`,
        ).all(ownerId) as unknown as ShareRow[];

        const stats = this.#aggregate('all');
        const favorites = requesterId === undefined ? new Set<string>() : this.#favoriteKeys(requesterId);

        return rows.map((row) => this.#toEntry(ownerId, row, stats, favorites));
    }

    get(ownerId: string, characterId: string, requesterId?: string): MarketEntry | null {
        const row = this.#db.prepare(
            `SELECT character_id, name, tags, description_length, published_at
             FROM character_shares
             WHERE user_id = ? AND character_id = ? AND visibility = 'public'`,
        ).get(ownerId, characterId) as ShareRow | undefined;

        if (row === undefined) {
            return null;
        }

        const stats = this.#aggregate('all');
        const favorites = requesterId === undefined ? new Set<string>() : this.#favoriteKeys(requesterId);

        return this.#toEntry(ownerId, row, stats, favorites);
    }

    /**
     * Browse. `q` matches the snapshotted name or tags; `sort` picks hot (default),
     * new or name. Stats are always all-time here — a listing that changed its
     * numbers depending on a window the user cannot see would be confusing.
     */
    list(options: {
        q?: string;
        tag?: string;
        sort?: MarketSort;
        limit?: number;
        offset?: number;
        requesterId?: string;
    } = {}): MarketEntry[] {
        const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 20)));
        const offset = Math.max(0, Math.trunc(options.offset ?? 0));
        const sort = options.sort ?? 'hot';

        const where: string[] = ["visibility = 'public'"];
        const params: (string | number)[] = [];

        const query = options.q?.trim();
        if (query !== undefined && query.length > 0) {
            where.push('(name LIKE ? OR tags LIKE ?)');
            const like = `%${query}%`;
            params.push(like, like);
        }

        const tag = options.tag?.trim();
        if (tag !== undefined && tag.length > 0) {
            // Tags are stored comma-joined with no padding, so wrapping both sides
            // keeps "cat" from matching "category".
            where.push("(',' || tags || ',') LIKE ?");
            params.push(`%,${tag},%`);
        }

        const order = sort === 'new'
            ? 'published_at DESC, name ASC'
            : sort === 'name'
                ? 'name ASC, published_at DESC'
                : 'name ASC'; // re-sorted by score below

        const rows = this.#db.prepare(
            `SELECT user_id, character_id, name, tags, description_length, published_at
             FROM character_shares WHERE ${where.join(' AND ')}
             ORDER BY ${order} LIMIT ? OFFSET ?`,
        ).all(...params, limit, offset) as unknown as (ShareRow & { user_id: string })[];

        const stats = this.#aggregate('all');
        const favorites = options.requesterId === undefined ? new Set<string>() : this.#favoriteKeys(options.requesterId);

        const entries = rows.map((row) => this.#toEntry(row.user_id, row, stats, favorites));

        if (sort === 'hot') {
            entries.sort((a, b) => b.stats.score - a.stats.score || a.name.localeCompare(b.name));
        }

        return entries;
    }

    /** Top characters for a window, from the daily aggregate table. */
    rankings(window: RankingWindow = 'day', limit = 20): RankingRow[] {
        const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
        const stats = this.#aggregate(window);

        const shared = this.#db.prepare(
            `SELECT user_id, character_id, name, tags, published_at
             FROM character_shares WHERE visibility = 'public'`,
        ).all() as unknown as (ShareRow & { user_id: string })[];

        const rows: RankingRow[] = [];
        for (const row of shared) {
            const key = `${row.user_id}/${row.character_id}`;
            const found = stats.get(key) ?? emptyStats();

            rows.push({
                rank: 0,
                ownerId: row.user_id,
                characterId: row.character_id,
                name: row.name,
                tags: parseTags(row.tags),
                stats: found,
                publishedAt: row.published_at,
            });
        }

        rows.sort((a, b) => b.stats.score - a.stats.score || b.stats.imports - a.stats.imports || a.name.localeCompare(b.name));

        return rows.slice(0, bounded).map((row, index) => ({ ...row, rank: index + 1 }));
    }

    /** A view of a public character. Unpublished characters are not counted. */
    recordView(ownerId: string, characterId: string): void {
        if (!this.isPublic(ownerId, characterId)) {
            return;
        }

        this.#bump(ownerId, characterId, 'views');
    }

    recordImport(ownerId: string, characterId: string): void {
        if (!this.isPublic(ownerId, characterId)) {
            return;
        }

        this.#bump(ownerId, characterId, 'imports');
    }

    /**
     * Toggle a favorite. Returns the new state and the character's favorite count,
     * so a client can update without a second request.
     */
    setFavorite(userId: string, ownerId: string, characterId: string, favorited: boolean): { favorited: boolean; favorites: number } {
        if (!this.isPublic(ownerId, characterId)) {
            throw new MarketError('not_published', 'this character is not published', 404);
        }

        return this.#db.transaction(() => {
            const existing = this.#db.prepare(
                'SELECT 1 AS ok FROM character_favorites WHERE user_id = ? AND owner_id = ? AND character_id = ?',
            ).get(userId, ownerId, characterId) as { ok: number | bigint } | undefined;

            const isFavorite = existing !== undefined;
            if (favorited && !isFavorite) {
                this.#db.prepare(
                    'INSERT INTO character_favorites (user_id, owner_id, character_id, created_at) VALUES (?, ?, ?, ?)',
                ).run(userId, ownerId, characterId, this.#now().toISOString());
                this.#bump(ownerId, characterId, 'favorites', 1);
            } else if (!favorited && isFavorite) {
                this.#db.prepare(
                    'DELETE FROM character_favorites WHERE user_id = ? AND owner_id = ? AND character_id = ?',
                ).run(userId, ownerId, characterId);
                this.#bump(ownerId, characterId, 'favorites', -1);
            }

            return { favorited: favorited, favorites: this.statsFor(ownerId, characterId).favorites };
        });
    }

    /** All-time numbers for one character. */
    statsFor(ownerId: string, characterId: string): MarketStats {
        const row = this.#db.prepare(
            `SELECT COALESCE(SUM(favorites), 0) AS favorites,
                    COALESCE(SUM(imports), 0) AS imports,
                    COALESCE(SUM(views), 0) AS views
             FROM character_stats WHERE owner_id = ? AND character_id = ?`,
        ).get(ownerId, characterId) as { favorites: number | bigint; imports: number | bigint; views: number | bigint };

        const stats = {
            favorites: Number(row.favorites),
            imports: Number(row.imports),
            views: Number(row.views),
        };

        return { ...stats, score: scoreOf(stats) };
    }

    /** The characters this user favorited, most recent first. */
    favoritesFor(userId: string, limit = 50): MarketEntry[] {
        const rows = this.#db.prepare(
            `SELECT s.user_id, s.character_id, s.name, s.tags, s.description_length, s.published_at, f.created_at AS favorited_at
             FROM character_favorites f
             JOIN character_shares s
               ON s.user_id = f.owner_id AND s.character_id = f.character_id AND s.visibility = 'public'
             WHERE f.user_id = ?
             ORDER BY f.created_at DESC LIMIT ?`,
        ).all(userId, Math.max(1, Math.min(200, Math.trunc(limit)))) as unknown as (ShareRow & { user_id: string })[];

        const stats = this.#aggregate('all');
        const favorites = this.#favoriteKeys(userId);

        return rows.map((row) => this.#toEntry(row.user_id, row, stats, favorites));
    }

    #bump(ownerId: string, characterId: string, column: 'favorites' | 'imports' | 'views', by = 1): void {
        const day = this.#now().toISOString().slice(0, 10);

        // `MAX(0, ...)` keeps a favorite toggle race from producing a negative count.
        this.#db.prepare(
            `INSERT INTO character_stats (owner_id, character_id, day, favorites, imports, views)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (owner_id, character_id, day) DO UPDATE SET
                ${column} = MAX(0, character_stats.${column} + excluded.${column})`,
        ).run(
            ownerId,
            characterId,
            day,
            column === 'favorites' ? by : 0,
            column === 'imports' ? by : 0,
            column === 'views' ? by : 0,
        );
    }

    /** key = "ownerId/characterId" -> aggregated stats for the window. */
    #aggregate(window: RankingWindow): Map<string, MarketStats> {
        const start = windowStart(window, this.#now());
        const sql = `SELECT owner_id, character_id,
                            COALESCE(SUM(favorites), 0) AS favorites,
                            COALESCE(SUM(imports), 0) AS imports,
                            COALESCE(SUM(views), 0) AS views
                     FROM character_stats
                     ${start === null ? '' : 'WHERE day >= ?'}
                     GROUP BY owner_id, character_id`;

        const rows = (start === null ? this.#db.prepare(sql).all() : this.#db.prepare(sql).all(start)) as unknown as {
            owner_id: string;
            character_id: string;
            favorites: number | bigint;
            imports: number | bigint;
            views: number | bigint;
        }[];

        const map = new Map<string, MarketStats>();
        for (const row of rows) {
            const stats = {
                favorites: Number(row.favorites),
                imports: Number(row.imports),
                views: Number(row.views),
            };
            map.set(`${row.owner_id}/${row.character_id}`, { ...stats, score: scoreOf(stats) });
        }

        return map;
    }

    #favoriteKeys(userId: string): Set<string> {
        const rows = this.#db.prepare(
            'SELECT owner_id, character_id FROM character_favorites WHERE user_id = ?',
        ).all(userId) as unknown as { owner_id: string; character_id: string }[];

        return new Set(rows.map((row) => `${row.owner_id}/${row.character_id}`));
    }

    #toEntry(ownerId: string, row: ShareRow, stats: Map<string, MarketStats>, favorites: Set<string>): MarketEntry {
        return {
            ownerId,
            characterId: row.character_id,
            name: row.name,
            tags: parseTags(row.tags),
            descriptionLength: Number(row.description_length),
            publishedAt: row.published_at,
            stats: stats.get(`${ownerId}/${row.character_id}`) ?? emptyStats(),
            favorited: favorites.has(`${ownerId}/${row.character_id}`),
        };
    }
}

interface ShareRow {
    character_id: string;
    name: string;
    tags: string;
    description_length: number | bigint;
    published_at: string | null;
}
