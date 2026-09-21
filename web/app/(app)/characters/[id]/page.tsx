'use client';

/**
 * One character: edit the card, swap the avatar, publish it to the market, and
 * see the conversations it has.
 *
 * Saving sends the edited fields as `data` and the server merges them into the
 * card — so `extensions` (which holds the linked world book) and anything a
 * newer card spec added survive an edit.
 */
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { CardForm, toDraft, type CardDraft } from '@/components/CardForm';
import { Icon } from '@/components/icons';
import { Avatar, ConfirmButton, Loading, Notice } from '@/components/ui';
import { api, avatarUrl, del, get, post, raw } from '@/lib/api';
import { ago, count } from '@/lib/format';
import type { CharacterCard, ChatSummary } from '@/lib/types';

export default function CharacterPage(): React.JSX.Element {
    const params = useParams<{ id: string }>();
    const router = useRouter();
    const id = decodeURIComponent(params.id);

    const [card, setCard] = useState<CharacterCard | null>(null);
    const [chats, setChats] = useState<ChatSummary[]>([]);
    const [published, setPublished] = useState<boolean | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [avatar, setAvatar] = useState(0);
    const file = useRef<HTMLInputElement | null>(null);

    const load = useCallback(async (): Promise<void> => {
        const [detail, threads, publishState] = await Promise.all([
            get<{ card: CharacterCard }>(`/characters/${encodeURIComponent(id)}`),
            get<{ chats: ChatSummary[] }>(`/chats/${encodeURIComponent(id)}`).catch(() => ({ chats: [] })),
            get<{ published: boolean }>(`/characters/${encodeURIComponent(id)}/publish`).catch(() => ({ published: false })),
        ]);

        setCard(detail.card);
        setChats(threads.chats);
        setPublished(publishState.published);
    }, [id]);

    useEffect(() => {
        void load().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
    }, [load]);

    const save = async (draft: CardDraft): Promise<void> => {
        setBusy(true);
        setError(null);
        setNote(null);

        try {
            await api(`/characters/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ data: draft }) });
            setNote('已保存。');
            await load();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    const togglePublish = async (): Promise<void> => {
        try {
            if (published === true) {
                await del(`/characters/${encodeURIComponent(id)}/publish`);
                setPublished(false);
                setNote('已从市场下架。');
            } else {
                await post(`/characters/${encodeURIComponent(id)}/publish`);
                setPublished(true);
                setNote('已发布到市场。');
            }
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    };

    const uploadAvatar = async (chosen: File | undefined): Promise<void> => {
        if (chosen === undefined) {
            return;
        }

        setBusy(true);
        setError(null);

        try {
            await raw(`/characters/${encodeURIComponent(id)}/avatar`, {
                method: 'PUT',
                headers: { 'Content-Type': 'image/png' },
                body: chosen,
            }).then(async (response) => {
                if (!response.ok) {
                    throw new Error(await response.text());
                }
            });
            setAvatar((n) => n + 1);
            setNote('头像已更换。');
            await load();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
            if (file.current !== null) {
                file.current.value = '';
            }
        }
    };

    const createChat = async (): Promise<void> => {
        try {
            const created = await post<{ cardId: string; name: string }>('/chats', { cardId: id });
            router.push(`/chats/${encodeURIComponent(created.cardId)}/${encodeURIComponent(created.name)}`);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    };

    const remove = async (): Promise<void> => {
        try {
            await del(`/characters/${encodeURIComponent(id)}`);
            router.push('/characters');
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    };

    if (card === null) {
        return (
            <div className="pane-pad">
                {error !== null ? <Notice kind="error">{error}</Notice> : <Loading />}
            </div>
        );
    }

    return (
        <div className="pane-pad pane-narrow">
            <div className="page-head">
                <div className="row" style={{ gap: 16 }}>
                    <Avatar src={`${avatarUrl(id)}?v=${avatar}`} size={72} alt={card.data.name} />
                    <div>
                        <h1>{card.data.name}</h1>
                        <div className="sub">
                            <code>{id}.png</code> · {card.spec === 'chara_card_v3' ? 'V3' : card.spec === 'chara_card_v2' ? 'V2' : 'V1'}
                            {published === true ? ' · 已发布' : ''}
                        </div>
                    </div>
                </div>

                <div className="row">
                    <input
                        ref={file}
                        type="file"
                        accept="image/png"
                        style={{ display: 'none' }}
                        onChange={(event) => void uploadAvatar(event.target.files?.[0])}
                    />
                    <button type="button" className="btn btn-sm" onClick={() => file.current?.click()}>换头像</button>
                    <a className="btn btn-sm" href={`/api/v1/characters/${encodeURIComponent(id)}/card.png`} download={`${card.data.name}.png`}>
                        <Icon name="upload" size={14} />
                        导出卡
                    </a>
                    <button type="button" className="btn btn-sm" onClick={() => void togglePublish()}>
                        {published === true ? '下架' : '发布到市场'}
                    </button>
                </div>
            </div>

            {error !== null ? <Notice kind="error">{error}</Notice> : null}
            {note !== null ? <Notice kind="ok">{note}</Notice> : null}

            <div className="row" style={{ margin: '18px 0' }}>
                <button type="button" className="btn btn-primary" onClick={() => void createChat()}>
                    <Icon name="plus" size={15} />
                    新建会话
                </button>
                <span className="grow" />
                <ConfirmButton
                    label="删除角色"
                    confirm={`连同 ${chats.length} 个对话一起删除？`}
                    onConfirm={remove}
                    small={false}
                />
            </div>

            <CardForm initial={toDraft(card.data)} busy={busy} submitLabel="保存" onSave={save} />

            <div className="section-title">对话（{count(chats.length)}）</div>
            {chats.length === 0 ? (
                <div className="empty">还没有对话。</div>
            ) : (
                <div className="list">
                    {chats.map((chat) => (
                        <Link className="list-item" key={chat.name} href={`/chats/${encodeURIComponent(id)}/${encodeURIComponent(chat.name)}`}>
                            <span className="body">
                                <span className="title" style={{ display: 'block' }}>{chat.name}</span>
                                <span className="meta" style={{ display: 'block' }}>
                                    {count(chat.messages)} 条 · {ago(chat.lastMessageAt)}
                                </span>
                            </span>
                            <Icon name="back" size={16} />
                        </Link>
                    ))}
                </div>
            )}
        </div>
    );
}
