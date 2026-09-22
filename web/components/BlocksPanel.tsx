'use client';

/**
 * What this account never wants to see.
 *
 * Per user and not global: this is taste, not policy — one person's must-see is
 * another's never-show-me. The platform's own line (what may not exist here at
 * all) is a different thing and lives in review.
 *
 * Two kinds, applied in two places, which is why they are separate lists:
 *   - 标签  filter listings and rankings before anything is shown;
 *   - 屏蔽词  mask a reply after the model has spoken — the only place a word can
 *     still turn up once a session is running.
 */
import { useCallback, useEffect, useState } from 'react';

import { del, get, post } from '@/lib/api';
import { Notice } from './ui';

export function BlocksPanel(): React.JSX.Element {
    const [blocks, setBlocks] = useState<{ tags: string[]; words: string[] } | null>(null);
    const [tag, setTag] = useState('');
    const [word, setWord] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async (): Promise<void> => {
        setBlocks(await get('/me/blocks'));
    }, []);

    useEffect(() => {
        void load().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
    }, [load]);

    const add = async (kind: 'tag' | 'word', value: string, clear: () => void): Promise<void> => {
        if (value.trim() === '') {
            return;
        }

        setBusy(true);
        setError(null);

        try {
            await post('/me/blocks', { kind, value: value.trim() });
            clear();
            await load();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    const remove = async (kind: 'tag' | 'word', value: string): Promise<void> => {
        setBusy(true);
        try {
            await del(`/me/blocks/${kind}/${encodeURIComponent(value)}`);
            await load();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="panel">
            <div className="section-title" style={{ marginTop: 0 }}>不想看到的</div>

            <div className="notice" style={{ marginBottom: 14 }}>
                这是<b>口味，不是规则</b>：只影响你自己看到什么，不影响别人，也不影响平台。
                两种粒度落在两个位置——<b>标签</b>在列表阶段就过滤掉，<b>屏蔽词</b>在模型说完之后遮掉
                （一轮已经在跑，那是它唯一还能冒出来的地方）。
            </div>

            <div className="field">
                <label htmlFor="block-tag">屏蔽标签</label>
                <div className="row">
                    <input
                        id="block-tag"
                        className="input grow"
                        placeholder="整标签匹配：屏蔽 cat 不会把 category 也弄没"
                        value={tag}
                        onChange={(event) => setTag(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                event.preventDefault();
                                void add('tag', tag, () => setTag(''));
                            }
                        }}
                    />
                    <button type="button" className="btn" disabled={busy || tag.trim() === ''} onClick={() => void add('tag', tag, () => setTag(''))}>
                        屏蔽
                    </button>
                </div>
                <ChipList items={blocks?.tags ?? []} onRemove={(value) => void remove('tag', value)} empty="还没有屏蔽任何标签。" />
            </div>

            <div className="field">
                <label htmlFor="block-word">屏蔽词</label>
                <div className="row">
                    <input
                        id="block-word"
                        className="input grow"
                        placeholder="回复里出现就遮成 ▮▮▮（会保存遮过的那份）"
                        value={word}
                        onChange={(event) => setWord(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                event.preventDefault();
                                void add('word', word, () => setWord(''));
                            }
                        }}
                    />
                    <button type="button" className="btn" disabled={busy || word.trim() === ''} onClick={() => void add('word', word, () => setWord(''))}>
                        屏蔽
                    </button>
                </div>
                <ChipList items={blocks?.words ?? []} onRemove={(value) => void remove('word', value)} empty="还没有屏蔽任何词。" />
            </div>

            {error !== null ? <Notice kind="error">{error}</Notice> : null}
        </div>
    );
}

function ChipList({ items, onRemove, empty }: { items: string[]; onRemove: (value: string) => void; empty: string }): React.JSX.Element {
    if (items.length === 0) {
        return <div className="hint" style={{ marginTop: 8 }}>{empty}</div>;
    }

    return (
        <div className="tags" style={{ marginTop: 8 }}>
            {items.map((item) => (
                <button
                    key={item}
                    type="button"
                    className="tag"
                    title="点一下放开"
                    style={{ cursor: 'pointer' }}
                    onClick={() => onRemove(item)}
                >
                    {item} ✕
                </button>
            ))}
        </div>
    );
}
