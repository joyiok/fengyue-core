/**
 * Application configuration.
 *
 * Values come from the `settings` table (see `settings/schema.ts`); the
 * environment only supplies the bootstrap — where the data lives — and seeds
 * rows that do not exist yet. `loadAppConfig` is that seed path, and is what the
 * tests use to build an isolated configuration without a database.
 */
import type { ModelConfig } from './gateway/types.ts';
import { SETTINGS, seedFromEnv, type SettingSpec, type SettingValue } from './settings/schema.ts';

export interface QuotaPolicy {
    /** Tokens a user may spend per UTC day. 0 = unlimited. */
    dailyTokenLimit: number;
    /** Tokens a user may spend per UTC month. 0 = unlimited. */
    monthlyTokenLimit: number;
    /** Ceiling for a single request's `max_tokens`. */
    maxTokensPerRequest: number;
}

/**
 * Credits: the balance a user spends. The token quota above is an operational
 * ceiling; this is the currency.
 */
export interface CreditSettings {
    /** Granted once, when an account is created. */
    initialGrant: number;
    /** Granted once per UTC day by checking in. */
    checkinAmount: number;
    /** Paid to the inviter when their code is redeemed. */
    inviteReward: number;
    /** Paid to the person redeeming a code. */
    inviteeReward: number;
    /** How many tokens one credit buys. */
    tokensPerCredit: number;
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

export interface ModelSettings {
    endpoint: string;
    name: string;
    /** Empty when unconfigured. Never logged and never returned in full. */
    apiKey: string;
    maxTokens: number;
    timeoutMs: number;
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
    credits: CreditSettings;
    /** The character market. Off = no publish/browse routes. */
    marketEnabled: boolean;
    model: ModelSettings;
    /** Default `{{user}}` name. */
    personaName: string;
    /** Where the HTTP server listens. Read once at start-up. */
    serverHost: string;
    serverPort: number;
}

/**
 * The parts that cannot come from the database: the database itself is reached
 * through them, and moving them means moving files rather than editing a value.
 */
export interface Bootstrap {
    dataRoot: string;
    databasePath: string;
    localUserId: string;
}

export type SettingReader = (key: string) => SettingValue;

/**
 * A value that may be read fresh on every use.
 *
 * Limits and prices are settings now, so a service cannot hold them still: an
 * admin raising a quota has to take effect under a running server. Callers that
 * have a fixed value keep passing one — the function form is opt-in.
 */
export type MaybeLive<T> = T | (() => T);

export function live<T>(value: MaybeLive<T>): T {
    return typeof value === 'function' ? (value as () => T)() : value;
}

const bool = (read: SettingReader, key: string): boolean => read(key) === true;
const num = (read: SettingReader, key: string): number => Number(read(key));
const str = (read: SettingReader, key: string): string => String(read(key));

export function appConfigFrom(read: SettingReader, bootstrap: Bootstrap): AppConfig {
    return {
        dataRoot: bootstrap.dataRoot,
        databasePath: bootstrap.databasePath,
        localUserId: bootstrap.localUserId,
        authRequired: bool(read, 'auth.enabled'),
        sessionTtlDays: num(read, 'auth.sessionTtlDays'),
        globalDailyTokenLimit: num(read, 'quota.globalDailyTokens'),
        defaultQuota: {
            dailyTokenLimit: num(read, 'quota.dailyTokens'),
            monthlyTokenLimit: num(read, 'quota.monthlyTokens'),
            maxTokensPerRequest: num(read, 'quota.maxTokensPerRequest'),
        },
        maxConcurrentStreamsPerUser: num(read, 'quota.maxStreams'),
        allowRegistration: bool(read, 'auth.allowRegistration'),
        memory: {
            enabled: bool(read, 'memory.enabled'),
            messageThreshold: num(read, 'memory.messageThreshold'),
            keepRecent: num(read, 'memory.keepRecent'),
            maxSummaryTokens: num(read, 'memory.maxSummaryTokens'),
        },
        credits: {
            initialGrant: num(read, 'credits.signup'),
            checkinAmount: num(read, 'credits.checkin'),
            inviteReward: num(read, 'credits.invite'),
            inviteeReward: num(read, 'credits.invitee'),
            tokensPerCredit: num(read, 'credits.tokensPerCredit'),
        },
        marketEnabled: bool(read, 'market.enabled'),
        model: {
            endpoint: str(read, 'model.endpoint'),
            name: str(read, 'model.name'),
            apiKey: str(read, 'model.apiKey'),
            maxTokens: num(read, 'model.maxTokens'),
            timeoutMs: num(read, 'model.timeoutMs'),
        },
        personaName: str(read, 'chat.personaName'),
        serverHost: str(read, 'server.host'),
        serverPort: num(read, 'server.port'),
    };
}

export function bootstrapFrom(env: NodeJS.ProcessEnv): Bootstrap {
    return {
        dataRoot: env.STORY_DATA_ROOT ?? './data',
        databasePath: env.STORY_DB ?? './story.sqlite',
        localUserId: 'local',
    };
}

/**
 * The inverse of `appConfigFrom`: an `AppConfig` back into setting values.
 *
 * Needed to bootstrap the settings table from a configuration object (tests hand
 * one over instead of an environment). Kept next to `appConfigFrom` and checked
 * by a round-trip test so the two cannot drift apart silently.
 */
export function appConfigToValues(config: AppConfig): Map<string, SettingValue> {
    return new Map<string, SettingValue>([
        ['auth.enabled', config.authRequired],
        ['auth.allowRegistration', config.allowRegistration],
        ['auth.sessionTtlDays', config.sessionTtlDays],
        ['quota.dailyTokens', config.defaultQuota.dailyTokenLimit],
        ['quota.monthlyTokens', config.defaultQuota.monthlyTokenLimit],
        ['quota.maxTokensPerRequest', config.defaultQuota.maxTokensPerRequest],
        ['quota.globalDailyTokens', config.globalDailyTokenLimit],
        ['quota.maxStreams', config.maxConcurrentStreamsPerUser],
        ['credits.signup', config.credits.initialGrant],
        ['credits.checkin', config.credits.checkinAmount],
        ['credits.invite', config.credits.inviteReward],
        ['credits.invitee', config.credits.inviteeReward],
        ['credits.tokensPerCredit', config.credits.tokensPerCredit],
        ['market.enabled', config.marketEnabled],
        ['memory.enabled', config.memory.enabled],
        ['memory.messageThreshold', config.memory.messageThreshold],
        ['memory.keepRecent', config.memory.keepRecent],
        ['memory.maxSummaryTokens', config.memory.maxSummaryTokens],
        ['model.endpoint', config.model.endpoint],
        ['model.name', config.model.name],
        ['model.apiKey', config.model.apiKey],
        ['model.maxTokens', config.model.maxTokens],
        ['model.timeoutMs', config.model.timeoutMs],
        ['chat.personaName', config.personaName],
        ['server.host', config.serverHost],
        ['server.port', config.serverPort],
    ]);
}

/** What a key goes back to when it is reset: the seed, or the shipped default. */
export function bootstrapValue(spec: SettingSpec, env: NodeJS.ProcessEnv): SettingValue {
    return seedFromEnv(spec, env) ?? spec.default;
}

/** The bootstrap an `AppConfig` implies: where its data lives. */
export function bootstrapOf(config: AppConfig): Bootstrap {
    return {
        dataRoot: config.dataRoot,
        databasePath: config.databasePath,
        localUserId: config.localUserId,
    };
}

/**
 * Build a configuration straight from the environment, with no database: every
 * key takes its seeded value, or the shipped default when nothing is set.
 *
 * This is the *seed* path. A running deployment reads the `settings` table
 * instead, and only falls back to these values for a row that was never written.
 */
export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
    const values = new Map<string, SettingValue>();

    for (const spec of SETTINGS) {
        values.set(spec.key, seedFromEnv(spec, env) ?? spec.default);
    }

    return appConfigFrom((key) => {
        const value = values.get(key);
        if (value === undefined) {
            const spec = SETTINGS.find((entry) => entry.key === key);
            throw new Error(`unknown setting: ${key}${spec === undefined ? '' : ` (${spec.type})`}`);
        }
        return value;
    }, bootstrapFrom(env));
}

/**
 * The gateway's own shape. Kept as a separate type so the model layer does not
 * have to know about the rest of the application's configuration.
 */
export function toModelConfig(model: ModelSettings): ModelConfig {
    if (model.endpoint.trim() === '') {
        throw new Error('no model endpoint configured: set "model.endpoint" in settings (admin UI or `cli.ts settings set`)');
    }

    if (model.name.trim() === '') {
        throw new Error('no model name configured: set "model.name" in settings (admin UI or `cli.ts settings set`)');
    }

    return {
        endpoint: model.endpoint,
        model: model.name,
        ...(model.apiKey === '' ? {} : { apiKey: model.apiKey }),
        maxTokens: model.maxTokens,
        timeoutMs: model.timeoutMs,
    };
}
