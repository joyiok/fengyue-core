'use client';

/**
 * Operator controls. Only rendered for `role === 'admin'`, and the server checks
 * again on every route — this hides the buttons, it is not the boundary.
 *
 * Everything here is also reachable from `src/cli.ts`, which is the way to do it
 * when the web app is not running.
 */
import { useCallback, useEffect, useState } from 'react';

import { get, post, put } from '@/lib/api';
import { count } from '@/lib/format';
import type { UsageSummary, User } from '@/lib/types';

type Row = User & { usage: UsageSummary | null };

export function AdminPanel(): React.JSX.Element {
    const [rows, setRows] = useState<Row[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [drafts, setDrafts] = useState<Record<string, { daily: string; monthly: string; perRequest: string; grant: string }>>({});

    const load = useCallback(async (): Promise<void> => {
        setRows((await get<{ users: Row[] }>('/users')).users);
    }, []);

    useEffect(() => {
        void load().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
    }, [load]);

    const draft = (row: Row): { daily: string; monthly: string; perRequest: string; grant: string } =>
        drafts[row.id] ?? {
            daily: String(row.usage?.policy.dailyTokenLimit ?? 0),
            monthly: String(row.usage?.policy.monthlyTokenLimit ?? 0),
            perRequest: String(row.usage?.policy.maxTokensPerRequest ?? 0),
            grant: '',
        };

    const edit = (row: Row, change: Partial<{ daily: string; monthly: string; perRequest: string; grant: string }>): void =>
        setDrafts((current) => ({ ...current, [row.id]: { ...(current[row.id] ?? draft(row)), ...change } }));

    const run = async (action: () => Promise<unknown>, message: string): Promise<void> => {
        setError(null);
        setNote(null);

        try {
            await action();
            setNote(message);
            await load();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    };

    return (
        <>
            <div className="section-title">用户（管理员）</div>
            {error !== null ? <div style={{ marginBottom: 12 }}><span className="notice error">{error}</span></div> : null}
            {note !== null ? <div style={{ marginBottom: 12 }}><span className="notice ok">{note}</span></div> : null}

            {rows === null ? (
                <div className="loading">正在载入…</div>
            ) : (
                <div className="stack">
                    {rows.map((row) => {
                        const form = draft(row);

                        return (
                            <div className="panel" key={row.id}>
                                <div className="row">
                                    <b>{row.displayName || row.handle}</b>
                                    <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>@{row.handle} · {row.id}</span>
                                    {row.role === 'admin' ? <span className="tag lamp">管理员</span> : null}
                                    {row.status === 'disabled' ? <span className="tag">已停用</span> : null}
                                    <span className="grow" />
                                    <button
                                        type="button"
                                        className="btn btn-sm"
                                        onClick={() => void run(
                                            () => put(`/users/${encodeURIComponent(row.id)}/status`, { status: row.status === 'disabled' ? 'active' : 'disabled' }),
                                            '已更新状态。',
                                        )}
                                    >
                                        {row.status === 'disabled' ? '启用' : '停用'}
                                    </button>
                                </div>

                                {row.usage === null ? null : (
                                    <div className="row" style={{ marginTop: 10, color: 'var(--text-faint)', fontSize: 12 }}>
                                        今日 {count(row.usage.day.tokens)} tokens · 本月 {count(row.usage.month.tokens)} ·{' '}
                                        进行中 {count(row.usage.inFlight.requests)}
                                    </div>
                                )}

                                <div className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
                                    <Field label="日额度" value={form.daily} onChange={(value) => edit(row, { daily: value })} />
                                    <Field label="月额度" value={form.monthly} onChange={(value) => edit(row, { monthly: value })} />
                                    <Field label="单次上限" value={form.perRequest} onChange={(value) => edit(row, { perRequest: value })} />
                                    <button
                                        type="button"
                                        className="btn btn-sm"
                                        onClick={() => void run(
                                            () => put(`/users/${encodeURIComponent(row.id)}/quota`, {
                                                dailyTokenLimit: Number(form.daily),
                                                monthlyTokenLimit: Number(form.monthly),
                                                maxTokensPerRequest: Number(form.perRequest),
                                            }),
                                            '额度已更新。',
                                        )}
                                    >
                                        保存额度
                                    </button>

                                    <span className="grow" />

                                    <Field label="加积分" value={form.grant} onChange={(value) => edit(row, { grant: value })} width={88} />
                                    <button
                                        type="button"
                                        className="btn btn-sm"
                                        disabled={form.grant.trim() === ''}
                                        onClick={() => void run(
                                            () => post(`/users/${encodeURIComponent(row.id)}/credits`, { amount: Number(form.grant), reference: 'admin' }),
                                            '已入账。',
                                        )}
                                    >
                                        入账
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </>
    );
}

function Field({ label, value, onChange, width = 108 }: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    width?: number;
}): React.JSX.Element {
    return (
        <div className="field" style={{ marginBottom: 0, width }}>
            <label>{label}</label>
            <input
                className="input"
                type="number"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                style={{ fontVariantNumeric: 'tabular-nums' }}
            />
        </div>
    );
}
