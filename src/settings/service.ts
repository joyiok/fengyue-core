/**
 * Runtime configuration, stored in the database.
 *
 * The rule the whole stack follows: **the environment says where the data is,
 * the `settings` table says how the service behaves.** At start-up every key in
 * `SETTINGS` gets exactly one row, filled from the environment when it has one
 * and from the shipped default otherwise. That is the only time the environment
 * is consulted; after boot the table is authoritative, so changing the model key
 * or a quota is an update, not a deploy.
 *
 * The table is complete — every key always has a row — rather than an override
 * layer on top of the environment. Two properties make that worth the space:
 * `list()` is the whole configuration and nothing else, and "reset" is just
 * writing the boot value back instead of a delete whose meaning depends on what
 * an operator may have in a file somewhere.
 *
 * Nothing is cached: a read is one indexed lookup and the CLI can change a value
 * under a running server, which has to be visible without a restart.
 */
import type { AppConfig, Bootstrap, ModelSettings, SettingReader } from '../config.ts';
import { appConfigFrom, appConfigToValues, toModelConfig } from '../config.ts';
import type { Database } from '../db/database.ts';
import type { ModelConfig } from '../gateway/types.ts';
import {
    SETTING_BY_KEY,
    SETTINGS,
    coerce,
    maskSecret,
    seedFromEnv,
    type SettingSpec,
    type SettingValue,
} from './schema.ts';

export interface SettingEntry {
    key: string;
    type: SettingSpec['type'];
    group: SettingSpec['group'];
    description: string;
    /** Never returned in full over HTTP. */
    secret: boolean;
    /** Read once at start-up, so a change needs a restart. */
    restart: boolean;
    default: SettingValue;
    /** The value at boot: what `reset` writes back. */
    bootValue: SettingValue;
    /** Current value. Secrets come back masked; `secretSet` says whether one is. */
    value: SettingValue;
    secretSet?: boolean;
    /** True when the value differs from what it booted with. */
    changed: boolean;
    /** The environment variable that seeded it, if any. */
    env?: string;
}

export interface SettingsServiceOptions {
    bootstrap: Bootstrap;
    /** Consulted only while filling in rows at start-up. */
    env?: NodeJS.ProcessEnv;
    /** Values to seed with instead of the environment (tests hand over a config). */
    seedValues?: Map<string, SettingValue>;
}

export class SettingsService {
    readonly #db: Database;
    readonly #bootstrap: Bootstrap;
    readonly #env: NodeJS.ProcessEnv;
    readonly #seedValues: Map<string, SettingValue> | undefined;

    constructor(db: Database, options: SettingsServiceOptions) {
        this.#db = db;
        this.#bootstrap = options.bootstrap;
        this.#env = options.env ?? {};
        this.#seedValues = options.seedValues;
        this.#seed(options.seedValues);
    }

    /** Write a row for every key that does not have one yet. Runs at boot. */
    #seed(values?: Map<string, SettingValue>): void {
        const insert = this.#db.prepare(
            'INSERT OR IGNORE INTO settings (key, value, boot_value, updated_at) VALUES (?, ?, ?, ?)',
        );

        this.#db.transaction(() => {
            const now = new Date().toISOString();
            for (const spec of SETTINGS) {
                const value = values?.get(spec.key) ?? this.#seedValue(spec);
                const json = JSON.stringify(value);
                insert.run(spec.key, json, json, now);
            }
        });
    }

    /** What a fresh row would be filled with here and now. */
    #seedValue(spec: SettingSpec): SettingValue {
        return this.#seedValues?.get(spec.key) ?? seedFromEnv(spec, this.#env) ?? spec.default;
    }

    /**
     * The value this key was *booted* with, and therefore what `reset` writes
     * back.
     *
     * Read from the row rather than recomputed, because recomputing it would
     * make `changed` and `reset` mean different things to different processes: a
     * CLI started without the deployment's environment would compute a
     * different boot value than the server did, and `reset` would write the
     * wrong thing back.
     */
    bootValueOf(key: string): SettingValue {
        const spec = this.#require(key);
        const row = this.#db.prepare('SELECT boot_value FROM settings WHERE key = ?').get(spec.key) as
            | { boot_value: string }
            | undefined;

        return row === undefined ? this.#seedValue(spec) : coerce(spec, JSON.parse(row.boot_value));
    }

    #require(key: string): SettingSpec {
        const spec = SETTING_BY_KEY.get(key);
        if (spec === undefined) {
            throw new Error(`unknown setting: ${key}`);
        }
        return spec;
    }

    #read(spec: SettingSpec): SettingValue {
        const row = this.#db.prepare('SELECT value FROM settings WHERE key = ?').get(spec.key) as
            | { value: string }
            | undefined;

        if (row === undefined) {
            return this.#seedValue(spec);
        }

        return coerce(spec, JSON.parse(row.value));
    }

    get(key: string): SettingValue {
        return this.#read(this.#require(key));
    }

    number(key: string): number {
        return Number(this.get(key));
    }

    boolean(key: string): boolean {
        return this.get(key) === true;
    }

    string(key: string): string {
        return String(this.get(key));
    }

    /**
     * Update one or more keys. Invalid values are rejected outright — a typo in
     * a limit should be loud rather than silently falling back to a default.
     */
    set(values: Record<string, unknown>): SettingEntry[] {
        const parsed: [SettingSpec, SettingValue][] = Object.entries(values).map(([key, raw]) => {
            const spec = this.#require(key);
            return [spec, coerce(spec, raw)];
        });

        const update = this.#db.prepare('UPDATE settings SET value = ?, updated_at = ? WHERE key = ?');

        this.#db.transaction(() => {
            const now = new Date().toISOString();
            for (const [spec, value] of parsed) {
                update.run(JSON.stringify(value), now, spec.key);
            }
        });

        return parsed.map(([spec]) => this.entry(spec.key));
    }

    /** Put a key back to the value it booted with. */
    reset(keys: string[]): SettingEntry[] {
        return this.set(Object.fromEntries(keys.map((key) => [key, this.bootValueOf(key)])));
    }

    read(): SettingReader {
        return (key: string): SettingValue => this.get(key);
    }

    entry(key: string): SettingEntry {
        const spec = this.#require(key);
        const value = this.#read(spec);
        const boot = this.bootValueOf(spec.key);

        return {
            key: spec.key,
            type: spec.type,
            group: spec.group,
            description: spec.description,
            secret: spec.secret === true,
            restart: spec.restart === true,
            default: spec.default,
            bootValue: boot,
            value: spec.secret === true ? maskSecret(value) : value,
            ...(spec.secret === true ? { secretSet: String(value) !== '' } : {}),
            changed: value !== boot,
            ...(spec.env !== undefined ? { env: spec.env } : {}),
        };
    }

    /** Every key, as the admin UI and `cli.ts settings list` render it. */
    list(): SettingEntry[] {
        return SETTINGS.map((spec) => this.entry(spec.key));
    }

    appConfig(): AppConfig {
        return appConfigFrom(this.read(), this.#bootstrap);
    }

    /**
     * The gateway's shape, or a clear error naming the setting to change. The
     * key never appears in the message.
     */
    modelConfig(): ModelConfig {
        return toModelConfig(this.appConfig().model);
    }

    /**
     * Raw model settings including the key, for the CLI. Not for HTTP: use
     * `entry('model.apiKey')`, which masks it.
     */
    modelSettings(): ModelSettings {
        return this.appConfig().model;
    }
}

/** Build the seed map an `AppConfig` implies — used when a caller has a config. */
export function seedValuesFrom(config: AppConfig): Map<string, SettingValue> {
    return appConfigToValues(config);
}
