/** Small display helpers. Everything user-visible goes through these. */

/** "刚刚" / "3 分钟前" / "09-21 22:04" — chat lists need three granularities. */
export function ago(value: string | number | null | undefined): string {
    if (value === null || value === undefined || value === '') {
        return '';
    }

    const at = new Date(value);
    if (Number.isNaN(at.getTime())) {
        return '';
    }

    const seconds = Math.round((Date.now() - at.getTime()) / 1000);
    if (seconds < 60) {
        return '刚刚';
    }
    if (seconds < 3600) {
        return `${Math.floor(seconds / 60)} 分钟前`;
    }
    if (seconds < 86400) {
        return `${Math.floor(seconds / 3600)} 小时前`;
    }

    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function clock(value: string | number | null | undefined): string {
    if (value === null || value === undefined || value === '') {
        return '';
    }

    const at = new Date(value);
    if (Number.isNaN(at.getTime())) {
        return '';
    }

    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export const count = (value: number): string => value.toLocaleString('en-US');

/** 1500 → "1.5k". Used for token counts in the debug panel. */
export function short(value: number): string {
    if (value < 1000) {
        return String(value);
    }
    return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}k`;
}

export function percent(used: number, limit: number): number {
    if (limit <= 0) {
        return 0;
    }
    return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}

/** First line of a block of prose, for list rows. */
export function head(text: string, limit = 42): string {
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length > limit ? `${line.slice(0, limit)}…` : line;
}
