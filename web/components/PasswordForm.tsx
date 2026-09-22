'use client';

/**
 * Change your own password.
 *
 * The current one is required — the server insists — because a live session is
 * not proof of who you are to the degree that re-keying the account is. Changing
 * it signs out every other session and hands back one fresh token, which is the
 * whole point: whoever else was holding one is now out.
 */
import { useState } from 'react';

import { post } from '@/lib/api';
import { Notice } from './ui';

export function PasswordForm(): React.JSX.Element {
    const [current, setCurrent] = useState('');
    const [next, setNext] = useState('');
    const [confirm, setConfirm] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);

    const submit = async (event: React.FormEvent): Promise<void> => {
        event.preventDefault();
        setError(null);
        setNote(null);

        if (next !== confirm) {
            setError('两次输入的新密码不一致。');
            return;
        }

        setBusy(true);

        try {
            await post('/me/password', { currentPassword: current, newPassword: next });
            setCurrent('');
            setNext('');
            setConfirm('');
            setNote('已修改。其它设备上的登录都已失效，你这个不受影响。');
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="panel">
            <div className="section-title" style={{ marginTop: 0 }}>密码</div>

            <form onSubmit={(event) => void submit(event)}>
                <div className="field">
                    <label htmlFor="current-password">当前密码</label>
                    <input
                        id="current-password"
                        className="input"
                        type="password"
                        value={current}
                        autoComplete="current-password"
                        onChange={(event) => setCurrent(event.target.value)}
                        required
                    />
                </div>

                <div className="field">
                    <label htmlFor="new-password">新密码</label>
                    <input
                        id="new-password"
                        className="input"
                        type="password"
                        value={next}
                        autoComplete="new-password"
                        onChange={(event) => setNext(event.target.value)}
                        required
                    />
                    <span className="hint">至少 8 个字符。改完之后其它地方的登录会全部失效。</span>
                </div>

                <div className="field">
                    <label htmlFor="confirm-password">再输一次</label>
                    <input
                        id="confirm-password"
                        className="input"
                        type="password"
                        value={confirm}
                        autoComplete="new-password"
                        onChange={(event) => setConfirm(event.target.value)}
                        required
                    />
                </div>

                {error !== null ? <div style={{ marginBottom: 12 }}><Notice kind="error">{error}</Notice></div> : null}
                {note !== null ? <div style={{ marginBottom: 12 }}><Notice kind="ok">{note}</Notice></div> : null}

                <div className="row row-end">
                    <button type="submit" className="btn btn-primary" disabled={busy || current === '' || next === ''}>
                        {busy ? '提交中…' : '修改密码'}
                    </button>
                </div>
            </form>
        </div>
    );
}
