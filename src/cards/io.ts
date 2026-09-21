/**
 * Reading and writing character cards.
 *
 * The PNG path is the important one: that is how SillyTavern and the wider card
 * ecosystem store and share characters.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
    createSolidPng,
    decodePng,
    encodePng,
    findTextChunk,
    upsertTextChunk,
    type PngChunk,
} from '../png/chunks.ts';
import { normalizeCard, toV2Json, toV3Json, type CharacterCard } from './types.ts';

/** SillyTavern checks `ccv3` first, then falls back to `chara`. */
export const CARD_CHUNK_KEYWORDS = ['ccv3', 'chara'] as const;

function decodeCardText(text: string, keyword: string): CharacterCard {
    let json: string;

    try {
        json = Buffer.from(text, 'base64').toString('utf8');
    } catch (error) {
        throw new Error(`card chunk "${keyword}" is not valid base64: ${String(error)}`);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch (error) {
        throw new Error(`card chunk "${keyword}" does not contain valid JSON: ${String(error)}`);
    }

    return normalizeCard(parsed);
}

export function cardFromPng(buffer: Buffer): CharacterCard {
    const chunks = decodePng(buffer);

    for (const keyword of CARD_CHUNK_KEYWORDS) {
        const text = findTextChunk(chunks, keyword);
        if (text !== null && text.length > 0) {
            return decodeCardText(text, keyword);
        }
    }

    throw new Error('PNG has no character data (neither a ccv3 nor a chara text chunk)');
}

export function cardFromJson(input: string | unknown): CharacterCard {
    const parsed: unknown = typeof input === 'string' ? JSON.parse(input) : input;
    return normalizeCard(parsed);
}

/**
 * Read a card from disk. `.png` goes through the PNG path, anything else is
 * treated as JSON — the same rule SillyTavern applies when importing.
 */
export async function readCardFile(filePath: string): Promise<CharacterCard> {
    const buffer = await readFile(filePath);

    if (path.extname(filePath).toLowerCase() === '.png') {
        return cardFromPng(buffer);
    }

    return cardFromJson(buffer.toString('utf8'));
}

/**
 * Write a card as PNG. Both chunks are written, matching SillyTavern's own
 * writer, so the result is readable by SillyTavern and by anything that only
 * understands V3.
 *
 * `baseImage` keeps the original avatar; without one a plain placeholder is
 * generated so the file is still a valid PNG.
 */
export function cardToPng(card: CharacterCard, baseImage?: Buffer): Buffer {
    let chunks: PngChunk[];

    if (baseImage) {
        chunks = decodePng(baseImage);
    } else {
        chunks = decodePng(createSolidPng(400, 600, [32, 36, 48]));
    }

    chunks = upsertTextChunk(chunks, 'chara', Buffer.from(toV2Json(card), 'utf8').toString('base64'));
    chunks = upsertTextChunk(chunks, 'ccv3', Buffer.from(toV3Json(card), 'utf8').toString('base64'));

    return encodePng(chunks);
}

export function cardToJson(card: CharacterCard): string {
    return toV2Json(card);
}

export interface CardSummary {
    id: string;
    name: string;
    spec: string;
    tags: string[];
    descriptionLength: number;
    firstMessageLength: number;
    hasV3Chunk: boolean;
    avatarBytes: number;
}

/** What a list endpoint needs, without shipping every card's full text. */
export function summarizeCard(id: string, card: CharacterCard, png?: Buffer): CardSummary {
    let hasV3Chunk = false;

    if (png) {
        try {
            hasV3Chunk = findTextChunk(decodePng(png), 'ccv3') !== null;
        } catch {
            hasV3Chunk = false;
        }
    }

    return {
        id,
        name: card.data.name,
        spec: card.spec,
        tags: card.data.tags ?? [],
        descriptionLength: (card.data.description ?? '').length,
        firstMessageLength: (card.data.first_mes ?? '').length,
        hasV3Chunk,
        avatarBytes: png?.length ?? 0,
    };
}
