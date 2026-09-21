/**
 * The small slice of PNG this project needs: read the chunk list, find or
 * replace `tEXt` chunks, and build a placeholder image.
 *
 * Character cards are a normal PNG plus a `tEXt` chunk whose keyword is `chara`
 * (spec V2) or `ccv3` (spec V3) and whose value is the base64 of the card JSON.
 * That is the entire format; everything else is bookkeeping.
 */
import { deflateSync, inflateSync } from 'node:zlib';

import { crc32 } from './crc32.ts';

export type PngChunk = {
    name: string;
    data: Buffer;
};

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPng(buffer: Buffer): boolean {
    return buffer.length > 8 && buffer.subarray(0, 8).equals(SIGNATURE);
}

/**
 * Split a PNG into its chunks, verifying every CRC. Throws when the file is not
 * a PNG or is corrupt, which is what you want when importing user uploads.
 */
export function decodePng(buffer: Buffer): PngChunk[] {
    if (!isPng(buffer)) {
        throw new Error('not a PNG file (bad signature)');
    }

    const chunks: PngChunk[] = [];
    let offset = SIGNATURE.length;

    while (offset + 12 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const name = buffer.toString('latin1', offset + 4, offset + 8);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;

        if (dataEnd + 4 > buffer.length) {
            throw new Error(`truncated PNG chunk: ${name}`);
        }

        const data = buffer.subarray(dataStart, dataEnd);
        const expected = buffer.readUInt32BE(dataEnd);
        const actual = crc32(buffer.subarray(offset + 4, dataEnd));

        if (expected !== actual) {
            throw new Error(`PNG chunk ${name} failed its CRC check`);
        }

        chunks.push({ name, data: Buffer.from(data) });

        if (name === 'IEND') {
            break;
        }

        offset = dataEnd + 4;
    }

    if (chunks.length === 0 || chunks[chunks.length - 1]?.name !== 'IEND') {
        throw new Error('PNG is missing its IEND chunk');
    }

    return chunks;
}

export function encodePng(chunks: PngChunk[]): Buffer {
    const parts: Buffer[] = [SIGNATURE];

    for (const chunk of chunks) {
        const name = Buffer.from(chunk.name, 'latin1');
        const header = Buffer.alloc(4);
        header.writeUInt32BE(chunk.data.length);

        const crcInput = Buffer.concat([name, chunk.data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(crcInput));

        parts.push(header, name, chunk.data, crc);
    }

    return Buffer.concat(parts);
}

/** `tEXt` payload is `keyword\0text`, both Latin-1 (base64 is ASCII). */
export function encodeTextChunk(keyword: string, text: string): Buffer {
    return Buffer.concat([
        Buffer.from(keyword, 'latin1'),
        Buffer.from([0]),
        Buffer.from(text, 'latin1'),
    ]);
}

export function decodeTextChunk(data: Buffer): { keyword: string; text: string } {
    const separator = data.indexOf(0);

    if (separator < 0) {
        throw new Error('malformed tEXt chunk: no keyword separator');
    }

    return {
        keyword: data.toString('latin1', 0, separator),
        text: data.toString('latin1', separator + 1),
    };
}

export function findTextChunk(chunks: PngChunk[], keyword: string): string | null {
    for (const chunk of chunks) {
        if (chunk.name !== 'tEXt') {
            continue;
        }

        const decoded = decodeTextChunk(chunk.data);
        if (decoded.keyword.toLowerCase() === keyword.toLowerCase()) {
            return decoded.text;
        }
    }

    return null;
}

/**
 * Replace any existing chunk with this keyword (SillyTavern removes the old ones
 * too), inserting the new one just before IEND.
 */
export function upsertTextChunk(chunks: PngChunk[], keyword: string, text: string): PngChunk[] {
    const kept = chunks.filter((chunk) => {
        if (chunk.name !== 'tEXt') {
            return true;
        }

        return decodeTextChunk(chunk.data).keyword.toLowerCase() !== keyword.toLowerCase();
    });

    const iendIndex = kept.findIndex((chunk) => chunk.name === 'IEND');
    const insertAt = iendIndex < 0 ? kept.length : iendIndex;

    kept.splice(insertAt, 0, { name: 'tEXt', data: encodeTextChunk(keyword, text) });

    return kept;
}

export function removeTextChunk(chunks: PngChunk[], keyword: string): PngChunk[] {
    return chunks.filter((chunk) => {
        if (chunk.name !== 'tEXt') {
            return true;
        }

        return decodeTextChunk(chunk.data).keyword.toLowerCase() !== keyword.toLowerCase();
    });
}

/**
 * A valid solid-colour PNG, used as the avatar when a card is created without an
 * image. Real deployments should keep the user's uploaded image instead.
 */
export function createSolidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr.writeUInt8(8, 8); // bit depth
    ihdr.writeUInt8(2, 9); // colour type: truecolour
    ihdr.writeUInt8(0, 10);
    ihdr.writeUInt8(0, 11);
    ihdr.writeUInt8(0, 12);

    const [r, g, b] = rgb;
    const stride = width * 3;
    const raw = Buffer.alloc((stride + 1) * height);

    for (let y = 0; y < height; y++) {
        const rowStart = y * (stride + 1);
        raw[rowStart] = 0; // filter type: none
        for (let x = 0; x < width; x++) {
            const pixel = rowStart + 1 + x * 3;
            raw[pixel] = r;
            raw[pixel + 1] = g;
            raw[pixel + 2] = b;
        }
    }

    return encodePng([
        { name: 'IHDR', data: ihdr },
        { name: 'IDAT', data: deflateSync(raw, { level: 9 }) },
        { name: 'IEND', data: Buffer.alloc(0) },
    ]);
}

/** Round-trip helper used by tests: inflate IDAT back into raw scanlines. */
export function decodeImageData(chunks: PngChunk[]): Buffer {
    const compressed = Buffer.concat(chunks.filter((c) => c.name === 'IDAT').map((c) => c.data));
    return inflateSync(compressed);
}
