/**
 * `fonts/hbSubset.js` — `hb_subset` through the raw WASM exports of harfbuzzjs' subset build.
 *
 * Ported from `harness/src/export/hbSubset.ts` (E4). Guide: `docs/guide/font-embedding.md` §"Subsetting".
 *
 * WHAT THE PORT CHANGED (P2). Vite's `'…harfbuzz-subset.wasm?url'` import is gone: the bytes arrive from `capability('hbSubset')`, which the registry fetched from `vendor/harfbuzz-subset.wasm` (measured: 622 493 bytes, zero imports, exporting `hb_subset_or_fail`; *the subset wasm is not glue-bound*, DESIGN.md S4). `loadSubsetter()` still takes an explicit `bytes` for a caller that has them already.
 *
 * The harness's own header follows.
 *
 * `hb_subset` through the raw WASM exports of harfbuzzjs' subset build.
 *
 * harfbuzzjs 1.6.1 ships `dist/harfbuzz-subset.wasm` and binds nothing to it — `src/shaping/hb-shaper.ts` answers `exposesSubset()` with `false` and E1 (`shaping.md`) recorded it — so the binding is written here against the 39 raw exports the module declares. There is no Emscripten glue and no imports at all: the module is a reactor, `_initialize()` is called once, and every pointer is an offset into its own `memory`.
 *
 * Two things about that surface shape the code. `hb_blob_create`'s memory mode 0 is HB_MEMORY_MODE_DUPLICATE, so the font bytes are copied into the WASM heap and the JS copy can go away immediately. And the module exports no `hb_version_string` and no `hb_face_get_glyph_count`, so the HarfBuzz version is the one the shaping build reports — the same package, the same release — and glyph counts are read out of the produced bytes rather than asked for.
 *
 * Everything the subsetter is asked to do is expressed as flags plus a glyph set plus pinned axes. Nothing here decides which flags to use; that is `fontEmbed.ts`, which is also the only caller.
 *
 * @packageDocumentation
 */
import { capability } from '../capabilities.ts';
import { CasterError } from '../errors.ts';

export type SubsetExports = {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  malloc: (size: number) => number;
  free: (pointer: number) => void;
  hb_blob_create: (data: number, length: number, mode: number, userData: number, destroy: number) => number;
  hb_blob_destroy: (blob: number) => void;
  hb_blob_get_data: (blob: number, lengthOut: number) => number;
  hb_blob_get_length: (blob: number) => number;
  hb_face_create: (blob: number, index: number) => number;
  hb_face_destroy: (face: number) => void;
  hb_face_reference_blob: (face: number) => number;
  hb_set_add: (set: number, value: number) => void;
  hb_subset_input_create_or_fail: () => number;
  hb_subset_input_destroy: (input: number) => void;
  hb_subset_input_glyph_set: (input: number) => number;
  hb_subset_input_keep_everything: (input: number) => void;
  hb_subset_input_set_flags: (input: number, flags: number) => void;
  hb_subset_input_pin_axis_location: (input: number, face: number, tag: number, value: number) => number;
  hb_subset_or_fail: (face: number, input: number) => number;
};
export type SubsetRequest = {
  /** SFNT bytes. WOFF and WOFF2 are decoded before they get here. */
  bytes: Uint8Array;
  /** Glyph ids to keep. `.notdef` is added by the subsetter, never by the caller. */
  gids: number[];
  /** Axis coordinates to pin, e.g. `{ wght: 650, opsz: 14 }`. */
  pins?: Record<string, number>;
  flags?: number;
  /** Keep every glyph rather than the set: how a variable face is instanced. */
  keepEverything?: boolean;
  /** Named in the error message when the subsetter refuses. */
  label?: string;
};
export type SubsetResult = {
  bytes: Uint8Array;
  /** `maxp.numGlyphs` of the output. With RETAIN_GIDS this is the highest kept id plus one. */
  numGlyphs: number;
  /** Table tags of the output, in directory order, so the caller can see `glyf` vs `CFF ` vs `CFF2`. */
  tables: string[];
};

import { sfntEntries, sfntTableBytes } from './fontProgram.ts';
/** `hb_subset_flags_t`, from `hb-subset.h`. Only the ones the harness named. */
export const SUBSET_FLAGS = {
    DEFAULT: 0x0000,
    NO_HINTING: 0x0001,
    RETAIN_GIDS: 0x0002,
    DESUBROUTINIZE: 0x0004,
    NAME_LEGACY: 0x0008,
    SET_OVERLAPS_FLAG: 0x0010,
    PASSTHROUGH_UNRECOGNIZED: 0x0020,
    NOTDEF_OUTLINE: 0x0040,
    GLYPH_NAMES: 0x0080,
    NO_PRUNE_UNICODE_RANGES: 0x0100,
    NO_LAYOUT_CLOSURE: 0x0200,
    OPTIMIZE_IUP_DELTAS: 0x0400,
    NO_BIDI_CLOSURE: 0x0800,
    /** Since HarfBuzz 13.0.0: a fully pinned CFF2 comes out as CFF1. */
    DOWNGRADE_CFF2: 0x4000,
    /** Since HarfBuzz 14.3.0: a CID-keyed CFF's output charset becomes CID = GID. */
    CFF_IDENTITY_CHARSET: 0x8000,
};
/** The default E4 (`font-embedding.md`) uses everywhere: drop hinting, keep the shaper's glyph ids. */
export const DEFAULT_SUBSET_FLAGS = SUBSET_FLAGS.NO_HINTING | SUBSET_FLAGS.RETAIN_GIDS;
let exports: SubsetExports|null = null;
let wasmBytes = 0;
/**
 * `(a<<24)|(b<<16)|(c<<8)|d`, which is what `hb_tag_t` is.
 *
 * @throws {CasterError} A tag that is not four characters long.
 */
export function hbTag(tag: string): number {
    if (tag.length !== 4)
        throw new CasterError(`caster: ${JSON.stringify(tag)} is not a four-character tag`);
    return ((tag.charCodeAt(0) << 24) | (tag.charCodeAt(1) << 16) | (tag.charCodeAt(2) << 8) | tag.charCodeAt(3)) >>> 0;
}
/**
 * Instantiate the subset module once.
 *
 * @remarks
 * `bytes` is for a caller that already has the file — the node side, which has no registry to fetch through. The browser passes nothing and the bytes are the ones the registry fetched from `vendor/harfbuzz-subset.wasm` (`capability('hbSubset')`; *the subset wasm is not glue-bound*, DESIGN.md S4).
 *
 * @throws {CapabilityError} No `bytes` given and `hbSubset` was not loaded.
 */
export async function loadSubsetter(bytes?: Uint8Array): Promise<void> {
    if (exports)
        return;
    // The registry fetched the wasm; a caller with its own bytes (a node-side checker) may hand them over instead.
    const source = bytes ?? capability('hbSubset');
    const module = await WebAssembly.compile(((source as unknown) as BufferSource));
    const instance = await WebAssembly.instantiate(module, {});
    const loaded = ((instance.exports as unknown) as SubsetExports);
    loaded._initialize?.();
    wasmBytes = source.length;
    exports = loaded;
}
/** Size of the subset module, for the table that sets it beside the WOFF2 decoder. */
export function subsetterBytes(): number {
    return wasmBytes;
}
/**
 * The instantiated module's exports.
 *
 * @throws {CasterError} `loadSubsetter()` has not been awaited.
 */
function api(): SubsetExports {
    if (!exports)
        throw new CasterError('caster: loadSubsetter() has not been awaited');
    return exports;
}
/** A view of the heap, re-read every time: memory grows and the buffer is replaced. */
const heap = (): Uint8Array => new Uint8Array(api().memory.buffer);
/**
 * `maxp.numGlyphs`, read out of the bytes because the module exports no getter.
 *
 * @throws {CasterError} The font has no `maxp` table.
 */
export function numGlyphsOf(bytes: Uint8Array): number {
    const maxp = sfntTableBytes(bytes, 'maxp');
    if (!maxp)
        throw new CasterError('caster: the font has no maxp table');
    return new DataView(maxp.buffer, maxp.byteOffset, maxp.byteLength).getUint16(4);
}
/**
 * Subset — or, with `keepEverything`, instance — one face.
 *
 * @remarks
 * Every allocation is released before the function returns, including on the error paths, because the module's heap is the only one it has and a document embeds one instance per `(face, coordinates)` pair.
 *
 * @throws {CasterError} The subsetter was not loaded; any HarfBuzz call that answers null, naming it and the request's `label`; an axis pin HarfBuzz refuses; an empty output.
 */
export function subsetFace(request: SubsetRequest): SubsetResult {
    const hb = api();
    const label = request.label ?? 'face';
    const flags = request.flags ?? DEFAULT_SUBSET_FLAGS;
    const source = hb.malloc(request.bytes.length);
    if (!source)
        throw new CasterError(`caster: malloc(${request.bytes.length}) failed for ${label}`);
    heap().set(request.bytes, source);
    let blob = 0;
    let face = 0;
    let input = 0;
    let output = 0;
    let outputBlob = 0;
    let lengthOut = 0;
    try {
        blob = hb.hb_blob_create(source, request.bytes.length, 0, 0, 0);
        if (!blob)
            throw new CasterError(`caster: hb_blob_create failed for ${label}`);
        face = hb.hb_face_create(blob, 0);
        if (!face)
            throw new CasterError(`caster: hb_face_create failed for ${label}`);
        input = hb.hb_subset_input_create_or_fail();
        if (!input)
            throw new CasterError(`caster: hb_subset_input_create_or_fail failed for ${label}`);
        if (request.keepEverything) {
            hb.hb_subset_input_keep_everything(input);
        }
        else {
            const set = hb.hb_subset_input_glyph_set(input);
            if (!set)
                throw new CasterError(`caster: hb_subset_input_glyph_set returned null for ${label}`);
            // .notdef is always kept: PDF/UA-2 forbids painting it but a font whose glyph zero is missing is not a font.
            hb.hb_set_add(set, 0);
            for (const gid of request.gids)
                hb.hb_set_add(set, gid);
        }
        hb.hb_subset_input_set_flags(input, flags);
        for (const [tag, value] of Object.entries(request.pins ?? {})) {
            if (!hb.hb_subset_input_pin_axis_location(input, face, hbTag(tag), value)) {
                throw new CasterError(`caster: pinning ${tag}=${value} failed for ${label}`);
            }
        }
        output = hb.hb_subset_or_fail(face, input);
        if (!output) {
            throw new CasterError(`caster: hb_subset_or_fail returned null for ${label} with flags 0x${flags.toString(16)}, ` +
                `${request.gids.length} glyph(s) and pins ${JSON.stringify(request.pins ?? {})}`);
        }
        outputBlob = hb.hb_face_reference_blob(output);
        if (!outputBlob)
            throw new CasterError(`caster: hb_face_reference_blob returned null for ${label}`);
        lengthOut = hb.malloc(4);
        const data = hb.hb_blob_get_data(outputBlob, lengthOut);
        const length = new DataView(hb.memory.buffer).getUint32(lengthOut, true);
        if (!data || length === 0)
            throw new CasterError(`caster: the subset of ${label} is empty`);
        const bytes = heap().slice(data, data + length);
        return { bytes, numGlyphs: numGlyphsOf(bytes), tables: sfntEntries(bytes).map((t) => t.tag) };
    }
    finally {
        if (lengthOut)
            hb.free(lengthOut);
        if (outputBlob)
            hb.hb_blob_destroy(outputBlob);
        if (output)
            hb.hb_face_destroy(output);
        if (input)
            hb.hb_subset_input_destroy(input);
        if (face)
            hb.hb_face_destroy(face);
        if (blob)
            hb.hb_blob_destroy(blob);
        hb.free(source);
    }
}
