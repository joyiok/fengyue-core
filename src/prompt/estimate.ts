/**
 * Token estimation.
 *
 * Deliberately an estimate: exact counts need the target model's own tokenizer,
 * which differs per provider. For budgeting a prompt window this is accurate
 * enough, and the number is reported in PromptStats so callers can see what was
 * assumed rather than guess.
 *
 * Rules of thumb used here:
 *   - CJK and other non-ASCII: roughly one token per character
 *   - ASCII: roughly one token per four characters
 *   - every message costs a few extra tokens of framing
 */
import type { PromptMessage } from './types.ts';

const ASCII_CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD_TOKENS = 4;

function isWide(codePoint: number): boolean {
    // CJK radicals and everything above, plus the common fullwidth/punctuation
    // blocks. Anything non-ASCII is counted as wide, which errs on the safe side.
    return codePoint > 0x2e7f;
}

export function estimateTokens(text: string): number {
    let wide = 0;
    let narrow = 0;

    for (const character of text) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (isWide(codePoint)) {
            wide += 1;
        } else {
            narrow += 1;
        }
    }

    return Math.ceil(wide + narrow / ASCII_CHARS_PER_TOKEN);
}

export function estimateMessagesTokens(messages: PromptMessage[]): number {
    let total = 0;

    for (const message of messages) {
        total += estimateTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
    }

    return total;
}

export { MESSAGE_OVERHEAD_TOKENS };
