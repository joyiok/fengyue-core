/**
 * Model gateway types.
 *
 * OpenAI-compatible only for now: vLLM, One API, OpenRouter, DeepSeek,
 * SiliconFlow and most aggregators speak it. Other providers get their own
 * adapter later, behind this same interface.
 */
import type { PromptMessage } from '../prompt/types.ts';

export interface ModelConfig {
    endpoint: string;
    model: string;
    apiKey?: string;
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    stop?: string[];
    timeoutMs?: number;
    extraHeaders?: Record<string, string>;
    /**
     * Ask the provider to report token usage on streamed responses
     * (`stream_options.include_usage`). Off by default because providers that do
     * not know the field may reject the request; without it, streamed usage is
     * estimated from the text.
     */
    includeUsage?: boolean;
}

export interface SamplingOverrides {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    stop?: string[];
}

export interface CompletionRequest {
    messages: PromptMessage[];
    overrides?: SamplingOverrides;
    signal?: AbortSignal;
}

export interface CompletionUsage {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
}

/** Where the token numbers came from — billing must not confuse the two. */
export type UsageSource = 'provider' | 'estimated';

export interface CompletionResult {
    content: string;
    model: string;
    usage: CompletionUsage;
    usageSource: UsageSource;
    finishReason: string | null;
    latencyMs: number;
    /** Time to the first streamed token; absent for non-streaming calls. */
    firstTokenMs?: number;
    streamed: boolean;
}

export class ModelError extends Error {
    status: number | undefined;
    body: string | undefined;

    constructor(message: string, details: { status?: number; body?: string } = {}) {
        super(message);
        this.name = 'ModelError';
        this.status = details.status;
        this.body = details.body;
    }
}

/** Never log this: it is the config with the key replaced by a marker. */
export function describeModelConfig(config: ModelConfig): Record<string, unknown> {
    return {
        endpoint: config.endpoint,
        model: config.model,
        apiKey: config.apiKey !== undefined && config.apiKey !== '' ? '(set)' : '(not set)',
        temperature: config.temperature ?? null,
        maxTokens: config.maxTokens ?? null,
        includeUsage: config.includeUsage ?? false,
    };
}
