/**
 * `fonts/fontEmbed.js` — the font layer: one embedded, subsetted, instanced program per `(face, coordinates)` pair, with the PDF dictionaries written by hand.
 *
 * Ported from `harness/src/export/fontEmbed.ts` (E3, E4, E5). Guide: `docs/guide/font-embedding.md`.
 *
 * WHAT THE PORT CHANGED (P2; *fontkit's browser bundle has no default export*, S1). `create` from fontkit and the three pdf-lib objects are capability handles rather than static imports; fontkit's browser build has no default export and `create` is read off the namespace.
 *
 * The harness's own header follows.
 *
 * The font layer: one embedded, subsetted, instanced program per `(face, coordinates)` pair, with the PDF dictionaries written by hand.
 *
 * E3 (`text-emission.md`) wrote `Type0` / `Identity-H` / `CIDFontType2` for TrueType and embedded the whole file. This generalises that in four directions and in no others. **Outlines**: `glyf` still goes to `CIDFontType2` with `FontFile2`, and CFF — plain, CID-keyed, or downgraded from CFF2 — goes to `CIDFontType0` with `FontFile3`. **Subsetting**: `hb_subset` with `RETAIN_GIDS`, so the shaper's glyph ids stay the CIDs, `/CIDToGIDMap` stays `/Identity`, and the emitter's `TJ` hex strings mean the same thing before and after. **Instancing**: a variable face is pinned to the coordinate the browser painted at *before* any metric is read, so the `/W` array is the instance's `hmtx` and not the default master's. **Precision**: `/W` carries as many decimals as the caller asks for, and the emitter's pen is tracked on the written value either way.
 *
 * The one-pass shape is what keeps instancing cheap, and honest by a check. Layout takes its advances from fontkit's instance of the source (`hmtx` plus `HVAR`); nothing is pinned until `finish()`, where a single `hb_subset` call pins the axes and cuts the used glyphs together (DESIGN.md S98). The cut program's own `hmtx` is then read back for every used glyph and compared with the advance layout used, so the numbers written into the file and the numbers in the file's program cannot drift apart unnoticed — which the node checker asserts as well.
 *
 * PDF 2.0 accepts no variable font. `fvar`, `gvar`, `CFF2` and `HVAR` are ignored by viewers, so a `CFF2` that survived pinning is not a smaller problem than a wrong width: it is a file that renders as nothing. It is an error here, named as one.
 *
 * Two roundings of one fractional advance may sit one font unit apart (fontkit's, HarfBuzz's), and `/W` takes fontkit's; a difference of more than one unit is refused, naming the face and the glyph. Pinning a **CFF2** face in HarfBuzz 14.4.0 instances the charstrings and drops `HVAR` **without baking its advance deltas into `hmtx`**, so such a face is expected to be refused by that check; no CFF2 variable face has been available to test it (CHANGELOG 0.1.4). A PDF reader advances by `/W` and is required to ignore the widths in the font program (ISO 32000-2 9.7.4.3), so the refusal is the check being strict, not the file being wrong.
 *
 * @packageDocumentation
 */
import { capability } from '../capabilities.ts';
import { CasterError } from '../errors.ts';

/* P2: the heavy libraries are never static imports — a module has to evaluate in node, with no bundle present, for its pure half to stay testable, and `capability()` refuses by name rather than falling back. */
const fontkit = () => capability('fontkit');
const create = ( bytes: Uint8Array) => fontkit().create(bytes);
const pdf = () => capability('pdf');

import type { Coords } from './axisMap.ts';
import type { OutlineTable, ProgramStats } from './fontProgram.ts';
/** Which outline table the embedded program carries. `glyf` goes to `CIDFontType2` with `FontFile2`; every flavour of CFF goes to `CIDFontType0` with `FontFile3`; `cff2` is an error, because PDF 2.0 accepts no variable font and a CFF2 that survived pinning renders as nothing. */
export type OutlineType = 'glyf'|'cff'|'cff-cid'|'cff2';

export type FontProfile = {
  /** Whether to embed only the glyphs the document shows. */
  subset: boolean;
  /** Decimals in the /W array. The emitter's pen follows the written value. */
  widthDecimals: number;
  /** Whether CFF goes in bare as /CIDFontType0C or wrapped as /OpenType. */
  cffContainer: 'bare'|'opentype';
  /** Whether /DW is the most common width rather than the 1000 default. */
  dwFromMode: boolean;
};
export type FontEmbedSpec = {
  /** The instance key: one embedded program per `(face, coordinates)` pair. */
  id: string;
  /** The face descriptor id the instance came from. */
  faceId: string;
  /** The CSS family, for the report. */
  family: string;
  /** SFNT bytes. WOFF and WOFF2 are decoded before they reach here. */
  bytes: Uint8Array;
  /** What the page loaded, which is not always what is embedded. */
  sourceFormat: 'ttf'|'otf'|'woff'|'woff2';
  /** Axis coordinates to pin. Empty for a static face. */
  coords: Coords;
  profile: FontProfile;
  /** CID to text, built from the whole document by `toUnicode.js`. Without it the map is the first text each glyph was used for, which is the rule of `text-emission.md` (E3). */
  toUnicodeText?: Map<number, string>;
  /** Every string each CID stood for, most frequent first, for the report. */
  cidToText?: Record<number, string[]>;
  /** CIDs the document paints for more than one string; recorded, not used. */
  ambiguousCids?: number[];
  /** Handed the bytes that were embedded, once `finish()` has cut them. The instance check loads exactly those bytes back into the shaper, so what is re-measured is the program in the file rather than a second one built the same way. */
  onProgram?: (bytes: Uint8Array) => void;
};
export type CidFont = {
  /** The instance key; also the key a page's /Resources /Font is built on. */
  id: string;
  /** The Type0 font object. */
  ref: PDFRef;
  postScriptName: string;
  upem: number;
  /** The advance of one glyph, in font units, as the embedded program's own `hmtx` carries it. */
  advance: (gid: number) => number;
  /** The same as the `/W` array will write it, in PDF glyph units, at the profile's decimals — which is what the emitter's pen has to be tracked on. */
  width: (gid: number) => number;
  /** Record that the content stream shows this glyph for this text. */
  use: (gid: number, text: string) => void;
  /** Cut the subset, write every dictionary, and report. */
  finish: () => CidFontStats;
};
export type CidFontStats = {
  id: string;
  postScriptName: string;
  /** Glyphs the content stream actually shows. */
  usedGlyphs: number;
  /** Bytes of the embedded font program, uncompressed. */
  fontFileBytes: number;
  /** Glyphs whose ToUnicode destination is more than one character. */
  multiCharToUnicode: number;
  /** Glyphs a second, different text was recorded for under the first-seen rule. */
  toUnicodeConflicts: number;
  faceId: string;
  family: string;
  sourceFormat: 'ttf'|'otf'|'woff'|'woff2';
  outlineType: OutlineType;
  /** Units per em of the embedded program; what `/W` is scaled from. */
  upem: number;
  coords: Coords;
  /** The glyph ids shown, ascending. They are the CIDs. */
  glyphsUsed: number[];
  /** Bytes of the source face as the exporter received it. */
  sourceBytes: number;
  /** Bytes of the embedded program before Flate. Equals `fontFileBytes`. */
  subsetBytes: number;
  /** Bytes of the stream in the file, i.e. after Flate. */
  subsetFlateBytes: number;
  /** `maxp.numGlyphs` (or the CharStrings count) of the embedded program. */
  numGlyphs: number;
  /** Glyph ids in the embedded program that still carry an outline. */
  nonEmptyGlyphs: number;
  /** The six-letter /BaseFont prefix; empty when the whole file is embedded. */
  subsetTag: string;
  cffContainer: 'bare'|'opentype';
  /** Which cluster strings each shown CID stood for, most frequent first. */
  cidToText: Record<number, string[]>;
  ambiguousCids: number[];
  /** Table tags of the embedded program, in directory order. */
  tables: string[];
  /** Whether the embedded program's `hmtx` is the instance's. False for a CFF2 face pinned by HarfBuzz 14.4.0, whose `hmtx` stays at the default master. Always true for a static face, which has only one set of advances. */
  hmtxInstanced: boolean;
  /** Glyphs whose `/W` had to come from the reference instance rather than `hmtx`. */
  staleAdvances: number;
  /** Whether a CID-keyed CFF's charset maps every kept glyph id to itself. */
  charsetIdentity: boolean|null;
  /** Whether CFF_IDENTITY_CHARSET had to be asked for to make that true. */
  charsetRetried: boolean;
  /** OS/2 fsType as the face declares it; policy, not enforced here. */
  fsType: string;
  path: 'B';
  /** What this instance cost the emit stage, by step (*the fonts stage, measured*, DESIGN.md S87). */
  ms: EmbedTiming;
};
export type EmbedTiming = {
  /** Pinning a variable face with `hb_subset`; `0` for a static face. */
  instance: number;
  /** fontkit over the instance, and over the source again for the reference advances when pinned. */
  parse: number;
  /** `hb_subset` to the glyphs shown, the identity-charset retry included. */
  subset: number;
  /** The program's checks, its dictionaries, and Flate over the program and the `ToUnicode` CMap. */
  write: number;
};

import { coordsKey } from './axisMap.ts';
import { cffStats, outlineTableOf, programStats, sfntEntries, sfntTableBytes } from './fontProgram.ts';
import { DEFAULT_SUBSET_FLAGS, SUBSET_FLAGS, subsetFace } from './hbSubset.ts';
import type { SubsetRequest } from './hbSubset.ts';
/** Glyph-space units per em in a PDF font dictionary. */
const PDF_GLYPH_UNITS = 1000;
/** FontDescriptor /Flags bits, by their PDF 32000-2 names. */
const FLAG_SERIF = 1 << 1;
const FLAG_SYMBOLIC = 1 << 2;
const FLAG_ITALIC = 1 << 6;
/** The one descriptor number no font table carries and PDF has no way to omit. 80 is the conventional value for an upright text weight; nothing in Caster reads it back and no viewer uses it for anything but a fallback substitute font, which a file with the program embedded never needs. */
const STEM_V = 80;
/** The profile of E3 (`text-emission.md`) and E5 (`structure-tree.md`): whole file, integer widths, nothing else changed. */
export const WHOLE_FONT_PROFILE: FontProfile = {
    subset: false,
    widthDecimals: 0,
    cffContainer: 'bare',
    dwFromMode: false,
};
/** The profile of E4 (`font-embedding.md`): subset, three-decimal widths, bare CFF. */
export const SUBSET_FONT_PROFILE: FontProfile = {
    subset: true,
    widthDecimals: 3,
    cffContainer: 'bare',
    dwFromMode: true,
};
const gidHex = (gid: number): string => gid.toString(16).padStart(4, '0').toUpperCase();
/** UTF-16BE hex, which is what a bfchar destination is. */
function utf16beHex(text: string): string {
    let out = '';
    for (let i = 0; i < text.length; i++)
        out += text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
    return out;
}
/**
 * The six-letter subset tag.
 *
 * @remarks
 * PDF 32000-2 9.9.2 wants six uppercase letters and requires only that two subsets of one font in one file differ. It is derived from the face, the coordinates and the glyph set rather than from a counter, so two runs over the same document produce the same file and a diff of two files is a diff of what changed.
 */
export function subsetTagFor(faceId: string, coords: Coords, gids: number[]): string {
    const source = `${faceId}|${coordsKey(coords)}|${gids.join(',')}`;
    // FNV-1a over 64 bits as two 32-bit halves; six letters need 28 bits and the mixing matters more than the width.
    let hi = 0x811c9dc5;
    let lo = 0x01000193;
    for (let i = 0; i < source.length; i++) {
        hi = Math.imul(hi ^ source.charCodeAt(i), 0x01000193) >>> 0;
        lo = Math.imul(lo + source.charCodeAt(i) * (i + 1), 0x85ebca6b) >>> 0;
    }
    let value = (hi ^ lo) >>> 0;
    let tag = '';
    for (let i = 0; i < 6; i++) {
        tag += String.fromCharCode(65 + (value % 26));
        value = Math.floor(value / 26) + (i === 2 ? hi % 26 : 0);
    }
    return tag;
}
/** A PDF name may not carry a space or a delimiter; a PostScript name should not either. */
const cleanName = (name: string): string => name.replace(/[\s()<>[\]{}/%#]/g, '');
/**
 * The subsetter request that pins a variable face to its instance, or `null` for a static face.
 *
 * @remarks
 * A CFF2 face has to come back as CFF1 or it is unusable: no viewer reads CFF2 out of a PDF. HarfBuzz does the conversion only when asked, and only when every axis is pinned, which is exactly the case here. Used at `finish()` for the profile that embeds the face whole, and for the empty-glyph check.
 */
export function instanceRequest(spec: Pick<FontEmbedSpec, 'id' | 'bytes' | 'coords'>): SubsetRequest | null {
    if (Object.keys(spec.coords).length === 0)
        return null;
    const flags = DEFAULT_SUBSET_FLAGS | (outlineTableOf(spec.bytes) === 'cff2' ? SUBSET_FLAGS.DOWNGRADE_CFF2 : 0);
    return { bytes: spec.bytes, gids: [], pins: spec.coords, flags, keepEverything: true, label: `${spec.id} (instancing)` };
}
/**
 * Embed one instance of one face.
 *
 * @remarks
 * Nothing is written until `finish()`: the `/W` array and the `ToUnicode` CMap can only be built once every page has been emitted, and the subset can only be cut once the glyph set is closed. The instancing waits for it too; the widths the emitter asks for while it lays out the pages are fontkit's instance of the source.
 *
 * @throws {CasterError} From `finish()`: a face that still carries a CFF2 table after pinning, a glyph whose `hmtx` in the cut program is more than one font unit from the advance layout used, a CID-keyed CFF whose charset cannot be made the identity even with `CFF_IDENTITY_CHARSET`, a CFF2 program, or a glyph the face draws and the subset left with no outline (*a face's own empty glyph was read as a dropped one*, DESIGN.md S45).
 */
export function embedFace(context: PDFContext, spec: FontEmbedSpec): CidFont {
    const { profile } = spec;
    const pinned = Object.keys(spec.coords).length > 0;
    const clock = () => performance.now();
    const ms3 = ( n: number) => Math.round(n * 1000) / 1000;
    const started = clock();
    // The layout widths are fontkit's own instance of the source (hmtx plus HVAR); the program is pinned once, at finish(), over the used glyphs only, and its hmtx is then checked against these widths.
    const font: FontkitFont = pinned ? create(spec.bytes).getVariation(spec.coords) : create(spec.bytes);
    const upem = font.unitsPerEm;
    const scale = PDF_GLYPH_UNITS / upem;
    const instanceMs = 0;
    const parseMs = ms3(clock() - started);
    const staleAdvances = 0;
    const fontRef = context.nextRef();
    const cidFontRef = context.nextRef();
    const descriptorRef = context.nextRef();
    const fontFileRef = context.nextRef();
    const toUnicodeRef = context.nextRef();
    const used = new Set<any>();
    const firstSeen = new Map<any, any>();
    let conflicts = 0;
    const roundWidth = (n: number): number => {
        const factor = 10 ** profile.widthDecimals;
        return Math.round(n * factor) / factor;
    };
    const advanceCache = new Map<any, any>();
    const advance = (gid: number): number => {
        const hit = advanceCache.get(gid);
        if (hit !== undefined)
            return hit;
        // The instance's advance is fractional where an HVAR delta interpolates; HarfBuzz and Blink both work in whole font units at this scale, so it is rounded to the number they use.
        const own = font.getGlyph(gid).advanceWidth;
        const value = pinned ? Math.round(own) : own;
        advanceCache.set(gid, value);
        return value;
    };
    const width = (gid: number): number => roundWidth(advance(gid) * scale);
    const use = (gid: number, text: string) => {
        used.add(gid);
        const seen = firstSeen.get(gid);
        if (seen === undefined)
            firstSeen.set(gid, text);
        else if (seen !== text)
            conflicts += 1;
    };
    const finish = (): CidFontStats => {
        const gids = [...used].sort((a, b) => a - b);
        const textOf = (gid: number): string => spec.toUnicodeText?.get(gid) ?? firstSeen.get(gid) ?? '';
        const pinFlags = pinned && outlineTableOf(spec.bytes) === 'cff2' ? SUBSET_FLAGS.DOWNGRADE_CFF2 : 0;
        const pins = pinned ? { pins: spec.coords } : {};
        // The whole instance, which only the profile that embeds the face whole and the empty-glyph check below need.
        const wholeInstance = (): Uint8Array => pinned ? subsetFace(instanceRequest(spec)!).bytes : spec.bytes;
        let programBytes = spec.bytes;
        let charsetRetried = false;
        let finishStarted = clock();
        if (profile.subset) {
            const label = `${spec.id} (${gids.length} glyphs)`;
            let result = subsetFace({ bytes: spec.bytes, gids, ...pins, flags: DEFAULT_SUBSET_FLAGS | pinFlags, label });
            // A CIDFontType0 addresses glyphs through the CFF charset, and /Ordering (Identity) with CID = GID is a claim about that charset. Noto Sans JP's is not the identity and hb_subset preserves the original CIDs, so the claim has to be made true rather than asserted.
            if (!charsetIsIdentity(result.bytes)) {
                result = subsetFace({
                    bytes: spec.bytes,
                    gids,
                    ...pins,
                    flags: DEFAULT_SUBSET_FLAGS | pinFlags | SUBSET_FLAGS.CFF_IDENTITY_CHARSET,
                    label: `${label} with CFF_IDENTITY_CHARSET`,
                });
                charsetRetried = true;
                if (!charsetIsIdentity(result.bytes)) {
                    throw new CasterError(`caster: ${spec.id} is a CID-keyed CFF whose charset is not the identity even with ` +
                        'CFF_IDENTITY_CHARSET, so CID cannot equal GID and Identity ordering would be a lie');
                }
            }
            programBytes = result.bytes;
        }
        else if (pinned) {
            programBytes = wholeInstance();
        }
        if (outlineTableOf(programBytes) === 'cff2') {
            throw new CasterError(`caster: ${spec.id} still carries a CFF2 table after pinning ${JSON.stringify(spec.coords)}; ` +
                'PDF 2.0 has no CFF2 font program and a viewer would render nothing');
        }
        // The widths layout used against the widths the file's own program carries. They are two roundings of one fractional advance (fontkit's from hmtx plus HVAR, HarfBuzz's from the instanced outline), so they may sit one font unit apart; anything further means the program is not the instance layout measured, which is what a CFF2 face pinned by HarfBuzz 14.4.0 does (its hmtx stays at the default master).
        const carried = hmtxAdvances(programBytes);
        for (const gid of gids) {
            const wanted = advance(gid);
            const have = carried(gid);
            if (Math.abs(have - wanted) > 1) {
                throw new CasterError(`caster: ${spec.id} glyph ${gid}: layout used an advance of ${wanted} but the embedded program's hmtx carries ${have}` +
                    (pinned ? ` after pinning ${JSON.stringify(spec.coords)}` : ''));
            }
        }
        const subsetMs = ms3(clock() - finishStarted);
        finishStarted = clock();
        const stats: ProgramStats = programStats(programBytes);
        const outlineType: OutlineType = stats.outline === 'glyf' ? 'glyf' : stats.outline === 'cff2' ? 'cff2' : stats.isCid ? 'cff-cid' : 'cff';
        if (outlineType === 'cff2') {
            throw new CasterError(`caster: ${spec.id} produced a CFF2 program, which no PDF viewer reads`);
        }
        // A glyph with no outline that carries text is the subsetter having dropped something the shaper chose — unless the face never drew it in the first place, which is M10 and is a real and ordinary thing for a face to do (*a face's own empty glyph was read as a dropped one*, DESIGN.md S45). JetBrains Mono builds `->`, `=>`, `!=` and `<=` by substituting every character but the last for one deliberately empty glyph, so the monospace advance is kept while the last character's glyph draws the whole ligature backwards over them; measured on `fixtures/specimen/fonts/JetBrainsMono-Regular.ttf`, gid 1751 is that spacer and its `loca` entry is zero bytes long in the file. The subset kept exactly what it was given, and the check was reading the font's own design as its own failure. So the question is asked of the difference rather than of the output: a glyph the program handed to the subsetter could draw, and the subset cannot, is the defect this guards against.
        let missing = gids.filter((gid) => !stats.nonEmptyGids.includes(gid) && textOf(gid).trim() !== '');
        if (missing.length > 0) {
            const before = new Set(programStats(wholeInstance()).nonEmptyGids);
            missing = missing.filter((gid) => before.has(gid));
        }
        if (missing.length > 0) {
            throw new CasterError(`caster: ${spec.id} shows glyph(s) ${missing.join(',')} that the subset left with no outline, and the face itself draws them`);
        }
        const subsetTag = profile.subset ? subsetTagFor(spec.faceId, spec.coords, gids) : '';
        const baseName = cleanName(font.postscriptName);
        const psName = subsetTag === '' ? baseName : `${subsetTag}+${baseName}`;
        context.assign(fontRef, context.obj({
            Type: 'Font',
            Subtype: 'Type0',
            BaseFont: pdf().PDFName.of(psName),
            Encoding: 'Identity-H',
            DescendantFonts: [cidFontRef],
            ToUnicode: toUnicodeRef,
        }));
        const isTrueType = outlineType === 'glyf';
        context.assign(cidFontRef, context.obj({
            Type: 'Font',
            Subtype: isTrueType ? 'CIDFontType2' : 'CIDFontType0',
            BaseFont: pdf().PDFName.of(psName),
            CIDSystemInfo: {
                Registry: pdf().PDFString.of('Adobe'),
                Ordering: pdf().PDFString.of('Identity'),
                Supplement: 0,
            },
            FontDescriptor: descriptorRef,
            DW: profile.dwFromMode ? mostCommonWidth(gids, width) : PDF_GLYPH_UNITS,
            W: widthArray(gids, width),
            // /CIDToGIDMap is a CIDFontType2 entry only; a CIDFontType0 has no such key at all and writing one would be a syntax error, not a redundancy.
            ...(isTrueType ? { CIDToGIDMap: 'Identity' } : {}),
        }));
        // The box is the instance's own, which only the pinned program knows: the source's head belongs to the default master.
        const bbox = pinned ? create(programBytes).bbox : font.bbox;
        const os2 = font['OS/2'];
        const italic = font.italicAngle !== 0 || os2?.fsSelection.italic === true;
        // sFamilyClass's high byte is the IBM family class: 1-7 are the serif classes, 8 is sans-serif, 0 is "no classification". Every face the harness measured declared 0, so the bit stays off rather than being asserted from a family name.
        const familyClass = os2 ? os2.sFamilyClass >> 8 : 0;
        const serif = familyClass >= 1 && familyClass <= 7;
        const useTypo = os2?.fsSelection.useTypoMetrics === true;
        const ascent = useTypo && os2 ? os2.typoAscender : font.hhea.ascent;
        const descent = useTypo && os2 ? os2.typoDescender : font.hhea.descent;
        const capHeight = os2?.capHeight && os2.capHeight > 0 ? os2.capHeight : capHeightFromH(font);
        context.assign(descriptorRef, context.obj({
            Type: 'FontDescriptor',
            FontName: pdf().PDFName.of(psName),
            Flags: FLAG_SYMBOLIC | (serif ? FLAG_SERIF : 0) | (italic ? FLAG_ITALIC : 0),
            FontBBox: [
                Math.round(bbox.minX * scale),
                Math.round(bbox.minY * scale),
                Math.round(bbox.maxX * scale),
                Math.round(bbox.maxY * scale),
            ],
            ItalicAngle: font.italicAngle,
            Ascent: Math.round(ascent * scale),
            Descent: Math.round(descent * scale),
            CapHeight: Math.round(capHeight * scale),
            StemV: STEM_V,
            ...(outlineType === 'glyf' ? { FontFile2: fontFileRef } : { FontFile3: fontFileRef }),
        }));
        // What actually goes in the stream. TrueType is the file; CFF is either the bare table, which is what /CIDFontType0C means, or the whole SFNT, which is what /OpenType means. /Length1 is the uncompressed TrueType length and belongs to FontFile2 alone.
        const streamBytes = outlineType === 'glyf' || profile.cffContainer === 'opentype'
            ? programBytes
            : (sfntTableBytes(programBytes, 'CFF ') ?? programBytes);
        const streamDict = outlineType === 'glyf'
            ? { Length1: streamBytes.length }
            : { Subtype: pdf().PDFName.of(profile.cffContainer === 'opentype' ? 'OpenType' : 'CIDFontType0C') };
        const stream = context.flateStream(streamBytes, streamDict);
        context.assign(fontFileRef, stream);
        context.assign(toUnicodeRef, context.flateStream(toUnicodeCMap(gids, textOf)));
        spec.onProgram?.(programBytes);
        const cidToText: Record<number,string[]> = {};
        for (const gid of gids)
            cidToText[gid] = spec.cidToText?.[gid] ?? [textOf(gid)];
        return {
            id: spec.id,
            postScriptName: font.postscriptName,
            usedGlyphs: gids.length,
            fontFileBytes: streamBytes.length,
            multiCharToUnicode: gids.filter((gid) => textOf(gid).length > 1).length,
            toUnicodeConflicts: conflicts,
            faceId: spec.faceId,
            family: spec.family,
            sourceFormat: spec.sourceFormat,
            outlineType,
            upem,
            coords: spec.coords,
            glyphsUsed: gids,
            sourceBytes: spec.bytes.length,
            subsetBytes: streamBytes.length,
            subsetFlateBytes: stream.getContents().length,
            numGlyphs: stats.numGlyphs,
            nonEmptyGlyphs: stats.nonEmptyGids.length,
            hmtxInstanced: staleAdvances === 0,
            staleAdvances,
            subsetTag,
            cffContainer: outlineType === 'glyf' ? 'bare' : profile.cffContainer,
            cidToText,
            ambiguousCids: spec.ambiguousCids ?? [],
            tables: outlineType === 'glyf' || profile.cffContainer === 'opentype' ? sfntEntries(programBytes).map((e) => e.tag) : ['CFF '],
            charsetIdentity: stats.isCid ? (stats.charsetIdentity ?? null) : null,
            charsetRetried,
            fsType: os2 ? fsTypeText(os2.fsType) : 'no OS/2 table',
            path: 'B',
            ms: { instance: instanceMs, parse: parseMs, subset: subsetMs, write: ms3(clock() - finishStarted) },
        };
    };
    return { id: spec.id, ref: fontRef, postScriptName: font.postscriptName, upem, advance, width, use, finish };
}
/**
 * The advance of a glyph as the program's own `hmtx` carries it, in font units.
 *
 * @throws {CasterError} The program has no `hmtx` or `hhea` table.
 */
function hmtxAdvances(bytes: Uint8Array): (gid: number) => number {
    const hhea = sfntTableBytes(bytes, 'hhea');
    const hmtx = sfntTableBytes(bytes, 'hmtx');
    if (!hhea || !hmtx)
        throw new CasterError('caster: the embedded program has no hhea/hmtx table to check the layout widths against');
    const count = new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength).getUint16(34);
    const view = new DataView(hmtx.buffer, hmtx.byteOffset, hmtx.byteLength);
    return (gid) => view.getUint16(Math.min(gid, count - 1) * 4);
}
/** True unless the program is a CID-keyed CFF whose charset renumbers glyphs. */
function charsetIsIdentity(bytes: Uint8Array): boolean {
    if (outlineTableOf(bytes) !== 'cff')
        return true;
    const table = sfntTableBytes(bytes, 'CFF ');
    if (!table)
        return true;
    const stats = cffStats(table);
    return !stats.isCid || stats.charsetIdentity === true;
}
/** `/CapHeight` when OS/2 does not carry it: the top of `H`, which is what it means. */
function capHeightFromH(font: FontkitFont): number {
    try {
        return font.glyphForCodePoint(0x48).bbox.maxY;
    }
    catch {
        return font.capHeight;
    }
}
/**
 * The width that repeats most; `/DW` covers every CID the `/W` array does not.
 *
 * @remarks
 * A subset's widths often tie — thirty-three glyphs of a text face produce a four-way tie at two occurrences each — so the tie-break is stated rather than left to iteration order: the widest of the equally common values wins, because `/DW` is only ever consulted for a CID the file does not describe and a default that is too narrow overlaps glyphs while one that is too wide only spaces them out.
 */
function mostCommonWidth(gids: number[], width: (gid: number) => number) {
    if (gids.length === 0)
        return PDF_GLYPH_UNITS;
    const counts = new Map<any, any>();
    for (const gid of gids) {
        const value = width(gid);
        counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    let best = PDF_GLYPH_UNITS;
    let bestCount = -1;
    for (const [value, count] of [...counts].sort(([a], [b]) => b - a)) {
        if (count > bestCount) {
            best = value;
            bestCount = count;
        }
    }
    return best;
}
/** fsType as a sentence, for the report. The gateway's policy question, not enforced. */
function fsTypeText(fsType: Record<string,boolean>): string {
    const set = Object.entries(fsType)
        .filter(([, value]) => value === true)
        .map(([name]) => name);
    return set.length === 0 ? 'installable' : set.join('+');
}
/** `/W` in its run form: `[ firstGid [w w w] firstGid [w] … ]`. Consecutive glyph ids share one run, which is what makes the array short for text that uses a contiguous slice of a font. */
export function widthArray(gids: number[], width: (gid: number) => number) {
    const out: (number|number[])[] = [];
    let run: number[] = [];
    let runStart = -1;
    for (const gid of gids) {
        if (runStart >= 0 && gid === runStart + run.length) {
            run.push(width(gid));
            continue;
        }
        if (runStart >= 0)
            out.push(runStart, run);
        runStart = gid;
        run = [width(gid)];
    }
    if (runStart >= 0)
        out.push(runStart, run);
    return out;
}
/** bfchar blocks cap at 100 entries each, per the CMap specification. */
const BFCHAR_BLOCK = 100;
/** The ToUnicode CMap: one `bfchar` entry per shown glyph that stands for text, in blocks of at most {@link BFCHAR_BLOCK}. */
export function toUnicodeCMap(gids: number[], textOf: (gid: number) => string) {
    const entries = gids
        .filter((gid) => textOf(gid).length > 0)
        .map((gid) => `<${gidHex(gid)}> <${utf16beHex(textOf(gid))}>`);
    const blocks: string[] = [];
    for (let i = 0; i < entries.length; i += BFCHAR_BLOCK) {
        const block = entries.slice(i, i + BFCHAR_BLOCK);
        blocks.push(`${block.length} beginbfchar\n${block.join('\n')}\nendbfchar`);
    }
    return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo <</Registry (Adobe) /Ordering (UCS) /Supplement 0>> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${blocks.join('\n')}
endcmap
CMapName currentdict /CMap defineresource pop
end
end
`;
}
/** The two-byte-per-glyph hex string an Identity-H `TJ` shows. */
export function glyphString(gids: number[]): PDFHexString {
    return pdf().PDFHexString.of(gids.map(gidHex).join(''));
}
