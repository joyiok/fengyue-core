'use client';

/**
 * The signed-in application frame: a quiet rail on the left, the page on the
 * right. It also owns the session — a page under it can assume there is a user.
 */
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { count } from '@/lib/format';
import { Icon } from './icons';
import { SessionProvider, useSession } from './session';

const NAV = [
    { href: '/chats', label: '对话', icon: 'chats' },
    { href: '/characters', label: '角色', icon: 'characters' },
    { href: '/worldbooks', label: '世界书', icon: 'world' },
    { href: '/mods', label: 'Mod', icon: 'world' },
    { href: '/market', label: '市场', icon: 'market' },
    { href: '/account', label: '账户', icon: 'account' },
];

function Rail(): React.JSX.Element {
    const { me, logout } = useSession();
    const pathname = usePathname();

    // Prefix matching, so /characters/林昭 still highlights 角色. The two admin
    // entries are exact: /admin/users must not light up under /admin.
    const current = (href: string, exact = false): boolean =>
        exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

    return (
        <nav className="rail">
            <Link href="/chats" className="wordmark">
                <b>story</b>
                <span>物语</span>
            </Link>

            {NAV.map((item) => (
                <Link
                    key={item.href}
                    href={item.href}
                    className="nav-link"
                    aria-current={current(item.href) ? 'page' : undefined}
                >
                    <Icon name={item.icon} />
                    <span>{item.label}</span>
                </Link>
            ))}

            <div className="rail-spacer" />

            {/* The operator area is its own block below a divider, not another
                entry in the list of things you do as a user of this service. */}
            {me?.user.role === 'admin' ? (
                <>
                    <div className="rail-divider" />
                    <div className="rail-label">管理</div>
                    <Link
                        href="/admin"
                        className="nav-link"
                        aria-current={current('/admin', true) ? 'page' : undefined}
                    >
                        <Icon name="account" />
                        <span>设置</span>
                    </Link>
                    <Link
                        href="/admin/users"
                        className="nav-link"
                        aria-current={current('/admin/users', true) ? 'page' : undefined}
                    >
                        <Icon name="characters" />
                        <span>用户</span>
                    </Link>
                </>
            ) : null}

            <div className="rail-user">
                <div className="handle">{me?.user.displayName || me?.user.handle}</div>
                <div className="meta">
                    {me?.credits === null || me?.credits === undefined
                        ? '单用户模式'
                        : `余额 ${count(me.credits.balance)}`}
                </div>
                <button type="button" className="btn btn-quiet btn-sm" style={{ justifyContent: 'flex-start', marginTop: 6 }} onClick={() => void logout()}>
                    退出登录
                </button>
            </div>
        </nav>
    );
}

function Guard({ children }: { children: React.ReactNode }): React.JSX.Element {
    const { me, loading, error, refresh } = useSession();
    const router = useRouter();

    useEffect(() => {
        if (!loading && me === null && error === null) {
            router.replace('/login');
        }
    }, [loading, me, error, router]);

    if (loading) {
        return <div className="pane"><div className="pane-pad loading">正在载入…</div></div>;
    }

    if (me === null) {
        return (
            <div className="pane">
                <div className="pane-pad">
                    <div className="notice error">
                        {error ?? '无法确认登录状态。'}
                        <button type="button" className="btn btn-sm" style={{ marginLeft: 12 }} onClick={() => void refresh()}>
                            重试
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return <>{children}</>;
}

export function AppFrame({ children }: { children: React.ReactNode }): React.JSX.Element {
    return (
        <SessionProvider>
            <div className="shell">
                <Rail />
                <Guard>
                    <div className="pane">{children}</div>
                </Guard>
            </div>
        </SessionProvider>
    );
}
