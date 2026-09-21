/**
 * The one place that talks to story-core.
 *
 * Same-origin only: the session is a cookie set by the API, and keeping the
 * client on one origin is what makes `credentials` work without CORS. In
 * production Caddy serves `/api/*` from story-core directly; in development the
 * catch-all route handler in app/api/v1 proxies to `STORY_API_BASE`.
 */
import type { Me } from './types';

export class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    readonly details: Record<string, unknown>;

    constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.details = details;
    }

    /** True when the session is gone and the only sane move is to log in again. */
    get isAuth(): boolean {
        return this.status === 401;
    }
}

const PREFIX = '/api/v1';

function jsonInit(init: RequestInit): RequestInit {
    const headers = new Headers(init.headers);

    if (init.body !== undefined && typeof init.body === 'string' && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
    }

    return { credentials: 'same-origin', ...init, headers };
}

export async function raw(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${PREFIX}${path}`, jsonInit(init));
}

/** Request JSON and parse JSON. Throws `ApiError` for any non-2xx. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await raw(path, init);
    const text = await response.text();

    if (!response.ok) {
        let payload: Record<string, unknown> = {};
        try {
            payload = JSON.parse(text) as Record<string, unknown>;
        } catch {
            // A non-JSON error body is still an error body.
        }

        throw new ApiError(
            response.status,
            String(payload.error ?? 'request_failed'),
            String(payload.message ?? payload.error ?? `${response.status} ${response.statusText}`),
            payload,
        );
    }

    return (text === '' ? undefined : JSON.parse(text)) as T;
}

export const get = <T>(path: string): Promise<T> => api<T>(path);

export const post = <T>(path: string, body?: unknown): Promise<T> =>
    api<T>(path, { method: 'POST', body: body === undefined ? '' : JSON.stringify(body) });

export const put = <T>(path: string, body?: unknown): Promise<T> =>
    api<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) });

export const del = <T>(path: string): Promise<T> => api<T>(path, { method: 'DELETE' });

export const getMe = (): Promise<Me> => get<Me>('/me');

/**
 * Import a card. The API takes the raw PNG/JSON body plus a `x-filename` header
 * rather than multipart, which is what a browser `<input type="file">` gives you
 * for free — `File` *is* a body.
 */
export async function importCard(file: File): Promise<{ id: string; fileName: string }> {
    const response = await raw('/characters', {
        method: 'POST',
        headers: { 'x-filename': file.name, 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
    });

    const text = await response.text();
    if (!response.ok) {
        throw new ApiError(response.status, 'import_failed', text.slice(0, 300) || 'import failed');
    }

    return JSON.parse(text) as { id: string; fileName: string };
}

/** Absolute URL for a character avatar, for `<img src>`. */
export const avatarUrl = (cardId: string): string =>
    `${PREFIX}/characters/${encodeURIComponent(cardId)}/card.png`;

export const marketAvatarUrl = (ownerId: string, characterId: string): string =>
    `${PREFIX}/market/${encodeURIComponent(ownerId)}/${encodeURIComponent(characterId)}/card.png`;
