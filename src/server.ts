/**
 * HTTP surface.
 *
 * Three shapes, one file:
 *   - single user (auth off): every request acts on one library, no accounts, no
 *     quotas — the local/self-hosted case, and what the M0–M2 tests use;
 *   - multi user (auth on): bearer tokens or a session cookie, one library per
 *     user, quotas and an immutable usage ledger;
 *   - the auth routes themselves, plus /me for the client to read its own quota.
 *
 * No framework on purpose: the routing here is a few dozen lines and it keeps the
 * streaming path under our control (no middleware can buffer an SSE body we did
 * not route through it).
 */
import http from 'node:http';
import path from 'node:path';

import { AuthError, AuthService, type User } from './auth/service.ts';
import { BillingService, QuotaError, type Reservation } from './billing/service.ts';
import { ChatSession } from './chat/session.ts';
import { loadAppConfig, type AppConfig } from './config.ts';
import { CreditError, CreditService } from './credits/service.ts';
import { Database } from './db/database.ts';
import { loadModelConfig } from './gateway/config.ts';
import { ModelError, describeModelConfig, type ModelConfig } from './gateway/types.ts';
import { Library } from './library.ts';
import { MarketError, MarketService, type MarketSort, type RankingWindow } from './market/service.ts';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const SESSION_COOKIE = 'story_session';

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
    const body = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
    });
    response.end(body);
}

function sendBuffer(response: http.ServerResponse, status: number, contentType: string, body: Buffer): void {
    response.writeHead(status, {
        'Content-Type': contentType,
        'Content-Length': body.length,
    });
    response.end(body);
}

/**
 * Start an SSE response.
 *
 * `no-transform` and `X-Accel-Buffering: no` are what stop a reverse proxy from
 * buffering the stream; without them a CDN or nginx can hold deltas until the
 * whole reply is finished, which looks like the model hanging.
 */
function startSse(response: http.ServerResponse): void {
    response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
}

function sseSend(response: http.ServerResponse, payload: unknown): void {
    if (!response.writableEnded) {
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
}

/**
 * Abort the upstream request when the client goes away, so a closed tab does not
 * keep paying for tokens. `response.on('close')` also fires on a normal finish,
 * hence the `writableEnded` check.
 */
function abortWhenClientLeaves(request: http.IncomingMessage, response: http.ServerResponse): AbortController {
    const controller = new AbortController();

    response.on('close', () => {
        if (!response.writableEnded) {
            controller.abort();
        }
    });

    request.on('error', () => controller.abort());

    return controller;
}

async function readBody(request: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of request) {
        const buffer = chunk as Buffer;
        size += buffer.length;
        if (size > MAX_BODY_BYTES) {
            throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
        }
        chunks.push(buffer);
    }

    return Buffer.concat(chunks);
}

/**
 * Decode one path segment. A stray `%` is a malformed path rather than a server
 * fault, so it falls back to the raw text and lets id validation reject it
 * instead of turning into a 500.
 */
function decodeSegment(value: string | undefined): string | undefined {
    if (value === undefined) {
        return undefined;
    }

    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function statusForError(error: unknown): number {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof ModelError) {
        // Upstream rate limiting is worth passing through so clients can back off;
        // an upstream auth failure is our misconfiguration, not the caller's.
        if (error.status === 429) {
            return 429;
        }
        return error.status === undefined ? 504 : 502;
    }

    if (message.startsWith('unsafe id') || message.startsWith('path escapes')) {
        return 400;
    }

    if (message.startsWith('request body exceeds')) {
        return 413;
    }

    // Malformed JSON in an uploaded card is the client's problem, not ours.
    if (error instanceof SyntaxError) {
        return 400;
    }

    if (message.includes('ENOENT')) {
        return 404;
    }

    return 500;
}

/** Bearer header first, then the session cookie, so both clients work. */
function requestToken(request: http.IncomingMessage): string | null {
    const header = request.headers.authorization;

    if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
        const token = header.slice(7).trim();
        if (token !== '') {
            return token;
        }
    }

    const cookie = request.headers.cookie;
    if (typeof cookie === 'string') {
        for (const part of cookie.split(';')) {
            const [name, ...rest] = part.trim().split('=');
            if (name === SESSION_COOKIE) {
                return decodeURIComponent(rest.join('='));
            }
        }
    }

    return null;
}

const PUBLIC_PATHS = new Set([
    '/',
    '/health',
    '/api/v1/auth/register',
    '/api/v1/auth/login',
    '/api/v1/auth/logout',
]);

export interface ServerContext {
    config: AppConfig;
    /** Null in single-user mode. */
    auth: AuthService | null;
    /** Null in single-user mode. */
    billing: BillingService | null;
    /** Null in single-user mode: a currency needs accounts. */
    credits: CreditService | null;
    /** Null in single-user mode or when the market is switched off. */
    market: MarketService | null;
    libraryFor: (userId: string) => Library | Promise<Library>;
}

export interface ServerOptions {
    /** Injectable so tests can run without a real model endpoint. */
    loadModelConfig?: () => Promise<ModelConfig>;
    /** Default persona name for sessions created over HTTP. */
    personaName?: string;
}

/** Wrap one library so it behaves as a single-user deployment. */
export function singleUserContext(library: Library, config: AppConfig = loadAppConfig({ STORY_AUTH: 'off' })): ServerContext {
    return {
        config,
        auth: null,
        billing: null,
        credits: null,
        market: null,
        libraryFor: () => library,
    };
}

export interface AppContext extends ServerContext {
    db: Database;
    close: () => void;
}

/** Build the real thing: database, accounts, billing, per-user libraries. */
export function createAppContext(config: AppConfig = loadAppConfig()): AppContext {
    const db = new Database(config.databasePath);
    const auth = config.authRequired ? new AuthService(db, { sessionTtlDays: config.sessionTtlDays }) : null;
    const billing = config.authRequired
        ? new BillingService(db, {
            defaultQuota: config.defaultQuota,
            globalDailyTokenLimit: config.globalDailyTokenLimit,
            maxConcurrentStreamsPerUser: config.maxConcurrentStreamsPerUser,
        })
        : null;

    const libraries = new Map<string, Library>();

    // Credits and the market both need accounts (a balance or a public listing with
    // no one to own it is meaningless), so they only exist in multi-user mode.
    const credits = config.authRequired
        ? new CreditService(db, {
            initialGrant: config.credits.initialGrant,
            checkinAmount: config.credits.checkinAmount,
            inviteReward: config.credits.inviteReward,
            inviteeReward: config.credits.inviteeReward,
            tokensPerCredit: config.credits.tokensPerCredit,
        })
        : null;
    const market = config.authRequired && config.marketEnabled ? new MarketService(db) : null;

    const libraryFor = (userId: string): Library => {
        // Single-user mode points straight at a SillyTavern data directory; with
        // accounts, every user gets their own tree so isolation is a filesystem
        // boundary rather than a query filter.
        const root = config.authRequired
            ? path.join(config.dataRoot, 'users', userId)
            : config.dataRoot;

        const existing = libraries.get(root);
        if (existing !== undefined) {
            return existing;
        }

        const library = new Library(root);
        libraries.set(root, library);
        return library;
    };

    return {
        config,
        auth,
        billing,
        credits,
        market,
        libraryFor,
        db,
        close: () => db.close(),
    };
}

export function createServer(contextOrLibrary: ServerContext | Library, options: ServerOptions = {}): http.Server {
    const context: ServerContext = contextOrLibrary instanceof Library
        ? singleUserContext(contextOrLibrary)
        : contextOrLibrary;

    const loadConfig = options.loadModelConfig ?? ((): Promise<ModelConfig> => loadModelConfig());
    const defaultPersona = options.personaName ?? process.env.STORY_PERSONA_NAME ?? 'User';

    return http.createServer((request, response) => {
        void (async () => {
            const url = new URL(request.url ?? '/', 'http://localhost');
            const parts = url.pathname.split('/').filter((segment) => segment !== '');
            const method = request.method ?? 'GET';

            try {
                let user: User | null = null;
                const auth = context.auth;

                if (auth !== null && !PUBLIC_PATHS.has(url.pathname)) {
                    const token = requestToken(request);
                    user = token === null ? null : auth.authenticate(token);

                    if (user === null) {
                        return sendJson(response, 401, {
                            error: 'authentication_required',
                            message: 'send Authorization: Bearer <token>, or log in at /api/v1/auth/login',
                        });
                    }
                }

                // Resolved for the authenticated user; in single-user mode this is
                // always the one library this server was started with.
                const library = await context.libraryFor(user?.id ?? context.config.localUserId);

                if (url.pathname === '/health') {
                    return sendJson(response, 200, {
                        ok: true,
                        auth: auth !== null,
                        // The absolute library path is useful when running locally, but
                        // a public probe has no business learning the filesystem layout.
                        ...(auth === null ? { root: library.root } : {}),
                    });
                }

                // There is no bundled UI: this is the API. Say so rather than
                // answering a bare 404, which reads like a broken deployment.
                if (url.pathname === '/') {
                    return sendJson(response, 200, {
                        name: 'story-core',
                        description: 'Self-hosted backend for character cards, world books and chat.',
                        auth: auth === null ? 'disabled' : 'required',
                        endpoints: {
                            health: 'GET /health',
                            model: 'GET /api/v1/model',
                            characters: 'GET|POST /api/v1/characters',
                            worldbooks: 'GET /api/v1/worldbooks',
                            chats: 'GET|POST /api/v1/chats',
                            turn: 'POST /api/v1/chats/:cardId/:chatName/messages',
                            register: 'POST /api/v1/auth/register',
                            login: 'POST /api/v1/auth/login',
                        },
                        ...(auth !== null && auth.count() === 0
                            ? { next: 'POST /api/v1/auth/register to create the first account (it becomes the admin)' }
                            : {}),
                    });
                }

                if (parts[0] !== 'api' || parts[1] !== 'v1') {
                    return sendJson(response, 404, { error: 'not found' });
                }

                // ------------------------------------------------------ accounts

                if (parts[2] === 'auth') {
                    const action = parts[3];

                    if (method === 'POST' && action === 'register') {
                        if (auth === null) {
                            return sendJson(response, 400, { error: 'auth_disabled', message: 'this server runs without accounts' });
                        }

                        const body = JSON.parse((await readBody(request)).toString('utf8') || '{}') as {
                            handle?: string;
                            password?: string;
                            displayName?: string;
                        };

                        const isFirstUser = auth.count() === 0;
                        if (!context.config.allowRegistration && !isFirstUser) {
                            return sendJson(response, 403, {
                                error: 'registration_closed',
                                message: 'registration is disabled on this server',
                            });
                        }

                        const result = auth.register({
                            handle: String(body.handle ?? ''),
                            password: String(body.password ?? ''),
                            ...(body.displayName !== undefined ? { displayName: String(body.displayName) } : {}),
                        });

                        setSessionCookie(response, result.token, result.expiresAt, request);

                        // A new account starts with a small balance, so the first
                        // conversation does not require a check-in or an invite.
                        const credits = context.credits;
                        if (credits !== null && credits.initialGrant > 0) {
                            credits.grant(result.user.id, credits.initialGrant, 'signup');
                        }

                        return sendJson(response, 201, {
                            ...result,
                            credits: credits === null ? null : { balance: credits.balance(result.user.id) },
                        });
                    }

                    if (method === 'POST' && action === 'login') {
                        if (auth === null) {
                            return sendJson(response, 400, { error: 'auth_disabled', message: 'this server runs without accounts' });
                        }

                        const body = JSON.parse((await readBody(request)).toString('utf8') || '{}') as {
                            handle?: string;
                            password?: string;
                        };

                        const result = auth.login(String(body.handle ?? ''), String(body.password ?? ''));
                        setSessionCookie(response, result.token, result.expiresAt, request);
                        return sendJson(response, 200, result);
                    }

                    if (method === 'POST' && action === 'logout') {
                        const token = requestToken(request);
                        if (auth !== null && token !== null) {
                            auth.logout(token);
                        }
                        clearSessionCookie(response);
                        response.writeHead(204);
                        return response.end();
                    }
                }

                // ------------------------------------------------------ own account

                if (parts[2] === 'me') {
                    if (user === null) {
                        return sendJson(response, 400, { error: 'auth_disabled', message: 'this server runs without accounts' });
                    }

                    const action = parts[3];
                    const credits = context.credits;

                    if (method === 'GET' && action === 'usage') {
                        return sendJson(response, 200, {
                            usage: context.billing?.summary(user.id) ?? null,
                            recent: context.billing?.ledgerFor(user.id, 50) ?? [],
                        });
                    }

                    if (method === 'GET' && action === 'credits') {
                        if (credits === null) {
                            return sendJson(response, 400, { error: 'credits_disabled', message: 'this server runs without accounts' });
                        }

                        return sendJson(response, 200, {
                            tokensPerCredit: credits.tokensPerCredit,
                            credits: credits.summary(user.id),
                        });
                    }

                    // Idempotent per UTC day: calling it twice pays once.
                    if (method === 'POST' && action === 'checkin') {
                        if (credits === null) {
                            return sendJson(response, 400, { error: 'credits_disabled', message: 'this server runs without accounts' });
                        }

                        const result = credits.checkin(user.id);
                        return sendJson(response, 200, { ...result, credits: credits.summary(user.id) });
                    }

                    if (action === 'invites') {
                        if (credits === null) {
                            return sendJson(response, 400, { error: 'credits_disabled', message: 'this server runs without accounts' });
                        }

                        if (method === 'GET') {
                            return sendJson(response, 200, { invites: credits.listInvites(user.id) });
                        }

                        if (method === 'POST' && parts[4] === 'redeem') {
                            const body = JSON.parse((await readBody(request)).toString('utf8') || '{}') as { code?: string };
                            const result = credits.redeemInvite(user.id, String(body.code ?? ''));
                            return sendJson(response, 200, { ...result, credits: credits.summary(user.id) });
                        }

                        if (method === 'POST') {
                            const body = JSON.parse((await readBody(request)).toString('utf8') || '{}') as { count?: number };
                            const codes = credits.createInvite(user.id, Number(body.count ?? 1));
                            return sendJson(response, 201, { codes });
                        }
                    }

                    if (method === 'GET' && action === 'favorites') {
                        if (context.market === null) {
                            return sendJson(response, 400, { error: 'market_disabled', message: 'the character market is not enabled on this server' });
                        }

                        return sendJson(response, 200, { characters: context.market.favoritesFor(user.id) });
                    }

                    if (method === 'GET') {
                        return sendJson(response, 200, {
                            user,
                            usage: context.billing?.summary(user.id) ?? null,
                            credits: credits?.summary(user.id) ?? null,
                        });
                    }
                }

                // ------------------------------------------------------ admin

                if (parts[2] === 'users') {
                    if (user === null) {
                        return sendJson(response, 400, { error: 'auth_disabled', message: 'this server runs without accounts' });
                    }

                    if (user.role !== 'admin') {
                        return sendJson(response, 403, { error: 'forbidden', message: 'admin role required' });
                    }

                    const targetId = parts[3] ? decodeURIComponent(parts[3]) : undefined;

                    if (method === 'GET' && targetId === undefined) {
                        const users = (context.auth as AuthService).list().map((entry) => ({
                            ...entry,
                            usage: context.billing?.summary(entry.id) ?? null,
                        }));
                        return sendJson(response, 200, { users });
                    }

                    if (method === 'PUT' && targetId !== undefined && parts[4] === 'quota') {
                        const body = JSON.parse((await readBody(request)).toString('utf8') || '{}') as Record<string, unknown>;
                        const pick = (key: string, fallback: number): number => {
                            const value = Number(body[key] ?? fallback);
                            return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
                        };

                        const current = context.billing?.policyFor(targetId);
                        if (context.billing === null || current === undefined) {
                            return sendJson(response, 400, { error: 'auth_disabled' });
                        }

                        const policy = context.billing.setPolicy(targetId, {
                            dailyTokenLimit: pick('dailyTokenLimit', current.dailyTokenLimit),
                            monthlyTokenLimit: pick('monthlyTokenLimit', current.monthlyTokenLimit),
                            maxTokensPerRequest: pick('maxTokensPerRequest', current.maxTokensPerRequest),
                        });

                        return sendJson(response, 200, { userId: targetId, policy });
                    }

                    if (method === 'PUT' && targetId !== undefined && parts[4] === 'status') {
                        const body = JSON.parse((await readBody(request)).toString('utf8') || '{}') as { status?: string };
                        const status = body.status === 'disabled' ? 'disabled' : 'active';
                        const updated = (context.auth as AuthService).setStatus(targetId, status);
                        return sendJson(response, 200, { user: updated });
                    }

                    // Manual top-up. Grants only: a negative adjustment would be a
                    // silent clawback, and the ledger is append-only on purpose.
                    if (method === 'POST' && targetId !== undefined && parts[4] === 'credits') {
                        if (context.credits === null) {
                            return sendJson(response, 400, { error: 'credits_disabled' });
                        }

                        const body = JSON.parse((await readBody(request)).toString('utf8') || '{}') as {
                            amount?: number;
                            reference?: string;
                        };
                        const amount = Math.trunc(Number(body.amount ?? 0));
                        if (!Number.isFinite(amount) || amount <= 0) {
                            return sendJson(response, 400, { error: 'amount must be a positive integer' });
                        }

                        const result = context.credits.grant(
                            targetId,
                            amount,
                            'admin',
                            body.reference === undefined ? undefined : String(body.reference),
                            { by: user.id },
                        );

                        return sendJson(response, 200, { userId: targetId, ...result });
                    }
                }

                const resource = parts[2];
                const id = decodeSegment(parts[3]);
                // Chat and character ids are URL-encoded on the way in (names contain
                // spaces and CJK), so every segment is decoded before use.
                const sub = decodeSegment(parts[4]);
                const subId = decodeSegment(parts[5]);

                // ------------------------------------------------------ market

                if (resource === 'market') {
                    if (context.market === null) {
                        return sendJson(response, 400, {
                            error: 'market_disabled',
                            message: 'the character market needs accounts, and must be enabled with STORY_MARKET',
                        });
                    }

                    const market = context.market;
                    const ownerId = id;
                    const characterId = sub;

                    if (method === 'GET' && ownerId === undefined) {
                        const sortParam = url.searchParams.get('sort') ?? 'hot';
                        const sort: MarketSort = sortParam === 'new' || sortParam === 'name' ? sortParam : 'hot';
                        const q = url.searchParams.get('q');
                        const tag = url.searchParams.get('tag');

                        return sendJson(response, 200, {
                            characters: market.list({
                                ...(q !== null ? { q } : {}),
                                ...(tag !== null ? { tag } : {}),
                                sort,
                                limit: Number(url.searchParams.get('limit') ?? 20),
                                offset: Number(url.searchParams.get('offset') ?? 0),
                                ...(user !== null ? { requesterId: user.id } : {}),
                            }),
                        });
                    }

                    if (method === 'GET' && ownerId !== undefined && characterId !== undefined && subId === undefined) {
                        const entry = market.get(ownerId, characterId, user?.id);
                        if (entry === null) {
                            return sendJson(response, 404, { error: 'not_published', message: 'no such published character' });
                        }

                        // Viewing your own listing should not inflate its score. The
                        // refreshed stats make this view visible in its own response.
                        if (user === null || user.id !== ownerId) {
                            market.recordView(ownerId, characterId);
                            entry.stats = market.statsFor(ownerId, characterId);
                        }

                        return sendJson(response, 200, { character: entry });
                    }

                    if (method === 'POST' && ownerId !== undefined && characterId !== undefined && subId === 'favorite') {
                        if (user === null) {
                            return sendJson(response, 400, { error: 'auth_disabled', message: 'favorites need an account' });
                        }

                        const body = JSON.parse((await readBody(request)).toString('utf8') || '{}') as { favorited?: boolean };
                        const current = market.get(ownerId, characterId, user.id);
                        if (current === null) {
                            return sendJson(response, 404, { error: 'not_published', message: 'no such published character' });
                        }

                        const favorited = typeof body.favorited === 'boolean' ? body.favorited : !current.favorited;
                        return sendJson(response, 200, market.setFavorite(user.id, ownerId, characterId, favorited));
                    }

                    // Import copies the card into the caller's own library. The card's
                    // embedded world book travels with the PNG, so the copy works
                    // without reaching back into the publisher's files.
                    if (method === 'POST' && ownerId !== undefined && characterId !== undefined && subId === 'import') {
                        if (user === null) {
                            return sendJson(response, 400, { error: 'auth_disabled', message: 'importing needs an account' });
                        }

                        if (user.id === ownerId) {
                            return sendJson(response, 400, { error: 'own_character', message: 'this character is already in your library' });
                        }

                        const entry = market.get(ownerId, characterId, user.id);
                        if (entry === null) {
                            return sendJson(response, 404, { error: 'not_published', message: 'no such published character' });
                        }

                        const source = await context.libraryFor(ownerId);
                        const png = await source.readCardPng(characterId);
                        const imported = await library.importCard(png, { filename: `${characterId}.png` });
                        market.recordImport(ownerId, characterId);

                        // Report the count including this import.
                        entry.stats = market.statsFor(ownerId, characterId);
                        return sendJson(response, 201, { imported, source: entry });
                    }
                }

                if (resource === 'rankings' && method === 'GET') {
                    if (context.market === null) {
                        return sendJson(response, 400, { error: 'market_disabled' });
                    }

                    const windowParam = url.searchParams.get('window') ?? 'day';
                    const window: RankingWindow = ['day', 'week', 'month', 'all'].includes(windowParam)
                        ? windowParam as RankingWindow
                        : 'day';

                    return sendJson(response, 200, {
                        window,
                        characters: context.market.rankings(window, Number(url.searchParams.get('limit') ?? 20)),
                    });
                }

                if (resource === 'characters') {
                    if (method === 'GET' && id === undefined) {
                        return sendJson(response, 200, { characters: await library.listCharacters() });
                    }

                    if (method === 'POST' && id === undefined) {
                        const body = await readBody(request);
                        const contentType = String(request.headers['content-type'] ?? '');
                        const headerName = request.headers['x-filename'];
                        const input = contentType.includes('json') ? body.toString('utf8') : body;
                        const imported = await library.importCard(input, {
                            ...(typeof headerName === 'string' ? { filename: headerName } : {}),
                        });
                        return sendJson(response, 201, imported);
                    }

                    if (method === 'GET' && id !== undefined && sub === undefined) {
                        return sendJson(response, 200, { id, card: await library.getCard(id) });
                    }

                    if (method === 'GET' && id !== undefined && sub === 'card.png') {
                        return sendBuffer(response, 200, 'image/png', await library.exportCardPng(id));
                    }

                    if (method === 'GET' && id !== undefined && sub === 'card.json') {
                        return sendJson(response, 200, await library.getCard(id));
                    }

                    // Publishing snapshots the card into the market listing, so
                    // browsing never reads every user's directory.
                    if (id !== undefined && sub === 'publish') {
                        if (context.market === null || user === null) {
                            return sendJson(response, 400, {
                                error: 'market_disabled',
                                message: 'publishing needs accounts, and must be enabled with STORY_MARKET',
                            });
                        }

                        if (method === 'GET') {
                            const published = context.market.isPublic(user.id, id);
                            return sendJson(response, 200, {
                                published,
                                character: published ? context.market.get(user.id, id, user.id) : null,
                            });
                        }

                        if (method === 'POST') {
                            const card = await library.getCard(id);
                            const character = context.market.publish(user.id, id, {
                                name: card.data.name,
                                tags: Array.isArray(card.data.tags) ? card.data.tags : [],
                                descriptionLength: (card.data.description ?? '').length,
                            });
                            return sendJson(response, 201, { published: true, character });
                        }

                        if (method === 'DELETE') {
                            return sendJson(response, 200, {
                                published: false,
                                removed: context.market.unpublish(user.id, id),
                            });
                        }
                    }
                }

                if (resource === 'worldbooks') {
                    if (method === 'GET' && id === undefined) {
                        return sendJson(response, 200, { worldbooks: await library.listWorldbooks() });
                    }

                    if (method === 'GET' && id !== undefined) {
                        return sendJson(response, 200, { id, worldbook: await library.getWorldbook(id) });
                    }
                }

                if (resource === 'chats') {
                    if (method === 'GET' && id === undefined) {
                        return sendJson(response, 200, { characters: await library.listChatCharacters() });
                    }

                    // Create a session from a card (greeting included).
                    if (method === 'POST' && id === undefined) {
                        const body = JSON.parse((await readBody(request)).toString('utf8') || '{}') as {
                            cardId?: string;
                            name?: string;
                            personaName?: string;
                            greetingIndex?: number;
                            worldbookIds?: string[];
                        };

                        if (typeof body.cardId !== 'string' || body.cardId === '') {
                            return sendJson(response, 400, { error: 'cardId is required' });
                        }

                        const created = await ChatSession.create(library, {
                            cardId: body.cardId,
                            personaName: body.personaName ?? defaultPersona,
                            memory: context.config.memory,
                            ...(body.name !== undefined ? { name: body.name } : {}),
                            ...(body.greetingIndex !== undefined ? { greetingIndex: body.greetingIndex } : {}),
                            ...(body.worldbookIds !== undefined ? { worldbookIds: body.worldbookIds } : {}),
                        });

                        return sendJson(response, 201, {
                            cardId: created.cardId,
                            name: created.name,
                            messages: created.messages,
                        });
                    }

                    if (method === 'GET' && id !== undefined && sub === undefined) {
                        return sendJson(response, 200, { character: id, chats: await library.listChats(id) });
                    }

                    // Read one chat: `/chats/<card>/<chat>`. The name lives in `sub`;
                    // `subId` is only used by the sub-routes (messages, regenerate,
                    // summarize), so requiring it here made this route unreachable.
                    if (method === 'GET' && id !== undefined && sub !== undefined && subId === undefined) {
                        return sendJson(response, 200, { character: id, name: sub, chat: await library.getChat(id, sub) });
                    }

                    // Force a summarization pass (same billing path as the automatic one).
                    if (method === 'POST' && id !== undefined && sub !== undefined && subId === 'summarize') {
                        let modelConfig: ModelConfig;
                        try {
                            modelConfig = await loadConfig();
                        } catch (error) {
                            return sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
                        }

                        const session = await ChatSession.load(library, id, sub, {
                            personaName: defaultPersona,
                            memory: context.config.memory,
                        });

                        const plan = session.summaryPlan();
                        if (plan === null) {
                            return sendJson(response, 200, { summarized: false, memory: session.memoryState });
                        }

                        const summary = await session.summarize(modelConfig);
                        return sendJson(response, 200, {
                            summarized: summary !== null,
                            memory: session.memoryState,
                            usage: summary?.usage ?? null,
                            usageSource: summary?.usageSource ?? null,
                        });
                    }

                    const isTurn = (method === 'POST') && id !== undefined && sub !== undefined
                        && (subId === 'messages' || subId === 'regenerate');

                    if (isTurn) {
                        const regenerate = subId === 'regenerate';
                        const body = JSON.parse((await readBody(request)).toString('utf8') || '{}') as {
                            message?: string;
                            stream?: boolean;
                            requestId?: string;
                            personaName?: string;
                            overrides?: { temperature?: number; topP?: number; maxTokens?: number; stop?: string[] };
                        };

                        if (!regenerate && (typeof body.message !== 'string' || body.message === '')) {
                            return sendJson(response, 400, { error: 'message is required' });
                        }

                        let modelConfig: ModelConfig;
                        try {
                            modelConfig = await loadConfig();
                        } catch (error) {
                            return sendJson(response, 503, {
                                error: error instanceof Error ? error.message : String(error),
                                hint: 'set STORY_MODEL_ENDPOINT / STORY_MODEL_NAME / STORY_MODEL_API_KEY',
                            });
                        }

                        const session = await ChatSession.load(library, id, sub, {
                            personaName: body.personaName ?? defaultPersona,
                            memory: context.config.memory,
                        });

                        // Credits are the user-facing balance; the token quota below is
                        // the operational ceiling. Checked before anything is spent, so
                        // an empty account is refused without calling the model.
                        if (user !== null && context.credits !== null) {
                            const balance = context.credits.balance(user.id);
                            if (balance <= 0) {
                                return sendJson(response, 402, {
                                    error: 'insufficient_credits',
                                    message: 'no credits left: check in, redeem an invite, or ask an admin for a grant',
                                    balance,
                                });
                            }
                        }

                        // Quota is checked before the model is called, and the worst
                        // case is reserved so parallel requests cannot overspend.
                        let reservation: Reservation | null = null;
                        if (user !== null && context.billing !== null) {
                            const billing = context.billing;
                            const policy = billing.policyFor(user.id);
                            const requestedMaxTokens = body.overrides?.maxTokens
                                ?? modelConfig.maxTokens
                                ?? policy.maxTokensPerRequest;
                            const estimate = session.preview(body.message ?? '').stats.estimatedTokens;

                            reservation = billing.authorize(user.id, {
                                estimatedPromptTokens: estimate,
                                requestedMaxTokens,
                                ...(body.requestId !== undefined ? { requestId: body.requestId } : {}),
                            });
                        }

                        const turnOptions = {
                            ...(body.requestId !== undefined ? { requestId: body.requestId } : {}),
                            ...(body.overrides !== undefined ? { overrides: body.overrides } : {}),
                        };

                        // Regeneration may also edit the user turn it answers.
                        const regenerateOptions = {
                            ...turnOptions,
                            ...(body.message !== undefined ? { userMessageOverride: body.message } : {}),
                        };

                        /**
                         * Charge the user-facing balance for work that already happened.
                         *
                         * The cost is only known after the model replies, so this cannot
                         * be a precondition. A failure here is logged and swallowed: the
                         * reply already reached the user, and the token quota is the
                         * ceiling that actually protects the operator. The idempotency
                         * key is the request id, so a retry is never charged twice.
                         */
                        const chargeCredits = (reference: string, model: string, promptTokens: number, completionTokens: number): void => {
                            if (user === null || context.credits === null) {
                                return;
                            }

                            const totalTokens = promptTokens + completionTokens;
                            const cost = context.credits.costForTokens(totalTokens);
                            if (cost <= 0) {
                                return;
                            }

                            try {
                                context.credits.spend(user.id, cost, 'turn', reference, { model, tokens: totalTokens });
                            } catch (error) {
                                console.warn(`[credits] charge failed for ${reference}: ${error instanceof Error ? error.message : String(error)}`);
                            }
                        };

                        const settle = (result: Awaited<ReturnType<ChatSession['send']>>): void => {
                            if (reservation !== null && context.billing !== null) {
                                // Idempotent by request id: a retried request is never
                                // billed twice.
                                context.billing.settle(reservation, {
                                    requestId: result.requestId,
                                    chatId: `${session.cardId}/${session.name}`,
                                    model: result.model,
                                    promptTokens: result.usage.promptTokens ?? 0,
                                    completionTokens: result.usage.completionTokens ?? 0,
                                    usageSource: result.usageSource,
                                    streamed: result.streamed,
                                });
                            }

                            chargeCredits(
                                result.requestId,
                                result.model,
                                result.usage.promptTokens ?? 0,
                                result.usage.completionTokens ?? 0,
                            );
                        };

                        /**
                         * Summarize when the history has outgrown the window.
                         *
                         * A summary is a real model call, so it goes through the same
                         * authorize/settle path as a turn: leaving it unbilled would
                         * be a hole in the quota, not a saving.
                         */
                        const runSummary = async (): Promise<{ summarized: boolean; upTo?: number; passes?: number } | void> => {
                            const plan = session.summaryPlan();
                            if (plan === null) {
                                return;
                            }

                            const summaryRequestId = `${body.requestId ?? session.name}:summary:${plan.upTo}`;
                            let summaryReservation: Reservation | null = null;

                            if (user !== null && context.billing !== null) {
                                try {
                                    summaryReservation = context.billing.authorize(user.id, {
                                        estimatedPromptTokens: plan.estimatedPromptTokens,
                                        requestedMaxTokens: plan.maxTokens,
                                        requestId: summaryRequestId,
                                    });
                                } catch {
                                    // Out of quota for the summary: the turn itself already
                                    // succeeded, so this is a skip rather than a failure.
                                    return;
                                }
                            }

                            try {
                                const summary = await session.summarize(modelConfig);
                                if (summary !== null && summaryReservation !== null && context.billing !== null) {
                                    context.billing.settle(summaryReservation, {
                                        requestId: summaryRequestId,
                                        chatId: `${session.cardId}/${session.name}`,
                                        model: summary.model,
                                        promptTokens: summary.usage.promptTokens ?? 0,
                                        completionTokens: summary.usage.completionTokens ?? 0,
                                        usageSource: summary.usageSource,
                                        streamed: false,
                                    });
                                } else if (summaryReservation !== null && context.billing !== null) {
                                    context.billing.release(summaryReservation);
                                }

                                if (summary !== null) {
                                    chargeCredits(
                                        summaryRequestId,
                                        summary.model,
                                        summary.usage.promptTokens ?? 0,
                                        summary.usage.completionTokens ?? 0,
                                    );
                                    console.log(`[memory] summarized ${session.cardId}/${session.name} up to ${summary.upTo} (pass ${summary.passes})`);
                                    return { summarized: true, upTo: summary.upTo, passes: summary.passes };
                                }
                            } catch (error) {
                                if (summaryReservation !== null && context.billing !== null) {
                                    context.billing.release(summaryReservation);
                                }
                                // Never fail a completed turn because its bookkeeping failed.
                                console.warn(`[memory] summarization failed: ${error instanceof Error ? error.message : String(error)}`);
                            }
                        };

                        const release = (error: unknown): void => {
                            // An aborted or failed turn produced nothing the user can
                            // see, so it is not billed. The reservation still counted
                            // against the quota while it was in flight.
                            if (reservation !== null && context.billing !== null) {
                                context.billing.release(reservation);
                            }
                            void error;
                        };

                        if (body.stream !== true) {
                            try {
                                const result = regenerate
                                    ? await session.regenerate(modelConfig, regenerateOptions)
                                    : await session.send(modelConfig, body.message as string, turnOptions);
                                settle(result);
                                const memory = await runSummary();
                                return sendJson(response, 200, {
                                    cardId: session.cardId,
                                    name: session.name,
                                    ...result,
                                    ...(memory !== undefined ? { memory } : {}),
                                });
                            } catch (error) {
                                release(error);
                                throw error;
                            }
                        }

                        startSse(response);
                        const controller = abortWhenClientLeaves(request, response);
                        const onDelta = (delta: string): void => sseSend(response, { type: 'delta', text: delta });

                        try {
                            const result = regenerate
                                ? await session.regenerate(modelConfig, { ...regenerateOptions, signal: controller.signal, onDelta })
                                : await session.send(modelConfig, body.message as string, { ...turnOptions, signal: controller.signal, onDelta });

                            settle(result);

                            sseSend(response, {
                                type: 'done',
                                reply: result.reply,
                                model: result.model,
                                usage: result.usage,
                                usageSource: result.usageSource,
                                latencyMs: result.latencyMs,
                                ...(result.firstTokenMs !== undefined ? { firstTokenMs: result.firstTokenMs } : {}),
                                prompt: result.stats,
                                requestId: result.requestId,
                            });

                            // The client already has the whole reply, so the extra
                            // summary call no longer delays anything it is waiting for.
                            await runSummary();
                        } catch (error) {
                            release(error);
                            if ((error as { name?: string }).name === 'AbortError') {
                                // The client left; it already stopped listening.
                                sseSend(response, { type: 'aborted' });
                            } else {
                                sseSend(response, {
                                    type: 'error',
                                    error: error instanceof Error ? error.message : String(error),
                                    status: error instanceof ModelError ? error.status ?? null : null,
                                });
                            }
                        }

                        response.end();
                        return undefined;
                    }
                }

                // What the gateway is configured with — never the key itself.
                if (resource === 'model' && method === 'GET') {
                    try {
                        return sendJson(response, 200, { configured: true, model: describeModelConfig(await loadConfig()) });
                    } catch (error) {
                        return sendJson(response, 200, {
                            configured: false,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                }

                return sendJson(response, 404, { error: 'not found', path: url.pathname });
            } catch (error) {
                if (error instanceof QuotaError) {
                    return sendJson(response, error.status, {
                        error: error.code,
                        message: error.message,
                        ...error.details,
                    });
                }

                if (error instanceof AuthError) {
                    return sendJson(response, error.status, { error: error.code, message: error.message });
                }

                if (error instanceof CreditError) {
                    return sendJson(response, error.status, {
                        error: error.code,
                        message: error.message,
                        ...error.details,
                    });
                }

                if (error instanceof MarketError) {
                    return sendJson(response, error.status, { error: error.code, message: error.message });
                }

                const message = error instanceof Error ? error.message : String(error);
                return sendJson(response, statusForError(error), { error: message });
            }
        })();
    });
}

function setSessionCookie(response: http.ServerResponse, token: string, expiresAt: string, request: http.IncomingMessage): void {
    const secure = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim() === 'https';
    const attributes = [
        `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Expires=${new Date(expiresAt).toUTCString()}`,
    ];

    if (secure) {
        attributes.push('Secure');
    }

    response.setHeader('Set-Cookie', attributes.join('; '));
}

function clearSessionCookie(response: http.ServerResponse): void {
    response.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function parseArgs(argv: string[]): { root: string; port: number; host: string } {
    let root = process.env.STORY_DATA_ROOT ?? './data';
    let port = Number(process.env.PORT ?? 8787);
    let host = process.env.STORY_HOST ?? '127.0.0.1';

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--root' && argv[i + 1]) {
            root = argv[i + 1] as string;
            i += 1;
        } else if (arg === '--port' && argv[i + 1]) {
            port = Number(argv[i + 1]);
            i += 1;
        } else if (arg === '--host' && argv[i + 1]) {
            host = argv[i + 1] as string;
            i += 1;
        }
    }

    return { root, port, host };
}

// Only start listening when executed directly, so tests can import createServer.
if (import.meta.url === `file://${process.argv[1]}`) {
    const args = parseArgs(process.argv.slice(2));
    const config = loadAppConfig();
    const app = createAppContext({ ...config, dataRoot: args.root });

    createServer(app).listen(args.port, args.host, () => {
        console.log(`story-core listening on http://${args.host}:${args.port}`);
        console.log(`data root:      ${args.root}`);
        console.log(`database:       ${config.databasePath}`);
        console.log(`accounts:       ${config.authRequired ? 'enabled' : 'disabled (single user)'}`);

        if (config.authRequired) {
            const users = app.auth?.count() ?? 0;
            console.log(users === 0
                ? 'no accounts yet: POST /api/v1/auth/register to create the first (admin) one'
                : `${users} account(s) registered`);
        }
    });

    const shutdown = (): void => {
        app.close();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
