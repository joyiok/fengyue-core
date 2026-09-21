'use client';

/**
 * World books (World Info / Lorebook).
 *
 * A book is one JSON file and the API round-trips it whole, so creating one and
 * importing one are the same operation with a different source: write the file.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Icon } from '@/components/icons';
import { ConfirmButton, Empty, Loading, Notice } from '@/components/ui';
import { del, get, put } from '@/lib/api';
import { count, short } from '@/lib/format';
import type { Worldbook, WorldbookSummary } from '@/lib/types';

export default function WorldbooksPage(): React.JSX.Element {
    const router = useRouter();
    const [books, setBooks] = useState<WorldbookSummary[] | null>(null);
    const [name, setName] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const file = useRef<HTMLInputElement | null>(null);

    const load = useCallback(async (): Promise<void> => {
        setBooks((await get<{ worldbooks: WorldbookSummary[] }>('/worldbooks')).worldbooks);
    }, []);

    useEffect(() => {
        void load().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
    }, [load]);

    const create = async (): Promise<void> => {
        const id = name.trim();
        if (id === '') {
            return;
        }

        setBusy(true);
        setError(null);

        try {
            await put(`/worldbooks/${encodeURIComponent(id)}`, { entries: {} });
            setName('');
            router.push(`/worldbooks/${encodeURIComponent(id)}`);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
            setBusy(false);
        }
    };

    const importFile = async (chosen: File | undefined): Promise<void> => {
        if (chosen === undefined) {
            return;
        }

        setBusy(true);
        setError(null);

        try {
            const parsed = JSON.parse(await chosen.text()) as Worldbook;
            // The file name is the book name — the same rule the library uses for
            // a file dropped into `worlds/`, so a re-import overwrites cleanly.
            const id = chosen.name.replace(/\.json$/i, '')
                || (typeof parsed.name === 'string' ? parsed.name : '')
                || 'worldbook';
            await put(`/worldbooks/${encodeURIComponent(id)}`, parsed);
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

    const remove = async (id: string): Promise<void> => {
        try {
            await del(`/worldbooks/${encodeURIComponent(id)}`);
            await load();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    };

    return (
        <div className="pane-pad pane-narrow">
            <div className="page-head">
                <div>
                    <h1>世界书</h1>
                    <div className="sub">关键词命中后注入设定，是「像酒馆」的那一块。</div>
                </div>
                <div className="row">
                    <input
                        ref={file}
                        type="file"
                        accept=".json,application/json"
                        style={{ display: 'none' }}
                        onChange={(event) => void importFile(event.target.files?.[0])}
                    />
                    <button type="button" className="btn" disabled={busy} onClick={() => file.current?.click()}>
                        <Icon name="upload" size={15} />
                        导入 JSON
                    </button>
                </div>
            </div>

            {error !== null ? <Notice kind="error">{error}</Notice> : null}

            <div className="panel">
                <div className="row">
                    <input
                        className="input grow"
                        placeholder="新世界书的名字"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                event.preventDefault();
                                void create();
                            }
                        }}
                    />
                    <button type="button" className="btn btn-primary" disabled={busy || name.trim() === ''} onClick={() => void create()}>
                        <Icon name="plus" size={15} />
                        新建
                    </button>
                </div>
            </div>

            {books === null ? <Loading /> : null}

            {books !== null && books.length === 0 ? (
                <Empty title="还没有世界书">
                    导入酒馆的 `worlds/*.json`，或新建一本。
                </Empty>
            ) : null}

            {books !== null && books.length > 0 ? (
                <div className="list" style={{ marginTop: 18 }}>
                    {books.map((book) => (
                        <div className="list-item" key={book.id}>
                            <Link className="body" href={`/worldbooks/${encodeURIComponent(book.id)}`}>
                                <div className="title">{book.id}</div>
                                <div className="meta">
                                    {count(book.entries)} 词条 · 常驻 {count(book.constantEntries)} · 禁用 {count(book.disabledEntries)} · {short(book.bytes)}B
                                </div>
                            </Link>
                            <ConfirmButton label="删除" confirm="删除这本世界书？" onConfirm={() => remove(book.id)} />
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );
}
