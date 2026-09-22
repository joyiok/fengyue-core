'use client';

/**
 * One conversation.
 *
 * The turn is streamed as SSE and only committed to the log at the end, so this
 * view mirrors that: while a reply is coming in it lives in `pending`, and it
 * becomes a real message only when the server says `done`. A failure or a
 * stop therefore leaves nothing behind — exactly like the log — and the draft
 * goes back into the composer.
 */
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Avatar, ConfirmButton, Notice } from '@/components/ui';
import { Icon } from '@/components/icons';
import { ApiError, api, avatarUrl, del, get, post } from '@/lib/api';
import { count, short } from '@/lib/format';
import { streamTurn, type TurnEvent } from '@/lib/sse';
import type { CharacterCard, ChatMessage, PromptStats } from '@/lib/types';

interface ChatPayload {
    character: string;
    name: string;
    chat: { messages: ChatMessage[] };
    /** Where this window starts in the full log. */
    offset: number;
    total: number;
}

/** How many messages one request pulls. Long chats page backwards from here. */
const PAGE = 60;

interface Pending {
    user: string;
    reply: string;
    /** Regenerating hides the last reply instead of appending after it. */
    regenerating: boolean;
}

interface DoneEvent {
    reply: string;
    model: string;
    usage: { promptTokens?: number; completionTokens?: number };
    usageSource: string;
    latencyMs: number;
    firstTokenMs?: number;
    prompt: PromptStats;
    requestId: string;
}

export default function ChatPage(): React.JSX.Element {
    const params = useParams<{ cardId: string; chatName: string }>();
    const router = useRouter();
    const cardId = decodeURIComponent(params.cardId);
    const chatName = decodeURIComponent(params.chatName);

    const [card, setCard] = useState<CharacterCard | null>(null);
    const [messages, setMessages] = useState<ChatMessage[] | null>(null);
    const [offset, setOffset] = useState(0);
    const [total, setTotal] = useState(0);
    const loaded = useRef(0);
    const [pending, setPending] = useState<Pending | null>(null);
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<DoneEvent | null>(null);
    const [editing, setEditing] = useState<number | null>(null);
    const [draftEdit, setDraftEdit] = useState('');

    const controller = useRef<AbortController | null>(null);
    const requestIds = useRef<Map<string, string>>(new Map());
    const scroller = useRef<HTMLDivElement | null>(null);
    const input = useRef<HTMLTextAreaElement | null>(null);

    /**
     * Resync the window that is already on screen.
     *
     * Always *at least* what the client is showing, so a turn, an edit or a
     * delete can never silently drop the older pages somebody scrolled to — and
     * never the whole log either, which is the point of paging.
     */
    const reload = useCallback(async (): Promise<void> => {
        const [chat, detail] = await Promise.all([
            get<ChatPayload>(`/chats/${encodeURIComponent(cardId)}/${encodeURIComponent(chatName)}?tail=${Math.max(PAGE, loaded.current + 8)}`),
            get<{ card: CharacterCard }>(`/characters/${encodeURIComponent(cardId)}`).catch(() => null),
        ]);

        setMessages(chat.chat.messages);
        setOffset(chat.offset);
        setTotal(chat.total);
        setCard(detail?.card ?? null);
    }, [cardId, chatName]);

    /** Walk backwards: the next older window goes on top of what is shown. */
    const loadOlder = useCallback(async (): Promise<void> => {
        if (offset <= 0) {
            return;
        }

        const from = Math.max(0, offset - PAGE);
        const page = await get<ChatPayload>(
            `/chats/${encodeURIComponent(cardId)}/${encodeURIComponent(chatName)}?offset=${from}&limit=${offset - from}`,
        );

        setMessages((current) => [...page.chat.messages, ...(current ?? [])]);
        setOffset(page.offset);
        setTotal(page.total);
    }, [cardId, chatName, offset]);

    useEffect(() => {
        void reload().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
    }, [reload]);

    useEffect(() => {
        loaded.current = messages?.length ?? 0;
    }, [messages]);

    useEffect(() => {
        scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
    }, [messages, pending]);

    const send = useCallback(async (text: string, regenerate = false): Promise<void> => {
        if (busy) {
            return;
        }

        // One request id per attempt at saying something: a retry after a network
        // failure reuses it, so the server can return the reply it already made
        // instead of paying for a second one. Changing the words is a new attempt.
        const key = `${regenerate ? 'regenerate' : 'turn'}:${text}`;
        let requestId = requestIds.current.get(key);
        if (requestId === undefined) {
            requestId = crypto.randomUUID();
            requestIds.current.set(key, requestId);
        }

        setBusy(true);
        setError(null);
        setDone(null);
        setPending({ user: text, reply: '', regenerating: regenerate });
        controller.current = new AbortController();

        let committed = false;

        try {
            await streamTurn(
                `/chats/${encodeURIComponent(cardId)}/${encodeURIComponent(chatName)}/${regenerate ? 'regenerate' : 'messages'}`,
                { ...(text === '' ? {} : { message: text }), requestId },
                (event: TurnEvent) => {
                    if (event.type === 'delta') {
                        setPending((current) => current === null ? current : { ...current, reply: current.reply + event.text });
                        return;
                    }

                    if (event.type === 'done') {
                        committed = true;
                        setDone(event);
                        requestIds.current.delete(key);
                        setMessages((current) => {
                            if (current === null) {
                                return current;
                            }
                            if (regenerate) {
                                const next = [...current];
                                const last = next[next.length - 1];
                                if (last !== undefined && !last.is_user) {
                                    next[next.length - 1] = { ...last, mes: event.reply };
                                }
                                return next;
                            }
                            return [
                                ...current,
                                { name: '', is_user: true, send_date: new Date().toISOString(), mes: text },
                                { name: card?.data.name ?? '', is_user: false, send_date: new Date().toISOString(), mes: event.reply },
                            ];
                        });
                        return;
                    }

                    if (event.type === 'error') {
                        setError(event.error);
                        return;
                    }

                    if (event.type === 'aborted') {
                        setError('已停止。这一轮没有保存。');
                    }
                },
                controller.current.signal,
            );
        } catch (caught) {
            if ((caught as { name?: string }).name !== 'AbortError') {
                setError(caught instanceof ApiError ? caught.message : String(caught));
            }
        } finally {
            setPending(null);
            setBusy(false);
            controller.current = null;

            // Nothing was persisted: the draft goes back where it came from.
            if (!committed && !regenerate) {
                setDraft(text);
            }

            void reload().catch(() => undefined);
        }
    }, [busy, card, cardId, chatName, reload]);

    const beginEdit = (index: number, text: string): void => {
        setEditing(index);
        setDraftEdit(text);
    };

    /**
     * Rewording and rerolling are different actions.
     *
     * `reroll` sends the edited words as what the last reply *answers* and rolls
     * it again — one action, and the replaced reply is kept in `previousReplies`
     * on the server rather than dropped. It only applies to the user turn that
     * the last reply answers, which is the only one `regenerate` can reroll.
     */
    const saveEdit = async (index: number, reroll: boolean): Promise<void> => {
        const text = draftEdit.trim();
        if (text === '') {
            return;
        }

        setEditing(null);

        if (reroll) {
            void send(text, true);
            return;
        }

        try {
            await api(`/chats/${encodeURIComponent(cardId)}/${encodeURIComponent(chatName)}/messages/${index}`, {
                method: 'PATCH',
                body: JSON.stringify({ message: text }),
            });
            setMessages((current) => current === null ? current : current.map((message, i) => (i === index ? { ...message, mes: text } : message)));
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    };

    /** The one user turn that the last reply answers — the only rerollable pair. */
    const canReroll = (index: number): boolean => {
        const last = shown.length - 1;
        return index === last - 1 && shown[index]?.is_user === true && shown[last]?.is_user === false;
    };

    const removeMessage = useCallback(async (index: number): Promise<void> => {
        try {
            await del(`/chats/${encodeURIComponent(cardId)}/${encodeURIComponent(chatName)}/messages/${index}`);
            setMessages((current) => current === null ? current : current.filter((_, i) => i !== index));
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    }, [cardId, chatName]);

    const removeChat = useCallback(async (): Promise<void> => {
        try {
            await del(`/chats/${encodeURIComponent(cardId)}/${encodeURIComponent(chatName)}`);
            router.push('/chats');
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    }, [cardId, chatName, router]);

    const summarize = useCallback(async (): Promise<void> => {
        try {
            await post(`/chats/${encodeURIComponent(cardId)}/${encodeURIComponent(chatName)}/summarize`);
            await reload();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    }, [cardId, chatName, reload]);

    const grow = (element: HTMLTextAreaElement): void => {
        element.style.height = 'auto';
        element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
    };

    /** Messages on screen: the log, plus the half-formed turn being streamed. */
    const shown = useMemo(() => {
        const base = messages ?? [];
        const trimmed = pending?.regenerating === true ? base.slice(0, -1) : base;
        return trimmed;
    }, [messages, pending]);

    const charName = card?.data.name ?? cardId;
    const lastIsReply = shown.length > 0 && shown[shown.length - 1]?.is_user === false;

    return (
        <div className="chat-wrap">
            <header className="chat-head">
                <Link href="/chats" className="btn btn-quiet btn-sm" title="返回对话列表">
                    <Icon name="back" size={16} />
                </Link>
                <Avatar src={avatarUrl(cardId)} size={38} alt={charName} />
                <div className="grow" style={{ minWidth: 0 }}>
                    <div className="title">{charName}</div>
                    <div className="meta">
                        {chatName} · {count(messages?.length ?? 0)} 条
                        {done !== null ? ` · ${done.model}` : ''}
                    </div>
                </div>
                <ConfirmButton label="删除对话" confirm="删除整个对话？" onConfirm={removeChat} />
            </header>

            <div className="chat-scroll" ref={scroller}>
                <div className="chat-flow">
                    {offset > 0 ? (
                        <div className="row" style={{ justifyContent: 'center' }}>
                            <button type="button" className="btn btn-sm" onClick={() => void loadOlder()}>
                                加载更早的 {Math.min(PAGE, offset)} 条
                            </button>
                            <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                                共 {total} 条，已载入 {offset}–{total}
                            </span>
                        </div>
                    ) : null}

                    {messages === null ? <div className="loading">正在载入…</div> : null}

                    {shown.map((message, index) => (
                        <div className="msg" key={`${index}-${message.send_date}`}>
                            {editing === index ? (
                                <div className="line-edit">
                                    <textarea
                                        className="textarea"
                                        rows={Math.min(14, Math.max(3, draftEdit.split('\n').length + 1))}
                                        value={draftEdit}
                                        autoFocus
                                        onChange={(event) => setDraftEdit(event.target.value)}
                                    />
                                    <div className="row row-end" style={{ marginTop: 8, gap: 8 }}>
                                        {canReroll(index) ? (
                                            <button type="button" className="btn btn-primary btn-sm" onClick={() => void saveEdit(index, true)}>
                                                保存并重新生成回答
                                            </button>
                                        ) : null}
                                        <button type="button" className="btn btn-sm" onClick={() => void saveEdit(index, false)}>
                                            保存
                                        </button>
                                        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setEditing(null)}>
                                            取消
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    {message.is_user ? (
                                        <div className="line-user">
                                            <div className="who">{message.name || '你'}</div>
                                            <div className="said">{message.mes}</div>
                                        </div>
                                    ) : (
                                        <div className="line-char">
                                            <div className="who">{message.name || charName}</div>
                                            <div className="prose">{message.mes}</div>
                                        </div>
                                    )}

                                    {!busy ? (
                                        <div className="msg-tools">
                                            <button
                                                type="button"
                                                className="btn btn-quiet btn-sm"
                                                title="编辑这条"
                                                onClick={() => beginEdit(index, message.mes)}
                                            >
                                                <Icon name="edit" size={14} />
                                            </button>
                                            <button
                                                type="button"
                                                className="btn btn-quiet btn-sm"
                                                title="删除这条"
                                                onClick={() => void removeMessage(index)}
                                            >
                                                <Icon name="trash" size={14} />
                                            </button>
                                        </div>
                                    ) : null}
                                </>
                            )}
                        </div>
                    ))}

                    {pending !== null ? (
                        <>
                            {pending.regenerating ? null : (
                                <div className="msg">
                                    <div className="line-user">
                                        <div className="who">你</div>
                                        <div className="said">{pending.user}</div>
                                    </div>
                                </div>
                            )}
                            <div className="msg">
                                <div className="line-char">
                                    <div className="who">{charName}</div>
                                    <div className={`prose${busy ? ' streaming' : ''}`}>
                                        {pending.reply === '' && busy ? '…' : pending.reply}
                                    </div>
                                </div>
                            </div>
                        </>
                    ) : null}

                    {messages !== null && messages.length === 0 ? (
                        <div className="empty">
                            <b>还没有开场白</b>
                            说点什么，开始这段对话。
                        </div>
                    ) : null}
                </div>

                {done !== null ? <PromptDebug stats={done.prompt} usage={done.usage} usageSource={done.usageSource} latencyMs={done.latencyMs} onSummarize={() => void summarize()} /> : null}
            </div>

            <div className="composer">
                <div className="composer-inner">
                    {error !== null ? (
                        <div style={{ marginBottom: 10 }}>
                            <Notice kind="error">{error}</Notice>
                        </div>
                    ) : null}

                    <textarea
                        ref={input}
                        value={draft}
                        placeholder={`对 ${charName} 说点什么…（Enter 发送，Shift+Enter 换行）`}
                        rows={2}
                        disabled={busy}
                        onChange={(event) => {
                            setDraft(event.target.value);
                            grow(event.target);
                        }}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                                event.preventDefault();
                                const text = draft.trim();
                                if (text !== '' && !busy) {
                                    setDraft('');
                                    void send(text);
                                }
                            }
                        }}
                    />

                    <div className="composer-bar">
                        {busy ? (
                            <button type="button" className="btn" onClick={() => controller.current?.abort()}>
                                <Icon name="stop" size={14} />
                                停止
                            </button>
                        ) : (
                            <button
                                type="button"
                                className="btn btn-primary"
                                disabled={draft.trim() === ''}
                                onClick={() => {
                                    const text = draft.trim();
                                    if (text !== '') {
                                        setDraft('');
                                        void send(text);
                                    }
                                }}
                            >
                                <Icon name="send" size={14} />
                                发送
                            </button>
                        )}

                        {lastIsReply && !busy ? (
                            <button type="button" className="btn" onClick={() => void send('', true)}>
                                <Icon name="refresh" size={14} />
                                重新生成
                            </button>
                        ) : null}

                        <span className="grow" />

                        {done !== null ? (
                            <span className="stat">
                                {short(done.prompt.estimatedTokens)} tokens · {done.latencyMs}ms · {done.usageSource === 'provider' ? '厂商计量' : '估算'}
                            </span>
                        ) : null}
                    </div>
                </div>
            </div>
        </div>
    );
}

function PromptDebug({
    stats,
    usage,
    usageSource,
    latencyMs,
    onSummarize,
}: {
    stats: PromptStats;
    usage: { promptTokens?: number; completionTokens?: number };
    usageSource: string;
    latencyMs: number;
    onSummarize: () => void;
}): React.JSX.Element {
    return (
        <details className="debug">
            <summary>这一轮发出去了什么</summary>
            <div>
                段落：{stats.sections.join(' · ') || '（无）'}
                <br />
                历史：纳入 {stats.historyIncluded} 条，裁掉 {stats.historyDropped} 条
                {stats.historyDroppedForRoleOrder > 0 ? `（其中 ${stats.historyDroppedForRoleOrder} 条为了不让窗口以角色开头）` : ''}
                <br />
                预算：约 {stats.estimatedTokens} tokens（历史 {stats.estimatedHistoryTokens} + 开销 {stats.estimatedOverheadTokens}）
                {stats.budgetExceeded ? '，已超预算' : ''}
                <br />
                用量：prompt {usage.promptTokens ?? '—'} / completion {usage.completionTokens ?? '—'}
                （{usageSource === 'provider' ? '厂商上报' : '按文本估算'}）· 耗时 {latencyMs}ms
            </div>

            {stats.worldInfo !== null ? (
                <div style={{ marginTop: 8 }}>
                    世界书：命中 {stats.worldInfo.activated.length} / 候选 {stats.worldInfo.candidates} 词条
                    （跳过：禁用 {stats.worldInfo.skippedByDisabled}，延迟 {stats.worldInfo.skippedByDelay}，
                    关键词 {stats.worldInfo.skippedByKeyLogic}，概率 {stats.worldInfo.skippedByProbability}，
                    冷却 {stats.worldInfo.skippedByCooldown}，预算 {stats.worldInfo.skippedByBudget}）
                    {stats.worldInfo.activated.map((entry) => (
                        <div key={`${entry.world}.${entry.uid}`}>
                            · [{entry.world}.{entry.uid}] {entry.comment || '(无备注)'} ← {entry.matchedKeys.join('/')} →{' '}
                            {entry.target} role={entry.role} ~{entry.estimatedTokens}t
                        </div>
                    ))}
                </div>
            ) : null}

            {stats.memory !== null ? (
                <div style={{ marginTop: 8 }}>
                    摘要：覆盖 {stats.memory.summarizedMessages} 条（{stats.memory.passes} 次合并，约 {stats.memory.estimatedTokens} tokens）
                    <button type="button" className="btn btn-quiet btn-sm" style={{ marginLeft: 8 }} onClick={onSummarize}>
                        立即摘要
                    </button>
                </div>
            ) : null}
        </details>
    );
}
