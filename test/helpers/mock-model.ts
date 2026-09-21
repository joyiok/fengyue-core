/**
 * A recording mock of an OpenAI-compatible endpoint.
 *
 * Requests are captured so tests can assert on what was actually sent — which is
 * the only way to check prompt behaviour without a real model. It also speaks SSE,
 * including the awkward cases (CRLF, keep-alive comments, junk lines) that real
 * providers produce.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';

export interface CapturedRequest {
    body: {
        model?: string;
        messages?: { role: string; content: string }[];
        stream?: boolean;
        stream_options?: { include_usage?: boolean };
        temperature?: number;
        top_p?: number;
        max_tokens?: number;
        stop?: string[];
    } | null;
    headers: http.IncomingHttpHeaders;
    aborted: boolean;
}

export interface MockModel {
    endpoint: string;
    requests: CapturedRequest[];
    close: () => Promise<void>;
}

export type MockHandler = (request: CapturedRequest, response: http.ServerResponse) => void;

export interface MockUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

export const respondWith = (
    content: string,
    usage: MockUsage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
): MockHandler => (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
        id: 'mock-1',
        object: 'chat.completion',
        created: 0,
        model: 'mock-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage,
    }));
};

export interface SseOptions {
    /** Emit a usage-only final chunk, as `stream_options.include_usage` asks for. */
    usage?: boolean;
    crlf?: boolean;
    /** Emit a comment line (keep-alive) and a non-JSON data line. */
    noise?: boolean;
    /** Separator used between the piecewise chunks inside one delta. */
    deltaSize?: number;
}

/** Streams `content` as SSE deltas, then a finish chunk and `[DONE]`. */
export const respondSse = (content: string, options: SseOptions = {}): MockHandler => (_request, response) => {
    const eol = options.crlf === true ? '\r\n' : '\n';
    const size = options.deltaSize ?? 4;

    response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
    });

    const send = (payload: string): void => {
        response.write(`data: ${payload}${eol}${eol}`);
    };

    if (options.noise === true) {
        response.write(`: keep-alive${eol}${eol}`);
        send('not json at all');
    }

    for (let index = 0; index < content.length; index += size) {
        send(JSON.stringify({ choices: [{ delta: { content: content.slice(index, index + size) } }] }));
    }

    if (options.usage === true) {
        send(JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }));
    }

    send(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
    response.write(`data: [DONE]${eol}${eol}`);
    response.end();
};

/** Opens a stream, sends one delta and then holds the connection open. */
export const respondSseAndHang = (): MockHandler => (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`);
    // Deliberately never ends: the test aborts the client side.
};

export async function startMockModel(handler: MockHandler = respondWith('好的。')): Promise<MockModel> {
    const requests: CapturedRequest[] = [];
    const sockets = new Set<Socket>();

    const server = http.createServer((request, response) => {
        let raw = '';
        const captured: CapturedRequest = { body: null, headers: request.headers, aborted: false };
        requests.push(captured);

        request.on('aborted', () => { captured.aborted = true; });
        response.on('close', () => {
            if (!response.writableEnded) {
                captured.aborted = true;
            }
        });

        request.on('data', (chunk) => { raw += chunk; });
        request.on('end', () => {
            try {
                captured.body = raw === '' ? null : JSON.parse(raw) as CapturedRequest['body'];
            } catch {
                captured.body = null;
            }

            handler(captured, response);
        });
    });

    // Without this, a test that aborts mid-stream leaves the socket open and
    // close() would wait forever.
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    return {
        endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
        requests,
        close: () => new Promise<void>((resolve) => {
            for (const socket of sockets) {
                socket.destroy();
            }
            server.close(() => resolve());
        }),
    };
}
