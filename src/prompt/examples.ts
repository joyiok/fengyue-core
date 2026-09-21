/**
 * Parsing of a card's `mes_example` field into real chat turns.
 *
 * Convention in the card ecosystem: examples are separated by `<START>`, and each
 * line starts with `{{user}}:` or `{{char}}:`. Cards in the wild are sloppy about
 * it, so unprefixed lines are treated as a continuation of the previous speaker,
 * and a block with no prefixes at all becomes a single character example.
 */
import type { PromptMessage } from './types.ts';

export interface ExampleNames {
    char: string;
    user: string;
}

const USER_PREFIX = /^\s*\{\{\s*user\s*\}\}\s*:\s*/i;
const CHAR_PREFIX = /^\s*\{\{\s*char\s*\}\}\s*:\s*/i;

export function substituteNames(text: string, names: ExampleNames): string {
    return text
        .replace(/\{\{\s*char\s*\}\}/gi, names.char)
        .replace(/\{\{\s*user\s*\}\}/gi, names.user);
}

export function parseExampleMessages(raw: string, names: ExampleNames): PromptMessage[] {
    if (raw.trim() === '') {
        return [];
    }

    const messages: PromptMessage[] = [];

    for (const block of raw.split(/<START>/i)) {
        const lines = block
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line !== '');

        if (lines.length === 0) {
            continue;
        }

        const blockMessages: PromptMessage[] = [];
        let currentRole: 'user' | 'assistant' | null = null;
        let currentLines: string[] = [];

        const flush = (): void => {
            if (currentRole !== null && currentLines.length > 0) {
                blockMessages.push({
                    role: currentRole,
                    content: substituteNames(currentLines.join('\n'), names),
                });
            }
            currentLines = [];
        };

        for (const line of lines) {
            let role: 'user' | 'assistant' | null = null;
            let content = line;

            if (USER_PREFIX.test(line)) {
                role = 'user';
                content = line.replace(USER_PREFIX, '');
            } else if (CHAR_PREFIX.test(line)) {
                role = 'assistant';
                content = line.replace(CHAR_PREFIX, '');
            }

            if (role === null) {
                // Continuation of whoever spoke last.
                currentLines.push(line);
                continue;
            }

            if (role !== currentRole) {
                flush();
                currentRole = role;
            }

            currentLines.push(content);
        }

        flush();

        if (blockMessages.length === 0) {
            messages.push({ role: 'assistant', content: substituteNames(lines.join('\n'), names) });
        } else {
            messages.push(...blockMessages);
        }
    }

    return messages;
}
