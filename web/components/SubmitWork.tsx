'use client';

/**
 * Put a work up for review.
 *
 * Submitting is not publishing: it puts the work in a queue and a human looks at
 * it first. This form collects the three things that are decisions rather than
 * content — how it is rated, whether the author is named, and when it should
 * appear — because those are the ones that are expensive to change later.
 */
import { useState } from 'react';

import { post, put } from '@/lib/api';
import { RATINGS, type MarketEntry, type WorkStatus } from '@/lib/types';
import { Notice } from './ui';

export function SubmitWork({
    characterId,
    current,
    onDone,
}: {
    characterId: string;
    current: MarketEntry | null;
    onDone: () => void | Promise<void>;
}): React.JSX.Element {
    const [rating, setRating] = useState(current?.rating ?? 'explicit');
    const [anonymous, setAnonymous] = useState(current?.anonymous ?? false);
    const [when, setWhen] = useState(current?.scheduledAt ? toLocalInput(current.scheduledAt) : '');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async (): Promise<void> => {
        setBusy(true);
        setError(null);

        try {
            await post(`/characters/${encodeURIComponent(characterId)}/publish`, {
                rating,
                anonymous,
                ...(when === '' ? {} : { scheduledAt: new Date(when).toISOString() }),
            });
            await onDone();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
            setBusy(false);
        }
    };

    return (
        <div className="panel">
            <div className="section-title" style={{ marginTop: 0 }}>提交审核</div>

            <div className="notice" style={{ marginBottom: 14 }}>
                提交后会进入审核队列，<b>通过之后才公开</b>。被拒会附上理由，改完可以再交。
            </div>

            <div className="field">
                <label>年龄分级</label>
                {RATINGS.map((entry) => (
                    <label
                        key={entry.value}
                        className="row"
                        style={{
                            gap: 10,
                            padding: '7px 10px',
                            borderRadius: 'var(--radius-sm)',
                            background: rating === entry.value ? 'var(--lamp-soft)' : 'var(--ink-1)',
                            cursor: 'pointer',
                            fontSize: 13.5,
                        }}
                    >
                        <input
                            type="radio"
                            name="rating"
                            checked={rating === entry.value}
                            onChange={() => setRating(entry.value)}
                        />
                        <b style={{ minWidth: 56 }}>{entry.label}</b>
                        <span style={{ color: 'var(--text-faint)' }}>{entry.hint}</span>
                    </label>
                ))}
                <span className="hint">分级是闸门不是分类法：具体写的是什么用标签表达，读者自己屏蔽。</span>
            </div>

            <div className="field">
                <label htmlFor="scheduled">定时上架（可选）</label>
                <input
                    id="scheduled"
                    className="input"
                    type="datetime-local"
                    value={when}
                    onChange={(event) => setWhen(event.target.value)}
                />
                <span className="hint">
                    审核可以先通过，到点才公开。<b>初次发布时间</b>记的是真正公开那一刻，之后改这里不会动它。
                </span>
            </div>

            <div className="field">
                <label className="row" style={{ gap: 8, fontSize: 13.5, cursor: 'pointer' }}>
                    <input type="checkbox" checked={anonymous} onChange={(event) => setAnonymous(event.target.checked)} />
                    匿名发布（不显示作者名）
                </label>
                <span className="hint">代价是读者无法拉黑你，也没法关注你。</span>
            </div>

            {error !== null ? <div style={{ marginBottom: 12 }}><Notice kind="error">{error}</Notice></div> : null}

            <div className="row row-end">
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
                    {busy ? '提交中…' : current === null ? '提交审核' : '重新提交'}
                </button>
            </div>
        </div>
    );
}

/** Adjust the listing's clock without resubmitting: the re-bump / fix-up lever. */
export function PublishTimeForm({
    characterId,
    current,
    onDone,
}: {
    characterId: string;
    current: MarketEntry;
    onDone: () => void | Promise<void>;
}): React.JSX.Element {
    const [when, setWhen] = useState(toLocalInput(current.publishTime ?? current.publishedAt ?? ''));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const save = async (): Promise<void> => {
        setBusy(true);
        setError(null);

        try {
            await put(`/characters/${encodeURIComponent(characterId)}/publish-time`, { when: new Date(when).toISOString() });
            await onDone();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
            setBusy(false);
        }
    };

    return (
        <div className="panel">
            <div className="section-title" style={{ marginTop: 0 }}>发布时间</div>
            <div className="field">
                <label htmlFor="publish-time">列表按这个时间排</label>
                <input
                    id="publish-time"
                    className="input"
                    type="datetime-local"
                    value={when}
                    onChange={(event) => setWhen(event.target.value)}
                />
                <span className="hint">
                    榜单和「最新」读的是它。可以用来重新推一把或改错的时间；
                    <b>初次发布时间不会变</b>。
                </span>
            </div>
            {error !== null ? <div style={{ marginBottom: 12 }}><Notice kind="error">{error}</Notice></div> : null}
            <div className="row row-end">
                <button type="button" className="btn" disabled={busy} onClick={() => void save()}>
                    {busy ? '保存中…' : '保存'}
                </button>
            </div>
        </div>
    );
}

const STATUS_TEXT: Record<WorkStatus, string> = {
    pending: '待审',
    approved: '已过审，等定时',
    public: '已上架',
    rejected: '被拒',
    withdrawn: '已下架',
};

export function StatusTag({ status }: { status: WorkStatus | null }): React.JSX.Element {
    if (status === null) {
        return <span className="tag">未提交</span>;
    }

    return (
        <span className={`tag${status === 'public' ? ' lamp' : ''}`}>
            {STATUS_TEXT[status]}
        </span>
    );
}

function toLocalInput(iso: string): string {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) {
        return '';
    }
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
