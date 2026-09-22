/**
 * Command line front end for the M0 asset layer.
 *
 *   node src/cli.ts list                         list character cards
 *   node src/cli.ts show <id>                    print one card as JSON
 *   node src/cli.ts import <file.png|file.json>  import a card
 *   node src/cli.ts export <id> [out.png]        re-encode a card as PNG
 *   node src/cli.ts worldbooks                   list world books
 *   node src/cli.ts chats [character]            list chat logs
 *   node src/cli.ts preview <id> <message>       show the prompt, call nothing
 *   node src/cli.ts ask <id> <message>           start a chat and send one turn
 *   node src/cli.ts say <id> <chat> <message>    continue an existing chat
 *
 * The library root comes from --root or STORY_LIBRARY_ROOT (default ./library).
 * Point it at a SillyTavern user directory (e.g. ..//path/to/sillytavern/data/default-user)
 * to work on an existing library directly.
 *
 * Model settings come from story.config.json or the STORY_MODEL_* variables;
 * see story.config.example.json. Without them, only the asset commands work.
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { AuthService } from './auth/service.ts';
import { BillingService } from './billing/service.ts';
import { ChatSession } from './chat/session.ts';
import { appConfigToValues, bootstrapOf, loadAppConfig, type AppConfig } from './config.ts';
import { CreditService } from './credits/service.ts';
import { Database } from './db/database.ts';
import type { ChatMessage } from './chats/types.ts';
import { describeModelConfig, type ModelConfig } from './gateway/types.ts';
import { Library } from './library.ts';
import { MarketService } from './market/service.ts';
import { assemblePrompt } from './prompt/assemble.ts';
import { SettingsService } from './settings/service.ts';

function usage(): never {
    console.log(`
Usage: node src/cli.ts <command> [options]

Commands:
  list                          list character cards
  show <id>                     print one card as JSON
  import <file.png|file.json>   import a card into the library
  export <id> [out.png]         re-encode a card as PNG
  worldbooks                    list world books
  chats [character]             list chat logs
  preview <id> <message>        print the prompt that would be sent
  ask <id> <message>            start a new chat and send one turn
  say <id> <chat> <message>     send a turn to an existing chat
  regen <id> <chat> [message]   replace the last reply (optionally editing the user turn)
  model                         show the configured model (key redacted)

  user add <handle> <password> [--admin]   create an account
  user passwd <handle> <password>          set a password (revokes every session)
  user close <handle>                      close an account: free the handle, remove the library
  user list                                accounts with their usage
  user enable|disable <handle>             flip an account's status
  user quota <handle> [--daily N] [--monthly N] [--per-request N]

  credits show <handle>                    balance, totals and the recent ledger
  credits grant <handle> <amount> [--reference X]   manual top-up
  credits invite <handle> [--count N]      mint invite codes
  market list [--q TEXT] [--sort hot|new|name] [--limit N]
  market publish <handle> <cardId> [--root DIR]     publish a card
  market unpublish <handle> <cardId>       withdraw a published card

  settings list                     every setting, its value and where it came from
  settings get <key>                one value (a secret is shown here, masked over HTTP)
  settings set <key> <value>        change one: takes effect without a restart
  settings reset <key> [...]        put keys back to their boot value

Options:
  --root <dir>                  library root (default: $STORY_LIBRARY_ROOT or ./library)
  --persona <name>              name used for {{user}} (default: the chat.personaName setting)
  --stream                      stream the reply as it is generated (ask/say/regen)
  --json                        machine-readable output for ask/say/regen
  --db <path>                   account database (default: $STORY_DB or ./story.sqlite)
`);
    process.exit(2);
}

/**
 * Split `<command> <positional...> [--flag value]` into its parts, so a command
 * can read positionals without tripping over a flag's value.
 */
function splitArgs(args: string[]): { positional: string[]; option: (name: string) => string | undefined } {
    return {
        positional: args.filter((value, index) => !value.startsWith('--') && !(args[index - 1] ?? '').startsWith('--')),
        option: (name) => {
            const index = args.indexOf(name);
            return index >= 0 ? args[index + 1] : undefined;
        },
    };
}

function takeRoot(argv: string[]): {
    root: string;
    persona: string | undefined;
    json: boolean;
    stream: boolean;
    dbPath: string;
    rest: string[];
} {
    let root = process.env.STORY_LIBRARY_ROOT ?? './library';
    let dbPath = process.env.STORY_DB ?? './story.sqlite';
    let persona: string | undefined;
    let json = false;
    let stream = false;
    const rest: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--root') {
            root = argv[i + 1] ?? root;
            i += 1;
            continue;
        }
        if (argv[i] === '--persona') {
            persona = argv[i + 1] ?? persona;
            i += 1;
            continue;
        }
        if (argv[i] === '--json') {
            json = true;
            continue;
        }
        if (argv[i] === '--stream') {
            stream = true;
            continue;
        }
        if (argv[i] === '--db') {
            dbPath = argv[i + 1] ?? dbPath;
            i += 1;
            continue;
        }
        rest.push(argv[i] as string);
    }

    return { root, persona, json, stream, dbPath, rest };
}

async function main(): Promise<number> {
    const { root, persona, json, stream, dbPath, rest } = takeRoot(process.argv.slice(2));
    const [command, ...args] = rest;

    // Configuration lives in the database. This seeds the table on first use
    // from the environment (exactly as a server boot does) and reads it after
    // that, so `settings set` and a running server see the same values.
    const seed = loadAppConfig();
    const settings = new SettingsService(new Database(dbPath), {
        bootstrap: bootstrapOf(seed),
        seedValues: appConfigToValues(seed),
    });
    const appConfig: AppConfig = settings.appConfig();
    const personaName = persona ?? appConfig.personaName;

    /**
     * Keep rolling memory up to date after a turn.
     *
     * The HTTP server does this with quota accounting; the CLI has no accounts, so
     * it just runs the pass when one is due. Without this, conversations started
     * from the command line would never get a summary.
     */
    const maintainMemory = async (session: ChatSession, modelConfig: ModelConfig): Promise<void> => {
        if (session.summaryPlan() === null) {
            return;
        }

        const summary = await session.summarize(modelConfig);
        if (summary !== null) {
            console.error(`[memory] summarized up to message ${summary.upTo} (pass ${summary.passes})`);
        }
    };

    /** Streams to stdout unless JSON output was requested. */
    const onDelta = json || !stream
        ? undefined
        : (delta: string): void => { process.stdout.write(delta); };

    if (!command) {
        usage();
    }

    const library = new Library(root);

    // These commands work on the database only. Creating a library directory for
    // them would be a pointless side effect — and in the container it is not even
    // possible, since only /data is writable and `--root` is somewhere else.
    const databaseOnly = ['user', 'settings', 'model'];
    if (!databaseOnly.includes(command ?? '')) {
        await library.ensureDirs();
    }

    switch (command) {
        case 'list': {
            const entries = await library.listCharacters();
            if (entries.length === 0) {
                console.log(`no character cards in ${library.charactersDir}`);
                return 0;
            }
            for (const entry of entries) {
                if (entry.ok) {
                    const v3 = entry.hasV3Chunk ? 'v3+v2' : 'v2';
                    console.log(`${entry.id.padEnd(28)} ${entry.name.padEnd(20)} ${v3.padEnd(6)} desc=${String(entry.descriptionLength).padStart(5)}  tags=${entry.tags.join(',')}`);
                } else {
                    console.log(`${entry.id.padEnd(28)} !! unreadable: ${entry.error}`);
                }
            }
            return 0;
        }

        case 'show': {
            const id = args[0];
            if (!id) usage();
            console.log(JSON.stringify(await library.getCard(id), null, 2));
            return 0;
        }

        case 'import': {
            const file = args[0];
            if (!file) usage();
            const buffer = await readFile(file);
            const result = await library.importCard(buffer, { filename: path.basename(file) });
            console.log(`imported ${result.fileName} -> id=${result.id} name=${result.summary.name}`);
            return 0;
        }

        case 'export': {
            const id = args[0];
            if (!id) usage();
            const out = args[1] ?? `${id}.png`;
            const png = await library.exportCardPng(id);
            await writeFile(out, png);
            console.log(`wrote ${out} (${png.length} bytes)`);
            return 0;
        }

        case 'worldbooks': {
            const books = await library.listWorldbooks();
            if (books.length === 0) {
                console.log(`no world books in ${library.worldsDir}`);
                return 0;
            }
            for (const book of books) {
                console.log(`${book.id.padEnd(28)} entries=${String(book.entries).padStart(4)}  constant=${book.constantEntries}  disabled=${book.disabledEntries}  ${book.bytes} bytes`);
            }
            return 0;
        }

        case 'chats': {
            const character = args[0];
            if (!character) {
                const characters = await library.listChatCharacters();
                if (characters.length === 0) {
                    console.log(`no chat logs in ${library.chatsDir}`);
                    return 0;
                }
                for (const name of characters) {
                    console.log(`${name}  (${(await library.listChats(name)).length} chats)`);
                }
                return 0;
            }
            for (const chat of await library.listChats(character)) {
                console.log(`${chat.name.padEnd(32)} messages=${String(chat.messages).padStart(4)}  last=${String(chat.lastMessageAt)}`);
            }
            return 0;
        }

        case 'preview': {
            const [id, message] = args;
            if (!id || !message) usage();

            // Side-effect free: build the prompt without creating a chat file.
            const card = await library.getCard(id);
            const worldbook = await library.resolveWorldbooks(card);
            const greeting = (card.data.first_mes ?? '').trim();
            const history: ChatMessage[] = greeting === ''
                ? []
                : [{ name: card.data.name, is_user: false, send_date: new Date().toISOString(), mes: greeting }];

            const assembled = assemblePrompt({
                card,
                history,
                userMessage: message,
                options: { personaName },
                worldbook,
            });

            if (json) {
                console.log(JSON.stringify(assembled, null, 2));
                return 0;
            }

            for (const promptMessage of assembled.messages) {
                console.log(`--- ${promptMessage.role} ---`);
                console.log(promptMessage.content);
            }

            const worldInfo = assembled.stats.worldInfo;
            if (worldInfo) {
                console.log(`\n(world info: ${worldInfo.activated.length}/${worldInfo.candidates} activated; ` +
                    `skipped key=${worldInfo.skippedByKeyLogic} probability=${worldInfo.skippedByProbability} ` +
                    `cooldown=${worldInfo.skippedByCooldown} delay=${worldInfo.skippedByDelay} ` +
                    `budget=${worldInfo.skippedByBudget}; ~${worldInfo.estimatedTokens} tokens)`);

                for (const activation of worldInfo.activated) {
                    const keys = activation.matchedKeys.length > 0 ? ` keys=${activation.matchedKeys.join('/')}` : '';
                    const depth = activation.target === 'at_depth' ? `@${activation.depth}` : '';
                    console.log(`   [${activation.world}.${activation.uid}] ${activation.comment || '(no comment)'}` +
                        ` ← ${activation.reason}${keys} → ${activation.target}${depth} role=${activation.role}`);
                }
            }

            console.log(`\n(estimated tokens: ${assembled.stats.estimatedTokens}; sections: ${assembled.stats.sections.join(', ')})`);
            return 0;
        }

        case 'ask': {
            const [id, message] = args;
            if (!id || !message) usage();

            const config = settings.modelConfig();
            const session = await ChatSession.create(library, {
                cardId: id,
                personaName,
                memory: appConfig.memory,
            });
            const result = await session.send(config, message, onDelta ? { onDelta } : {});
            await maintainMemory(session, config);

            if (json) {
                console.log(JSON.stringify({
                    chat: session.name,
                    reply: result.reply,
                    model: result.model,
                    usage: result.usage,
                    usageSource: result.usageSource,
                    prompt: result.stats,
                }, null, 2));
                return 0;
            }

            if (onDelta) {
                process.stdout.write(`\n\n(chat=${session.name} model=${result.model} ` +
                    `tokens=${result.usage.totalTokens ?? '?'}(${result.usageSource}) ` +
                    `${result.latencyMs}ms${result.firstTokenMs !== undefined ? ` first=${result.firstTokenMs}ms` : ''})\n`);
                return 0;
            }

            console.log(`[${session.card.data.name}] ${result.reply}`);
            console.log(`\n(chat=${session.name} model=${result.model} tokens=${result.usage.totalTokens ?? '?'} ${result.latencyMs}ms)`);
            return 0;
        }

        case 'say': {
            const [id, chatName, message] = args;
            if (!id || !chatName || !message) usage();

            const config = settings.modelConfig();
            const session = await ChatSession.load(library, id, chatName, {
                personaName,
                memory: appConfig.memory,
            });
            const result = await session.send(config, message, onDelta ? { onDelta } : {});
            await maintainMemory(session, config);

            if (json) {
                console.log(JSON.stringify({
                    chat: session.name,
                    reply: result.reply,
                    model: result.model,
                    usage: result.usage,
                    usageSource: result.usageSource,
                    prompt: result.stats,
                    history: session.messages.length,
                }, null, 2));
                return 0;
            }

            if (onDelta) {
                process.stdout.write(`\n\n(chat=${session.name} turns=${session.messages.length} ` +
                    `tokens=${result.usage.totalTokens ?? '?'}(${result.usageSource}) ${result.latencyMs}ms)\n`);
                return 0;
            }

            console.log(`[${session.card.data.name}] ${result.reply}`);
            console.log(`\n(chat=${session.name} turns=${session.messages.length} tokens=${result.usage.totalTokens ?? '?'} ${result.latencyMs}ms)`);
            return 0;
        }

        case 'regen': {
            const [id, chatName, newMessage] = args;
            if (!id || !chatName) usage();

            const config = settings.modelConfig();
            const session = await ChatSession.load(library, id, chatName, {
                personaName,
                memory: appConfig.memory,
            });
            const result = await session.regenerate(config, {
                ...(newMessage !== undefined ? { userMessageOverride: newMessage } : {}),
                ...(onDelta ? { onDelta } : {}),
            });
            await maintainMemory(session, config);

            if (json) {
                console.log(JSON.stringify({
                    chat: session.name,
                    reply: result.reply,
                    model: result.model,
                    usage: result.usage,
                    usageSource: result.usageSource,
                    prompt: result.stats,
                    history: session.messages.length,
                }, null, 2));
                return 0;
            }

            if (onDelta) {
                process.stdout.write(`\n\n(regenerated chat=${session.name} turns=${session.messages.length} ` +
                    `tokens=${result.usage.totalTokens ?? '?'}(${result.usageSource}) ${result.latencyMs}ms)\n`);
                return 0;
            }

            console.log(`[${session.card.data.name}] ${result.reply}`);
            console.log(`\n(regenerated chat=${session.name} turns=${session.messages.length} tokens=${result.usage.totalTokens ?? '?'} ${result.latencyMs}ms)`);
            return 0;
        }

        case 'user': {
            const config = appConfig;
            const db = new Database(dbPath);
            const auth = new AuthService(db, { sessionTtlDays: config.sessionTtlDays });
            const billing = new BillingService(db, {
                defaultQuota: config.defaultQuota,
                globalDailyTokenLimit: config.globalDailyTokenLimit,
                maxConcurrentStreamsPerUser: config.maxConcurrentStreamsPerUser,
            });

            try {
                const [action, ...actionArgs] = args;
                const flag = (name: string): number | undefined => {
                    const index = actionArgs.indexOf(name);
                    if (index < 0) {
                        return undefined;
                    }
                    const value = Number(actionArgs[index + 1]);
                    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
                };
                const handleArg = actionArgs.find((value) => !value.startsWith('--'));

                switch (action) {
                    case 'add': {
                        const handle = actionArgs[0];
                        const password = actionArgs[1];
                        if (!handle || !password) usage();

                        const created = auth.register({
                            handle,
                            password,
                            // Only pass a role when one was requested: passing 'user'
                            // unconditionally would defeat the first-account-is-admin
                            // bootstrap in AuthService.
                            ...(actionArgs.includes('--admin') ? { role: 'admin' as const } : {}),
                        });

                        console.log(`created ${created.user.handle} (${created.user.role}, id=${created.user.id})`);
                        return 0;
                    }

                    // Account recovery from the operator's console: no current
                    // password is asked for, because whoever has this shell owns
                    // the box already. It revokes every session just like a
                    // self-service change, so a recovery also clears out whoever
                    // may have been inside.
                    case 'passwd': {
                        const handle = actionArgs[0];
                        const newPassword = actionArgs[1];
                        if (!handle || !newPassword) usage();

                        const target = auth.findByHandle(handle);
                        if (target === null) {
                            console.error(`no such account: ${handle}`);
                            return 1;
                        }

                        auth.resetPassword(target.id, newPassword);
                        console.log(`password updated for ${target.handle}; every session was revoked`);
                        return 0;
                    }

                    // Close an account: free the handle, make the password
                    // unusable, revoke the sessions and remove the library. The
                    // ledgers stay, so every total still reconciles.
                    case 'close': {
                        if (!handleArg) usage();

                        const target = auth.findByHandle(handleArg);
                        if (target === null) {
                            console.error(`no such account: ${handleArg}`);
                            return 1;
                        }

                        auth.anonymize(target.id);
                        await rm(path.join(appConfig.dataRoot, 'users', target.id), { recursive: true, force: true });

                        console.log(`closed ${handleArg}: handle freed, sessions revoked, library removed`);
                        console.log('(the usage and credit ledgers are kept so totals still reconcile)');
                        return 0;
                    }

                    case 'list': {
                        const users = auth.list();
                        if (users.length === 0) {
                            console.log('no accounts yet; the first one created becomes an admin');
                            return 0;
                        }

                        for (const entry of users) {
                            const summary = billing.summary(entry.id);
                            const limit = (value: number): string => (value === 0 ? 'unlimited' : String(value));
                            console.log([
                                entry.handle.padEnd(20),
                                entry.role.padEnd(6),
                                entry.status.padEnd(9),
                                `day=${summary.day.tokens}/${limit(summary.day.limit)}`,
                                `month=${summary.month.tokens}/${limit(summary.month.limit)}`,
                                `perRequest=${summary.policy.maxTokensPerRequest}`,
                            ].join(' '));
                        }
                        return 0;
                    }

                    case 'enable':
                    case 'disable': {
                        if (!handleArg) usage();
                        const user = auth.findByHandle(handleArg);
                        if (user === null) {
                            throw new Error(`no such account: ${handleArg}`);
                        }

                        const updated = auth.setStatus(user.id, action === 'disable' ? 'disabled' : 'active');
                        console.log(`${updated.handle} is now ${updated.status}`);
                        return 0;
                    }

                    case 'quota': {
                        if (!handleArg) usage();
                        const user = auth.findByHandle(handleArg);
                        if (user === null) {
                            throw new Error(`no such account: ${handleArg}`);
                        }

                        const current = billing.policyFor(user.id);
                        const policy = billing.setPolicy(user.id, {
                            dailyTokenLimit: flag('--daily') ?? current.dailyTokenLimit,
                            monthlyTokenLimit: flag('--monthly') ?? current.monthlyTokenLimit,
                            maxTokensPerRequest: flag('--per-request') ?? current.maxTokensPerRequest,
                        });

                        console.log(JSON.stringify(policy));
                        return 0;
                    }

                    default:
                        usage();
                }
            } finally {
                db.close();
            }
        }

        case 'credits': {
            const config = appConfig;
            const db = new Database(dbPath);
            const auth = new AuthService(db, { sessionTtlDays: config.sessionTtlDays });
            const credits = new CreditService(db, {
                initialGrant: config.credits.initialGrant,
                checkinAmount: config.credits.checkinAmount,
                inviteReward: config.credits.inviteReward,
                inviteeReward: config.credits.inviteeReward,
                tokensPerCredit: config.credits.tokensPerCredit,
            });

            try {
                const { positional, option } = splitArgs(args);
                const [action, handleArg, amountArg] = positional;

                if (!action || !handleArg) usage();
                const user = auth.findByHandle(handleArg);
                if (user === null) {
                    throw new Error(`no such account: ${handleArg}`);
                }

                switch (action) {
                    case 'show': {
                        const summary = credits.summary(user.id, 20);

                        // granted - spent == balance is the reconciliation an operator
                        // actually checks, so print both sides.
                        console.log(`${user.handle}  balance=${summary.balance}  granted=${summary.granted}  spent=${summary.spent}  `
                            + `today=+${summary.today.granted}/-${summary.today.spent}  (${credits.tokensPerCredit} tokens = 1 credit)`);

                        for (const entry of summary.recent) {
                            console.log([
                                entry.createdAt,
                                String(entry.amount).padStart(6),
                                entry.reason.padEnd(8),
                                entry.reference ?? '',
                            ].join('  '));
                        }
                        return 0;
                    }

                    case 'grant': {
                        const amount = Math.trunc(Number(amountArg));
                        if (!Number.isFinite(amount) || amount <= 0) {
                            throw new Error('grant needs a positive amount: credits grant <handle> <amount> [--reference X]');
                        }

                        const result = credits.grant(user.id, amount, 'admin', option('--reference'));
                        console.log(`${result.recorded ? 'granted' : 'already granted (same reference)'} `
                            + `${amount} to ${user.handle}; balance=${result.balance}`);
                        return 0;
                    }

                    case 'invite': {
                        const count = Math.trunc(Number(option('--count') ?? 1));
                        const codes = credits.createInvite(user.id, Number.isFinite(count) && count > 0 ? count : 1);
                        for (const code of codes) {
                            console.log(code);
                        }
                        return 0;
                    }

                    default:
                        usage();
                }
            } finally {
                db.close();
            }
        }

        case 'market': {
            const config = appConfig;
            const db = new Database(dbPath);
            const auth = new AuthService(db, { sessionTtlDays: config.sessionTtlDays });
            const market = new MarketService(db);

            try {
                const { positional, option } = splitArgs(args);
                const [action, handleArg, cardId] = positional;

                switch (action) {
                    case 'list': {
                        const sortArg = option('--sort');
                        const q = option('--q');
                        const list = market.list({
                            ...(q !== undefined ? { q } : {}),
                            sort: sortArg === 'new' || sortArg === 'name' ? sortArg : 'hot',
                            limit: Number(option('--limit') ?? 20),
                            offset: Number(option('--offset') ?? 0),
                        });

                        if (list.length === 0) {
                            console.log('nothing published yet');
                            return 0;
                        }

                        for (const entry of list) {
                            console.log([
                                entry.ownerId.slice(0, 8),
                                entry.characterId.padEnd(18),
                                `score=${String(entry.stats.score).padStart(4)}`,
                                `fav=${entry.stats.favorites} import=${entry.stats.imports} view=${entry.stats.views}`,
                                entry.tags.join(','),
                            ].join('  '));
                        }
                        return 0;
                    }

                    case 'publish':
                    case 'unpublish': {
                        if (!handleArg || !cardId) usage();
                        const user = auth.findByHandle(handleArg);
                        if (user === null) {
                            throw new Error(`no such account: ${handleArg}`);
                        }

                        if (action === 'unpublish') {
                            const removed = market.unpublish(user.id, cardId);
                            console.log(removed ? `unpublished ${cardId}` : `${cardId} was not published`);
                            return 0;
                        }

                        // --root is that account's library directory, since cards live
                        // in files rather than in the database.
                        const card = await new Library(root).getCard(cardId);
                        const entry = market.publish(user.id, cardId, {
                            name: card.data.name,
                            tags: Array.isArray(card.data.tags) ? card.data.tags : [],
                            descriptionLength: (card.data.description ?? '').length,
                        });

                        console.log(`published ${entry.characterId} for ${user.handle}: ${entry.name} [${entry.tags.join(', ')}]`);
                        return 0;
                    }

                    default:
                        usage();
                }
            } finally {
                db.close();
            }
        }

        case 'settings': {
            const { positional } = splitArgs(args);
            const [action, key, ...valueParts] = positional;

            switch (action) {
                case 'list': {
                    for (const entry of settings.list()) {
                        const shown = entry.secret ? String(entry.value) : JSON.stringify(entry.value);
                        const flags = [
                            entry.changed ? 'changed' : '',
                            entry.restart ? 'restart' : '',
                            entry.env === undefined ? '' : `seed=${entry.env}`,
                        ].filter((part) => part !== '').join(' ');

                        console.log(`${entry.key.padEnd(28)} ${String(shown).padEnd(26)} ${flags}`);
                    }

                    console.log('\nEvery key has exactly one row. `settings set` writes it and `settings reset`');
                    console.log('puts it back to the value it booted with; the environment is consulted only to');
                    console.log('fill a row in, so editing a variable under a running server does nothing.');
                    return 0;
                }

                case 'get': {
                    if (key === undefined) {
                        usage();
                    }
                    // The operator's console: a secret is shown here and masked
                    // everywhere it could reach a log or a browser.
                    console.log(JSON.stringify(settings.get(key), null, 2));
                    return 0;
                }

                case 'set': {
                    if (key === undefined || valueParts.length === 0) {
                        usage();
                    }
                    const [entry] = settings.set({ [key]: valueParts.join(' ') });
                    if (entry === undefined) {
                        usage();
                    }
                    console.log(`${entry.key} = ${JSON.stringify(entry.value)}`
                        + `${entry.restart ? '   (restart before it takes effect)' : ''}`);
                    return 0;
                }

                case 'reset': {
                    const keys = [key, ...valueParts].filter((part): part is string => part !== undefined);
                    if (keys.length === 0) {
                        usage();
                    }
                    for (const entry of settings.reset(keys)) {
                        console.log(`${entry.key} = ${JSON.stringify(entry.value)}`);
                    }
                    return 0;
                }

                default:
                    usage();
            }
        }

        case 'model': {
            console.log(JSON.stringify(describeModelConfig(settings.modelConfig()), null, 2));
            return 0;
        }

        default:
            usage();
    }
}

main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
        console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
