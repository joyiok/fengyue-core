/**
 * Line icons, 20px, drawn inline so the app has no icon dependency and the
 * stroke colour follows `currentColor` (which is how the nav highlight works).
 */

const paths: Record<string, React.JSX.Element> = {
    chats: (
        <>
            <path d="M4 5h16v10H8l-4 4z" />
            <path d="M8 9h8" />
            <path d="M8 12h5" />
        </>
    ),
    characters: (
        <>
            <circle cx="12" cy="8.5" r="3.5" />
            <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" />
        </>
    ),
    world: (
        <>
            <circle cx="12" cy="12" r="8.5" />
            <path d="M3.5 12h17" />
            <path d="M12 3.5c2.4 2.4 3.6 5.3 3.6 8.5s-1.2 6.1-3.6 8.5c-2.4-2.4-3.6-5.3-3.6-8.5S9.6 5.9 12 3.5z" />
        </>
    ),
    market: (
        <>
            <path d="M4 8h16l-1.2 11H5.2z" />
            <path d="M8.5 8V6a3.5 3.5 0 0 1 7 0v2" />
        </>
    ),
    account: (
        <>
            <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
            <path d="M3.5 10h17" />
            <path d="M7 14.5h4" />
        </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    trash: (
        <>
            <path d="M4.5 7h15" />
            <path d="M9.5 7V5h5v2" />
            <path d="M6.5 7l1 12h9l1-12" />
        </>
    ),
    refresh: (
        <>
            <path d="M20 12a8 8 0 1 1-2.6-5.9" />
            <path d="M20 4v4h-4" />
        </>
    ),
    back: <path d="M15 5l-7 7 7 7" />,
    send: <path d="M4 12l16-7-6 16-2.5-6.5z" />,
    stop: <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />,
    star: (
        <path d="M12 4.5l2.3 5 5.2.6-3.9 3.6 1.1 5.3L12 16.4 7.3 19l1.1-5.3-3.9-3.6 5.2-.6z" />
    ),
    upload: (
        <>
            <path d="M12 16V5" />
            <path d="M8 9l4-4 4 4" />
            <path d="M5 16v3h14v-3" />
        </>
    ),
    edit: (
        <>
            <path d="M4 20h4l10-10-4-4L4 16z" />
            <path d="M13.5 6.5l4 4" />
        </>
    ),
    check: <path d="M5 13l4.5 4.5L19 7" />,
    // Mod 是「装上去的一块」，不是「世界」——两个功能共用图标就分不清了。
    mod: (
        <>
            <path d="M10 4h4v3.2a1.8 1.8 0 1 0 3.6 0V4h2.4v4.4h-3.2a1.8 1.8 0 1 0 0 3.6h3.2V20H4V4h6z" />
        </>
    ),
    // 版本：一条主干长出分叉。
    branch: (
        <>
            <circle cx="7" cy="6" r="2" />
            <circle cx="7" cy="18" r="2" />
            <circle cx="17" cy="10" r="2" />
            <path d="M7 8v8" />
            <path d="M7 12h5a3 3 0 0 0 3-3v-.5" />
        </>
    ),
    eyeoff: (
        <>
            <path d="M4 4l16 16" />
            <path d="M9.6 6.4A8.6 8.6 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-2.7 3.3" />
            <path d="M6.2 8.2A17 17 0 0 0 3 12s4 6 9 6a8.5 8.5 0 0 0 3.4-.7" />
        </>
    ),
};

export function Icon({ name, size = 18 }: { name: keyof typeof paths | string; size?: number }): React.JSX.Element {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            {paths[name] ?? null}
        </svg>
    );
}
