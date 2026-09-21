'use client';

/**
 * A published character: read the card, then decide whether to import it.
 *
 * The listing only carries a snapshot, so the card is fetched here — which is
 * also exactly what the reader is choosing between: read it, or copy it into
 * their own library.
 */
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { Icon } from '@/components/icons';
import { Loading, Notice, TagList } from '@/components/ui';
import { get, marketAvatarUrl, post } from '@/lib/api';
import { clock, count } from '@/lib/format';
import type { CharacterCard, MarketEntry } from '@/lib/types';

export default function MarketDetailPage(): React.JSX.Element {
    const params = useParams<{ ownerId: string; characterId: string }>();
    const router = useRouter();
    const ownerId = decodeURIComponent(params.ownerId);
    const characterId = decodeURIComponent(params.characterId);

    const [entry, setEntry] = useState<MarketEntry | null>(null);
    const [card, setCard] = useState<CharacterCard | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const base = `/market/${encodeURIComponent(ownerId)}/${encodeURIComponent(characterId)}`;

    const load = useCallback(async (): Promise<void> => {
        const [listing, detail] = await Promise.all([
            get<{ character: MarketEntry }>(base),
            get<CharacterCard>(`${base}/card.json`).catch(() => null),
        ]);

        setEntry(listing.character);
        setCard(detail);
    }, [base]);

    useEffect(() => {
        void load().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
    }, [load]);

    const favorite = async (): Promise<void> => {
        if (entry === null) {
            return;
        }

        try {
            const result = await post<{ favorited: boolean; favorites: number }>(`${base}/favorite`, { favorited: !entry.favorited });
            setEntry({ ...entry, favorited: result.favorited, stats: { ...entry.stats, favorites: result.favorites } });
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    };

    const importCard = async (): Promise<void> => {
        setBusy(true);
        setError(null);

        try {
            const result = await post<{ imported: { id: string } }>(`${base}/import`);
            router.push(`/characters/${encodeURIComponent(result.imported.id)}`);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
            setBusy(false);
        }
    };

    if (entry === null) {
        return (
            <div className="pane-pad">
                {error !== null ? <Notice kind="error">{error}</Notice> : <Loading />}
            </div>
        );
    }

    return (
        <div className="pane-pad pane-narrow">
            <div className="page-head">
                <div className="row" style={{ gap: 16 }}>
                    <img
                        className="avatar"
                        src={`${marketAvatarUrl(ownerId, characterId)}?v=${entry.stats.imports}`}
                        width={72}
                        height={72}
                        alt=""
                    />
                    <div>
                        <h1>{entry.name}</h1>
                        <div className="sub">
                            由 {ownerId} 发布 · {clock(entry.publishedAt)}
                        </div>
                    </div>
                </div>

                <div className="row">
                    <Link className="btn btn-quiet btn-sm" href="/market">
                        <Icon name="back" size={15} />
                        返回
                    </Link>
                    <button type="button" className="btn" onClick={() => void favorite()}>
                        <Icon name="star" size={15} />
                        {entry.favorited ? '已收藏' : '收藏'}
                    </button>
                    <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void importCard()}>
                        {busy ? '导入中…' : '导入到我的库'}
                    </button>
                </div>
            </div>

            {error !== null ? <Notice kind="error">{error}</Notice> : null}

            <div className="panel">
                <TagList tags={entry.tags} max={12} />
                <dl className="kv" style={{ marginTop: 14 }}>
                    <dt>收藏</dt><dd>{count(entry.stats.favorites)}</dd>
                    <dt>导入</dt><dd>{count(entry.stats.imports)}</dd>
                    <dt>浏览</dt><dd>{count(entry.stats.views)}</dd>
                    <dt>热度</dt><dd>{count(entry.stats.score)}</dd>
                </dl>
            </div>

            {card !== null ? (
                <>
                    <div className="section-title">设定</div>
                    <div className="panel">
                        <div className="prose" style={{ fontSize: 15 }}>{card.data.description || '（作者没有写设定）'}</div>
                    </div>

                    {card.data.personality ? (
                        <>
                            <div className="section-title">性格</div>
                            <div className="panel"><div className="prose" style={{ fontSize: 15 }}>{card.data.personality}</div></div>
                        </>
                    ) : null}

                    {card.data.first_mes ? (
                        <>
                            <div className="section-title">开场白</div>
                            <div className="panel"><div className="prose">{card.data.first_mes}</div></div>
                        </>
                    ) : null}

                    {card.data.creator_notes ? (
                        <>
                            <div className="section-title">作者备注</div>
                            <div className="panel"><div style={{ fontSize: 14, color: 'var(--text-dim)', whiteSpace: 'pre-wrap' }}>{card.data.creator_notes}</div></div>
                        </>
                    ) : null}
                </>
            ) : (
                <div className="notice" style={{ marginTop: 16 }}>这张卡的完整内容读不出来（可能已从作者的库里移除）。</div>
            )}
        </div>
    );
}
