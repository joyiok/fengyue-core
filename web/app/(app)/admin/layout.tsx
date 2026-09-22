'use client';

/**
 * The operator area.
 *
 * Deliberately its own tree with its own navigation, not a tab buried in the
 * account page: running the service and using it are different jobs, with
 * different consequences for a wrong click. Mixing them into one screen is how
 * someone changes a production quota while looking for their own balance.
 *
 * The guard here is a courtesy — the server refuses every `/api/v1/admin/*`
 * route from a non-admin regardless of what is rendered.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Notice } from '@/components/ui';
import { useSession } from '@/components/session';

const TABS = [
    { href: '/admin', label: '设置' },
    { href: '/admin/users', label: '用户' },
];

export default function AdminLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
    const { me, loading } = useSession();
    const pathname = usePathname();

    if (loading) {
        return <div className="pane-pad loading">正在载入…</div>;
    }

    if (me?.user.role !== 'admin') {
        return (
            <div className="pane-pad pane-narrow">
                <Notice kind="error">这一片需要管理员权限。第一个注册的账号是管理员。</Notice>
            </div>
        );
    }

    return (
        <div className="pane-pad pane-narrow">
            <div className="page-head">
                <div>
                    <h1>管理</h1>
                    <div className="sub">跑这个服务要用的东西，和「你自己在用这个服务」是两件事。</div>
                </div>

                <div className="row">
                    {TABS.map((tab) => (
                        <Link
                            key={tab.href}
                            href={tab.href}
                            className={`btn btn-sm${pathname === tab.href || (tab.href === '/admin' && pathname === '/admin/settings') ? ' btn-primary' : ''}`}
                        >
                            {tab.label}
                        </Link>
                    ))}
                </div>
            </div>

            {children}
        </div>
    );
}
