'use client';

/**
 * Author tools: ask the engine what it is about to do, without paying for it.
 *
 * Both are dry runs over the real code path — `preview` calls the same
 * `assemblePrompt` a real turn does, `recall` calls the same world book scanner.
 * A "simulation" that used its own approximation would be worse than nothing:
 * it would agree with the author while the real turn disagreed with both.
 */
import { useState } from 'react';

import { post } from '@/lib/api';
import type { PromptStats } from '@/lib/types';
import { Notice } from './ui';

/** What a turn would send, and what it carried. */
export function PromptPreview({ characterId, version }: { characterId: string; version?: string }): React.JSX.Element {
    const [message, setMessage] = useState('');
    const [result, setResult] = useState<{ messages: { role: string; content: string }[]; stats: PromptStats } | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const run = async (): Promise<void> => {
        setBusy(true);
        setError(null);

        try {
            setResult(await post(`/characters/${encodeURIComponent(characterId)}/preview`, {
                message,
                ...(version === undefined ? {} : { version }),
            }));
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="panel">
            <div className="section-title" style={{ marginTop: 0 }}>提示词预览</div>
            <div className="field">
                <textarea
                    className="textarea"
                    rows={3}
                    placeholder="写一句话，看这一轮会把什么发出去。不调模型、不计费。"
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                />
            </div>

            <div className="row row-end">
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void run()}>
                    {busy ? '跑一遍…' : '预览这一轮'}
                </button>
            </div>

            {error !== null ? <div style={{ marginTop: 12 }}><Notice kind="error">{error}</Notice></div> : null}

            {result === null ? null : (
                <div style={{ marginTop: 16 }}>
                    <div className="debug" style={{ maxWidth: 'none', margin: 0, marginBottom: 12 }}>
                        段落：{result.stats.sections.join(' · ') || '（无）'}
                        <br />
                        约 {result.stats.estimatedTokens} tokens（历史 {result.stats.estimatedHistoryTokens} + 开销 {result.stats.estimatedOverheadTokens}）
                        {result.stats.budgetExceeded ? '，已超预算' : ''}
                    </div>

                    <div className="stack">
                        {result.messages.map((message_, index) => (
                            <div key={index} className="panel" style={{ background: 'var(--ink-2)', padding: '13px 15px' }}>
                                <div style={{ fontSize: 10.5, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--lamp)', marginBottom: 7 }}>
                                    {message_.role}
                                </div>
                                <div style={{ whiteSpace: 'pre-wrap', fontSize: 13.5, lineHeight: 1.8, color: 'var(--text-dim)' }}>
                                    {message_.content}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

/**
 * 召回测试: would this line of text hit any entry, and why not.
 *
 * The skip counts are the useful half. "Nothing fired" is almost never a bug in
 * the text — it is `matchWholeWords`, or a scan depth, or a probability roll —
 * and those are exactly what the breakdown names.
 */
export function RecallTest({ worldbookId }: { worldbookId: string }): React.JSX.Element {
    const [query, setQuery] = useState('');
    const [info, setInfo] = useState<Record<string, unknown> | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const run = async (): Promise<void> => {
        setBusy(true);
        setError(null);

        try {
            const response = await post(`/worldbooks/${encodeURIComponent(worldbookId)}/recall`, { query });
            setInfo((response as { worldInfo: Record<string, unknown> }).worldInfo);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    const stats = info as unknown as {
        activated: { uid: number; comment: string; matchedKeys: string[]; preview: string }[];
        candidates: number;
        skippedByDisabled: number;
        skippedByDelay: number;
        skippedByKeyLogic: number;
        skippedByProbability: number;
        skippedByCooldown: number;
        skippedByBudget: number;
    } | null;

    return (
        <div className="panel">
            <div className="section-title" style={{ marginTop: 0 }}>召回测试</div>
            <div className="field">
                <textarea
                    className="textarea"
                    rows={2}
                    placeholder="输入一句会提到关键词的话，看哪些词条会命中。不调模型。"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                />
            </div>
            <div className="row row-end">
                <button type="button" className="btn btn-primary btn-sm" disabled={busy || query.trim() === ''} onClick={() => void run()}>
                    {busy ? '扫一遍…' : '测试召回'}
                </button>
            </div>

            {error !== null ? <div style={{ marginTop: 12 }}><Notice kind="error">{error}</Notice></div> : null}

            {stats === null ? null : (
                <div style={{ marginTop: 16 }}>
                    <div className="debug" style={{ maxWidth: 'none', margin: 0 }}>
                        命中 {stats.activated.length} / 候选 {stats.candidates}
                        {' '}（跳过：禁用 {stats.skippedByDisabled}，延迟 {stats.skippedByDelay}，
                        关键词 {stats.skippedByKeyLogic}，概率 {stats.skippedByProbability}，
                        冷却 {stats.skippedByCooldown}，预算 {stats.skippedByBudget}）
                    </div>

                    <div className="list" style={{ marginTop: 12 }}>
                        {stats.activated.length === 0 ? (
                            <div className="list-item">
                                <div className="body">
                                    <div className="title" style={{ color: 'var(--text-faint)' }}>一个都没命中</div>
                                    <div className="meta">上面那行「跳过」会告诉你卡在哪一条规则上。</div>
                                </div>
                            </div>
                        ) : stats.activated.map((entry) => (
                            <div className="list-item" key={entry.uid}>
                                <div className="body">
                                    <div className="title">#{entry.uid} {entry.comment || '（无备注）'}</div>
                                    <div className="meta">{entry.matchedKeys.join(' / ')} · {entry.preview}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
