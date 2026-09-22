'use client';

/**
 * Released versions of one work.
 *
 * Two controls, kept apart because they do different things: **存一版** freezes
 * what is saved now (so later edits cannot erase what players are on), and
 * **设为主作品** decides which release the *listing* names. The second moves the
 * listing in the rankings, which is why it says so instead of looking like a
 * rename.
 */
import { useCallback, useEffect, useState } from 'react';

import { del, get, post, put } from '@/lib/api';
import { clock } from '@/lib/format';
import type { VersionInfo } from '@/lib/versions';
import { ConfirmButton, Loading, Notice } from './ui';

export function VersionsPanel({ characterId }: { characterId: string }): React.JSX.Element {
    const [state, setState] = useState<{ versions: VersionInfo[]; primary: string | null } | null>(null);
    const [label, setLabel] = useState('');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);

    const load = useCallback(async (): Promise<void> => {
        setState(await get(`/characters/${encodeURIComponent(characterId)}/versions`));
    }, [characterId]);

    useEffect(() => {
        void load().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
    }, [load]);

    const run = async (action: () => Promise<unknown>, ok: string): Promise<void> => {
        setBusy(true);
        setError(null);
        setMessage(null);

        try {
            await action();
            setMessage(ok);
            await load();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="panel">
            <div className="section-title" style={{ marginTop: 0 }}>版本</div>

            <div className="notice" style={{ marginBottom: 14 }}>
                存一版 = 把<b>现在保存的这张卡</b>定格。之后怎么改都不动它，玩家也能开一局停在旧版上。
            </div>

            <div className="row" style={{ alignItems: 'flex-end', gap: 10 }}>
                <div className="field" style={{ marginBottom: 0, width: 150 }}>
                    <label htmlFor="v-name">版本号</label>
                    <input id="v-name" className="input" placeholder="v2（留空自动）" value={label} onChange={(event) => setLabel(event.target.value)} />
                </div>
                <div className="field grow" style={{ marginBottom: 0 }}>
                    <label htmlFor="v-note">这次改了什么</label>
                    <input id="v-note" className="input" value={note} onChange={(event) => setNote(event.target.value)} />
                </div>
                <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => void run(
                        () => post(`/characters/${encodeURIComponent(characterId)}/versions`, {
                            version: label.trim() === '' ? undefined : label.trim(),
                            label: label.trim() === '' ? undefined : label.trim(),
                            note,
                        }),
                        '已存一版。',
                    )}
                >
                    存一版
                </button>
            </div>

            {error !== null ? <div style={{ marginTop: 12 }}><Notice kind="error">{error}</Notice></div> : null}
            {message !== null ? <div style={{ marginTop: 12 }}><Notice kind="ok">{message}</Notice></div> : null}

            <div style={{ marginTop: 16 }}>
                {state === null ? <Loading /> : state.versions.length === 0 ? (
                    <div style={{ fontSize: 13, color: 'var(--text-faint)' }}>还没有存过版本。</div>
                ) : (
                    <div className="list">
                        {state.versions.map((entry) => {
                            const primary = state.primary === entry.version;

                            return (
                                <div className="list-item" key={entry.version}>
                                    <div className="body">
                                        <div className="title">
                                            {entry.version}
                                            {primary ? <span className="tag lamp" style={{ marginLeft: 8 }}>主作品</span> : null}
                                        </div>
                                        <div className="meta">{entry.note === '' ? '（没写改了什么）' : entry.note} · {clock(entry.createdAt)}</div>
                                    </div>

                                    <div className="row" style={{ gap: 6 }}>
                                        <a
                                            className="btn btn-sm"
                                            href={`/api/v1/characters/${encodeURIComponent(characterId)}/versions/${encodeURIComponent(entry.version)}`}
                                            download={`${characterId}-${entry.version}.png`}
                                        >
                                            导出
                                        </a>
                                        {primary ? null : (
                                            <button
                                                type="button"
                                                className="btn btn-sm"
                                                disabled={busy}
                                                title="换主作品会挪动列表，榜单跟着变"
                                                onClick={() => void run(
                                                    () => put(`/characters/${encodeURIComponent(characterId)}/primary`, { version: entry.version }),
                                                    '已切到这一版。注意：列表动了，榜单也会跟着动。',
                                                )}
                                            >
                                                设为主作品
                                            </button>
                                        )}
                                        <ConfirmButton
                                            label="删除"
                                            confirm={primary ? '这是主作品，删不掉' : '删除这一版？'}
                                            onConfirm={() => run(
                                                () => del(`/characters/${encodeURIComponent(characterId)}/versions/${encodeURIComponent(entry.version)}`),
                                                '已删除。',
                                            )}
                                        />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 12 }}>
                <b>主作品删不掉</b>——列表指着它。先切到别的版，它才能删。
            </div>
        </div>
    );
}