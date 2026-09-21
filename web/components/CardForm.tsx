'use client';

/**
 * The character editor.
 *
 * Field names are the card's own (`description`, `first_mes`, `mes_example`…), so
 * what is on screen is what ends up in the PNG and what SillyTavern reads. The
 * form sends only these fields; the server merges them into the card, leaving
 * `extensions` (which holds the linked world book) alone.
 */
import { useState } from 'react';

import type { CharacterCardData } from '@/lib/types';
import { Icon } from './icons';

const FIELDS: { key: keyof CardDraft; label: string; hint?: string; rows?: number }[] = [
    { key: 'description', label: '设定', hint: '角色的外观、身份、背景。{{char}} 与 {{user}} 会被替换。', rows: 8 },
    { key: 'personality', label: '性格', rows: 3 },
    { key: 'scenario', label: '场景', rows: 3 },
    { key: 'first_mes', label: '开场白', hint: '新对话的第一条消息。', rows: 5 },
    { key: 'mes_example', label: '对话示例', hint: '用 <START> 分隔，行首写 {{char}}: 或 {{user}}:。', rows: 8 },
    { key: 'system_prompt', label: '系统提示词', hint: '留空则用内置的角色指令。', rows: 4 },
    { key: 'post_history_instructions', label: '历史后指令', hint: '独立成一条 system，紧贴最后一条用户消息之前。', rows: 4 },
    { key: 'creator_notes', label: '作者备注', rows: 3 },
];

export interface CardDraft {
    name: string;
    tags: string[];
    description: string;
    personality: string;
    scenario: string;
    first_mes: string;
    mes_example: string;
    system_prompt: string;
    post_history_instructions: string;
    creator_notes: string;
    alternate_greetings: string[];
}

export function toDraft(data: CharacterCardData): CardDraft {
    return {
        name: data.name ?? '',
        tags: data.tags ?? [],
        description: data.description ?? '',
        personality: data.personality ?? '',
        scenario: data.scenario ?? '',
        first_mes: data.first_mes ?? '',
        mes_example: data.mes_example ?? '',
        system_prompt: data.system_prompt ?? '',
        post_history_instructions: data.post_history_instructions ?? '',
        creator_notes: data.creator_notes ?? '',
        alternate_greetings: data.alternate_greetings ?? [],
    };
}

export function CardForm({
    initial,
    busy,
    submitLabel,
    onSave,
    aside,
}: {
    initial: CardDraft;
    busy: boolean;
    submitLabel: string;
    onSave: (draft: CardDraft) => void | Promise<void>;
    aside?: React.ReactNode;
}): React.JSX.Element {
    const [draft, setDraft] = useState<CardDraft>(initial);

    const set = <K extends keyof CardDraft>(key: K, value: CardDraft[K]): void =>
        setDraft((current) => ({ ...current, [key]: value }));

    const setGreeting = (index: number, value: string): void =>
        setDraft((current) => ({
            ...current,
            alternate_greetings: current.alternate_greetings.map((text, i) => (i === index ? value : text)),
        }));

    return (
        <form onSubmit={(event) => {
            event.preventDefault();
            void onSave(draft);
        }}>
            <div className="panel">
                <div className="field">
                    <label htmlFor="name">名字</label>
                    <input id="name" className="input" value={draft.name} onChange={(event) => set('name', event.target.value)} required />
                </div>

                <div className="field">
                    <label htmlFor="tags">标签</label>
                    <input
                        id="tags"
                        className="input"
                        value={draft.tags.join(', ')}
                        placeholder="用逗号分隔，例如：奇幻, 女性"
                        onChange={(event) => set('tags', event.target.value.split(',').map((tag) => tag.trim()).filter((tag) => tag !== ''))}
                    />
                </div>
            </div>

            {FIELDS.map((field) => (
                <div className="panel" key={String(field.key)}>
                    <div className="field" style={{ marginBottom: 0 }}>
                        <label htmlFor={String(field.key)}>{field.label}</label>
                        {field.hint !== undefined ? <span className="hint">{field.hint}</span> : null}
                        <textarea
                            id={String(field.key)}
                            className={`textarea${(field.rows ?? 3) >= 8 ? ' tall' : ''}`}
                            rows={field.rows ?? 3}
                            value={String(draft[field.key] ?? '')}
                            onChange={(event) => set(field.key, event.target.value)}
                        />
                    </div>
                </div>
            ))}

            <div className="panel">
                <div className="field" style={{ marginBottom: 12 }}>
                    <label>备选开场白</label>
                    <span className="hint">新建对话时可以从中挑一段。</span>
                </div>

                <div className="stack">
                    {draft.alternate_greetings.map((text, index) => (
                        <div key={index}>
                            <textarea
                                className="textarea"
                                rows={3}
                                value={text}
                                onChange={(event) => setGreeting(index, event.target.value)}
                            />
                            <div className="row row-end" style={{ marginTop: 6 }}>
                                <button
                                    type="button"
                                    className="btn btn-quiet btn-sm btn-danger"
                                    onClick={() => set('alternate_greetings', draft.alternate_greetings.filter((_, i) => i !== index))}
                                >
                                    <Icon name="trash" size={14} />
                                    删除
                                </button>
                            </div>
                        </div>
                    ))}

                    <div className="row row-end">
                        <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => set('alternate_greetings', [...draft.alternate_greetings, ''])}
                        >
                            <Icon name="plus" size={14} />
                            加一段
                        </button>
                    </div>
                </div>
            </div>

            <div className="row row-end" style={{ marginTop: 18 }}>
                {aside}
                <button type="submit" className="btn btn-primary" disabled={busy}>
                    {busy ? '保存中…' : submitLabel}
                </button>
            </div>
        </form>
    );
}
