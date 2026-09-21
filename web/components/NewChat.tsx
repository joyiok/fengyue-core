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
import type { CharacterCard, CharacterListEntry, WorldbookSummary } from '@/lib/types';
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
    const [greeting, setGreeting] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

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
            get<{ card: CharacterCard }>(`/characters/${encodeURIComponent(picked)}`),
            get<{ worldbooks: WorldbookSummary[] }>('/worldbooks').catch(() => ({ worldbooks: [] })),
        ]).then(([detail, books]) => {
            setCard(detail.card);
            setWorldbooks(books.worldbooks);
        }).catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
    }, [picked]);

    const create = async (): Promise<void> => {
        if (picked === null) {
            return;
        }

        setBusy(true);
        setError(null);

        try {
            const created = await post<Created>('/chats', { cardId: picked, greetingIndex: greeting });
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
                    <div className="sub">{picked === null ? '选一个角色' : '选一段开场白'}</div>
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

                            {linked !== null ? (
                                <div className="hint" style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                                    世界书：
                                    {worldbooks.some((book) => book.id === linked)
                                        ? <a href={`/worldbooks/${encodeURIComponent(linked)}`} style={{ color: 'var(--lamp)' }}>{linked}</a>
                                        : `${linked}（未找到）`}
                                    ，会自动生效。
                                </div>
                            ) : null}

                            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void create()}>
                                {busy ? '创建中…' : '开始对话'}
                            </button>
                        </>
                    )}
                </div>
            ) : null}
        </div>
    );
}
