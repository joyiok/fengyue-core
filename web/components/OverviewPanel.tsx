'use client';

/**
 * What the operator needs at a glance: is anyone using this, and what is it
 * costing.
 *
 * Deliberately a summary rather than a dashboard of charts. The numbers here are
 * the ones that tell you whether to act — the model gateway is unconfigured,
 * the circuit breaker is close, someone is burning the allowance — and each one
 * links to where it is changed.
 */
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { get } from '@/lib/api';
import { clock, count } from '@/lib/format';
import type { AdminOverview } from '@/lib/types';
import { Loading, Notice } from './ui';

export function OverviewPanel(): React.JSX.Element {
    const [view, setView] = useState<AdminOverview | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async (): Promise<void> => {
        setView(await get<AdminOverview>('/admin/overview'));
    }, []);

    useEffect(() => {
        void load().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
    }, [load]);

    if (view === null) {
        return error === null ? <Loading /> : <Notice kind="error">{error}</Notice>;
    }

    return (
        <div className="stack">
            {error !== null ? <Notice kind="error">{error}</Notice> : null}

            {view.model.configured ? (
                <Notice kind="ok">模型网关：{view.model.name} · {view.model.endpoint}</Notice>
            ) : (
                <Notice kind="error">
                    模型网关还没配，现在发消息会返回 503。
                    <Link href="/admin/settings" style={{ color: 'var(--lamp)', marginLeft: 10 }}>去配置 →</Link>
                </Notice>
            )}

            <div className="grid-stats">
                <Stat label="账号" value={count(view.accounts.total)} hint={`启用 ${view.accounts.active} · 停用 ${view.accounts.disabled}`} />
                <Stat
                    label="今日 tokens"
                    value={count(view.usage?.day.tokens ?? 0)}
                    hint={`${count(view.usage?.day.requests ?? 0)} 次调用`}
                />
                <Stat
                    label="本月 tokens"
                    value={count(view.usage?.month.tokens ?? 0)}
                    hint={`${count(view.usage?.month.requests ?? 0)} 次调用`}
                />
                <Stat
                    label="进行中"
                    value={count(view.usage?.inFlight.requests ?? 0)}
                    hint={`已预留 ${count(view.usage?.inFlight.reservedTokens ?? 0)} tokens`}
                />
                {view.credits === null ? null : (
                    <Stat
                        label="积分余额"
                        value={count(view.credits.balance)}
                        hint={`发出 ${count(view.credits.granted)} · 花掉 ${count(view.credits.spent)}`}
                    />
                )}
                {view.market === null ? null : (
                    <Stat
                        label="市场"
                        value={count(view.market.published)}
                        hint={`已发布角色 · ${count(view.market.favorites)} 次收藏`}
                    />
                )}
            </div>

            <div>
                <div className="section-title">最近的调用</div>
                {(view.usage?.recent.length ?? 0) === 0 ? (
                    <div className="empty">还没有任何一轮对话。</div>
                ) : (
                    <table className="data">
                        <thead>
                            <tr>
                                <th>时间</th><th>账号</th><th>会话</th><th>模型</th>
                                <th className="num">tokens</th><th>计量</th>
                            </tr>
                        </thead>
                        <tbody>
                            {(view.usage?.recent ?? []).map((row) => (
                                <tr key={`${row.createdAt}-${row.chatId}`}>
                                    <td>{clock(row.createdAt)}</td>
                                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{row.userId.slice(0, 8)}</td>
                                    <td style={{ color: 'var(--text-faint)' }}>{row.chatId ?? '—'}</td>
                                    <td>{row.model}</td>
                                    <td className="num">{count(row.totalTokens)}</td>
                                    <td style={{ color: row.usageSource === 'provider' ? 'var(--ok)' : 'var(--text-faint)' }}>
                                        {row.usageSource === 'provider' ? '厂商' : '估算'}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }): React.JSX.Element {
    return (
        <div className="stat-tile">
            <div className="label">{label}</div>
            <div className="value">{value}</div>
            <div className="hint">{hint}</div>
        </div>
    );
}
