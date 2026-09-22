'use client';

/**
 * My mods and the Mod gallery.
 *
 * Two lists, one page: what you wrote and what you can load. Uploading to the
 * gallery is a deliberate act per mod — nothing becomes public as a side effect
 * of saving it.
 */
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { ModEditor } from '@/components/ModEditor';
import { Icon } from '@/components/icons';
import { ConfirmButton, Empty, Loading, Notice, TagList } from '@/components/ui';
import { del, get, post } from '@/lib/api';
import { count } from '@/lib/format';
import type { Mod } from '@/lib/types';

export default function ModsPage(): React.JSX.Element {
    const [mine, setMine] = useState<Mod[] | null>(null);
    const [gallery, setGallery] = useState<Mod[] | null>(null);
    const [editing, setEditing] = useState<Mod | null | 'new'>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async (): Promise<void> => {
        const [own, shared] = await Promise.all([
            get<{ mods: Mod[] }>('/mods?mine=1'),
            get<{ mods: Mod[] }>('/mods'),
        ]);
        setMine(own.mods);
        setGallery(shared.mods.filter((mod) => mod.ownerId !== own.mods[0]?.ownerId));
    }, []);

    useEffect(() => {
        void load().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
    }, [load]);

    const publish = async (mod: Mod): Promise<void> => {
        try {
            await post(`/mods/${encodeURIComponent(mod.id)}/visibility`, {
                visibility: mod.visibility === 'public' ? 'private' : 'public',
            });
            await load();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    };

    return (
        <div className="pane-pad pane-narrow">
            <div className="page-head">
                <div>
                    <h1>Mod</h1>
                    <div className="sub">可复用的一段设定。开一局时加载到某张卡上。</div>
                </div>
                <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
                    <Icon name="plus" size={15} />
                    新建 Mod
                </button>
            </div>

            {error !== null ? <Notice kind="error">{error}</Notice> : null}

            {editing === null ? null : (
                <div style={{ marginBottom: 18 }}>
                    <ModEditor initial={editing === 'new' ? null : editing} onDone={async () => { setEditing(null); await load(); }} />
                </div>
            )}

            <div className="notice" style={{ marginBottom: 16 }}>
                <b>Mod 是内容，不是插件。</b>它往提示词里加东西，不改程序行为。加载什么由<b>卡说了算</b>——
                每张卡有自己的来源策略，写在卡里、跟着卡走。
            </div>

            <div className="section-title">我写的</div>
            {mine === null ? <Loading /> : mine.length === 0 ? (
                <Empty title="还没写过 Mod">一段提示词、一套世界书词条、或一个记忆预设。</Empty>
            ) : (
                <div className="stack">
                    {mine.map((mod) => (
                        <div className="panel" key={mod.id}>
                            <div className="row">
                                <b style={{ fontFamily: 'var(--font-read)', fontSize: 16 }}>{mod.name}</b>
                                <span className={`tag${mod.visibility === 'public' ? ' lamp' : ''}`}>
                                    {mod.visibility === 'public' ? '广场可见' : '私有'}
                                </span>
                                <span className="tag">{mod.scope === 'dedicated' ? `专用 · ${mod.boundCharacterId}` : '公用'}</span>
                                {mod.memory === null ? null : <span className="tag lamp">记忆预设（会花钱）</span>}
                                <span className="grow" />
                                <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>被加载 {count(mod.uses)} 次</span>
                            </div>

                            {mod.description === '' ? null : <div style={{ fontSize: 13.5, color: 'var(--text-dim)', margin: '8px 0' }}>{mod.description}</div>}
                            <TagList tags={mod.tags} />

                            <div className="row" style={{ marginTop: 12 }}>
                                <button type="button" className="btn btn-sm" onClick={() => setEditing(mod)}>编辑</button>
                                <button type="button" className="btn btn-sm" onClick={() => void publish(mod)}>
                                    {mod.visibility === 'public' ? '从广场撤下' : '上传到广场'}
                                </button>
                                <span className="grow" />
                                <ConfirmButton label="删除" confirm="删除这个 Mod？" onConfirm={async () => {
                                    await del(`/mods/${encodeURIComponent(mod.id)}`).catch(() => undefined);
                                    await load();
                                }} />
                            </div>
                        </div>
                    ))}
                </div>
            )}

            <div className="section-title">Mod 广场</div>
            {gallery === null ? <Loading /> : gallery.length === 0 ? (
                <Empty title="广场还是空的">把你的 Mod「上传到广场」，别人就能选到。</Empty>
            ) : (
                <div className="stack">
                    {gallery.map((mod) => (
                        <div className="panel" key={mod.id}>
                            <div className="row">
                                <b style={{ fontFamily: 'var(--font-read)', fontSize: 16 }}>{mod.name}</b>
                                <span className="tag">{mod.scope === 'dedicated' ? `专用 · ${mod.boundCharacterId}` : '公用'}</span>
                                {mod.memory === null ? null : <span className="tag lamp">记忆预设（会花钱）</span>}
                                <span className="grow" />
                                <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>被加载 {count(mod.uses)} 次</span>
                            </div>
                            {mod.description === '' ? null : <div style={{ fontSize: 13.5, color: 'var(--text-dim)', margin: '8px 0' }}>{mod.description}</div>}
                            <TagList tags={mod.tags} />
                        </div>
                    ))}
                </div>
            )}

            <div style={{ marginTop: 18, fontSize: 12.5, color: 'var(--text-faint)' }}>
                新建会话时可以选 Mod。<Link href="/chats" style={{ color: 'var(--lamp)' }}>去开一局 →</Link>
            </div>
        </div>
    );
}