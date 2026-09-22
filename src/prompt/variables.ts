/**
 * Card variables and the panel that collects them.
 *
 * A card can ask the reader something before the first turn — a name, a
 * backstory, a setting — and use the answers in its own prompt. This is that
 * mechanism: declarations live on the card (so they travel with the PNG),
 * the panel is HTML the author wrote (so it can look like anything), and the
 * answers substitute `{{key}}` placeholders in the prompt and the opening.
 *
 * Three deliberate calls:
 *
 *   `{{key}}` and not Jinja. The syntax is what people have seen elsewhere
 *   (`{{input}}`), and a whole template language is a whole template language —
 *   this only has to put a value in a hole.
 *
 *   the panel is HTML we render, and it is *sanitised* first. An author's card
 *   is read by other people; `<script>` and `on*` handlers in a greeting card is
 *   a way to run code in someone else's session. Stripping them costs nothing
 *   and the panel still looks like whatever the author designed.
 *
 *   the form binds through `data-var`, not through author-written markup. The
 *   panel says where the fields go; this code says what a field is. An author
 *   who writes no fields gets default controls from the declarations, so a
 *   panel is optional decoration rather than a requirement.
 */

/** One thing the card asks for. Lives in `extensions.story.variables`. */
export interface CardVariable {
    /** `{{key}}` in prompts. `[A-Za-z_][A-Za-z0-9_]*`, at most 30 chars. */
    key: string;
    /** What the field is called in the panel. */
    label: string;
    /** Help text under the field. */
    help?: string;
    /** Pre-filled value. */
    default?: string;
    /** Refuse to start the chat while this is empty. */
    required?: boolean;
}

export const MAX_VARIABLE_KEY_LENGTH = 30;

/**
 * `{{key}}` fills a hole. An unknown key is left alone: an empty placeholder is
 * quieter than a missing one, and "this name is not defined" is a mistake the
 * author fixes, not something to paper over silently.
 */
/**
 * The card with `{{key}}` filled in.
 *
 * Returns a copy — the card is what the author wrote and it stays that way, on
 * disk and in the debug panel. Substituting at the edge, once, means the
 * definition block, the opening line and the tail all read the same filled text
 * and there is no second place where a placeholder could leak through.
 */
export function applyVariables<T extends { data: Record<string, unknown> }>(card: T, values: Readonly<Record<string, string>>): T {
    if (Object.keys(values).length === 0) {
        return card;
    }

    const fill = (value: unknown): unknown => (typeof value === 'string' ? substituteVariables(value, values) : value);

    return {
        ...card,
        data: {
            ...card.data,
            system_prompt: fill(card.data.system_prompt),
            description: fill(card.data.description),
            personality: fill(card.data.personality),
            scenario: fill(card.data.scenario),
            first_mes: fill(card.data.first_mes),
            post_history_instructions: fill(card.data.post_history_instructions),
        },
    };
}

export function substituteVariables(text: string, values: Readonly<Record<string, string>>): string {
    return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu, (whole, key: string) => (
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole
    ));
}

/** Collect every `{{key}}` a piece of text asks for. */
export function referencedVariables(text: string): string[] {
    const found = new Set<string>();

    for (const match of text.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu)) {
        found.add(match[1] as string);
    }

    return [...found];
}

/**
 * The panel, minus everything that could run.
 *
 * Not a full HTML sanitiser — it removes the two things that execute code in a
 * reader's session: `<script>`/`<style>`-free markup with no event handlers and
 * no `javascript:` URLs. Everything else (structure, classes, images, forms)
 * passes through, because the point of an author-written panel is how it looks.
 */
export function sanitizePanelHtml(html: string): string {
    return html
        // Handlers and script/style blocks.
        .replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/giu, '')
        .replace(/<\s*(script|style)\b[^>]*\/?\s*>/giu, '')
        // on*="..." / on*='...' / on*=bare
        .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, '')
        // href/src/xlink:href pointing at code
        .replace(/\s(?:href|src|xlink:href|formaction|action)\s*=\s*(["']?)\s*javascript:[^"'>\s]*\1/giu, '');
}

/** Parse and check a declaration list. Throws on anything unusable. */
export function normalizeVariables(input: unknown): CardVariable[] {
    if (!Array.isArray(input)) {
        return [];
    }

    const seen = new Set<string>();
    const out: CardVariable[] = [];

    for (const raw of input) {
        if (typeof raw !== 'object' || raw === null) {
            continue;
        }

        const record = raw as Record<string, unknown>;
        const key = typeof record.key === 'string' ? record.key.trim() : '';

        if (seen.has(key)) {
            throw new Error(`variable ${key} is declared twice`);
        }

        const label = typeof record.label === 'string' ? record.label.trim() : '';

        out.push({
            key,
            label: label === '' ? key : label,
            ...(typeof record.help === 'string' ? { help: record.help } : {}),
            ...(typeof record.default === 'string' ? { default: record.default } : {}),
            ...(record.required === true ? { required: true } : {}),
        });
        seen.add(key);
    }

    return out;
}

/** Check a key against the rules. Throws with the reason. */
export function assertVariableKey(key: string): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
        throw new Error(`variable ${key} is not a name: use letters, digits and underscore, and do not start with a digit`);
    }
    if (key.length > MAX_VARIABLE_KEY_LENGTH) {
        throw new Error(`variable ${key} is too long: at most ${MAX_VARIABLE_KEY_LENGTH} characters`);
    }
}

/**
 * Read the declarations off a card.
 *
 * `extensions` is a passthrough — what goes in comes out, unvalidated — so this
 * is where a card meets the rules. Same shape as `modCardRules`, for the same
 * reason: a card is data from anywhere and the checks live where it is read.
 */
export function cardVariables(card: { data: { extensions?: unknown } }): CardVariable[] {
    const extensions = card.data.extensions as Record<string, unknown> | undefined;
    const story = (extensions?.story ?? {}) as Record<string, unknown>;
    return normalizeVariables(story.variables);
}

/** The author's panel HTML, or '' when they wrote none. */
export function cardPanel(card: { data: { extensions?: unknown } }): string {
    const extensions = card.data.extensions as Record<string, unknown> | undefined;
    const story = (extensions?.story ?? {}) as Record<string, unknown>;
    return typeof story.panel === 'string' ? sanitizePanelHtml(story.panel) : '';
}
