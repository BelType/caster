/**
 * `fonts/woff.js` — WOFF to SFNT, because a `FontFace` never gives its bytes back.
 *
 * Ported from `harness/src/export/woff.ts` (E4). Guide: `docs/guide/font-embedding.md` §"WOFF and WOFF2".
 *
 * WHAT THE PORT CHANGED (P3; *BelType ships faces of its own, and WOFF2 is decoded*, DESIGN.md S46; see CHANGELOG 2026-09-14). The WOFF2 half is a capability here. `wawoff2`'s promise never settles in a browser, because the Emscripten glue exports its Module only inside the `ENVIRONMENT_IS_NODE` branch, the same shape `scripts/bundle-vendor.js` already patched around for harfbuzzjs and lcms-wasm; so the bundler appends that one assignment unconditionally and the decoder settles — 89 652 B of WOFF2 to 214 196 B of SFNT in 41 ms, measured in headless Chromium. `decodeWoff2` below is the door, behind the `woff2` capability, which loads only for a descriptor whose only source is a WOFF2. The diagnosis survives as the deadline's message, because a hang is the one failure this library has ever had.
 *
 * The harness's own header follows.
 *
 * WOFF and WOFF2 to SFNT, because a `FontFace` never gives its bytes back.
 *
 * The gateway will be handed whatever the page loads, and a page that loads a web font loads it compressed. `FontFace` has no API that returns the decoded font, and `hb_subset` and fontkit both want an SFNT, so the exporter has two options and E4 (`font-embedding.md`) measures both: either the gateway supplies the raw TTF or OTF alongside the compressed file it displays, or the exporter decodes.
 *
 * WOFF is a table-by-table zlib wrapper around an ordinary SFNT and needs no library at all: the header names the tables, each one is a zlib stream, and `DecompressionStream('deflate')` — which is the zlib wrapper, not the raw one — is in every browser this harness targets. Rebuilding the SFNT is arithmetic: sort the directory by tag, pad every table to four bytes, write the offsets. Every table's `origChecksum` from the WOFF directory is then verified against the rebuilt bytes, which is a check the format hands over for free and which proves the reconstruction rather than assuming it.
 *
 * WOFF2 is a different thing entirely — the `glyf` table is taken apart and re-derived on decode — so it goes through Google's own decoder, the Emscripten build published as `wawoff2`. Its output is *not* the raw TTF byte for byte and cannot be: the format is normalising, not lossless, at the file level. What has to be true is that the two roads produce the same font, which E4 (`font-embedding.md`) checks the only way that matters — by subsetting both and comparing glyph ids and advances.
 *
 * `wawoff2` as published **does not run in a browser** (the bundle patches it, as the paragraph above says), which the spec asked to be verified rather than assumed, and the failure is silent rather than loud: the package imports, `decompress` is a function, and calling it returns a promise that never settles. `decompress.js` waits on `onRuntimeInitialized`, and the Emscripten build only makes that reachable through `module["exports"] = Module`, which it executes inside its `ENVIRONMENT_IS_NODE` branch. Under a bundler the browser branch runs, nothing is exported, the flag is written to an empty object and the callback is never called. Every call here is therefore raced against a deadline and the diagnosis is what the rejection says, so a caller can fall back rather than hang.
 *
 * @packageDocumentation
 */

import { CasterError } from '../errors.ts';
import { capability } from '../capabilities.ts';

export type WoffTable = {
  tag: string;
  origLength: number;
  compLength: number;
  origChecksum: number;
  compressed: boolean;
};

export type DecodedWoff = {
  /** The rebuilt SFNT. */
  bytes: Uint8Array;
  ms: number;
  tables: WoffTable[];
  /** Whether every table matched the checksum the WOFF recorded — a check the format hands over for free, and which proves the reconstruction rather than assuming it. */
  checksumsOk: boolean;
};

const SIGNATURE_WOFF = 0x774f4646;
const SIGNATURE_WOFF2 = 0x774f4632;
export const isWoff = ( bytes: Uint8Array) => bytes.length > 4 && new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0) === SIGNATURE_WOFF;
export const isWoff2 = ( bytes: Uint8Array) => bytes.length > 4 && new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0) === SIGNATURE_WOFF2;
/** Inflate one zlib-wrapped table through the platform's own `DecompressionStream`. */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([((bytes as unknown) as BlobPart)]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}
/** The SFNT table checksum: the sum of the table's 32-bit words, zero-padded. */
function tableChecksum(bytes: Uint8Array, offset: number, length: number): number {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let sum = 0;
    const words = Math.floor(length / 4);
    for (let i = 0; i < words; i++)
        sum = (sum + view.getUint32(offset + i * 4)) >>> 0;
    const rest = length % 4;
    if (rest > 0) {
        let last = 0;
        for (let i = 0; i < 4; i++)
            last = (((last << 8) >>> 0) + (i < rest ? bytes[offset + words * 4 + i] : 0)) >>> 0;
        sum = (sum + last) >>> 0;
    }
    return sum >>> 0;
}
/**
 * WOFF to SFNT, by hand.
 *
 * @remarks
 * The output table order is alphabetical by tag, which is what the SFNT directory requires; the *data* order of the original file is not recoverable from a WOFF and does not need to be, since nothing in a font depends on it.
 *
 * @throws {CasterError} Bytes that do not begin with the WOFF signature, or a table that decodes to a length its own directory does not record.
 */
export async function decodeWoff(bytes: Uint8Array): Promise<DecodedWoff> {
    const started = performance.now();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0) !== SIGNATURE_WOFF)
        throw new CasterError('caster: decodeWoff was handed bytes that do not begin with the WOFF signature');
    const flavour = view.getUint32(4);
    const numTables = view.getUint16(12);
    const tables: WoffTable[] = [];
    const sources: { offset: number; compLength: number; }[] = [];
    for (let i = 0; i < numTables; i++) {
        const at = 44 + i * 20;
        tables.push({
            tag: String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]),
            origLength: view.getUint32(at + 12),
            compLength: view.getUint32(at + 8),
            origChecksum: view.getUint32(at + 16),
            compressed: view.getUint32(at + 8) < view.getUint32(at + 12),
        });
        sources.push({ offset: view.getUint32(at + 4), compLength: view.getUint32(at + 8) });
    }
    const order = tables.map((_, i) => i).sort((a, b) => (tables[a].tag < tables[b].tag ? -1 : 1));
    const data: Uint8Array[] = [];
    for (const index of order) {
        const table = tables[index];
        const raw = bytes.subarray(sources[index].offset, sources[index].offset + sources[index].compLength);
        const decoded = table.compressed ? await inflate(raw) : raw.slice();
        if (decoded.length !== table.origLength) {
            throw new CasterError(`caster: the WOFF table ${table.tag} decoded to ${decoded.length} bytes, and its own directory says ${table.origLength}`);
        }
        data.push(decoded);
    }
    const offsets: number[] = [];
    let total = 12 + numTables * 16;
    for (const table of data) {
        offsets.push(total);
        total += Math.ceil(table.length / 4) * 4;
    }
    const out = new Uint8Array(total);
    const write = new DataView(out.buffer);
    /* eslint-disable-next-line */
    write.setUint32(0, flavour);
    write.setUint16(4, numTables);
    let power = 1;
    let exponent = 0;
    while (power * 2 <= numTables) {
        power *= 2;
        exponent += 1;
    }
    write.setUint16(6, power * 16);
    write.setUint16(8, exponent);
    write.setUint16(10, numTables * 16 - power * 16);
    order.forEach((index, position) => {
        const table = tables[index];
        const at = 12 + position * 16;
        for (let k = 0; k < 4; k++)
            out[at + k] = table.tag.charCodeAt(k);
        write.setUint32(at + 4, table.origChecksum);
        write.setUint32(at + 8, offsets[position]);
        write.setUint32(at + 12, table.origLength);
        out.set(data[position], offsets[position]);
    });
    // head's directory checksum is defined over the table with checkSumAdjustment zeroed, so the field is cleared in a copy rather than the check being skipped.
    const checksumsOk = order.every((index, position) => {
        const table = tables[index];
        if (table.tag !== 'head')
            return tableChecksum(out, offsets[position], table.origLength) === table.origChecksum;
        const head = out.slice(offsets[position], offsets[position] + table.origLength);
        new DataView(head.buffer).setUint32(8, 0);
        return tableChecksum(head, 0, table.origLength) === table.origChecksum;
    });
    return { bytes: out, ms: performance.now() - started, tables: order.map((i) => tables[i]), checksumsOk };
}

/**
 * The diagnosis the port shipped as a refusal, kept because it is still the whole reason `vendor/wawoff2.js` exists and is not a plain `import('wawoff2')`.
 *
 * @remarks
 * `wawoff2` imports in a tab, `decompress` is a function, and the promise it returns never settles: the Emscripten glue runs `module["exports"]=Module` only inside its `ENVIRONMENT_IS_NODE` branch, so under a bundler the browser branch exports nothing, `decompress.js` writes `onRuntimeInitialized` onto an empty object and waits forever. `scripts/bundle-vendor.js` appends that one assignment unconditionally to the glue's own file scope, which is the entire patch. Measured after it: 89 652 B of WOFF2 to 214 196 B of SFNT in 41 ms, in headless Chromium.
 */
export const WOFF2_NEVER_SETTLED = 'wawoff2 decompress() never settled: its Emscripten build assigns module.exports only inside ' +
    'ENVIRONMENT_IS_NODE, so under a bundler the browser branch exports nothing, decompress.js sets ' +
    'onRuntimeInitialized on an empty object and the promise it awaits is never resolved';

/**
 * How long a decode is given before the diagnosis above is the answer.
 *
 * @remarks
 * The bundle is patched and measured, so this never fires in the shipped path — it is here because a hang is the one failure this library has ever had, and a printer that stops with no message is worse than one that refuses by name.
 */
const WOFF2_DEADLINE_MS = 30000;

/**
 * WOFF2 to SFNT, through Google's own decoder (*BelType ships faces of its own, and WOFF2 is decoded*, DESIGN.md S46).
 *
 * @remarks
 * The output is not the original file byte for byte and cannot be: WOFF2 takes `glyf` apart and re-derives it, so the format is normalising rather than lossless at the file level. What has to be true is that the two roads produce the same font, which E4 (`font-embedding.md`) checked the only way that matters — by subsetting both and comparing glyph ids and advances.
 *
 * @param family - Named in a refusal, as its `element`.
 * @param url - Named in a refusal.
 * @throws {CapabilityError} The `woff2` capability was not loaded.
 * @throws {CasterError} The decode did not settle within {@link WOFF2_DEADLINE_MS}, or produced nothing.
 */
export async function decodeWoff2(bytes: Uint8Array, family: string, url: string): Promise<Uint8Array> {
    const known = decodedWoff2.get(bytes);
    if (known)
        return known;
    const { decompress } = capability('woff2');
    const deadline = new Promise<any>((_, reject) => setTimeout(() => reject(new CasterError(`caster: decoding the WOFF2 for ${JSON.stringify(family)} at ${url} did not finish in ${WOFF2_DEADLINE_MS} ms — ${WOFF2_NEVER_SETTLED}`, { element: family })), WOFF2_DEADLINE_MS));
    const decoded = await Promise.race([decompress(bytes), deadline]);
    if (!decoded || !((decoded as any).length)) throw new CasterError(`caster: the WOFF2 for ${JSON.stringify(family)} at ${url} decoded to nothing`, { element: family });
    const sfnt = new Uint8Array((decoded as ArrayLike<number>));
    decodedWoff2.set(bytes, sfnt);
    return sfnt;
}
/** A decode is a function of its bytes, and the font table keeps a kept face's bytes between prints (`host/fonts.ts`). */
const decodedWoff2: WeakMap<Uint8Array,Uint8Array> = new WeakMap();
