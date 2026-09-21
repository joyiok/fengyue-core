/**
 * Server-Sent Events, read by hand.
 *
 * `EventSource` cannot POST a body, and the turn endpoint needs one, so the
 * stream is read off a `fetch` response instead. The parser tolerates CRLF,
 * keep-alive comment lines and non-JSON `data:` lines — real proxies and real
 * providers produce all three, and a reader that dies on them looks like "the
 * model hung".
 */
import { ApiError, raw } from './api';
import type { CompletionUsage, PromptStats } from './types';

export type TurnEvent =
    | { type: 'delta'; text: string }
    | {
        type: 'done';
        reply: string;
        model: string;
        usage: CompletionUsage;
        usageSource: string;
        latencyMs: number;
        firstTokenMs?: number;
        prompt: PromptStats;
        requestId: string;
    }
    | { type: 'error'; error: string; status: number | null }
    | { type: 'aborted' };

const FRAME = /\r?\n\r?\n/;

/** Yield the events of one SSE body. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<TurnEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true });

            for (;;) {
                const match = FRAME.exec(buffer);
                if (match === null || match.index === undefined) {
                    break;
                }

                const frame = buffer.slice(0, match.index);
                buffer = buffer.slice(match.index + match[0].length);

                // Only `data:` lines carry a payload; `:` is a keep-alive comment.
                const payload = frame
                    .split(/\r?\n/)
                    .filter((line) => line.startsWith('data:'))
                    .map((line) => line.slice(5).trimStart())
                    .join('\n');

                if (payload === '' || payload === '[DONE]') {
                    continue;
                }

                try {
                    yield JSON.parse(payload) as TurnEvent;
                } catch {
                    // A line that is not JSON is noise, not a reason to drop the stream.
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}

/**
 * Send one turn and dispatch its events.
 *
 * A rejected turn (no credits, out of quota, no model configured) comes back as
 * ordinary JSON *before* any stream starts, so that case is an `ApiError` and not
 * a silent empty stream.
 */
export async function streamTurn(
    path: string,
    body: Record<string, unknown>,
    onEvent: (event: TurnEvent) => void,
    signal?: AbortSignal,
): Promise<void> {
    const response = await raw(path, {
        method: 'POST',
        body: JSON.stringify({ ...body, stream: true }),
        ...(signal ? { signal } : {}),
    });

    const contentType = response.headers.get('content-type') ?? '';

    if (!contentType.includes('text/event-stream')) {
        const text = await response.text();
        let payload: Record<string, unknown> = {};
        try {
            payload = JSON.parse(text) as Record<string, unknown>;
        } catch {
            // Fall through with the raw text as the message.
        }

        throw new ApiError(
            response.status,
            String(payload.error ?? 'turn_failed'),
            String(payload.message ?? payload.error ?? (text.slice(0, 300) || 'the turn did not start')),
            payload,
        );
    }

    if (response.body === null) {
        throw new ApiError(502, 'empty_stream', 'the server opened a stream with no body');
    }

    for await (const event of readSse(response.body)) {
        onEvent(event);
    }
}
