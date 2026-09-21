/**
 * CRC-32 (IEEE 802.3), as required by the PNG chunk format.
 *
 * Implemented here rather than pulled from a package: the whole point of this
 * layer is to have no dependencies that can drift, and this is 15 lines.
 */
const TABLE: Uint32Array = (() => {
    const table = new Uint32Array(256);

    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }

    return table;
})();

export function crc32(data: Uint8Array): number {
    let crc = 0xffffffff;

    for (let i = 0; i < data.length; i++) {
        const byte = data[i] ?? 0;
        crc = (TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
    }

    return (crc ^ 0xffffffff) >>> 0;
}
