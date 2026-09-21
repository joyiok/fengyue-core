'use client';

/**
 * Sign in / sign up.
 *
 * The API sets an httpOnly session cookie on success, so there is no token to
 * store here: the form posts credentials and navigates, and the app frame finds
 * out who you are by asking `/me`.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ApiError, post } from '@/lib/api';
import type { LoginResult } from '@/lib/types';

export function AuthForm({ mode }: { mode: 'login' | 'register' }): React.JSX.Element {
    const router = useRouter();
    const [handle, setHandle] = useState('');
    const [password, setPassword] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const isRegister = mode === 'register';

    const submit = async (event: React.FormEvent): Promise<void> => {
        event.preventDefault();
        setBusy(true);
        setError(null);

        try {
            await post<LoginResult>(
                isRegister ? '/auth/register' : '/auth/login',
                isRegister
                    ? { handle, password, ...(displayName.trim() === '' ? {} : { displayName: displayName.trim() }) }
                    : { handle, password },
            );
            router.push('/chats');
        } catch (caught) {
            setError(caught instanceof ApiError ? caught.message : String(caught));
            setBusy(false);
        }
    };

    return (
        <main className="auth-page">
            <div className="auth-card">
                <div className="wordmark">
                    <b>story</b>
                    <span>物语</span>
                </div>

                <h1>{isRegister ? '创建账号' : '欢迎回来'}</h1>
                <p className="sub">
                    {isRegister ? '第一个注册的账号是管理员。' : '登录后继续你的故事。'}
                </p>

                <form onSubmit={(event) => void submit(event)}>
                    <div className="field">
                        <label htmlFor="handle">用户名</label>
                        <input
                            id="handle"
                            className="input"
                            value={handle}
                            onChange={(event) => setHandle(event.target.value)}
                            autoComplete="username"
                            autoFocus
                            required
                        />
                    </div>

                    {isRegister ? (
                        <div className="field">
                            <label htmlFor="displayName">显示名（可选）</label>
                            <input
                                id="displayName"
                                className="input"
                                value={displayName}
                                onChange={(event) => setDisplayName(event.target.value)}
                            />
                        </div>
                    ) : null}

                    <div className="field">
                        <label htmlFor="password">密码</label>
                        <input
                            id="password"
                            className="input"
                            type="password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            autoComplete={isRegister ? 'new-password' : 'current-password'}
                            required
                        />
                    </div>

                    {error !== null ? <div className="notice error" style={{ marginBottom: 16 }}>{error}</div> : null}

                    <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={busy}>
                        {busy ? '请稍候…' : isRegister ? '创建账号' : '登录'}
                    </button>
                </form>

                <div className="auth-foot">
                    {isRegister ? (
                        <span>已经有账号了？<Link href="/login">去登录</Link></span>
                    ) : (
                        <span>还没有账号？<Link href="/register">创建一个</Link></span>
                    )}
                </div>
            </div>
        </main>
    );
}
