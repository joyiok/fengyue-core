'use client';

/**
 * The account screen: credits (money the user spends) and quota (the operator's
 * ceiling) side by side, because they answer different questions and a user who
 * confuses them will file the wrong bug.
 *
 * Both ledgers are append-only on the server, so the tables here are the whole
 * truth: every balance is the sum of the rows above it.
 */
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { Icon } from '@/components/icons';
import { PasswordForm } from '@/components/PasswordForm';
import { Loading, Meter, Notice } from '@/components/ui';
import { get, post } from '@/lib/api';
import { clock, count, percent } from '@/lib/format';
import type { CreditEntry, CreditSummary, Invite, MarketEntry, UsageRecord, UsageSummary } from '@/lib/types';

export default function AccountPage(): React.JSX.Element {
    const [credits, setCredits] = useState<CreditSummary | null>(null);
    const [usage, setUsage] = useState<UsageSummary | null>(null);
    const [ledger, setLedger] = useState<UsageRecord[]>([]);
    const [invites, setInvites] = useState<Invite[]>([]);
    const [favorites, setFavorites] = useState<MarketEntry[]>([]);
    const [perCredit, setPerCredit] = useState(1000);
    const [handle, setHandle] = useState('');
    const [role, setRole] = useState('user');
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);

    const load = useCallback(async (): Promise<void> => {
        const [me, creditView, usageView, inviteView, favoriteView] = await Promise.all([
            get<{ user: { handle: string; role: string } }>('/me'),
            get<{ tokensPerCredit: number; credits: CreditSummary }>('/me/credits').catch(() => null),
            get<{ usage: UsageSummary | null; recent: UsageRecord[] }>('/me/usage'),
            get<{ invites: Invite[] }>('/me/invites').catch(() => ({ invites: [] })),
            get<{ characters: MarketEntry[] }>('/me/favorites').catch(() => ({ characters: [] })),
        ]);

        setHandle(me.user.handle);
        setRole(me.user.role);
        setCredits(creditView?.credits ?? null);
        setPerCredit(creditView?.tokensPerCredit ?? 1000);
        setUsage(usageView.usage);
        setLedger(usageView.recent);
        setInvites(inviteView.invites);
        setFavorites(favoriteView.characters);
    }, []);

    useEffect(() => {
        void load().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
    }, [load]);

    const run = async (action: () => Promise<unknown>, message: string): Promise<void> => {
        setBusy(true);
        setError(null);
        setNote(null);

        try {
            await action();
            setNote(message);
            await load();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="pane-pad pane-narrow">
            <div className="page-head">
                <div>
                    <h1>账户</h1>
                    <div className="sub">
                        @{handle}{role === 'admin' ? ' · 管理员' : ''}
                        {role === 'admin' ? <Link href="/admin" style={{ color: 'var(--lamp)', marginLeft: 10 }}>管理入口 →</Link> : null}
                    </div>
                </div>
            </div>

            {error !== null ? <Notice kind="error">{error}</Notice> : null}
            {note !== null ? <Notice kind="ok">{note}</Notice> : null}

            {/* ------------------------------------------------------------ credits */}
            <div className="section-title">积分</div>
            <div className="panel">
                {credits === null ? <Loading /> : (
                    <>
                        <div className="row" style={{ alignItems: 'flex-end', gap: 28 }}>
                            <div>
                                <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>余额</div>
                                <div style={{ fontFamily: 'var(--font-read)', fontSize: 34, color: 'var(--lamp)', lineHeight: 1.1 }}>
                                    {count(credits.balance)}
                                </div>
                            </div>
                            <dl className="kv grow" style={{ gridTemplateColumns: '88px 1fr' }}>
                                <dt>累计获得</dt><dd>{count(credits.granted)}</dd>
                                <dt>累计消费</dt><dd>{count(credits.spent)}</dd>
                                <dt>今日</dt><dd>+{count(credits.today.granted)} / −{count(credits.today.spent)}</dd>
                                <dt>计价</dt><dd>{count(perCredit)} tokens = 1 积分</dd>
                            </dl>
                        </div>

                        <div className="row" style={{ marginTop: 18 }}>
                            <button
                                type="button"
                                className="btn btn-primary"
                                disabled={busy}
                                onClick={() => void run(() => post('/me/checkin'), '签到成功。')}
                            >
                                每日签到
                            </button>

                            <input
                                className="input"
                                style={{ width: 180 }}
                                placeholder="邀请码"
                                value={code}
                                onChange={(event) => setCode(event.target.value)}
                            />
                            <button
                                type="button"
                                className="btn"
                                disabled={busy || code.trim() === ''}
                                onClick={() => void run(() => post('/me/invites/redeem', { code: code.trim() }), '兑换成功。')}
                            >
                                兑换
                            </button>

                            <span className="grow" />
                            <button
                                type="button"
                                className="btn"
                                disabled={busy}
                                onClick={() => void run(() => post('/me/invites', { count: 1 }), '已生成一个邀请码。')}
                            >
                                <Icon name="plus" size={14} />
                                生成邀请码
                            </button>
                        </div>

                        {invites.length > 0 ? (
                            <table className="data" style={{ marginTop: 18 }}>
                                <thead>
                                    <tr><th>邀请码</th><th>生成于</th><th>状态</th></tr>
                                </thead>
                                <tbody>
                                    {invites.map((invite) => (
                                        <tr key={invite.code}>
                                            <td style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.08em' }}>{invite.code}</td>
                                            <td>{clock(invite.createdAt)}</td>
                                            <td style={{ color: invite.usedBy === null ? 'var(--ok)' : 'var(--text-faint)' }}>
                                                {invite.usedBy === null ? '未使用' : `被 ${invite.usedBy} 使用`}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        ) : null}

                        <div className="section-title" style={{ marginTop: 22 }}>积分流水</div>
                        <table className="data">
                            <thead>
                                <tr><th>时间</th><th>原因</th><th>备注</th><th className="num">变动</th></tr>
                            </thead>
                            <tbody>
                                {credits.recent.map((entry: CreditEntry) => (
                                    <tr key={entry.id}>
                                        <td>{clock(entry.createdAt)}</td>
                                        <td>{entry.reason}</td>
                                        <td style={{ color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                                            {entry.reference ?? '—'}
                                        </td>
                                        <td className="num" style={{ color: entry.amount > 0 ? 'var(--ok)' : 'var(--text-dim)' }}>
                                            {entry.amount > 0 ? '+' : ''}{count(entry.amount)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </>
                )}
            </div>

            {/* -------------------------------------------------------------- quota */}
            <div className="section-title">额度（运营者的上限）</div>
            <div className="panel">
                {usage === null ? <Loading /> : (
                    <>
                        <div className="field">
                            <label>今日 {count(usage.day.tokens)} / {usage.day.limit === 0 ? '不限' : count(usage.day.limit)} tokens</label>
                            <Meter value={usage.day.limit === 0 ? 0 : percent(usage.day.tokens, usage.day.limit)} />
                        </div>
                        <div className="field">
                            <label>本月 {count(usage.month.tokens)} / {usage.month.limit === 0 ? '不限' : count(usage.month.limit)} tokens</label>
                            <Meter value={usage.month.limit === 0 ? 0 : percent(usage.month.tokens, usage.month.limit)} />
                        </div>

                        <dl className="kv" style={{ marginTop: 14 }}>
                            <dt>单次上限</dt><dd>{count(usage.policy.maxTokensPerRequest)} tokens</dd>
                            <dt>进行中</dt><dd>{count(usage.inFlight.requests)} 个请求，已预留 {count(usage.inFlight.reservedTokens)} tokens</dd>
                            <dt>全局熔断</dt>
                            <dd>{usage.global.limit === 0 ? '未启用' : `${count(usage.global.tokens)} / ${count(usage.global.limit)}`}</dd>
                        </dl>

                        <div className="section-title" style={{ marginTop: 22 }}>用量流水</div>
                        <table className="data">
                            <thead>
                                <tr>
                                    <th>时间</th><th>会话</th><th>模型</th>
                                    <th className="num">提示</th><th className="num">回复</th><th>计量</th>
                                </tr>
                            </thead>
                            <tbody>
                                {ledger.map((row) => (
                                    <tr key={row.id}>
                                        <td>{clock(row.createdAt)}</td>
                                        <td style={{ color: 'var(--text-faint)' }}>{row.chatId ?? '—'}</td>
                                        <td>{row.model}</td>
                                        <td className="num">{count(row.promptTokens)}</td>
                                        <td className="num">{count(row.completionTokens)}</td>
                                        <td style={{ color: row.usageSource === 'provider' ? 'var(--ok)' : 'var(--text-faint)' }}>
                                            {row.usageSource === 'provider' ? '厂商' : '估算'}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </>
                )}
            </div>

            {/* ---------------------------------------------------------- favorites */}
            <div className="section-title">收藏</div>
            {favorites.length === 0 ? (
                <div className="empty">
                    还没有收藏。
                    <div style={{ marginTop: 12 }}><Link className="btn btn-sm" href="/market">去市场看看</Link></div>
                </div>
            ) : (
                <div className="list">
                    {favorites.map((entry) => (
                        <Link
                            className="list-item"
                            key={`${entry.ownerId}/${entry.characterId}`}
                            href={`/market/${encodeURIComponent(entry.ownerId)}/${encodeURIComponent(entry.characterId)}`}
                        >
                            <span className="body">
                                <span className="title" style={{ display: 'block' }}>{entry.name}</span>
                                <span className="meta" style={{ display: 'block' }}>{entry.ownerId}</span>
                            </span>
                            <Icon name="back" size={16} />
                        </Link>
                    ))}
                </div>
            )}

            <div style={{ marginTop: 14 }}>
                <PasswordForm />
            </div>

            {/* Operator controls live in /admin, on purpose: running the service
                and using it are different jobs, and mixing them into one screen
                is how someone changes a production quota while looking for their
                own balance. */}
        </div>
    );
}
