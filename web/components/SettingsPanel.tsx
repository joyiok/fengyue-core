'use client';

/**
 * Runtime settings, editable without a deploy.
 *
 * This panel is the reason the settings table exists: the model key and the
 * quotas used to live in an `.env` that needed a container restart to take
 * effect. Everything here is an update to a row.
 *
 * A secret is shown masked and only sent when it was retyped, so a save can
 * never overwrite a key with its own mask. Keys marked `restart` are read once
 * at start-up and say so.
 */
import { useCallback, useEffect, useState } from 'react';

import { get, put, post } from '@/lib/api';
import type { SettingEntry } from '@/lib/types';
import { Notice } from './ui';
import { Icon } from './icons';

const GROUPS: [SettingEntry['group'], string][] = [
    ['model', '模型网关'],
    ['quota', '额度（运营者的上限）'],
    ['credits', '积分（用户的余额）'],
    ['memory', '滚动摘要'],
    ['market', '市场'],
    ['auth', '账号'],
    ['chat', '对话'],
    ['server', '服务'],
];

const LABELS: Record<string, string> = {
    'model.endpoint': '接口地址',
    'model.name': '模型名',
    'model.apiKey': 'API Key',
    'model.maxTokens': '默认 max_tokens',
    'model.timeoutMs': '超时（毫秒）',

    'quota.dailyTokens': '每人每日 tokens',
    'quota.monthlyTokens': '每人每月 tokens',
    'quota.maxTokensPerRequest': '单次 max_tokens 上限',
    'quota.globalDailyTokens': '全局每日熔断',
    'quota.maxStreams': '每人并发流式数',

    'credits.signup': '注册赠送',
    'credits.checkin': '每日签到',
    'credits.invite': '邀请人奖励',
    'credits.invitee': '被邀请人奖励',
    'credits.tokensPerCredit': '多少 tokens = 1 积分',

    'memory.enabled': '开启摘要',
    'memory.messageThreshold': '多少条未摘要后触发',
    'memory.keepRecent': '最近多少条保持原样',
    'memory.maxSummaryTokens': '摘要块 token 上限',

    'market.enabled': '开启市场',

    'auth.enabled': '开启账号',
    'auth.allowRegistration': '开放注册',
    'auth.sessionTtlDays': '会话有效天数',

    'chat.personaName': '默认 {{user}} 名字',

    'server.host': '监听地址',
    'server.port': '监听端口',
};

export function SettingsPanel(): React.JSX.Element {
    const [entries, setEntries] = useState<SettingEntry[] | null>(null);
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);

    const load = useCallback(async (): Promise<void> => {
        setEntries((await get<{ entries: SettingEntry[] }>('/settings')).entries);
        setDrafts({});
    }, []);

    useEffect(() => {
        void load().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
    }, [load]);

    const draftOf = (entry: SettingEntry): string => {
        const typed = drafts[entry.key];
        if (typed !== undefined) {
            return typed;
        }
        return entry.secret ? '' : String(entry.value);
    };

    /** Only the keys that were actually touched — a save never writes the rest. */
    const changed = (): Record<string, string> => {
        const payload: Record<string, string> = {};
        for (const entry of entries ?? []) {
            const typed = drafts[entry.key];
            if (typed === undefined) {
                continue;
            }
            if (!entry.secret && typed === String(entry.value)) {
                continue;
            }
            if (entry.secret && typed === '') {
                continue;
            }
            payload[entry.key] = typed;
        }
        return payload;
    };

    const save = async (): Promise<void> => {
        const payload = changed();
        if (Object.keys(payload).length === 0) {
            setNote('没有改动。');
            return;
        }

        setBusy(true);
        setError(null);
        setNote(null);

        try {
            await put('/settings', payload);
            const touched = Object.keys(payload).filter((key) => entries?.find((entry) => entry.key === key)?.restart === true);
            setNote(touched.length === 0
                ? '已保存，立刻生效。'
                : `已保存。${touched.map((key) => LABELS[key] ?? key).join('、')} 要重启才生效。`);
            await load();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
            setBusy(false);
        }
    };

    const reset = async (key: string): Promise<void> => {
        setBusy(true);
        setError(null);

        try {
            await post('/settings/reset', { keys: [key] });
            await load();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    if (entries === null) {
        return <div className="loading">正在载入设置…</div>;
    }

    const pending = Object.keys(changed()).length > 0;

    return (
        <>
            <div className="section-title">设置</div>

            {error !== null ? <div style={{ marginBottom: 12 }}><Notice kind="error">{error}</Notice></div> : null}
            {note !== null ? <div style={{ marginBottom: 12 }}><Notice kind="ok">{note}</Notice></div> : null}

            <div className="notice" style={{ marginBottom: 14 }}>
                这些值存在数据库里，改完即生效（标注「重启」的除外）。环境变量只在某个键还没有值时
                填一次，之后不再读取——所以它们不是你以后要维护的东西。
            </div>

            {GROUPS.map(([group, title]) => {
                const rows = entries.filter((entry) => entry.group === group);
                if (rows.length === 0) {
                    return null;
                }

                return (
                    <div className="panel" key={group}>
                        <div className="section-title" style={{ marginTop: 0 }}>{title}</div>

                        {rows.map((entry) => (
                            <div className="field" key={entry.key}>
                                <label htmlFor={entry.key}>
                                    {LABELS[entry.key] ?? entry.key}
                                    <code style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-faint)' }}>{entry.key}</code>
                                    {entry.restart ? <span className="tag" style={{ marginLeft: 8 }}>重启</span> : null}
                                    {entry.changed ? <span className="tag lamp" style={{ marginLeft: 6 }}>已改</span> : null}
                                </label>

                                {entry.type === 'boolean' ? (
                                    <label className="row" style={{ gap: 8, fontSize: 13.5, color: 'var(--text-dim)', cursor: 'pointer' }}>
                                        <input
                                            id={entry.key}
                                            type="checkbox"
                                            checked={draftOf(entry) === 'true' || (drafts[entry.key] === undefined && entry.value === true)}
                                            onChange={(event) => setDrafts((current) => ({ ...current, [entry.key]: event.target.checked ? 'true' : 'false' }))}
                                        />
                                        开启
                                    </label>
                                ) : (
                                    <input
                                        id={entry.key}
                                        className="input"
                                        type={entry.secret ? 'password' : entry.type === 'number' ? 'number' : 'text'}
                                        value={draftOf(entry)}
                                        placeholder={entry.secret ? (entry.secretSet ? String(entry.value) : '（未设置）') : undefined}
                                        autoComplete={entry.secret ? 'new-password' : undefined}
                                        onChange={(event) => setDrafts((current) => ({ ...current, [entry.key]: event.target.value }))}
                                    />
                                )}

                                <span className="hint" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                                    <span>{entry.description}</span>
                                    {entry.changed ? (
                                        <button type="button" className="btn btn-quiet btn-sm" disabled={busy} onClick={() => void reset(entry.key)}>
                                            <Icon name="refresh" size={13} />
                                            改回 {JSON.stringify(entry.bootValue)}
                                        </button>
                                    ) : null}
                                </span>
                            </div>
                        ))}
                    </div>
                );
            })}

            <div className="row row-end" style={{ marginTop: 16 }}>
                <button type="button" className="btn btn-primary" disabled={busy || !pending} onClick={() => void save()}>
                    {busy ? '保存中…' : pending ? '保存改动' : '没有改动'}
                </button>
            </div>
        </>
    );
}
