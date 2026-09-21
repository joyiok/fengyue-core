'use client';

/** Create a card from scratch instead of importing one. */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { CardForm, type CardDraft } from '@/components/CardForm';
import { Notice } from '@/components/ui';
import { api } from '@/lib/api';

const BLANK: CardDraft = {
    name: '',
    tags: [],
    description: '',
    personality: '',
    scenario: '',
    first_mes: '',
    mes_example: '',
    system_prompt: '',
    post_history_instructions: '',
    creator_notes: '',
    alternate_greetings: [],
};

export default function NewCharacterPage(): React.JSX.Element {
    const router = useRouter();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const save = async (draft: CardDraft): Promise<void> => {
        setBusy(true);
        setError(null);

        try {
            // The name doubles as the file name (and therefore the id), which is
            // why it travels in a header rather than only in the body.
            const created = await api<{ id: string }>('/characters', {
                method: 'POST',
                headers: { 'x-filename': draft.name },
                body: JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: draft }),
            });
            router.push(`/characters/${encodeURIComponent(created.id)}`);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
            setBusy(false);
        }
    };

    return (
        <div className="pane-pad pane-narrow">
            <div className="page-head">
                <div>
                    <h1>新建角色</h1>
                    <div className="sub">保存后生成一张标准 V2 卡（PNG）。</div>
                </div>
            </div>

            {error !== null ? <Notice kind="error">{error}</Notice> : null}

            <div style={{ marginTop: 18 }}>
                <CardForm initial={BLANK} busy={busy} submitLabel="创建" onSave={save} />
            </div>
        </div>
    );
}
