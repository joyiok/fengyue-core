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
 *   3. **Public means public.** `get`/`list` expose only `status = 'public'`
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

export type WorkStatus = 'pending' | 'approved' | 'public' | 'rejected' | 'withdrawn';

export interface MarketEntry {
    ownerId: string;
    characterId: string;
    name: string;
    tags: string[];
    descriptionLength: number;
    /** First publication. Never changes. */
    publishedAt: string | null;
    /** What the rankings read: the scheduled release, the re-bump, the lever. */
    publishTime: string | null;
    status: WorkStatus;
    submittedAt: string | null;
    reviewedAt: string | null;
    reviewNote: string | null;
    scheduledAt: string | null;
    /** The author chose not to be named. */
    anonymous: boolean;
    rating: string;
    primaryVersion: string | null;
    stats: MarketStats;
    favorited: boolean;
}

export interface SubmitOptions {
    /** Hold the listing until this moment. Review can pass before it arrives. */
    scheduledAt?: string | null;
    /** Publish without naming the author. */
    anonymous?: boolean;
    rating?: string;
    primaryVersion?: string | null;
}

/**
 * A flag raised against a published character.
 *
 * Not a foreign key to `users` or to the listing: a report has to survive the
 * account being closed and the card being unpublished, or resolving one would
 * destroy the record of what was resolved.
 */
export interface CharacterReport {
    id: number;
    ownerId: string;
    characterId: string;
    reporterId: string;
    reason: string;
    status: 'open' | 'resolved';
    createdAt: string;
    resolvedAt: string | null;
    resolvedBy: string | null;
    action: string | null;
}

interface ReportRow {
    id: number | bigint;
    owner_id: string;
    character_id: string;
    reporter_id: string;
    reason: string;
    status: string;
    created_at: string;
    resolved_at: string | null;
    resolved_by: string | null;
    action: string | null;
}

function toReport(row: ReportRow): CharacterReport {
    return {
        id: Number(row.id),
        ownerId: row.owner_id,
        characterId: row.character_id,
        reporterId: row.reporter_id,
        reason: row.reason,
        status: row.status === 'resolved' ? 'resolved' : 'open',
        createdAt: row.created_at,
        resolvedAt: row.resolved_at,
        resolvedBy: row.resolved_by,
        action: row.action,
    };
}

function asStatus(value: string): WorkStatus {
    return value === 'pending' || value === 'approved' || value === 'rejected' || value === 'withdrawn' ? value : 'public';
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
    /**
     * Submit a work for review.
     *
     * Nothing is listed by writing a row: it goes to `pending` and a human looks
     * at it first. That is the difference between a market and a paste bin, and
     * it is also the only place a takedown has to happen *before* something is
     * public rather than after somebody complains.
     */
    submit(
        ownerId: string,
        characterId: string,
        snapshot: PublishSnapshot,
        options: SubmitOptions = {},
    ): MarketEntry {
        const now = this.#now();
        const stamp = now.toISOString();
        const scheduled = options.scheduledAt === undefined || options.scheduledAt === null || options.scheduledAt === ''
            ? null
            : new Date(options.scheduledAt).toISOString();

        this.#db.prepare(
            `INSERT INTO character_shares
                (user_id, character_id, visibility, name, tags, description_length, published_at, publish_time,
                 status, submitted_at, scheduled_at, anonymous, rating, primary_version, updated_at)
             VALUES (?, ?, 'private', ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
             ON CONFLICT (user_id, character_id) DO UPDATE SET
                name = excluded.name,
                tags = excluded.tags,
                description_length = excluded.description_length,
                status = 'pending',
                submitted_at = excluded.submitted_at,
                reviewed_at = NULL,
                reviewed_by = NULL,
                review_note = NULL,
                scheduled_at = excluded.scheduled_at,
                anonymous = excluded.anonymous,
                rating = excluded.rating,
                primary_version = COALESCE(excluded.primary_version, character_shares.primary_version),
                updated_at = excluded.updated_at`,
        ).run(
            ownerId,
            characterId,
            snapshot.name,
            snapshot.tags.join(','),
            Math.max(0, Math.trunc(snapshot.descriptionLength)),
            // Neither clock is set here. `published_at` (the record of a first
            // release) and `publish_time` (the listing clock) are both written
            // when the work is actually listed — by `review`, or by the
            // scheduled release that `#promote` performs.
            null,
            null,
            stamp,
            scheduled,
            options.anonymous === true ? 1 : 0,
            options.rating ?? 'explicit',
            options.primaryVersion ?? null,
            stamp,
        );

        return this.requireEntry(ownerId, characterId);
    }

    /**
     * The reviewer's decision.
     *
     * Approving lists it — unless the author asked for a timed release and the
     * moment has not arrived, in which case it waits in `approved` and the read
     * paths promote it when its time comes. Rejecting keeps the note the author
     * needs to read, which is the whole point of a review rather than a delete.
     */
    review(
        ownerId: string,
        characterId: string,
        moderatorId: string,
        decision: 'approve' | 'reject',
        note = '',
    ): MarketEntry {
        const now = this.#now();
        const stamp = now.toISOString();
        const row = this.#db.prepare(
            'SELECT scheduled_at FROM character_shares WHERE user_id = ? AND character_id = ?',
        ).get(ownerId, characterId) as { scheduled_at: string | null } | undefined;

        if (row === undefined) {
            throw new MarketError('not_published', 'no such submission', 404);
        }

        let status: WorkStatus;
        if (decision === 'reject') {
            status = 'rejected';
        } else {
            const scheduled = row.scheduled_at === null ? null : Date.parse(row.scheduled_at);
            status = scheduled !== null && Number.isFinite(scheduled) && scheduled > now.getTime()
                ? 'approved'
                : 'public';
        }

        this.#db.prepare(
            `UPDATE character_shares
             SET status = ?, reviewed_at = ?, reviewed_by = ?, review_note = ?,
                 visibility = ?, publish_time = CASE WHEN ? = 'public' THEN ? ELSE publish_time END,
                 published_at = CASE WHEN ? = 'public' THEN COALESCE(published_at, ?) ELSE published_at END,
                 updated_at = ?
             WHERE user_id = ? AND character_id = ?`,
        ).run(
            status, stamp, moderatorId, note,
            status === 'public' ? 'public' : 'private',
            status, stamp,
            status, stamp,
            stamp, ownerId, characterId,
        );

        return this.requireEntry(ownerId, characterId);
    }

    /** The author takes it down. Reversible: it can be submitted again. */
    withdraw(ownerId: string, characterId: string): boolean {
        const result = this.#db.prepare(
            `UPDATE character_shares SET status = 'withdrawn', visibility = 'private', updated_at = ?
             WHERE user_id = ? AND character_id = ? AND status IN ('public', 'approved', 'pending')`,
        ).run(this.#now().toISOString(), ownerId, characterId);

        return Number(result.changes) > 0;
    }

    /**
     * Move the listing's clock. This is the operator's lever: a re-bump, a
     * corrected time. `published_at` — when it was first published — never
     * moves, so the record of a first release survives every re-bump.
     */
    setPublishTime(ownerId: string, characterId: string, when: string): MarketEntry {
        const at = new Date(when);
        if (Number.isNaN(at.getTime())) {
            throw new MarketError('not_published', 'publish time must be an ISO date', 400);
        }

        this.#db.prepare(
            'UPDATE character_shares SET publish_time = ?, updated_at = ? WHERE user_id = ? AND character_id = ?',
        ).run(at.toISOString(), this.#now().toISOString(), ownerId, characterId);

        return this.requireEntry(ownerId, characterId);
    }

    /** What state a work is in, for the author's own screen. */
    stateOf(ownerId: string, characterId: string): WorkStatus | null {
        const row = this.#db.prepare(
            'SELECT status FROM character_shares WHERE user_id = ? AND character_id = ?',
        ).get(ownerId, characterId) as { status: string } | undefined;

        return row === undefined ? null : asStatus(row.status);
    }

    /** The review queue. `all` is the audit trail. */
    reviewQueue(status: 'pending' | 'all' = 'pending'): MarketEntry[] {
        this.#promote(this.#now().toISOString());

        const rows = (status === 'all'
            ? this.#db.prepare('SELECT * FROM character_shares ORDER BY submitted_at DESC LIMIT 200').all()
            : this.#db.prepare("SELECT * FROM character_shares WHERE status = 'pending' ORDER BY submitted_at ASC LIMIT 200").all()
        ) as unknown as (ShareRow & { user_id: string })[];

        // The queue is a work list, not a reader's screen: nobody's favorites
        // are relevant to whether something should be listed.
        const stats = this.#aggregate('all');
        const favorites = new Set<string>();
        return rows.map((row) => this.#toEntry(row.user_id, row, stats, favorites));
    }

    /**
     * Release the timed ones.
     *
     * Done on read rather than by a timer: a listing is the only thing a missed
     * release affects, so this is the only place it matters, and it needs no
     * background process to be running.
     */
    #promote(now: string): void {
        this.#db.prepare(
            `UPDATE character_shares
             SET status = 'public', visibility = 'public', publish_time = ?,
                 published_at = COALESCE(published_at, ?), updated_at = ?
             WHERE status = 'approved' AND scheduled_at IS NOT NULL AND scheduled_at <= ?`,
        ).run(now, now, now, now);
    }

    /** The one-step path: submit and approve. For the CLI and the tests. */
    publish(ownerId: string, characterId: string, snapshot: PublishSnapshot, options: SubmitOptions = {}): MarketEntry {
        this.submit(ownerId, characterId, snapshot, options);
        return this.review(ownerId, characterId, 'system', 'approve');
    }

    /**
     * Read a work back whatever state it is in.
     *
     * `get` is the reader's door and only opens on `public`; the submit and
     * review steps need to see their own result *before* that, so they read
     * through here instead.
     */
    requireEntry(ownerId: string, characterId: string): MarketEntry {
        const row = this.#db.prepare(
            'SELECT * FROM character_shares WHERE user_id = ? AND character_id = ?',
        ).get(ownerId, characterId) as unknown as (ShareRow & { user_id: string }) | undefined;

        if (row === undefined) {
            throw new MarketError('not_published', 'character could not be read back', 500);
        }

        return this.#toEntry(ownerId, row, this.#aggregate('all'), this.#favoriteKeys(ownerId));
    }

    unpublish(ownerId: string, characterId: string): boolean {
        return this.withdraw(ownerId, characterId);
    }

    /** How much of the market is actually in use, for the operator's overview. */
    counts(): { published: number; favorites: number } {
        const shares = this.#db.prepare('SELECT COUNT(*) AS n FROM character_shares').get() as { n: number | bigint };
        const favorites = this.#db.prepare('SELECT COUNT(*) AS n FROM character_favorites').get() as { n: number | bigint };
        return { published: Number(shares.n), favorites: Number(favorites.n) };
    }

    /**
     * Flag a published character for a human to look at.
     *
     * One open report per reporter per character: the button means "this should
     * be looked at", not a counter that a grudge can inflate.
     */
    report(ownerId: string, characterId: string, reporterId: string, reason: string): CharacterReport {
        const existing = this.#db.prepare(
            `SELECT * FROM character_reports
             WHERE owner_id = ? AND character_id = ? AND reporter_id = ? AND status = 'open'`,
        ).get(ownerId, characterId, reporterId) as ReportRow | undefined;

        if (existing !== undefined) {
            return toReport(existing);
        }

        const created = this.#now().toISOString();
        const result = this.#db.prepare(
            `INSERT INTO character_reports (owner_id, character_id, reporter_id, reason, status, created_at)
             VALUES (?, ?, ?, ?, 'open', ?)`,
        ).run(ownerId, characterId, reporterId, String(reason ?? '').slice(0, 2000), created);

        return {
            id: Number(result.lastInsertRowid),
            ownerId,
            characterId,
            reporterId,
            reason: String(reason ?? ''),
            status: 'open',
            createdAt: created,
            resolvedAt: null,
            resolvedBy: null,
            action: null,
        };
    }

    /** The queue. `open` is what an operator acts on; `resolved` is the record. */
    reports(status: 'open' | 'resolved' | 'all' = 'open'): CharacterReport[] {
        const rows = (status === 'all'
            ? this.#db.prepare('SELECT * FROM character_reports ORDER BY id DESC LIMIT 200').all()
            : this.#db.prepare('SELECT * FROM character_reports WHERE status = ? ORDER BY id DESC LIMIT 200').all(status)) as unknown as ReportRow[];

        return rows.map(toReport);
    }

    /**
     * Resolve one report: dismiss it, or take the listing down.
     *
     * Either way the report keeps its record — who raised it, who resolved it,
     * and what was done. "Resolved" is not "deleted".
     */
    resolveReport(
        reportId: number,
        moderatorId: string,
        action: 'dismiss' | 'unpublish',
    ): { report: CharacterReport; unpublished: boolean } {
        const row = this.#db.prepare('SELECT * FROM character_reports WHERE id = ?').get(reportId) as ReportRow | undefined;
        if (row === undefined) {
            throw new MarketError('not_published', 'no such report', 404);
        }

        let unpublished = false;
        if (action === 'unpublish' && row.status === 'open') {
            unpublished = this.unpublish(row.owner_id, row.character_id);
        }

        this.#db.prepare(
            `UPDATE character_reports SET status = 'resolved', resolved_at = ?, resolved_by = ?, action = ?
             WHERE id = ?`,
        ).run(this.#now().toISOString(), moderatorId, action, reportId);

        const updated = this.#db.prepare('SELECT * FROM character_reports WHERE id = ?').get(reportId) as unknown as ReportRow;
        return { report: toReport(updated), unpublished };
    }

    isPublic(ownerId: string, characterId: string): boolean {
        const row = this.#db.prepare(
            `SELECT 1 AS ok FROM character_shares
             WHERE user_id = ? AND character_id = ? AND status = 'public'`,
        ).get(ownerId, characterId) as { ok: number | bigint } | undefined;

        return row !== undefined;
    }

    /** Published characters of one owner. `requesterId` decides whether `favorited` is meaningful. */
    listByOwner(ownerId: string, requesterId?: string): MarketEntry[] {
        const rows = this.#db.prepare(
            `SELECT character_id, name, tags, description_length, published_at
             FROM character_shares WHERE user_id = ? AND status = 'public'
             ORDER BY published_at DESC, character_id ASC`,
        ).all(ownerId) as unknown as ShareRow[];

        const stats = this.#aggregate('all');
        const favorites = requesterId === undefined ? new Set<string>() : this.#favoriteKeys(requesterId);

        return rows.map((row) => this.#toEntry(ownerId, row, stats, favorites));
    }

    get(ownerId: string, characterId: string, requesterId?: string): MarketEntry | null {
        const row = this.#db.prepare(
            `SELECT * FROM character_shares
             WHERE user_id = ? AND character_id = ? AND status = 'public'`,
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

        const where: string[] = ["status = 'public'"];
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
            `SELECT *
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
            `SELECT * FROM character_shares WHERE status = 'public'`,
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
            `SELECT s.*, f.created_at AS favorited_at
             FROM character_favorites f
             JOIN character_shares s
               ON s.user_id = f.owner_id AND s.character_id = f.character_id AND s.status = 'public'
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
            publishTime: row.publish_time,
            status: asStatus(row.status),
            submittedAt: row.submitted_at,
            reviewedAt: row.reviewed_at,
            reviewNote: row.review_note,
            scheduledAt: row.scheduled_at,
            primaryVersion: row.primary_version,
            anonymous: Number(row.anonymous) === 1,
            rating: row.rating,
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
    publish_time: string | null;
    status: string;
    submitted_at: string | null;
    reviewed_at: string | null;
    review_note: string | null;
    scheduled_at: string | null;
    primary_version: string | null;
    anonymous: number | bigint;
    rating: string;
}
