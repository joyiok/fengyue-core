'use client';

/**
 * All conversations, newest first.
 *
 * The API stores chats per character (`/chats/:cardId`), so this list is one
 * request for the characters that have chats plus one per character for its
 * threads — cheap at the scale a self-hosted instance runs at, and it keeps the
 * server honest about where a thread lives.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { Icon } from '@/components/icons';
import { NewChat } from '@/components/NewChat';
import { Avatar, ConfirmButton, Empty, Loading, Notice } from '@/components/ui';
import { avatarUrl, del, get } from '@/lib/api';
import { ago, count } from '@/lib/format';
import type { CardSummary, CharacterListEntry, ChatSummary } from '@/lib/types';

interface Thread {
    cardId: string;
    cardName: string;
    chat: ChatSummary;
}

export default function ChatsPage(): React.JSX.Element {
    const router = useRouter();
    const [threads, setThreads] = useState<Thread[] | null>(null);
    const [cards, setCards] = useState<CardSummary[]>([]);
    const [composing, setComposing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async (): Promise<void> => {
        const [list, owners] = await Promise.all([
            get<{ characters: CharacterListEntry[] }>('/characters'),
            get<{ characters: string[] }>('/chats'),
        ]);

        const summaries = list.characters.filter((entry): entry is { ok: true } & CardSummary => entry.ok);
        setCards(summaries);

        const names = new Map(summaries.map((entry) => [entry.id, entry.name]));

        const perCard = await Promise.all(owners.characters.map(async (cardId) => {
            try {
                const payload = await get<{ chats: ChatSummary[] }>(`/chats/${encodeURIComponent(cardId)}`);
                return payload.chats.map((chat) => ({
                    cardId,
                    cardName: names.get(cardId) ?? cardId,
                    chat,
                }));
            } catch {
                return [] as Thread[];
            }
        }));

        setThreads(perCard
            .flat()
            .sort((a, b) => new Date(b.chat.lastMessageAt ?? 0).getTime() - new Date(a.chat.lastMessageAt ?? 0).getTime()));
    }, []);

    useEffect(() => {
        void load().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
    }, [load]);

    const remove = async (cardId: string, name: string): Promise<void> => {
        try {
            await del(`/chats/${encodeURIComponent(cardId)}/${encodeURIComponent(name)}`);
            await load();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    };

    return (
        <div className="pane-pad pane-narrow">
            <div className="page-head">
                <div>
                    <h1>对话</h1>
                    <div className="sub">{threads === null ? '…' : `${count(threads.length)} 个会话`}</div>
                </div>
                <button type="button" className="btn btn-primary" onClick={() => setComposing(true)}>
                    <Icon name="plus" size={15} />
                    新建会话
                </button>
            </div>

            {error !== null ? <Notice kind="error">{error}</Notice> : null}

            {composing ? (
                <NewChat
                    onClose={() => setComposing(false)}
                    onCreated={(created) => {
                        router.push(`/chats/${encodeURIComponent(created.cardId)}/${encodeURIComponent(created.name)}`);
                    }}
                />
            ) : null}

            {threads === null ? <Loading /> : null}

            {threads !== null && threads.length === 0 && !composing ? (
                <Empty title="还没有对话">
                    选一张角色卡，说第一句话。
                    {cards.length === 0 ? (
                        <div style={{ marginTop: 12 }}>
                            <Link className="btn btn-sm" href="/characters">去导入角色卡</Link>
                        </div>
                    ) : null}
                </Empty>
            ) : null}

            {threads !== null && threads.length > 0 ? (
                <>
                    <div className="section-title">最近</div>
                    <div className="list">
                        {threads.map(({ cardId, cardName, chat }) => (
                            <div className="list-item" key={`${cardId}/${chat.name}`}>
                                <Avatar src={avatarUrl(cardId)} size={40} alt={cardName} />
                                <Link className="body" href={`/chats/${encodeURIComponent(cardId)}/${encodeURIComponent(chat.name)}`}>
                                    <div className="title">
                                        {cardName}
                                        <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}> · {chat.name}</span>
                                    </div>
                                    <div className="meta">
                                        {count(chat.messages)} 条 · 你说了 {count(chat.userMessages)} 句 · {ago(chat.lastMessageAt)}
                                    </div>
                                </Link>
                                <ConfirmButton
                                    label="删除"
                                    confirm="删除这个对话？"
                                    onConfirm={() => remove(cardId, chat.name)}
                                />
                            </div>
                        ))}
                    </div>
                </>
            ) : null}
        </div>
    );
}
