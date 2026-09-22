/**
 * OpenAI-compatible chat completions client: non-streaming and SSE streaming.
 *
 * Thin on purpose. One request, one response, errors carrying the upstream status
 * so callers can decide about retries and about telling the user their quota ran
 * out. Retries, key pools and billing belong to the gateway service later.
 */
import { estimateMessagesTokens, estimateTokens } from '../prompt/estimate.ts';
import {
    ModelError,
    type CompletionRequest,
    type CompletionResult,
    type CompletionUsage,
    type ModelConfig,
    type UsageSource,
} from './types.ts';

const MAX_ERROR_BODY = 600;

interface OpenAIChatResponse {
    model?: string;
    choices?: {
        message?: { content?: unknown };
        delta?: { content?: unknown };
        finish_reason?: string | null;
    }[];
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
    error?: { message?: string };
}

function buildBody(config: ModelConfig, request: CompletionRequest, stream: boolean): Record<string, unknown> {
    const overrides = request.overrides ?? {};

    const body: Record<string, unknown> = {
        model: config.model,
        messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
        stream,
    };

    if (stream && config.includeUsage === true) {
        // Providers that do not know this field may reject the request, which is
        // why it is opt-in; without it streamed usage is estimated below.
        body.stream_options = { include_usage: true };
    }

    const temperature = overrides.temperature ?? config.temperature;
    if (temperature !== undefined) {
        body.temperature = temperature;
    }

    const topP = overrides.topP ?? config.topP;
    if (topP !== undefined) {
        body.top_p = topP;
    }

    const maxTokens = overrides.maxTokens ?? config.maxTokens;
    if (maxTokens !== undefined) {
        body.max_tokens = maxTokens;
    }

    if (config.frequencyPenalty !== undefined) {
        body.frequency_penalty = config.frequencyPenalty;
    }

    if (config.presencePenalty !== undefined) {
        body.presence_penalty = config.presencePenalty;
    }

    const stop = overrides.stop ?? config.stop;
    if (stop !== undefined && stop.length > 0) {
        body.stop = stop;
    }

    return body;
}

/** Providers disagree: some return a string, some an array of parts. */
function extractContent(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }

    if (Array.isArray(value)) {
        return value
            .map((part) => {
                if (typeof part === 'string') {
                    return part;
                }
                if (part !== null && typeof part === 'object' && 'text' in part) {
                    const text = (part as { text?: unknown }).text;
                    return typeof text === 'string' ? text : '';
                }
                return '';
            })
            .join('');
    }

    return '';
}

function usageFrom(payload: OpenAIChatResponse['usage']): CompletionUsage | null {
    if (!payload) {
        return null;
    }

    const usage: CompletionUsage = {};
    if (payload.prompt_tokens !== undefined) {
        usage.promptTokens = payload.prompt_tokens;
    }
    if (payload.completion_tokens !== undefined) {
        usage.completionTokens = payload.completion_tokens;
    }
    if (payload.total_tokens !== undefined) {
        usage.totalTokens = payload.total_tokens;
    } else if (usage.promptTokens !== undefined || usage.completionTokens !== undefined) {
        usage.totalTokens = (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
    }

    return Object.keys(usage).length > 0 ? usage : null;
}

function estimatedUsage(request: CompletionRequest, content: string): CompletionUsage {
    const promptTokens = estimateMessagesTokens(request.messages);
    const completionTokens = estimateTokens(content);

    return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

function isAbortError(error: unknown): boolean {
    const name = (error as { name?: string } | null)?.name;
    return name === 'AbortError' || name === 'TimeoutError';
}

function requestSignal(config: ModelConfig, external?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(config.timeoutMs ?? 120_000);
    return external ? AbortSignal.any([external, timeout]) : timeout;
}

async function postRequest(
    config: ModelConfig,
    request: CompletionRequest,
    stream: boolean,
): Promise<Response> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json',
        ...config.extraHeaders,
    };

    if (config.apiKey !== undefined && config.apiKey !== '') {
        headers.Authorization = `Bearer ${config.apiKey}`;
    }

    let response: Response;

    try {
        response = await fetch(completionsUrl(config.endpoint), {
            method: 'POST',
            headers,
            body: JSON.stringify(buildBody(config, request, stream)),
            signal: requestSignal(config, request.signal),
        });
    } catch (error) {
        if (isAbortError(error)) {
            // Pass aborts through untouched: callers must be able to tell a
            // client disconnect from a transport failure.
            throw error;
        }
        throw new ModelError(`could not reach the model endpoint: ${String(error)}`);
    }

    if (!response.ok) {
        const body = (await response.text().catch(() => '')).slice(0, MAX_ERROR_BODY);
        // Note: the API key is never included here, only what the upstream said.
        // A 404 here is almost always the tail of the URL, and saying so is
        // the difference between a two-second fix and an hour of guessing.
        const hint = response.status === 404
            ? '（404 几乎总是地址末尾不对：写 `https://host/v1` 或完整的 '
              + '`https://host/v1/chat/completions` 都可以，两种都收）'
            : '';
        throw new ModelError(`model endpoint returned HTTP ${response.status}${hint}`, {
            status: response.status,
            body,
        });
    }

    return response;
}

/**
 * The chat-completions URL, from whatever the operator typed.
 *
 * Both spellings exist in the wild — `https://host/v1` and the full
 * `https://host/v1/chat/completions` — and until this function only the second
 * worked. Filling in the first produced `HTTP 404`, which reads as "the model
 * is unreachable" and says nothing about the URL.
 *
 * Accepting both is not laziness. This is a string typed by hand out of a
 * provider's docs, and a failure that looks like their model is down when it is
 * only our path is our bug and not theirs.
 */
export function completionsUrl(endpoint: string): string {
    const base = endpoint.replace(/\/+$/, '');
    return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

export async function createChatCompletion(config: ModelConfig, request: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    const response = await postRequest(config, request, false);
    const payload = (await response.json()) as OpenAIChatResponse;

    if (payload.error?.message) {
        throw new ModelError(`model endpoint reported an error: ${payload.error.message}`);
    }

    const choice = payload.choices?.[0];
    if (!choice) {
        throw new ModelError('model endpoint returned no choices');
    }

    const content = extractContent(choice.message?.content);
    const reported = usageFrom(payload.usage);

    return {
        content,
        model: payload.model ?? config.model,
        usage: reported ?? estimatedUsage(request, content),
        usageSource: (reported ? 'provider' : 'estimated') satisfies UsageSource,
        finishReason: choice.finish_reason ?? null,
        latencyMs: Date.now() - started,
        streamed: false,
    };
}

/**
 * Split an SSE body into `data:` payloads.
 *
 * Handles CRLF, multiple data lines per event, keep-alive comments and a final
 * event without a trailing blank line. Anything that is not a data line is
 * ignored, which is what makes it tolerant of provider quirks.
 */
async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    let buffer = '';

    const takeEvent = (): string | null => {
        const boundary = buffer.indexOf('\n\n');
        if (boundary < 0) {
            return null;
        }

        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const data = raw
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');

        return data === '' ? null : data;
    };

    for await (const chunk of body) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');

        let event = takeEvent();
        while (event !== null) {
            yield event;
            event = takeEvent();
        }
    }

    buffer += decoder.decode();
    buffer = buffer.replace(/\r\n/g, '\n');

    let event = takeEvent();
    while (event !== null) {
        yield event;
        event = takeEvent();
    }

    const tail = buffer
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');

    if (tail !== '') {
        yield tail;
    }
}

/**
 * Stream a completion, handing each delta to `onDelta` as it arrives.
 *
 * Aborts are re-thrown as AbortError so the caller can stay silent about a user
 * that simply navigated away.
 */
export async function streamChatCompletion(
    config: ModelConfig,
    request: CompletionRequest,
    onDelta: (delta: string) => void | Promise<void>,
): Promise<CompletionResult> {
    const started = Date.now();
    const response = await postRequest(config, request, true);

    if (!response.body) {
        throw new ModelError('model endpoint returned no response body for a stream');
    }

    let content = '';
    let model = config.model;
    let finishReason: string | null = null;
    let firstTokenMs: number | undefined;
    let reported: CompletionUsage | null = null;

    try {
        for await (const data of readSseData(response.body)) {
            if (data === '[DONE]') {
                break;
            }

            let payload: OpenAIChatResponse;
            try {
                payload = JSON.parse(data) as OpenAIChatResponse;
            } catch {
                // Keep-alives and provider chatter are not worth failing over.
                continue;
            }

            if (payload.error?.message) {
                throw new ModelError(`model endpoint reported an error: ${payload.error.message}`);
            }

            if (payload.model) {
                model = payload.model;
            }

            const choice = payload.choices?.[0];
            const delta = extractContent(choice?.delta?.content);

            if (delta !== '') {
                firstTokenMs ??= Date.now() - started;
                content += delta;
                await onDelta(delta);
            }

            if (choice?.finish_reason) {
                finishReason = choice.finish_reason;
            }

            reported = usageFrom(payload.usage) ?? reported;
        }
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        if (error instanceof ModelError) {
            throw error;
        }
        throw new ModelError(`stream failed: ${String(error)}`);
    }

    return {
        content,
        model,
        usage: reported ?? estimatedUsage(request, content),
        usageSource: reported ? 'provider' : 'estimated',
        finishReason,
        latencyMs: Date.now() - started,
        ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
        streamed: true,
    };
}
