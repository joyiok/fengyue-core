/**
 * API proxy used when the app runs on its own (`next dev`, or `next start`
 * without a reverse proxy in front).
 *
 * In production this route is never reached: Caddy matches `/api/*` first and
 * proxies it straight to story-core with `flush_interval -1`, which is the most
 * reliable path for a Server-Sent Events body. This handler exists so local
 * development and any host without that routing still work on one origin — the
 * session cookie is set by the API, so the browser must see the API and the UI
 * as the same site.
 *
 * It forwards bytes and nothing else: no caching, no body rewriting, no
 * buffering of the response stream.
 */
const UPSTREAM = (process.env.STORY_API_BASE ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');

/** Hop-by-hop and framing headers must not be relayed verbatim. */
const DROP_REQUEST = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding']);
const DROP_RESPONSE = new Set(['content-encoding', 'content-length', 'connection', 'keep-alive', 'transfer-encoding']);

async function forward(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const marker = '/api/v1/';

    // Take the path from the raw URL rather than from decoded params: a chat name
    // can contain spaces and CJK, and re-encoding it is exactly how those break.
    const at = url.pathname.indexOf(marker);
    const suffix = at === -1 ? '' : url.pathname.slice(at + marker.length);
    const target = `${UPSTREAM}${marker}${suffix}${url.search}`;

    const headers = new Headers();
    for (const [name, value] of request.headers) {
        if (!DROP_REQUEST.has(name)) {
            headers.set(name, value);
        }
    }

    const method = request.method.toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD';

    const upstream = await fetch(target, {
        method,
        headers,
        redirect: 'manual',
        ...(hasBody ? { body: await request.arrayBuffer() } : {}),
        // Node's fetch needs this when a body is supplied as a buffer.
        ...(hasBody ? { duplex: 'half' } : {}),
    } as RequestInit);

    const responseHeaders = new Headers();
    for (const [name, value] of upstream.headers) {
        if (!DROP_RESPONSE.has(name)) {
            responseHeaders.set(name, value);
        }
    }

    if (upstream.status === 204 || upstream.status === 304) {
        return new Response(null, { status: upstream.status, headers: responseHeaders });
    }

    // `upstream.body` is handed over as-is: a streamed reply stays streamed.
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = forward;
export const HEAD = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
