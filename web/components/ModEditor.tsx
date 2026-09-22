'use client';

/**
 * Write a mod.
 *
 * The three payloads are separated on purpose, because they land in three
 * different places in the prompt — and because the third one (a memory preset)
 * is the only one that makes a session start *spending money*, so it is behind
 * its own switch with the cost spelled out rather than buried in a text box.
 */
import { useState } from 'react';

import { del, post, put } from '@/lib/api';
import type { Mod } from '@/lib/types';
import { ConfirmButton, Notice } from './ui';

const BLANK: Mod = {
    id: '',
    ownerId: '',
    name: '',
    description: '',
    visibility: 'private',
    scope: 'shared',
    boundCharacterId: null,
    systemPrompt: '',
    postHistory: '',
    worldbook: {},
    style: '',
    memory: null,
    tags: [],
    uses: 0,
    createdAt: '',
    updatedAt: '',
};

export function ModEditor({
    initial,
    onDone,
}: {
    initial: Mod | null;
    onDone: () => void | Promise<void>;
}): React.JSX.Element {
    const [draft, setDraft] = useState<Mod>(initial ?? BLANK);
    const [memoryOn, setMemoryOn] = useState(initial?.memory !== null && initial?.memory !== undefined);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const set = <K extends keyof Mod>(key: K, value: Mod[K]): void =>
        setDraft((current) => ({ ...current, [key]: value }));

    const save = async (): Promise<void> => {
        setBusy(true);
        setError(null);

        const body = {
            name: draft.name,
            description: draft.description,
            scope: draft.scope,
            boundCharacterId: draft.boundCharacterId,
            systemPrompt: draft.systemPrompt,
            postHistory: draft.postHistory,
            style: draft.style,
            tags: draft.tags,
            // A memory preset is sent as an explicit `null` when switched off,
            // so turning it off is a change and not "leave it alone".
            memory: memoryOn ? { ...(draft.memory ?? {}), enabled: true } : null,
        };

        try {
            if (initial === null) {
                await post('/mods', body);
            } else {
                await put(`/mods/${encodeURIComponent(initial.id)}`, body);
            }
            await onDone();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
            setBusy(false);
        }
    };

    return (
        <div className="panel">
            <div className="page-head" style={{ marginBottom: 14 }}>
                <div>
                    <h1 style={{ fontSize: 19 }}>{initial === null ? '新建 Mod' : `编辑 ${initial.name}`}</h1>
                    <div className="sub">Mod 是内容，不是插件：它往提示词里加东西，不改程序行为。</div>
                </div>
                {initial === null ? null : (
                    <ConfirmButton
                        label="删除"
                        confirm="删除这个 Mod？"
                        small={false}
                        onConfirm={async () => {
                            await del(`/mods/${encodeURIComponent(initial.id)}`).catch(() => undefined);
                            await onDone();
                        }}
                    />
                )}
            </div>

            <div className="field">
                <label htmlFor="mod-name">名字</label>
                <input id="mod-name" className="input" value={draft.name} onChange={(event) => set('name', event.target.value)} required />
            </div>

            <div className="field">
                <label htmlFor="mod-desc">说明</label>
                <textarea id="mod-desc" className="textarea" rows={2} value={draft.description} onChange={(event) => set('description', event.target.value)} />
            </div>

            <div className="row" style={{ gap: 18, alignItems: 'flex-start' }}>
                <div className="field grow">
                    <label htmlFor="mod-system">提示词片段（进 system，在卡之后）</label>
                    <textarea id="mod-system" className="textarea" rows={6} value={draft.systemPrompt} onChange={(event) => set('systemPrompt', event.target.value)} />
                </div>
                <div className="field grow">
                    <label htmlFor="mod-post">历史后指令（紧贴用户消息）</label>
                    <textarea id="mod-post" className="textarea" rows={6} value={draft.postHistory} onChange={(event) => set('postHistory', event.target.value)} />
                </div>
            </div>

            <div className="field">
                <label htmlFor="mod-style">自定义 CSS（可选）</label>
                <textarea id="mod-style" className="textarea mono" rows={3} value={draft.style} onChange={(event) => set('style', event.target.value)} />
                <span className="hint">
                    大多数卡会<b>禁止</b>加载带 CSS 的 Mod（默认就是禁）。CSS 能改整页的样子，是这几样里最危险的。
                </span>
            </div>

            <div className="panel" style={{ background: 'var(--ink-2)' }}>
                <label className="row" style={{ gap: 8, cursor: 'pointer', fontSize: 14 }}>
                    <input type="checkbox" checked={memoryOn} onChange={(event) => setMemoryOn(event.target.checked)} />
                    <b>记忆预设</b>
                    <span className="tag lamp">会花钱</span>
                </label>

                {memoryOn ? (
                    <>
                        <div className="notice" style={{ margin: '10px 0' }}>
                            开启后这一局会做<b>滚动摘要</b>，每次合并是一次真实且计费的模型调用（账本里
                            <code>…:summary:&lt;n&gt;</code>）。这是唯一会让加载 Mod 产生费用的地方。
                        </div>
                        <div className="field">
                            <label htmlFor="mod-instr">摘要指令（内容）</label>
                            <textarea id="mod-instr" className="textarea" rows={3} value={draft.memory?.instruction ?? ''} onChange={(event) => set('memory', { ...(draft.memory ?? {}), instruction: event.target.value })} />
                        </div>
                        <div className="row" style={{ gap: 12 }}>
                            <Num label="触发条数" value={draft.memory?.messageThreshold ?? 40} onChange={(value) => set('memory', { ...(draft.memory ?? {}), messageThreshold: value })} />
                            <Num label="保留最近" value={draft.memory?.keepRecent ?? 12} onChange={(value) => set('memory', { ...(draft.memory ?? {}), keepRecent: value })} />
                            <Num label="摘要上限 tokens" value={draft.memory?.maxSummaryTokens ?? 500} onChange={(value) => set('memory', { ...(draft.memory ?? {}), maxSummaryTokens: value })} />
                        </div>
                    </>
                ) : null}
            </div>

            <div className="row" style={{ gap: 18, alignItems: 'flex-start' }}>
                <div className="field grow">
                    <label>作用域</label>
                    <label className="row" style={{ gap: 8, cursor: 'pointer', fontSize: 13.5 }}>
                        <input type="radio" name="scope" checked={draft.scope === 'shared'} onChange={() => set('scope', 'shared')} />
                        公用：任何作品都能选
                    </label>
                    <label className="row" style={{ gap: 8, cursor: 'pointer', fontSize: 13.5 }}>
                        <input type="radio" name="scope" checked={draft.scope === 'dedicated'} onChange={() => set('scope', 'dedicated')} />
                        专用：只在某一个作品里能选到
                    </label>
                    {draft.scope === 'dedicated' ? (
                        <input
                            className="input"
                            placeholder="那个作品的 id（角色文件名）"
                            value={draft.boundCharacterId ?? ''}
                            onChange={(event) => set('boundCharacterId', event.target.value)}
                        />
                    ) : null}
                </div>

                <div className="field grow">
                    <label>可见性</label>
                    <label className="row" style={{ gap: 8, cursor: 'pointer', fontSize: 13.5 }}>
                        <input type="radio" name="vis" checked={draft.visibility === 'private'} onChange={() => set('visibility', 'private')} />
                        私有：只有自己能用
                    </label>
                    <label className="row" style={{ gap: 8, cursor: 'pointer', fontSize: 13.5 }}>
                        <input type="radio" name="vis" checked={draft.visibility === 'public'} onChange={() => set('visibility', 'public')} />
                        公开：进 Mod 广场
                    </label>
                    <span className="hint">上传广场是显式的，不是保存顺带的。</span>
                </div>
            </div>

            {error !== null ? <div style={{ marginBottom: 12 }}><Notice kind="error">{error}</Notice></div> : null}

            <div className="row row-end">
                <button type="button" className="btn btn-primary" disabled={busy || draft.name.trim() === ''} onClick={() => void save()}>
                    {busy ? '保存中…' : initial === null ? '创建' : '保存'}
                </button>
            </div>
        </div>
    );
}

function Num({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }): React.JSX.Element {
    return (
        <div className="field" style={{ marginBottom: 0, width: 130 }}>
            <label>{label}</label>
            <input className="input" type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} />
        </div>
    );
}
