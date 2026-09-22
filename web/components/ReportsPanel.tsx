'use client';

/**
 * The moderation queue.
 *
 * Deliberately thin. A report records that somebody thinks a listing is wrong;
 * a human then either dismisses it or takes the listing down. There is no
 * automatic hiding on a report count, because that turns a grudge into a
 * takedown — the whole point of the queue is that a person decides.
 *
 * Resolving empties the queue, not the history: who said what and who decided
 * stays readable afterwards.
 */
import { useCallback, useEffect, useState } from 'react';

import { get, post } from '@/lib/api';
import { clock, count } from '@/lib/format';
import type { CharacterReport } from '@/lib/types';
import { Loading, Notice } from './ui';

type Filter = 'open' | 'resolved' | 'all';
const FILTERS: [Filter, string][] = [['open', '待处理'], ['resolved', '已处理'], ['all', '全部']];

export function ReportsPanel(): React.JSX.Element {
    const [filter, setFilter] = useState<Filter>('open');
    const [reports, setReports] = useState<CharacterReport[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);

    const load = useCallback(async (): Promise<void> => {
        setReports(null);
        setReports((await get<{ reports: CharacterReport[] }>(`/admin/reports?status=${filter}`)).reports);
    }, [filter]);

    useEffect(() => {
        void load().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
    }, [load]);

    const resolve = async (id: number, action: 'dismiss' | 'unpublish'): Promise<void> => {
        setBusy(true);
        setError(null);
        setNote(null);

        try {
            const result = await post<{ report: CharacterReport; unpublished: boolean }>(`/admin/reports/${id}/resolve`, { action });
            setNote(action === 'unpublish'
                ? (result.unpublished ? '已下架该角色。' : '该角色已不在市场上，记录已标记为已处理。')
                : '已标记为不处理。');
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

            {reports === null ? <Loading /> : reports.length === 0 ? (
                <div className="empty">这里没有举报。</div>
            ) : (
                <div className="list">
                    {reports.map((report) => (
                        <div className="list-item" key={report.id} style={{ alignItems: 'flex-start' }}>
                            <div className="body">
                                <div className="title">
                                    {report.characterId}
                                    <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}> · 作者 {report.ownerId.slice(0, 8)}</span>
                                    {report.status === 'open'
                                        ? <span className="tag lamp" style={{ marginLeft: 8 }}>待处理</span>
                                        : <span className="tag" style={{ marginLeft: 8 }}>{report.action === 'unpublish' ? '已下架' : '不处理'}</span>}
                                </div>
                                <div className="meta" style={{ whiteSpace: 'normal' }}>{report.reason}</div>
                                <div className="meta">
                                    {clock(report.createdAt)} · 举报人 {report.reporterId.slice(0, 8)}
                                    {report.resolvedAt === null ? '' : ` · ${clock(report.resolvedAt)} 由 ${report.resolvedBy?.slice(0, 8)} 处理`}
                                </div>
                            </div>

                            {report.status === 'open' ? (
                                <div className="row" style={{ gap: 6 }}>
                                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void resolve(report.id, 'dismiss')}>
                                        不处理
                                    </button>
                                    <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void resolve(report.id, 'unpublish')}>
                                        下架
                                    </button>
                                </div>
                            ) : null}
                        </div>
                    ))}
                </div>
            )}

            <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                共 {count(reports?.length ?? 0)} 条。举报只做一件事：让人看见。「下架」会把角色从市场撤下，
                但不会动作者库里的那份；处理过的记录留在「已处理」里。
            </div>
        </div>
    );
}
