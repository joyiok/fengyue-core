'use client';

/**
 * The character library.
 *
 * Import is a plain file input: the API takes the raw PNG (or JSON) body with a
 * `x-filename` header, which is exactly what a `File` already is — no multipart
 * encoding needed on either side.
 */
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Icon } from '@/components/icons';
import { Empty, Loading, Notice, TagList } from '@/components/ui';
import { avatarUrl, get, importCard } from '@/lib/api';
import type { CharacterListEntry } from '@/lib/types';

export default function CharactersPage(): React.JSX.Element {
    const [entries, setEntries] = useState<CharacterListEntry[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const file = useRef<HTMLInputElement | null>(null);

    const load = useCallback(async (): Promise<void> => {
        const payload = await get<{ characters: CharacterListEntry[] }>('/characters');
        setEntries(payload.characters);
    }, []);

    useEffect(() => {
        void load().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
    }, [load]);

    const upload = async (chosen: File | undefined): Promise<void> => {
        if (chosen === undefined) {
            return;
        }

        setBusy(true);
        setError(null);
        setNote(null);

        try {
            const imported = await importCard(chosen);
            setNote(`已导入「${imported.fileName}」`);
            await load();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
            if (file.current !== null) {
                file.current.value = '';
            }
        }
    };

    const ok = entries?.filter((entry) => entry.ok) ?? [];
    const broken = entries?.filter((entry) => !entry.ok) ?? [];

    return (
        <div className="pane-pad">
            <div className="page-head">
                <div>
                    <h1>角色</h1>
                    <div className="sub">{entries === null ? '…' : `${ok.length} 张卡`}</div>
                </div>
                <div className="row">
                    <input
                        ref={file}
                        type="file"
                        accept=".png,.json,image/png,application/json"
                        style={{ display: 'none' }}
                        onChange={(event) => void upload(event.target.files?.[0])}
                    />
                    <button type="button" className="btn" disabled={busy} onClick={() => file.current?.click()}>
                        <Icon name="upload" size={15} />
                        {busy ? '导入中…' : '导入卡'}
                    </button>
                    <Link href="/characters/new" className="btn btn-primary">
                        <Icon name="plus" size={15} />
                        新建角色
                    </Link>
                </div>
            </div>

            {error !== null ? <Notice kind="error">{error}</Notice> : null}
            {note !== null ? <Notice kind="ok">{note}</Notice> : null}

            {entries === null ? <Loading /> : null}

            {entries !== null && ok.length === 0 && broken.length === 0 ? (
                <Empty title="库里还没有角色卡">
                    支持 V1 / V2 / V3 卡（PNG 内嵌或 JSON），也能直接用酒馆导出的卡。
                </Empty>
            ) : null}

            {ok.length > 0 ? (
                <div className="grid-cards" style={{ marginTop: 18 }}>
                    {ok.map((entry) => entry.ok && (
                        <Link className="card-tile" key={entry.id} href={`/characters/${encodeURIComponent(entry.id)}`}>
                            <img className="thumb" src={avatarUrl(entry.id)} alt="" loading="lazy" />
                            <div className="body">
                                <div className="title">{entry.name}</div>
                                <div className="meta" style={{ marginBottom: 8 }}>
                                    {entry.spec === 'chara_card_v3' ? 'V3' : entry.spec === 'chara_card_v2' ? 'V2' : 'V1'}
                                    {' · '}设定 {entry.descriptionLength} 字
                                </div>
                                <TagList tags={entry.tags} />
                            </div>
                        </Link>
                    ))}
                </div>
            ) : null}

            {broken.length > 0 ? (
                <>
                    <div className="section-title">读不出来的文件</div>
                    <div className="list">
                        {broken.map((entry) => !entry.ok && (
                            <div className="list-item" key={entry.id}>
                                <div className="body">
                                    <div className="title">{entry.id}.png</div>
                                    <div className="meta">{entry.error}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </>
            ) : null}
        </div>
    );
}
