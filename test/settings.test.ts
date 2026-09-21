/**
 * Runtime configuration in the database.
 *
 * The rule these tests pin down: the environment says where the data is, the
 * `settings` table says how the service behaves. An environment variable is
 * consulted exactly once per key — to fill in a row that does not exist yet —
 * and the row is the truth after that. That is what makes "change the model key"
 * an update rather than a redeploy.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { BillingService } from '../src/billing/service.ts';
import { appConfigFrom, appConfigToValues, bootstrapOf, loadAppConfig } from '../src/config.ts';
import { Database } from '../src/db/database.ts';
import { SettingsService } from '../src/settings/service.ts';
import { SETTINGS } from '../src/settings/schema.ts';

async function withSettings(
    env: NodeJS.ProcessEnv,
    run: (settings: SettingsService, db: Database) => Promise<void> | void,
): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), 'story-settings-'));

    try {
        const seed = loadAppConfig(env);
        const db = new Database(path.join(dir, 'test.sqlite'));
        const settings = new SettingsService(db, { bootstrap: bootstrapOf(seed), seedValues: appConfigToValues(seed) });

        try {
            await run(settings, db);
        } finally {
            db.close();
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

test('every key gets one row, seeded from the environment and defaulting otherwise', async () => {
    await withSettings({ STORY_DAILY_TOKENS: '1234', STORY_MARKET: 'off' }, (settings) => {
        const byKey = new Map(settings.list().map((entry) => [entry.key, entry]));
        assert.equal(byKey.size, SETTINGS.length);

        assert.equal(settings.number('quota.dailyTokens'), 1234);
        assert.equal(settings.boolean('market.enabled'), false);

        // Nothing set in the environment: the shipped default is what is stored,
        // so `list()` is the whole configuration and nothing is "unset".
        assert.equal(settings.number('credits.signup'), 100);
        assert.equal(settings.get('model.endpoint'), '');
        assert.equal(byKey.get('model.apiKey')?.secret, true);
    });
});

test('the row is the truth once it exists: the environment is ignored afterwards', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'story-settings-seed-'));

    try {
        const dbPath = path.join(dir, 'test.sqlite');

        // First boot: the environment seeds the model endpoint.
        const first = loadAppConfig({ STORY_MODEL_ENDPOINT: 'https://first.example/v1', STORY_MODEL_NAME: 'first-model' });
        const db = new Database(dbPath);
        const settings = new SettingsService(db, {
            bootstrap: bootstrapOf(first),
            seedValues: appConfigToValues(first),
        });
        assert.equal(settings.string('model.endpoint'), 'https://first.example/v1');
        db.close();

        // Second boot with a different environment: the row wins. This is the
        // whole point — an operator edits the setting, not the deployment.
        const second = loadAppConfig({ STORY_MODEL_ENDPOINT: 'https://second.example/v1', STORY_MODEL_NAME: 'second-model' });
        const reopened = new Database(dbPath);
        const store = new SettingsService(reopened, {
            bootstrap: bootstrapOf(second),
            seedValues: appConfigToValues(second),
        });
        assert.equal(store.string('model.endpoint'), 'https://first.example/v1');
        assert.equal(store.string('model.name'), 'first-model');
        reopened.close();
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('set and reset keep types, and reset goes back to the boot value', async () => {
    await withSettings({ STORY_DAILY_TOKENS: '1234' }, (settings) => {
        const [updated] = settings.set({ 'quota.dailyTokens': '99', 'market.enabled': 'off', 'model.name': 'deepseek-chat' });
        assert.equal(settings.number('quota.dailyTokens'), 99);
        assert.equal(settings.boolean('market.enabled'), false);
        assert.equal(settings.string('model.name'), 'deepseek-chat');
        assert.equal(updated?.changed, true);

        settings.reset(['quota.dailyTokens', 'market.enabled']);
        assert.equal(settings.number('quota.dailyTokens'), 1234, 'reset returns to the seeded value');
        assert.equal(settings.boolean('market.enabled'), true, 'reset returns to the default');
        assert.equal(settings.string('model.name'), 'deepseek-chat', 'untouched keys stay put');
    });
});

test('an unknown key or a bad value is rejected loudly, not silently defaulted', async () => {
    await withSettings({}, (settings) => {
        assert.throws(() => settings.set({ 'quota.nope': 1 }), /unknown setting: quota.nope/);
        assert.throws(() => settings.set({ 'quota.dailyTokens': 'lots' }), /expects a number/);
        assert.throws(() => settings.set({ 'market.enabled': 'maybe' }), /expects a boolean/);
        assert.throws(() => settings.set({ 'auth.sessionTtlDays': 0 }), /must be >= 1/);

        // Nothing was half-applied.
        assert.equal(settings.number('quota.dailyTokens'), 200_000);
        assert.equal(settings.boolean('market.enabled'), true);
    });
});

test('a secret is masked in the listing and readable only in the console', async () => {
    await withSettings({}, (settings) => {
        settings.set({ 'model.apiKey': 'sk-very-secret-value' });

        const entry = settings.entry('model.apiKey');
        assert.equal(entry.secret, true);
        assert.equal(entry.secretSet, true);
        assert.equal(String(entry.value).includes('very-secret-value'), false, 'the listing must not carry the key');
        assert.equal(String(entry.value).endsWith('alue'), true, 'but it is recognisable as the same key');

        // The CLI is the operator's console, so the raw value is available there.
        assert.equal(settings.get('model.apiKey'), 'sk-very-secret-value');
    });
});

test('appConfigFrom and appConfigToValues are inverses', () => {
    const config = loadAppConfig({
        STORY_AUTH: 'off',
        STORY_DAILY_TOKENS: '1234',
        STORY_CREDITS_SIGNUP: '7',
        STORY_MARKET: 'off',
        STORY_MODEL_ENDPOINT: 'https://x/v1',
        STORY_MODEL_NAME: 'x-model',
        STORY_MODEL_API_KEY: 'sk-x',
    });

    const values = appConfigToValues(config);
    const rebuilt = appConfigFrom((key) => {
        const value = values.get(key);
        if (value === undefined) {
            throw new Error(`appConfigToValues did not produce ${key}`);
        }
        return value;
    }, bootstrapOf(config));

    assert.deepEqual(rebuilt, config);

    // The mapping is total over the schema. A key that neither reads nor writes
    // would sit in the settings table forever and be silently ignored, which is
    // the one failure this guard exists to catch.
    assert.deepEqual([...values.keys()].sort(), SETTINGS.map((spec) => spec.key).sort());
});

test('a limit read through an accessor sees a change made under it', async () => {
    await withSettings({}, (settings, db) => {
        // This is how BillingService reads its limits now: on every use rather
        // than copied at construction, so an admin raising a quota is obeyed by
        // the next request instead of the next restart.
        const billing = new BillingService(db, {
            defaultQuota: () => settings.appConfig().defaultQuota,
            globalDailyTokenLimit: (): number => settings.number('quota.globalDailyTokens'),
        });

        assert.equal(billing.policyFor('nobody').dailyTokenLimit, 200_000);
        settings.set({ 'quota.dailyTokens': 5 });
        assert.equal(billing.policyFor('nobody').dailyTokenLimit, 5);
    });
});

test('an unconfigured model names the setting to change and never prints a key', async () => {
    await withSettings({ STORY_MODEL_API_KEY: 'sk-hunter2' }, (settings) => {
        assert.throws(() => settings.modelConfig(), /no model endpoint configured: set "model\.endpoint"/);

        settings.set({ 'model.endpoint': 'https://x/v1' });
        assert.throws(() => settings.modelConfig(), /no model name configured: set "model\.name"/);

        try {
            settings.modelConfig();
        } catch (error) {
            assert.equal(String(error).includes('hunter2'), false);
        }

        settings.set({ 'model.name': 'x-model' });
        const model = settings.modelConfig();
        assert.equal(model.apiKey, 'sk-hunter2');
    });
});

test('the boot value belongs to the row, not to whoever is looking at it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'story-settings-boot-'));

    try {
        const dbPath = path.join(dir, 'test.sqlite');

        // The server boots with the deployment's environment.
        const db = new Database(dbPath);
        const server = new SettingsService(db, {
            bootstrap: bootstrapOf(loadAppConfig({ STORY_DAILY_TOKENS: '1234' })),
            seedValues: appConfigToValues(loadAppConfig({ STORY_DAILY_TOKENS: '1234' })),
        });
        server.set({ 'quota.dailyTokens': 42 });
        db.close();

        // A CLI runs in a different shell, without those variables. It must not
        // invent a different "boot value" — otherwise `reset` would write back
        // the CLI's default and silently destroy the deployment's setting.
        const cliDb = new Database(dbPath);
        const cli = new SettingsService(cliDb, {
            bootstrap: bootstrapOf(loadAppConfig({})),
            seedValues: appConfigToValues(loadAppConfig({})),
        });

        assert.equal(cli.bootValueOf('quota.dailyTokens'), 1234, 'the row remembers what it was booted with');
        assert.equal(cli.entry('quota.dailyTokens').changed, true);

        cli.reset(['quota.dailyTokens']);
        assert.equal(cli.number('quota.dailyTokens'), 1234);
        cliDb.close();
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('restart-required settings are marked so the UI can warn', async () => {
    await withSettings({}, (settings) => {
        const restarting = settings.list().filter((entry) => entry.restart).map((entry) => entry.key).sort();
        assert.deepEqual(restarting, ['auth.enabled', 'server.host', 'server.port']);
    });
});
