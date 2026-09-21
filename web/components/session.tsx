'use client';

/**
 * Session state, loaded once per app frame.
 *
 * There is no token to keep on the client: the API sets an httpOnly session
 * cookie, so "am I logged in" is answered by asking the server and is the only
 * thing the UI ever knows about authentication.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import { ApiError, getMe, post } from '@/lib/api';
import type { Me } from '@/lib/types';

interface SessionState {
    me: Me | null;
    loading: boolean;
    error: string | null;
    refresh: () => Promise<void>;
    logout: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export function useSession(): SessionState {
    const value = useContext(SessionContext);
    if (value === null) {
        throw new Error('useSession must be used inside <AppFrame>');
    }
    return value;
}

/** Convenience for the common case: only the signed-in user. */
export function useUser(): Me['user'] | null {
    return useSession().me?.user ?? null;
}

export function SessionProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
    const router = useRouter();
    const [me, setMe] = useState<Me | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async (): Promise<void> => {
        try {
            setMe(await getMe());
            setError(null);
        } catch (caught) {
            if (caught instanceof ApiError && caught.isAuth) {
                setMe(null);
                router.replace('/login');
                return;
            }
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setLoading(false);
        }
    }, [router]);

    const logout = useCallback(async (): Promise<void> => {
        try {
            await post('/auth/logout');
        } finally {
            setMe(null);
            router.replace('/login');
        }
    }, [router]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const value = useMemo<SessionState>(() => ({ me, loading, error, refresh, logout }), [me, loading, error, refresh, logout]);

    return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
