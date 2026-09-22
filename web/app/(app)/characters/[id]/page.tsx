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
import { PublishTimeForm, StatusTag, SubmitWork } from '@/components/SubmitWork';
import { VersionsPanel } from '@/components/VersionsPanel';
import { Icon } from '@/components/icons';
import { Avatar, ConfirmButton, Loading, Notice } from '@/components/ui';
import { api, avatarUrl, del, get, post, raw } from '@/lib/api';
import { ago, count } from '@/lib/format';
import type { CharacterCard, ChatSummary, MarketEntry, WorkStatus } from '@/lib/types';

export default function CharacterPage(): React.JSX.Element {
    const params = useParams<{ id: string }>();
    const router = useRouter();
    const id = decodeURIComponent(params.id);

    const [card, setCard] = useState<CharacterCard | null>(null);
    const [chats, setChats] = useState<ChatSummary[]>([]);
    const [submission, setSubmission] = useState<{ status: WorkStatus | null; character: MarketEntry | null } | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [avatar, setAvatar] = useState(0);
    const file = useRef<HTMLInputElement | null>(null);

    const load = useCallback(async (): Promise<void> => {
        const [detail, threads, publishState] = await Promise.all([
            get<{ card: CharacterCard }>(`/characters/${encodeURIComponent(id)}`),
            get<{ chats: ChatSummary[] }>(`/chats/${encodeURIComponent(id)}`).catch(() => ({ chats: [] })),
            get<{ status: WorkStatus | null; character: MarketEntry | null }>(`/characters/${encodeURIComponent(id)}/publish`)
                .catch(() => ({ status: null, character: null })),
        ]);

        setCard(detail.card);
        setChats(threads.chats);
        setSubmission({ status: publishState.status, character: publishState.character });
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

    /**
     * Withdrawing is the only reversible half of the flow: it takes the listing
     * down and the work can be submitted again. Rejecting is not available to
     * the author — that is a reviewer's decision, and it comes with a reason.
     */
    const withdraw = async (): Promise<void> => {
        try {
            await del(`/characters/${encodeURIComponent(id)}/publish`);
            setNote('已下架。要重新上架就再提交一次。');
            await load();
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
                            {' · '}<StatusTag status={submission?.status ?? null} />
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
                    {submission?.status === 'public' || submission?.status === 'approved' ? (
                        <button type="button" className="btn btn-sm" onClick={() => void withdraw()}>下架</button>
                    ) : null}
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

            {/* Where this work is in its life, and the two things the author
                controls about going public: submitting it, and its clock. */}
            {submission?.status === 'rejected' && submission.character?.reviewNote ? (
                <div style={{ marginBottom: 14 }}>
                    <Notice kind="error">
                        被拒：{submission.character.reviewNote}
                        <span style={{ display: 'block', marginTop: 6, color: 'var(--text-dim)' }}>
                            改完下面的设定再重新提交。
                        </span>
                    </Notice>
                </div>
            ) : null}

            {submission?.status === 'public' && submission.character !== null ? (
                <PublishTimeForm characterId={id} current={submission.character} onDone={load} />
            ) : (
                <SubmitWork characterId={id} current={submission?.character ?? null} onDone={load} />
            )}

            <div className="section-title">这张卡</div>

            <CardForm initial={toDraft(card.data)} busy={busy} submitLabel="保存" onSave={save} />

            <div className="section-title">发布</div>

            <div style={{ marginTop: 0 }}>
                <VersionsPanel characterId={id} />
            </div>

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
