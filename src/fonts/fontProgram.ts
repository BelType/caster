/**
 * `fonts/fontProgram.js` — reading a font program back out of its own bytes.
 *
 * Ported from `harness/src/export/fontProgram.ts` (E4). Guide: `docs/guide/font-embedding.md` §"What the subset contains".
 *
 * The harness's own header follows.
 *
 * Reading a font program back out of its own bytes: what a subset actually contains, in the terms a PDF font dictionary is checked against.
 *
 * Two questions need answering and neither of them is a metric fontkit will volunteer. **How many glyphs still carry an outline** — because "the subset worked" means the file holds the glyphs the document paints and empty slots for the rest, and `maxp.numGlyphs` under `RETAIN_GIDS` is the highest kept id plus one rather than a count of anything. And, for a CID-keyed CFF, **what the charset says** — because a `CIDFontType0` addresses glyphs through the charset, so `/Ordering (Identity)` with CID equal to GID is a claim about the charset and is false unless the charset is the identity.
 *
 * That second one is not hypothetical. Noto Sans JP is CID-keyed with a charset that is *not* the identity — glyph 372 is CID 628 — and `hb_subset` preserves the original CIDs, so a subset produced without asking otherwise would have a charset a PDF reader resolves to the wrong glyph.
 *
 * The readers here are deliberately small and dependency-free: they run in the browser inside the exporter and in Node inside the checker, over the same bytes, and a checker that shared a parser with the thing it checks would be testing the parser and nothing else — so the *checker* reads the program out of the PDF and this module only reads bytes, with no knowledge of PDF at all.
 *
 * @packageDocumentation
 */
import { CasterError } from '../errors.ts';

/** `glyf`, `CFF `, `CFF2`, or a bare CFF with no SFNT wrapper. */
export type OutlineTable = 'glyf'|'cff'|'cff2'|'bare-cff';

export type SfntEntry = {
  tag: string;
  offset: number;
  length: number;
};
export type ProgramStats = {
  outline: OutlineTable;
  /** `maxp.numGlyphs` for SFNT, the CharStrings count for a bare CFF. */
  numGlyphs: number;
  /** Glyph ids whose outline is not empty, ascending. */
  nonEmptyGids: number[];
  /** Set for a CFF only. */
  isCid?: boolean;
  /** `/Registry-/Ordering-Supplement` of a CID-keyed CFF. */
  ros?: string;
  /** GID to CID, index by GID; a CID-keyed CFF only. */
  charset?: number[];
  /** Whether that charset is the identity, i.e. whether CID equals GID. */
  charsetIdentity?: boolean;
};
export type CffIndex = {
  items: [number, number][];
  end: number;
};

export function sfntEntries(bytes: Uint8Array): SfntEntry[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint16(4);
    const out: SfntEntry[] = [];
    for (let i = 0; i < count; i++) {
        const at = 12 + i * 16;
        out.push({
            tag: String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]),
            offset: view.getUint32(at + 8),
            length: view.getUint32(at + 12),
        });
    }
    return out;
}
export function sfntTableBytes(bytes: Uint8Array, tag: string): Uint8Array|null {
    const entry = sfntEntries(bytes).find((e) => e.tag === tag);
    return entry ? bytes.subarray(entry.offset, entry.offset + entry.length) : null;
}
/**
 * Which outline table the program carries.
 *
 * @throws {CasterError} An SFNT with none of `glyf`, `CFF ` or `CFF2`.
 */
export function outlineTableOf(bytes: Uint8Array): OutlineTable {
    const tags = new Set(sfntEntries(bytes).map((e) => e.tag));
    if (tags.has('glyf'))
        return 'glyf';
    if (tags.has('CFF2'))
        return 'cff2';
    if (tags.has('CFF '))
        return 'cff';
    throw new CasterError(`caster: no outline table among ${[...tags].join(' ')}`);
}
/**
 * Non-empty `loca` entries: the glyphs a `glyf` subset actually kept.
 *
 * @throws {CasterError} A `glyf` font without `head`, `maxp` or `loca`.
 */
export function glyfStats(bytes: Uint8Array): ProgramStats {
    const head = sfntTableBytes(bytes, 'head');
    const maxp = sfntTableBytes(bytes, 'maxp');
    const loca = sfntTableBytes(bytes, 'loca');
    if (!head || !maxp || !loca)
        throw new CasterError('caster: a glyf font without head, maxp or loca');
    const longOffsets = new DataView(head.buffer, head.byteOffset, head.byteLength).getInt16(50) === 1;
    const numGlyphs = new DataView(maxp.buffer, maxp.byteOffset, maxp.byteLength).getUint16(4);
    const view = new DataView(loca.buffer, loca.byteOffset, loca.byteLength);
    const at = (i: number): number => (longOffsets ? view.getUint32(i * 4) : view.getUint16(i * 2) * 2);
    const nonEmptyGids: number[] = [];
    for (let gid = 0; gid < numGlyphs; gid++)
        if (at(gid + 1) > at(gid))
            nonEmptyGids.push(gid);
    return { outline: 'glyf', numGlyphs, nonEmptyGids };
}
/** A CFF INDEX: a count, an offset size, count+1 offsets, then the data. */
function readIndex(bytes: Uint8Array, at: number): CffIndex {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint16(at);
    if (count === 0)
        return { items: [], end: at + 2 };
    const offSize = bytes[at + 2];
    const offsetAt = (i: number): number => {
        let value = 0;
        for (let k = 0; k < offSize; k++)
            value = value * 256 + bytes[at + 3 + i * offSize + k];
        return value;
    };
    const dataStart = at + 3 + (count + 1) * offSize - 1;
    const items: [number,number][] = [];
    for (let i = 0; i < count; i++)
        items.push([dataStart + offsetAt(i), dataStart + offsetAt(i + 1)]);
    return { items, end: dataStart + offsetAt(count) };
}
/** A CFF DICT: operands then an operator, with two-byte operators prefixed by 12. */
function readDict(bytes: Uint8Array, start: number, end: number): Map<number,number[]> {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const dict = new Map<any, any>();
    let operands: number[] = [];
    let at = start;
    while (at < end) {
        const b0 = bytes[at];
        if (b0 <= 21) {
            let operator = b0;
            at += 1;
            if (b0 === 12) {
                operator = 1200 + bytes[at];
                at += 1;
            }
            dict.set(operator, operands);
            operands = [];
        }
        else if (b0 === 28) {
            operands.push(view.getInt16(at + 1));
            at += 3;
        }
        else if (b0 === 29) {
            operands.push(view.getInt32(at + 1));
            at += 5;
        }
        else if (b0 === 30) {
            // A real number, nibble-encoded; the terminator is nibble 15.
            let text = '';
            at += 1;
            let done = false;
            while (at < end && !done) {
                const byte = bytes[at];
                at += 1;
                for (const nibble of [byte >> 4, byte & 15]) {
                    if (nibble <= 9)
                        text += String(nibble);
                    else if (nibble === 10)
                        text += '.';
                    else if (nibble === 11)
                        text += 'E';
                    else if (nibble === 12)
                        text += 'E-';
                    else if (nibble === 14)
                        text += '-';
                    else if (nibble === 15) {
                        done = true;
                        break;
                    }
                }
            }
            operands.push(Number.parseFloat(text));
        }
        else if (b0 >= 32 && b0 <= 246) {
            operands.push(b0 - 139);
            at += 1;
        }
        else if (b0 >= 247 && b0 <= 250) {
            operands.push((b0 - 247) * 256 + bytes[at + 1] + 108);
            at += 2;
        }
        else if (b0 >= 251 && b0 <= 254) {
            operands.push(-(b0 - 251) * 256 - bytes[at + 1] - 108);
            at += 2;
        }
        else {
            at += 1;
        }
    }
    return dict;
}
/** CFF top-DICT operators this module reads, by their encoded number. */
const OP_CHARSET = 15;
const OP_CHARSTRINGS = 17;
const OP_ROS = 1230;
/**
 * A bare CFF table: how many glyphs, which have outlines, and — when it is CID-keyed — what the charset maps each glyph id to.
 *
 * @remarks
 * A CharString of one byte is `endchar` and nothing else, which is what `hb_subset` leaves behind for a glyph it dropped under `RETAIN_GIDS`; that is the CFF equivalent of an empty `loca` entry.
 *
 * @throws {CasterError} A top DICT with no CharStrings, or a charset format other than 0, 1 or 2.
 */
export function cffStats(cff: Uint8Array): ProgramStats {
    const view = new DataView(cff.buffer, cff.byteOffset, cff.byteLength);
    const headerSize = cff[2];
    const nameIndex = readIndex(cff, headerSize);
    const topIndex = readIndex(cff, nameIndex.end);
    const stringIndex = readIndex(cff, topIndex.end);
    const top = readDict(cff, topIndex.items[0][0], topIndex.items[0][1]);
    const charStringsOffset = top.get(OP_CHARSTRINGS)?.[0];
    if (charStringsOffset === undefined)
        throw new CasterError('caster: the CFF top DICT has no CharStrings');
    const charStrings = readIndex(cff, charStringsOffset);
    const numGlyphs = charStrings.items.length;
    const nonEmptyGids: number[] = charStrings.items
        .map(([from, to], gid) => (to - from > 1 ? gid : -1))
        .filter((gid) => gid >= 0);
    const ros = top.get(OP_ROS);
    const isCid = ros !== undefined;
    const strings = stringIndex.items.map(([from, to]) => String.fromCharCode(...cff.subarray(from, to)));
    const sidText = (sid: number): string => (sid >= 391 ? (strings[sid - 391] ?? `sid${sid}`) : `std${sid}`);
    const charsetOffset = top.get(OP_CHARSET)?.[0] ?? 0;
    const charset: number[] = [0];
    if (charsetOffset > 2) {
        const format = cff[charsetOffset];
        let at = charsetOffset + 1;
        if (format === 0) {
            for (let gid = 1; gid < numGlyphs; gid++) {
                charset.push(view.getUint16(at));
                at += 2;
            }
        }
        else if (format === 1 || format === 2) {
            while (charset.length < numGlyphs) {
                const first = view.getUint16(at);
                at += 2;
                const left = format === 1 ? cff[at++] : (view.getUint16(at), (at += 2), view.getUint16(at - 2));
                for (let i = 0; i <= left && charset.length < numGlyphs; i++)
                    charset.push(first + i);
            }
        }
        else {
            throw new CasterError(`caster: unknown CFF charset format ${format}`);
        }
    }
    else {
        // Offset 0, 1 or 2 is one of the predefined charsets, all of which are identity for a CID font's purposes because none of them is used by one.
        for (let gid = 1; gid < numGlyphs; gid++)
            charset.push(gid);
    }
    return {
        outline: 'cff',
        numGlyphs,
        nonEmptyGids,
        isCid,
        ...(ros ? { ros: `${sidText(ros[0])}-${sidText(ros[1])}-${ros[2]}` } : {}),
        charset,
        charsetIdentity: charset.every((cid, gid) => cid === gid),
    };
}
/**
 * Read whatever program the bytes are: an SFNT wrapper, or a bare CFF table.
 *
 * @throws {CasterError} The outline table the directory names is not there; and whatever {@link outlineTableOf}, {@link glyfStats} and {@link cffStats} refuse.
 */
export function programStats(bytes: Uint8Array): ProgramStats {
    const signature = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    const isSfnt = signature === 0x00010000 || signature === 0x4f54544f || signature === 0x74727565;
    if (!isSfnt)
        return cffStats(bytes);
    const outline = outlineTableOf(bytes);
    if (outline === 'glyf')
        return glyfStats(bytes);
    const table = sfntTableBytes(bytes, outline === 'cff' ? 'CFF ' : 'CFF2');
    if (!table)
        throw new CasterError(`caster: the ${outline} table went missing`);
    if (outline === 'cff2') {
        const maxp = sfntTableBytes(bytes, 'maxp');
        const numGlyphs = maxp ? new DataView(maxp.buffer, maxp.byteOffset, maxp.byteLength).getUint16(4) : 0;
        return { outline: 'cff2', numGlyphs, nonEmptyGids: [] };
    }
    return cffStats(table);
}
