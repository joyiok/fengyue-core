'use client';

/** The small shared pieces. Nothing here knows about the API. */
import { useState } from 'react';

import { Icon } from './icons';

export function Avatar({ src, size = 44, alt = '' }: { src: string; size?: number; alt?: string }): React.JSX.Element {
    const [failed, setFailed] = useState(false);

    return (
        <img
            className="avatar"
            src={src}
            width={size}
            height={size}
            alt={alt}
            onError={() => setFailed(true)}
            style={failed ? { display: 'none' } : { width: size, height: size }}
        />
    );
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'error' | 'ok'; children: React.ReactNode }): React.JSX.Element {
    return <div className={`notice ${kind === 'info' ? '' : kind}`}>{children}</div>;
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }): React.JSX.Element {
    return (
        <div className="empty">
            <b>{title}</b>
            {children}
        </div>
    );
}

export function Loading({ text = '正在载入…' }: { text?: string }): React.JSX.Element {
    return <div className="loading">{text}</div>;
}

export function TagList({ tags, max = 4 }: { tags: string[]; max?: number }): React.JSX.Element | null {
    if (tags.length === 0) {
        return null;
    }

    return (
        <div className="tags">
            {tags.slice(0, max).map((tag) => (
                <span className="tag" key={tag}>{tag}</span>
            ))}
            {tags.length > max ? <span className="tag">+{tags.length - max}</span> : null}
        </div>
    );
}

/**
 * A destructive button that asks first. Every deletion in this app removes
 * things that cannot be recovered from the UI, so nothing is one click away.
 */
export function ConfirmButton({
    label,
    confirm,
    onConfirm,
    small = true,
}: {
    label: string;
    confirm: string;
    onConfirm: () => void | Promise<void>;
    small?: boolean;
}): React.JSX.Element {
    const [armed, setArmed] = useState(false);

    if (!armed) {
        return (
            <button type="button" className={`btn btn-quiet btn-danger ${small ? 'btn-sm' : ''}`} onClick={() => setArmed(true)}>
                <Icon name="trash" size={14} />
                {label}
            </button>
        );
    }

    return (
        <span className="row" style={{ gap: 6 }}>
            <span style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>{confirm}</span>
            <button
                type="button"
                className={`btn btn-danger ${small ? 'btn-sm' : ''}`}
                onClick={() => {
                    setArmed(false);
                    void onConfirm();
                }}
            >
                确定
            </button>
            <button type="button" className={`btn btn-quiet ${small ? 'btn-sm' : ''}`} onClick={() => setArmed(false)}>
                取消
            </button>
        </span>
    );
}

export function Meter({ value }: { value: number }): React.JSX.Element {
    return (
        <div className="meter">
            <i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
        </div>
    );
}
