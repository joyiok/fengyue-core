'use client';

/**
 * The character market: what other accounts have published.
 *
 * The listing is a snapshot taken at publish time (name, tags, how long the
 * description is), so browsing never reads anyone's files — which is why it is
 * fast. The card itself is fetched only on the detail page.
 */
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { Empty, Loading, Notice, TagList } from '@/components/ui';
import { get, marketAvatarUrl } from '@/lib/api';
import { count } from '@/lib/format';
import type { MarketEntry, RankingRow } from '@/lib/types';

type Tab = 'market' | 'rankings';
type Sort = 'hot' | 'new' | 'name';
type Window = 'day' | 'week' | 'month' | 'all';

const SORTS: [Sort, string][] = [['hot', '最热'], ['new', '最新'], ['name', '名字']];
const WINDOWS: [Window, string][] = [['day', '今天'], ['week', '本周'], ['month', '本月'], ['all', '全部']];

export default function MarketPage(): React.JSX.Element {
    const [tab, setTab] = useState<Tab>('market');
    const [query, setQuery] = useState('');
    const [tag, setTag] = useState('');
    const [sort, setSort] = useState<Sort>('hot');
    const [window_, setWindow] = useState<Window>('day');
    const [entries, setEntries] = useState<MarketEntry[] | null>(null);
    const [ranking, setRanking] = useState<RankingRow[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async (): Promise<void> => {
        setError(null);

        try {
            if (tab === 'market') {
                const params = new URLSearchParams({ sort, limit: '48' });
                if (query.trim() !== '') {
                    params.set('q', query.trim());
                }
                if (tag.trim() !== '') {
                    params.set('tag', tag.trim());
                }
                setEntries((await get<{ characters: MarketEntry[] }>(`/market?${params.toString()}`)).characters);
            } else {
                const params = new URLSearchParams({ window: window_, limit: '48' });
                setRanking((await get<{ characters: RankingRow[] }>(`/rankings?${params.toString()}`)).characters);
            }
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    }, [tab, query, tag, sort, window_]);

    useEffect(() => {
        setEntries(null);
        setRanking(null);
        void load();
    }, [load]);

    return (
        <div className="pane-pad">
            <div className="page-head">
                <div>
                    <h1>市场</h1>
                    <div className="sub">公开的角色卡，可以直接导入自己的库。</div>
                </div>
                <div className="row">
                    {tab === 'market' ? SORTS.map(([value, label]) => (
                        <button
                            key={value}
                            type="button"
                            className={`btn btn-sm${sort === value ? ' btn-primary' : ''}`}
                            onClick={() => setSort(value)}
                        >
                            {label}
                        </button>
                    )) : WINDOWS.map(([value, label]) => (
                        <button
                            key={value}
                            type="button"
                            className={`btn btn-sm${window_ === value ? ' btn-primary' : ''}`}
                            onClick={() => setWindow(value)}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="row" style={{ marginBottom: 8 }}>
                <button type="button" className={`btn btn-sm${tab === 'market' ? ' btn-primary' : ''}`} onClick={() => setTab('market')}>
                    浏览
                </button>
                <button type="button" className={`btn btn-sm${tab === 'rankings' ? ' btn-primary' : ''}`} onClick={() => setTab('rankings')}>
                    榜单
                </button>
                <span className="grow" />
                {tab === 'market' ? (
                    <>
                        <input
                            className="input"
                            style={{ width: 150 }}
                            placeholder="标签"
                            value={tag}
                            onChange={(event) => setTag(event.target.value)}
                        />
                        <input
                            className="input"
                            style={{ width: 220 }}
                            placeholder="搜索名字或描述"
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                        />
                    </>
                ) : null}
            </div>

            {error !== null ? <Notice kind="error">{error}</Notice> : null}

            {tab === 'market' ? (
                entries === null ? <Loading /> : entries.length === 0 ? (
                    <Empty title="没有找到公开的角色">
                        试试别的关键词，或者去角色页发布你自己的。
                    </Empty>
                ) : (
                    <Grid entries={entries} />
                )
            ) : ranking === null ? <Loading /> : ranking.length === 0 ? (
                <Empty title="榜单还是空的">浏览、收藏和导入都会计分。</Empty>
            ) : (
                <div className="list">
                    {ranking.map((row) => (
                        <Link
                            className="list-item"
                            key={`${row.ownerId}/${row.characterId}`}
                            href={`/market/${encodeURIComponent(row.ownerId)}/${encodeURIComponent(row.characterId)}`}
                        >
                            <b style={{ width: 28, color: 'var(--lamp)', fontVariantNumeric: 'tabular-nums' }}>{row.rank}</b>
                            <img className="avatar" src={marketAvatarUrl(row.ownerId, row.characterId)} width={38} height={38} alt="" />
                            <span className="body">
                                <span className="title" style={{ display: 'block' }}>{row.name}</span>
                                <span className="meta" style={{ display: 'block' }}>
                                    收藏 {count(row.stats.favorites)} · 导入 {count(row.stats.imports)} · 浏览 {count(row.stats.views)} · {row.ownerId}
                                </span>
                            </span>
                            <span className="tag lamp">{count(row.stats.score)} 分</span>
                        </Link>
                    ))}
                </div>
            )}
        </div>
    );
}

function Grid({ entries }: { entries: MarketEntry[] }): React.JSX.Element {
    return (
        <div className="grid-cards">
            {entries.map((entry) => (
                <Link
                    className="card-tile"
                    key={`${entry.ownerId}/${entry.characterId}`}
                    href={`/market/${encodeURIComponent(entry.ownerId)}/${encodeURIComponent(entry.characterId)}`}
                >
                    <img className="thumb" src={marketAvatarUrl(entry.ownerId, entry.characterId)} alt="" loading="lazy" />
                    <div className="body">
                        <div className="title">{entry.name}</div>
                        <div className="meta" style={{ marginBottom: 8 }}>
                            {entry.ownerId} · 收藏 {count(entry.stats.favorites)} · 导入 {count(entry.stats.imports)}
                        </div>
                        <TagList tags={entry.tags} />
                    </div>
                </Link>
            ))}
        </div>
    );
}
