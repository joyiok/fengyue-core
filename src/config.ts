/**
 * Application configuration.
 *
 * Everything is overridable by environment variable so a deployment never has to
 * edit code, and every default is safe to run locally.
 */
export interface QuotaPolicy {
    /** Tokens a user may spend per UTC day. 0 = unlimited. */
    dailyTokenLimit: number;
    /** Tokens a user may spend per UTC month. 0 = unlimited. */
    monthlyTokenLimit: number;
    /** Ceiling for a single request's `max_tokens`. */
    maxTokensPerRequest: number;
}

export interface MemorySettings {
    enabled: boolean;
    /** Un-summarized messages needed before a pass runs. */
    messageThreshold: number;
    /** Messages that always stay verbatim. */
    keepRecent: number;
    /** Ceiling for the summary block (estimated tokens). */
    maxSummaryTokens: number;
}

export interface AppConfig {
    /** Where per-user libraries live: `<dataRoot>/users/<userId>/`. */
    dataRoot: string;
    databasePath: string;
    /** false = local single-user mode: no accounts, no quotas. */
    authRequired: boolean;
    sessionTtlDays: number;
    /** Circuit breaker across all users. 0 = unlimited. */
    globalDailyTokenLimit: number;
    defaultQuota: QuotaPolicy;
    /** Simultaneous streaming requests one user may have in flight. */
    maxConcurrentStreamsPerUser: number;
    /** When auth is off, everything acts as this local user. */
    localUserId: string;
    /** Open registration. The very first account is always allowed (bootstrap). */
    allowRegistration: boolean;
    /** Rolling summary memory. */
    memory: MemorySettings;
}

function numberFrom(value: string | undefined, fallback: number): number {
    if (value === undefined || value.trim() === '') {
        return fallback;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
    const authFlag = (env.STORY_AUTH ?? 'on').trim().toLowerCase();

    return {
        dataRoot: env.STORY_DATA_ROOT ?? './data',
        databasePath: env.STORY_DB ?? './story.sqlite',
        authRequired: !['off', 'false', '0', 'no'].includes(authFlag),
        sessionTtlDays: numberFrom(env.STORY_SESSION_TTL_DAYS, 30),
        globalDailyTokenLimit: numberFrom(env.STORY_GLOBAL_DAILY_TOKENS, 0),
        defaultQuota: {
            dailyTokenLimit: numberFrom(env.STORY_DAILY_TOKENS, 200_000),
            monthlyTokenLimit: numberFrom(env.STORY_MONTHLY_TOKENS, 3_000_000),
            maxTokensPerRequest: numberFrom(env.STORY_MAX_TOKENS_PER_REQUEST, 2048),
        },
        maxConcurrentStreamsPerUser: numberFrom(env.STORY_MAX_STREAMS, 2),
        localUserId: 'local',
        allowRegistration: !['off', 'false', '0', 'no'].includes((env.STORY_ALLOW_REGISTRATION ?? 'on').trim().toLowerCase()),
        memory: {
            enabled: !['off', 'false', '0', 'no'].includes((env.STORY_MEMORY ?? 'on').trim().toLowerCase()),
            messageThreshold: numberFrom(env.STORY_MEMORY_THRESHOLD, 40),
            keepRecent: numberFrom(env.STORY_MEMORY_KEEP_RECENT, 12),
            maxSummaryTokens: numberFrom(env.STORY_MEMORY_MAX_TOKENS, 500),
        },
    };
}
