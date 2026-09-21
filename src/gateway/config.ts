/**
 * Model gateway configuration.
 *
 * Precedence: environment variables win over the config file, so a deployment can
 * keep secrets out of the file entirely. Keys must never be logged; use
 * describeModelConfig() when you need to show what is configured.
 */
import { readFile } from 'node:fs/promises';

import type { ModelConfig } from './types.ts';

export const DEFAULT_CONFIG_FILE = 'story.config.json';

interface ConfigFileShape {
    model?: Partial<ModelConfig>;
}

function numberFrom(value: string | undefined): number | undefined {
    if (value === undefined || value.trim() === '') {
        return undefined;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

export interface LoadConfigOptions {
    configPath?: string;
    env?: NodeJS.ProcessEnv;
    /** When false, a missing config file is not an error (default true). */
    required?: boolean;
}

export async function loadModelConfig(options: LoadConfigOptions = {}): Promise<ModelConfig> {
    const env = options.env ?? process.env;
    const configPath = options.configPath ?? env.STORY_CONFIG ?? DEFAULT_CONFIG_FILE;

    let fromFile: Partial<ModelConfig> = {};

    try {
        const parsed = JSON.parse(await readFile(configPath, 'utf8')) as ConfigFileShape;
        fromFile = parsed.model ?? {};
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && options.required !== false) {
            throw new Error(`could not read ${configPath}: ${String(error)}`);
        }
    }

    const config: ModelConfig = {
        endpoint: env.STORY_MODEL_ENDPOINT ?? fromFile.endpoint ?? '',
        model: env.STORY_MODEL_NAME ?? fromFile.model ?? '',
        ...(env.STORY_MODEL_API_KEY ?? fromFile.apiKey) !== undefined
            ? { apiKey: env.STORY_MODEL_API_KEY ?? fromFile.apiKey }
            : {},
        temperature: numberFrom(env.STORY_MODEL_TEMPERATURE) ?? fromFile.temperature,
        topP: numberFrom(env.STORY_MODEL_TOP_P) ?? fromFile.topP,
        maxTokens: numberFrom(env.STORY_MODEL_MAX_TOKENS) ?? fromFile.maxTokens,
        frequencyPenalty: fromFile.frequencyPenalty,
        presencePenalty: fromFile.presencePenalty,
        stop: fromFile.stop,
        timeoutMs: numberFrom(env.STORY_MODEL_TIMEOUT_MS) ?? fromFile.timeoutMs ?? 120_000,
        extraHeaders: fromFile.extraHeaders,
    };

    if (config.endpoint === '') {
        throw new Error(
            'no model endpoint configured: set STORY_MODEL_ENDPOINT or "model.endpoint" in '
            + `${configPath} (see story.config.example.json)`,
        );
    }

    if (config.model === '') {
        throw new Error(
            'no model name configured: set STORY_MODEL_NAME or "model.model" in '
            + `${configPath}`,
        );
    }

    return config;
}
