'use client';

/**
 * One world book, entry by entry.
 *
 * The editor changes the fields that decide *whether* and *where* an entry fires
 * — keys, constant, selective, probability, order, position, depth, sticky,
 * cooldown — and leaves every other field of the entry exactly as it was read, so
 * a book written by a newer SillyTavern survives a round trip through here.
 */
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { RecallTest } from '@/components/AuthorTools';
import { Icon } from '@/components/icons';
import { ConfirmButton, Loading, Notice } from '@/components/ui';
import { del, get, put } from '@/lib/api';
import type { Worldbook, WorldbookEntry } from '@/lib/types';

const POSITIONS = [
    [0, '角色定义之前'],
    [1, '角色定义之后'],
    [2, '作者注之前'],
    [3, '作者注之后'],
    [4, '指定深度'],
    [5, '示例之前'],
    [6, '示例之后'],
    [7, '出口'],
] as const;

const ROLES = [
    ['', '跟随'],
    ['0', 'system'],
    ['1', 'user'],
    ['2', 'assistant'],
] as const;

export default function WorldbookPage(): React.JSX.Element {
    const params = useParams<{ id: string }>();
    const router = useRouter();
    const id = decodeURIComponent(params.id);

    const [book, setBook] = useState<Worldbook | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);

    const load = useCallback(async (): Promise<void> => {
        setBook((await get<{ worldbook: Worldbook }>(`/worldbooks/${encodeURIComponent(id)}`)).worldbook);
    }, [id]);

    useEffect(() => {
        void load().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
    }, [load]);

    const patch = (uid: string, change: Partial<WorldbookEntry>): void => {
        setBook((current) => {
            if (current === null) {
                return current;
            }
            const existing = current.entries[uid];
            return {
                ...current,
                entries: { ...current.entries, [uid]: { ...existing, ...change } },
            };
        });
    };

    const addEntry = (): void => {
        setBook((current) => {
            if (current === null) {
                return current;
            }
            const uids = Object.values(current.entries).map((entry) => Number(entry.uid)).filter((uid) => Number.isFinite(uid));
            const uid = uids.length === 0 ? 0 : Math.max(...uids) + 1;

            return {
                ...current,
                entries: {
                    ...current.entries,
                    [uid]: {
                        uid,
                        displayIndex: uid,
                        key: [],
                        keysecondary: [],
                        comment: '',
                        content: '',
                        constant: false,
                        selective: true,
                        order: 100,
                        position: 0,
                        disable: false,
                        sticky: 0,
                        cooldown: 0,
                        delay: 0,
                        probability: 100,
                        depth: 4,
                        scanDepth: null,
                        role: null,
                    },
                },
            };
        });
    };

    const removeEntry = (uid: string): void => {
        setBook((current) => {
            if (current === null) {
                return current;
            }
            const entries = { ...current.entries };
            delete entries[uid];
            return { ...current, entries };
        });
    };

    const save = async (): Promise<void> => {
        if (book === null) {
            return;
        }

        setBusy(true);
        setError(null);
        setNote(null);

        try {
            await put(`/worldbooks/${encodeURIComponent(id)}`, book);
            setNote('已保存。');
            await load();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    const remove = async (): Promise<void> => {
        try {
            await del(`/worldbooks/${encodeURIComponent(id)}`);
            router.push('/worldbooks');
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    };

    const entries = book === null ? [] : Object.entries(book.entries).sort((a, b) => Number(a[0]) - Number(b[0]));

    return (
        <div className="pane-pad pane-narrow">
            <div className="page-head">
                <div>
                    <h1>{id}</h1>
                    <div className="sub">{entries.length} 个词条</div>
                </div>
                <div className="row">
                    <Link className="btn btn-quiet btn-sm" href="/worldbooks">
                        <Icon name="back" size={15} />
                        返回
                    </Link>
                    <ConfirmButton label="删除世界书" confirm="删除这本世界书？" onConfirm={remove} small={false} />
                </div>
            </div>

            {error !== null ? <Notice kind="error">{error}</Notice> : null}
            {note !== null ? <Notice kind="ok">{note}</Notice> : null}

            {book === null ? <Loading /> : (
                <>
                    <div style={{ margin: '16px 0' }}>
                <RecallTest worldbookId={id} />
            </div>

            <div className="row" style={{ margin: '16px 0' }}>
                        <button type="button" className="btn btn-sm" onClick={addEntry}>
                            <Icon name="plus" size={14} />
                            加词条
                        </button>
                        <span className="grow" />
                        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
                            {busy ? '保存中…' : '保存'}
                        </button>
                    </div>

                    <div className="stack">
                        {entries.map(([key, entry]) => (
                            <details className="panel" key={key}>
                                <summary className="row" style={{ cursor: 'pointer', gap: 10 }}>
                                    <b style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-faint)' }}>#{entry.uid}</b>
                                    <span className="grow" style={{ fontFamily: 'var(--font-read)', fontSize: 15 }}>
                                        {entry.comment || '（无备注）'}
                                    </span>
                                    {entry.disable ? <span className="tag">禁用</span> : null}
                                    {entry.constant ? <span className="tag lamp">常驻</span> : null}
                                    <span className="tag">{(entry.key ?? []).join('/') || '—'}</span>
                                </summary>

                                <div style={{ marginTop: 16 }}>
                                    <div className="field">
                                        <label>备注</label>
                                        <input className="input" value={entry.comment ?? ''} onChange={(event) => patch(key, { comment: event.target.value })} />
                                    </div>

                                    <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                                        <div className="field grow">
                                            <label>主关键词（逗号分隔）</label>
                                            <input
                                                className="input"
                                                value={(entry.key ?? []).join(', ')}
                                                onChange={(event) => patch(key, { key: split(event.target.value) })}
                                            />
                                        </div>
                                        <div className="field grow">
                                            <label>次关键词</label>
                                            <input
                                                className="input"
                                                value={(entry.keysecondary ?? []).join(', ')}
                                                disabled={entry.selective === false}
                                                onChange={(event) => patch(key, { keysecondary: split(event.target.value) })}
                                            />
                                        </div>
                                    </div>

                                    <div className="field">
                                        <label>内容</label>
                                        <textarea
                                            className="textarea tall"
                                            rows={6}
                                            value={entry.content ?? ''}
                                            onChange={(event) => patch(key, { content: event.target.value })}
                                        />
                                    </div>

                                    <div className="row" style={{ gap: 18 }}>
                                        <Toggle label="常驻（不等关键词）" checked={entry.constant === true} onChange={(value) => patch(key, { constant: value })} />
                                        <Toggle label="启用次关键词" checked={entry.selective !== false} onChange={(value) => patch(key, { selective: value })} />
                                        <Toggle label="禁用" checked={entry.disable === true} onChange={(value) => patch(key, { disable: value })} />
                                    </div>

                                    <div className="row" style={{ gap: 12, alignItems: 'flex-end', marginTop: 12 }}>
                                        <NumField label="顺序 order" value={entry.order ?? 100} onChange={(value) => patch(key, { order: value })} />
                                        <div className="field" style={{ marginBottom: 0, width: 150 }}>
                                            <label>插入位置</label>
                                            <select
                                                className="select"
                                                value={entry.position ?? 0}
                                                onChange={(event) => patch(key, { position: Number(event.target.value) })}
                                            >
                                                {POSITIONS.map(([value, label]) => (
                                                    <option key={value} value={value}>{label}</option>
                                                ))}
                                            </select>
                                        </div>
                                        <NumField label="深度 depth" value={entry.depth ?? 4} onChange={(value) => patch(key, { depth: value })} />
                                        <NumField
                                            label="扫描 scanDepth"
                                            value={entry.scanDepth ?? 2}
                                            onChange={(value) => patch(key, { scanDepth: value })}
                                        />
                                    </div>

                                    <div className="row" style={{ gap: 12, alignItems: 'flex-end', marginTop: 12 }}>
                                        <NumField label="概率 %" value={entry.probability ?? 100} onChange={(value) => patch(key, { probability: value })} />
                                        <NumField label="sticky" value={entry.sticky ?? 0} onChange={(value) => patch(key, { sticky: value })} />
                                        <NumField label="cooldown" value={entry.cooldown ?? 0} onChange={(value) => patch(key, { cooldown: value })} />
                                        <NumField label="delay" value={entry.delay ?? 0} onChange={(value) => patch(key, { delay: value })} />
                                        <div className="field" style={{ marginBottom: 0, width: 130 }}>
                                            <label>角色（仅深度模式）</label>
                                            <select
                                                className="select"
                                                value={entry.role === null || entry.role === undefined ? '' : String(entry.role)}
                                                onChange={(event) => patch(key, { role: event.target.value === '' ? null : Number(event.target.value) })}
                                            >
                                                {ROLES.map(([value, label]) => (
                                                    <option key={value} value={value}>{label}</option>
                                                ))}
                                            </select>
                                        </div>
                                    </div>

                                    <div className="row row-end" style={{ marginTop: 14 }}>
                                        <ConfirmButton label="删除词条" confirm="删除这个词条？" onConfirm={() => removeEntry(key)} />
                                    </div>
                                </div>
                            </details>
                        ))}
                    </div>

                    {entries.length === 0 ? <div className="empty">这本世界书还没有词条。</div> : null}
                </>
            )}
        </div>
    );
}

function split(value: string): string[] {
    return value.split(',').map((part) => part.trim()).filter((part) => part !== '');
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }): React.JSX.Element {
    return (
        <label className="row" style={{ gap: 7, fontSize: 13, color: 'var(--text-dim)', cursor: 'pointer' }}>
            <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
            {label}
        </label>
    );
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }): React.JSX.Element {
    return (
        <div className="field" style={{ marginBottom: 0, width: 108 }}>
            <label>{label}</label>
            <input
                className="input"
                type="number"
                value={value}
                onChange={(event) => onChange(Number(event.target.value))}
                style={{ fontVariantNumeric: 'tabular-nums' }}
            />
        </div>
    );
}
