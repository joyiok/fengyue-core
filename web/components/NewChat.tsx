'use client';

/**
 * Start a new conversation.
 *
 * Two steps, because the second one needs the card: the greeting is chosen from
 * `first_mes` plus `alternate_greetings`, which is the only decision a new
 * conversation actually asks for. The linked world book is shown as information —
 * the API resolves `data.extensions.world` on its own, which is the normal case.
 */
import { useEffect, useState } from 'react';

import { avatarUrl, get, post } from '@/lib/api';
import { head } from '@/lib/format';
import type { CharacterCard, CharacterListEntry, Mod, WorldbookSummary } from '@/lib/types';
import { Avatar, Loading, Notice } from './ui';
import { Icon } from './icons';

interface Created {
    cardId: string;
    name: string;
}

export function NewChat({
    onClose,
    onCreated,
}: {
    onClose: () => void;
    onCreated: (created: Created) => void;
}): React.JSX.Element {
    const [cards, setCards] = useState<CharacterListEntry[] | null>(null);
    const [picked, setPicked] = useState<string | null>(null);
    const [card, setCard] = useState<CharacterCard | null>(null);
    const [worldbooks, setWorldbooks] = useState<WorldbookSummary[]>([]);
    /** `null` until the book list is in: creating then falls back to the card's
     *  own link rather than silently dropping it. */
    const [attached, setAttached] = useState<string[] | null>(null);
    const [greeting, setGreeting] = useState(0);
    const [mods, setMods] = useState<Mod[]>([]);
    const [attachedMods, setAttachedMods] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    // What the card asks before the first turn. The declarations travel with the
    // PNG; the panel, when the author wrote one, is HTML the site renders, with
    // fields bound through `data-var`.
    const [asked, setAsked] = useState<{ key: string; label: string; help?: string; default?: string; required?: boolean }[]>([]);
    const [panel, setPanel] = useState('');
    const [values, setValues] = useState<Record<string, string>>({});
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (picked === null || picked === '') {
            return;
        }

        void get<{ data: { extensions?: Record<string, unknown> } }>(`/characters/${encodeURIComponent(picked ?? '')}`).then((card) => {
            const story = ((card.data.extensions ?? {}) as { story?: Record<string, unknown> }).story ?? {};
            const declared = Array.isArray(story.variables) ? story.variables as { key: string; default?: string }[] : [];
            setAsked(declared as never);
            setPanel(typeof story.panel === 'string' ? story.panel : '');
            const seeded: Record<string, string> = {};
            for (const variable of declared) {
                seeded[variable.key] = variable.default ?? '';
            }
            setValues(seeded);
        }).catch(() => {
            setAsked([]);
            setPanel('');
        });
    }, [picked]);

    useEffect(() => {
        void get<{ characters: CharacterListEntry[] }>('/characters')
            .then((payload) => setCards(payload.characters.filter((entry) => entry.ok)))
            .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
    }, []);

    useEffect(() => {
        if (picked === null) {
            return;
        }

        setCard(null);
        setGreeting(0);

        void Promise.all([
            get<{ card: CharacterCard }>(`/characters/${encodeURIComponent(picked ?? '')}`),
            get<{ worldbooks: WorldbookSummary[] }>('/worldbooks').catch(() => ({ worldbooks: [] })),
        ]).then(([detail, books]) => {
            setCard(detail.card);
            setWorldbooks(books.worldbooks);
            const primary = typeof detail.card.data.extensions?.world === 'string' ? detail.card.data.extensions.world : null;
            setAttached(primary !== null && books.worldbooks.some((book) => book.id === primary) ? [primary] : []);
        }).catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
    }, [picked]);

    const toggleBook = (id: string): void => {
        setAttached((current) => current === null
            ? [id]
            : current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]);
    };

    // Only what this work may carry: shared mods from everyone, plus dedicated
    // mods written for this one. The server enforces the card's policy again at
    // `POST /chats` — this is about showing an honest list, not about security.
    useEffect(() => {
        if (picked === null || card === null) {
            return;
        }

        void get<{ mods: Mod[] }>(`/mods?characterId=${encodeURIComponent(picked ?? '')}`)
            .then((available) => {
                setMods(available.mods.filter((mod) => mayLoad(card, mod)));
                setAttachedMods([]);
            })
            .catch(() => setMods([]));
    }, [picked, card]);

    const create = async (): Promise<void> => {
        if (picked === null) {
            return;
        }

        setBusy(true);
        setError(null);

        try {
            // Always send the list once it is known: an empty one means "no world
            // book at all", which is a different request from "use the card's".
            const created = await post<Created>('/chats', {
                cardId: picked,
                variables: values,
                greetingIndex: greeting,
                ...(attached === null ? {} : { worldbookIds: attached }),
                ...(attachedMods.length === 0 ? {} : { modIds: attachedMods }),
            });
            onCreated(created);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
            setBusy(false);
        }
    };

    const greetings = card === null
        ? []
        : [card.data.first_mes ?? '', ...(card.data.alternate_greetings ?? [])].filter((text) => text.trim() !== '');

    const linked = typeof card?.data.extensions?.world === 'string' ? card.data.extensions.world : null;

    return (
        <div className="panel">
            <div className="page-head" style={{ marginBottom: 16 }}>
                <div>
                    <h1 style={{ fontSize: 20 }}>新的对话</h1>
                    <div className="sub">{picked === null ? '选一个角色' : '选开场白和世界书'}</div>
                </div>
                <button type="button" className="btn btn-quiet btn-sm" onClick={onClose}>取消</button>
            </div>

            {error !== null ? <Notice kind="error">{error}</Notice> : null}

            {cards === null ? <Loading /> : null}

            {cards !== null && picked === null ? (
                cards.length === 0 ? (
                    <Notice>
                        还没有角色卡。
                        <a href="/characters" style={{ color: 'var(--lamp)' }}>去导入一张</a>
                    </Notice>
                ) : (
                    <div className="list" style={{ maxHeight: '52vh', overflowY: 'auto' }}>
                        {cards.map((entry) => {
                            if (!entry.ok) {
                                return null;
                            }
                            return (
                                <button
                                    type="button"
                                    className="list-item"
                                    key={entry.id}
                                    style={{ textAlign: 'left', cursor: 'pointer', border: 'none', width: '100%' }}
                                    onClick={() => setPicked(entry.id)}
                                >
                                    <Avatar src={avatarUrl(entry.id)} size={40} alt={entry.name} />
                                    <span className="body">
                                        <span className="title" style={{ display: 'block' }}>{entry.name}</span>
                                        <span className="meta" style={{ display: 'block' }}>
                                            {entry.tags.slice(0, 3).join(' · ') || entry.id}
                                        </span>
                                    </span>
                                    <Icon name="back" size={16} />
                                </button>
                            );
                        })}
                    </div>
                )
            ) : null}

            {picked !== null ? (
                <div className="stack">
                    <div className="row">
                        <Avatar src={avatarUrl(picked)} size={36} alt="" />
                        <b style={{ fontFamily: 'var(--font-read)', fontSize: 17 }}>{card?.data.name ?? picked}</b>
                        <span className="grow" />
                        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setPicked(null)}>换个角色</button>
                    </div>

                    {card === null ? <Loading /> : (
                        <>
                            {greetings.length > 1 ? (
                                <div className="field">
                                    <label>开场白</label>
                                    {greetings.map((text, index) => (
                                        <label
                                            key={index}
                                            className="row"
                                            style={{
                                                gap: 10,
                                                alignItems: 'flex-start',
                                                padding: '8px 10px',
                                                borderRadius: 'var(--radius-sm)',
                                                background: greeting === index ? 'var(--lamp-soft)' : 'var(--ink-1)',
                                                cursor: 'pointer',
                                            }}
                                        >
                                            <input
                                                type="radio"
                                                name="greeting"
                                                checked={greeting === index}
                                                onChange={() => setGreeting(index)}
                                                style={{ marginTop: 4 }}
                                            />
                                            <span style={{ fontSize: 13.5, color: 'var(--text-dim)' }}>{head(text, 64)}</span>
                                        </label>
                                    ))}
                                </div>
                            ) : null}

                            <div className="field">
                                <label>世界书</label>
                                {worldbooks.length === 0 ? (
                                    <span className="hint">库里还没有世界书。</span>
                                ) : (
                                    <>
                                        {worldbooks.map((book) => (
                                            <label
                                                key={book.id}
                                                className="row"
                                                style={{
                                                    gap: 10,
                                                    padding: '6px 10px',
                                                    borderRadius: 'var(--radius-sm)',
                                                    background: 'var(--ink-1)',
                                                    cursor: 'pointer',
                                                    fontSize: 13.5,
                                                }}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={attached?.includes(book.id) ?? false}
                                                    onChange={() => toggleBook(book.id)}
                                                />
                                                <span className="grow">
                                                    {book.id}
                                                    {book.id === linked ? <span className="tag lamp" style={{ marginLeft: 8 }}>卡片默认</span> : null}
                                                </span>
                                                <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>{book.entries} 词条</span>
                                            </label>
                                        ))}
                                        <span className="hint">
                                            都不勾就是一本都不挂。卡片默认勾了 {linked ?? '（这张卡没关联世界书）'}。
                                        </span>
                                    </>
                                )}
                            </div>

                            {mods.length === 0 ? null : (
                                <div className="field">
                                    <label>Mod</label>
                                    {mods.map((mod) => {
                                        const on = attachedMods.includes(mod.id);
                                        return (
                                            <label
                                                key={mod.id}
                                                className="row"
                                                style={{ gap: 10, padding: '6px 10px', borderRadius: 'var(--radius-sm)', background: 'var(--ink-1)', cursor: 'pointer', fontSize: 13.5 }}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={on}
                                                    onChange={() => setAttachedMods((current) => on ? current.filter((entry) => entry !== mod.id) : [...current, mod.id])}
                                                />
                                                <span className="grow">{mod.name}</span>
                                                {mod.memory === null ? null : <span className="tag lamp">会花钱</span>}
                                                <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>{mod.scope === 'dedicated' ? '专用' : '公用'}</span>
                                            </label>
                                        );
                                    })}

                                    {attachedMods.some((id) => mods.find((mod) => mod.id === id)?.memory != null) ? (
                                        <div className="notice" style={{ marginTop: 8 }}>
                                            选中的 Mod 会开启<b>滚动摘要</b>：每次合并是一次真实且计费的模型调用。
                                            不带记忆预设的 Mod 不产生这笔费用。
                                        </div>
                                    ) : null}

                                    <span className="hint">这张卡允许的才列在这里——每张卡有自己的来源策略，写在卡里、跟着卡走。</span>
                                </div>
                            )}

                            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void create()}>
{asked.length === 0 ? null : (
                <div className="panel">
                    <div className="section-title" style={{ marginTop: 0 }}>开聊之前</div>
                    {panel === '' ? null : (
                        <div className="stack" dangerouslySetInnerHTML={{ __html: panel }} />
                    )}
                    {asked.map((variable) => (
                        <div className="field" key={variable.key}>
                            <label className="label">{variable.label}{variable.required === true ? ' *' : ''}</label>
                            <input
                                className="input"
                                data-var={variable.key}
                                value={values[variable.key] ?? ''}
                                onChange={(event) => setValues((previous) => ({ ...previous, [variable.key]: event.target.value }))}
                            />
                            {(variable.help ?? '') === '' ? null : <div className="help">{variable.help}</div>}
                        </div>
                    ))}
                </div>
            )}
                               {busy ? '创建中…' : '开始对话'}
                            </button>
                        </>
                    )}
                </div>
            ) : null}
        </div>
    );
}

/**
 * Mirror of the server's four policy tiers, for the list only.
 *
 * `extensions.story.mods.policy` lives on the card so it travels with the PNG;
 * the server enforces it again at `POST /chats`. Hiding a button is not a
 * boundary — this is about showing an honest list, not about security.
 */
function mayLoad(card: CharacterCard, mod: Mod): boolean {
    const story = (card.data.extensions?.story ?? {}) as { mods?: { policy?: unknown }; authorId?: unknown };
    const policy = story.mods?.policy;
    const authorId = typeof story.authorId === 'string' ? story.authorId : null;
    const mine = mod.ownerId === authorId;

    if (policy === 'none') return false;
    if (policy === 'own') return mine;
    if (policy === 'own-dedicated') return mod.scope === 'shared' || mine;
    return true;
}
