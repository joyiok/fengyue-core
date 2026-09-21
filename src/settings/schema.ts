/**
 * The setting schema: one entry per runtime-tunable value.
 *
 * This file is deliberately free of imports so both the config loader and the
 * database-backed settings service can depend on it without a cycle.
 *
 * Two rules make the whole configuration story predictable:
 *
 *   - Environment variables say **where the data is** (the database file, the
 *     library root) and nothing else.
 *   - Everything else lives in the `settings` table. An environment variable
 *     listed here is consulted exactly once per key: to fill in a row that does
 *     not exist yet. Once the row exists, the row is the truth and the variable
 *     is ignored — which is the point, because changing the model key should not
 *     require editing a file and restarting a container.
 *
 * `unset`-ing a key makes the next start seed it again, which is also how you
 * fall back to the shipped default.
 */

export type SettingType = 'number' | 'boolean' | 'string';

export type SettingValue = number | boolean | string;

export interface SettingSpec {
    key: string;
    type: SettingType;
    default: SettingValue;
    /** Consulted only to seed a row that does not exist yet. */
    env?: string;
    group: 'auth' | 'server' | 'model' | 'quota' | 'credits' | 'market' | 'memory' | 'chat';
    description: string;
    /** Never returned in full over HTTP; the CLI can still show it. */
    secret?: boolean;
    /** Changing it needs a process restart: it is read once at start-up. */
    restart?: boolean;
    /** Inclusive lower bound for numbers. */
    min?: number;
}

export const SETTINGS: SettingSpec[] = [
    // ---------------------------------------------------------------- accounts
    {
        key: 'auth.enabled',
        type: 'boolean',
        default: true,
        env: 'STORY_AUTH',
        group: 'auth',
        restart: true,
        description: 'Accounts, per-user isolation, quotas and credits. Off = single-user local mode.',
    },
    {
        key: 'auth.allowRegistration',
        type: 'boolean',
        default: true,
        env: 'STORY_ALLOW_REGISTRATION',
        group: 'auth',
        description: 'Open registration. The very first account is always allowed, so a fresh install can bootstrap.',
    },
    {
        key: 'auth.sessionTtlDays',
        type: 'number',
        default: 30,
        env: 'STORY_SESSION_TTL_DAYS',
        group: 'auth',
        min: 1,
        description: 'How long a session cookie or bearer token stays valid.',
    },

    // ------------------------------------------------------------------ server
    {
        key: 'server.host',
        type: 'string',
        default: '127.0.0.1',
        env: 'STORY_HOST',
        group: 'server',
        restart: true,
        description: 'Address the HTTP server binds. Loopback unless something in front of it needs to reach it.',
    },
    {
        key: 'server.port',
        type: 'number',
        default: 8787,
        env: 'PORT',
        group: 'server',
        restart: true,
        min: 1,
        description: 'Port the HTTP server binds. Keep this in step with the container port mapping.',
    },

    // ------------------------------------------------------------------- model
    {
        key: 'model.endpoint',
        type: 'string',
        default: '',
        env: 'STORY_MODEL_ENDPOINT',
        group: 'model',
        description: 'OpenAI-compatible /chat/completions endpoint. Empty = turns are refused with 503.',
    },
    {
        key: 'model.name',
        type: 'string',
        default: '',
        env: 'STORY_MODEL_NAME',
        group: 'model',
        description: 'Model name sent upstream.',
    },
    {
        key: 'model.apiKey',
        type: 'string',
        default: '',
        env: 'STORY_MODEL_API_KEY',
        group: 'model',
        secret: true,
        description: 'Bearer key for the model gateway. Never logged, never returned in full.',
    },
    {
        key: 'model.maxTokens',
        type: 'number',
        default: 2048,
        env: 'STORY_MODEL_MAX_TOKENS',
        group: 'model',
        min: 1,
        description: 'Default `max_tokens` for a completion. A request may override it per turn.',
    },
    {
        key: 'model.timeoutMs',
        type: 'number',
        default: 120_000,
        env: 'STORY_MODEL_TIMEOUT_MS',
        group: 'model',
        min: 1,
        description: 'Give up on the upstream model after this long.',
    },

    // ------------------------------------------------------------------- quota
    {
        key: 'quota.dailyTokens',
        type: 'number',
        default: 200_000,
        env: 'STORY_DAILY_TOKENS',
        group: 'quota',
        description: 'Tokens one account may spend per UTC day. 0 = unlimited.',
    },
    {
        key: 'quota.monthlyTokens',
        type: 'number',
        default: 3_000_000,
        env: 'STORY_MONTHLY_TOKENS',
        group: 'quota',
        description: 'Tokens one account may spend per UTC month. 0 = unlimited.',
    },
    {
        key: 'quota.maxTokensPerRequest',
        type: 'number',
        default: 2048,
        env: 'STORY_MAX_TOKENS_PER_REQUEST',
        group: 'quota',
        min: 1,
        description: 'Ceiling on one request’s `max_tokens`.',
    },
    {
        key: 'quota.globalDailyTokens',
        type: 'number',
        default: 0,
        env: 'STORY_GLOBAL_DAILY_TOKENS',
        group: 'quota',
        description: 'Circuit breaker across every account per UTC day. 0 = unlimited.',
    },
    {
        key: 'quota.maxStreams',
        type: 'number',
        default: 2,
        env: 'STORY_MAX_STREAMS',
        group: 'quota',
        description: 'Simultaneous streaming requests one account may have in flight.',
    },

    // ----------------------------------------------------------------- credits
    {
        key: 'credits.signup',
        type: 'number',
        default: 100,
        env: 'STORY_CREDITS_SIGNUP',
        group: 'credits',
        description: 'Balance granted once, when an account is created.',
    },
    {
        key: 'credits.checkin',
        type: 'number',
        default: 10,
        env: 'STORY_CREDITS_CHECKIN',
        group: 'credits',
        description: 'Balance granted once per UTC day by checking in.',
    },
    {
        key: 'credits.invite',
        type: 'number',
        default: 50,
        env: 'STORY_CREDITS_INVITE',
        group: 'credits',
        description: 'Paid to the inviter when their code is redeemed.',
    },
    {
        key: 'credits.invitee',
        type: 'number',
        default: 50,
        env: 'STORY_CREDITS_INVITEE',
        group: 'credits',
        description: 'Paid to the person redeeming a code.',
    },
    {
        key: 'credits.tokensPerCredit',
        type: 'number',
        default: 1000,
        env: 'STORY_TOKENS_PER_CREDIT',
        group: 'credits',
        min: 1,
        description: 'How many tokens one credit buys, rounded up per turn.',
    },

    // ------------------------------------------------------------------ market
    {
        key: 'market.enabled',
        type: 'boolean',
        default: true,
        env: 'STORY_MARKET',
        group: 'market',
        description: 'The character market. Off = no publish or browse routes.',
    },

    // ------------------------------------------------------------------ memory
    {
        key: 'memory.enabled',
        type: 'boolean',
        default: true,
        env: 'STORY_MEMORY',
        group: 'memory',
        description: 'Rolling summary memory for long conversations.',
    },
    {
        key: 'memory.messageThreshold',
        type: 'number',
        default: 40,
        env: 'STORY_MEMORY_THRESHOLD',
        group: 'memory',
        min: 1,
        description: 'Un-summarized messages needed before a summarization pass runs.',
    },
    {
        key: 'memory.keepRecent',
        type: 'number',
        default: 12,
        env: 'STORY_MEMORY_KEEP_RECENT',
        group: 'memory',
        description: 'Messages that always stay verbatim, however long the chat gets.',
    },
    {
        key: 'memory.maxSummaryTokens',
        type: 'number',
        default: 500,
        env: 'STORY_MEMORY_MAX_TOKENS',
        group: 'memory',
        min: 1,
        description: 'Ceiling for the summary block in the prompt (estimated tokens).',
    },

    // -------------------------------------------------------------------- chat
    {
        key: 'chat.personaName',
        type: 'string',
        default: 'User',
        env: 'STORY_PERSONA_NAME',
        group: 'chat',
        description: 'Name used for `{{user}}` substitution when a session does not carry its own.',
    },
];

export const SETTING_BY_KEY: Map<string, SettingSpec> = new Map(SETTINGS.map((spec) => [spec.key, spec]));

/** Mask a secret for transport: enough to tell "set" from "empty", nothing more. */
export function maskSecret(value: SettingValue): string {
    const text = String(value);
    if (text === '') {
        return '';
    }
    return `••••${text.slice(-4)}`;
}

/**
 * Parse one raw value (from the API, the CLI or an environment variable) into
 * the type the schema asks for. Throws rather than silently falling back: a
 * typo in a limit should be loud.
 */
export function coerce(spec: SettingSpec, raw: unknown): SettingValue {
    if (spec.type === 'boolean') {
        if (typeof raw === 'boolean') {
            return raw;
        }

        const text = String(raw ?? '').trim().toLowerCase();
        if (['on', 'true', '1', 'yes', ''].includes(text)) {
            return true;
        }
        if (['off', 'false', '0', 'no'].includes(text)) {
            return false;
        }
        throw new Error(`${spec.key} expects a boolean (on/off), got ${JSON.stringify(raw)}`);
    }

    if (spec.type === 'number') {
        const parsed = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
        if (!Number.isFinite(parsed)) {
            throw new Error(`${spec.key} expects a number, got ${JSON.stringify(raw)}`);
        }
        const value = Math.trunc(parsed);
        const min = spec.min ?? 0;
        if (value < min) {
            throw new Error(`${spec.key} must be >= ${min}, got ${value}`);
        }
        return value;
    }

    return String(raw ?? '');
}

/**
 * What an environment variable seeds a missing row with, or `undefined` when
 * nothing is configured there.
 *
 * Note the boolean rule: an *unset* variable does not seed anything (the default
 * applies), while `STORY_AUTH=off` does. That is what lets a fresh local run
 * differ from a deployed one without either of them editing a file.
 */
export function seedFromEnv(spec: SettingSpec, env: NodeJS.ProcessEnv): SettingValue | undefined {
    if (spec.env === undefined) {
        return undefined;
    }

    const raw = env[spec.env];
    if (raw === undefined || raw.trim() === '') {
        return undefined;
    }

    return coerce(spec, raw);
}
