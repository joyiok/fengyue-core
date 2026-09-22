'use client';

/**
 * The review queue.
 *
 * Nothing is listed by being written: it lands here first. That is the whole
 * point — it is the one place something can be stopped *before* it is public
 * rather than after somebody complains about it.
 *
 * Rejecting keeps the reason, and the reason is the deliverable: the author has
 * to be able to read what was wrong and fix it. "Reviewed" is not "deleted".
 */
import { useCallback, useEffect, useState } from 'react';

import { get, post } from '@/lib/api';
import { clock, count } from '@/lib/format';
import { RATING_LABELS, type MarketEntry } from '@/lib/types';
import { Loading, Notice } from './ui';

type Filter = 'pending' | 'all';
const FILTERS: [Filter, string][] = [['pending', '待审'], ['all', '全部']];

export function ReviewQueue(): React.JSX.Element {
    const [filter, setFilter] = useState<Filter>('pending');
    const [queue, setQueue] = useState<MarketEntry[] | null>(null);
    const [notes, setNotes] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);

    const load = useCallback(async (): Promise<void> => {
        setQueue(null);
        setQueue((await get<{ reviews: MarketEntry[] }>(`/admin/reviews?status=${filter}`)).reviews);
        setNotes({});
    }, [filter]);

    useEffect(() => {
        void load().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
    }, [load]);

    const decide = async (entry: MarketEntry, decision: 'approve' | 'reject'): Promise<void> => {
        const key = `${entry.ownerId}/${entry.characterId}`;
        setBusy(true);
        setError(null);
        setNote(null);

        try {
            await post('/admin/reviews', {
                ownerId: entry.ownerId,
                characterId: entry.characterId,
                decision,
                ...(notes[key] === undefined || notes[key] === '' ? {} : { note: notes[key] }),
            });
            setNote(decision === 'approve' ? '已通过。' : '已拒绝，理由已发给作者。');
            await load();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
            setBusy(false);
        }
    };

    return (
        <div className="stack">
            <div className="row">
                {FILTERS.map(([value, label]) => (
                    <button
                        key={value}
                        type="button"
                        className={`btn btn-sm${filter === value ? ' btn-primary' : ''}`}
                        onClick={() => setFilter(value)}
                    >
                        {label}
                    </button>
                ))}
            </div>

            {error !== null ? <Notice kind="error">{error}</Notice> : null}
            {note !== null ? <Notice kind="ok">{note}</Notice> : null}

            {queue === null ? <Loading /> : queue.length === 0 ? (
                <div className="empty">{filter === 'pending' ? '队列是空的。' : '还没有提交过。'}</div>
            ) : (
                <div className="list">
                    {queue.map((entry) => {
                        const key = `${entry.ownerId}/${entry.characterId}`;

                        return (
                            <div className="list-item" key={key} style={{ alignItems: 'flex-start' }}>
                                <div className="body">
                                    <div className="title">
                                        {entry.name}
                                        <span className={`tag${entry.status === 'public' ? ' lamp' : ''}`} style={{ marginLeft: 8 }}>
                                            {entry.status}
                                        </span>
                                        <span className="tag" style={{ marginLeft: 6 }}>{RATING_LABELS[entry.rating] ?? entry.rating}</span>
                                        {entry.anonymous ? <span className="tag" style={{ marginLeft: 6 }}>匿名</span> : null}
                                        {entry.scheduledAt === null ? null : (
                                            <span className="tag" style={{ marginLeft: 6 }}>定时 {clock(entry.scheduledAt)}</span>
                                        )}
                                    </div>

                                    <div className="meta">
                                        {entry.tags.length === 0 ? '（无标签）' : entry.tags.join(' · ')}
                                        {' · '}设定 {count(entry.descriptionLength)} 字
                                        {' · '}作者 {entry.anonymous ? '匿名' : entry.ownerId.slice(0, 8)}
                                        {' · '}提交于 {clock(entry.submittedAt)}
                                    </div>

                                    {entry.reviewNote === null || entry.reviewNote === '' ? null : (
                                        <div className="meta" style={{ color: 'var(--danger)', whiteSpace: 'normal' }}>
                                            上次理由：{entry.reviewNote}
                                        </div>
                                    )}

                                    {entry.status === 'pending' ? (
                                        <div className="row" style={{ marginTop: 10, gap: 8 }}>
                                            <input
                                                className="input"
                                                style={{ flex: '1 1 240px' }}
                                                placeholder="拒绝时要说清楚哪里不对（作者只看得到这段）"
                                                value={notes[key] ?? ''}
                                                onChange={(event) => setNotes((current) => ({ ...current, [key]: event.target.value }))}
                                            />
                                            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void decide(entry, 'approve')}>
                                                通过
                                            </button>
                                            <button
                                                type="button"
                                                className="btn btn-sm btn-danger"
                                                disabled={busy || (notes[key] ?? '').trim() === ''}
                                                title="拒绝要写理由"
                                                onClick={() => void decide(entry, 'reject')}
                                            >
                                                拒绝
                                            </button>
                                        </div>
                                    ) : null}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                共 {count(queue?.length ?? 0)} 条。拒绝必须写理由，而且记录留在「全部」里——<b>处理不等于删除</b>。
            </div>
        </div>
    );
}
