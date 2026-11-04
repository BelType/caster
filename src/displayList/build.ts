/**
 * `displayList/build.js` — the measurement and the walk, decided into a {@link DisplayList}: what goes on which page, in which order, under which marked content.
 *
 * Caster's own. This is the half of the old `emitStructure` that decides and writes no PDF: the interleaving of paragraphs, paints, images and vectors by paint order and DOM order, each page's units and their reading rank, the page's ground, the groups and their marked content, the marks, the Figure boxes, the heading positions and the page labels (stage 1 of `.claude/plans/the-display-list/executors.md`; the writer lost them in stage 2). Version 2 (`.claude/plans/the-display-list/plan-v2.md`) adds the unit conversions the writer used to make (`xToPt`, `yToPt`, the chain's `cm`, a rectangle's four edges, a link's rectangles, a cluster's box), and the bytes: fonts, images, facsimiles and pixels are hashed into `resources.blobs`.
 *
 * @remarks
 * A vector `node` is still the collectors' own record, copied to plain values with every DOM element dropped (see `displayList.js`). {@link plain} is the copy, and it refuses what it cannot carry rather than skip it, naming where the object sits. Everything else the builder makes is written as the list's types have it, field by field.
 *
 * @packageDocumentation
 */

import { CasterError } from '../errors.ts';
import { bboxOf } from '../vectors/cssBoxes.ts';
import { apply } from '../coordinates/matrix.ts';
import { ownsContent } from '../walk/structure.ts';
import { resolveStructure } from './structure.ts';
import { toPdfMatrix } from '../coordinates/ctm.ts';
import { outlineTableOf } from '../fonts/fontProgram.ts';
import { rgbaOf } from '../images/samples.ts';
import { spaceGlyph } from '../measure/textMeasure.ts';
import { checkGaps } from './validate.ts';
import { glyphAdvance } from '../fonts/hbShaper.ts';
import { shaperVariations } from '../fonts/axisMap.ts';
import { pageGeometryFor, xToPt, yToPt } from '../coordinates/pageGeometry.ts';
import { pageLabelRuns } from '../emit/pageLabels.ts';
import { scopeNameOf } from '../walk/tableHeaders.ts';
import { PX_TO_PT, round3 } from '../coordinates/units.ts';

import type { ContentStart, ColourWriting, DisplayList, DocumentInfo, FontWidths, Writing, Item, Page, OutlineEntry, Resources, TextItem, TextOrigin, Fill, LinkItem, RectItem, VectorItem, VectorOrigin, Painting, Paint, Stroke, FormDefinition, ImageSource, PhotoEvidence, RasterSource } from '../displayList.ts';
import type { MeasuredLine, MeasuredPaint, MeasuredImage, MeasuredEmoji, MeasuredRun, MeasureResult } from '../measure/textMeasure.ts';
import type { MeasuredVector, PaintSpec, RasterSpec, VectorNode } from '../vectors/vector.ts';
import type { DecodedSamples } from '../images/samples.ts';
import type { LoadedFacsimile } from '../images/facsimile.ts';
import type { PreparedImage } from '../images/imagePass.ts';
import type { PhotoDecision } from '../images/photoRule.ts';
import type { WalkResult, WalkTable, StructureNode, WalkAnnot } from '../walk/structure.ts';
import type { BoxPt } from '../coordinates/pageGeometry.ts';
import type { ContentRef, LinkRef } from './structure.ts';
import type { ReportTable, ReportCollapsedEdge } from '../report.ts';
import type { TableCell } from '../walk/tableModel.ts';
import type { PageMarks } from '../coordinates/printMarks.ts';

/** What the builder is told beyond the measurement and the walk: the slice of `emitStructure`'s options that decides rather than writes. */
export type BuildInputs = {
  title: string;
  /** The list's `info.created`, an ISO 8601 instant in UTC. */
  created: string;
  /** The document's own URL, which a relative link `href` resolves against into the link's `target.uri`. Absent, a relative `href` is kept as written. */
  baseUri?: string;
  /** The list's `writing`, with the colour story's profiles as bytes, which the builder hashes into `blobs`. */
  writing: Omit<Writing, 'colour'> & { colour?: Omit<ColourWriting, 'profiles'> & { profileBytes: Uint8Array, srgbBytes: Uint8Array } };
  /** The list's `info.conformance`: `tagged` under `standard: 'none'` or once a guess withdrew the claim (S90, S103), as `print()` decided it for the report. */
  conformance: DocumentInfo['conformance'];
  /** `css` is the order a browser paints in; under `dom` the paint index is not consulted at all. */
  paintOrder?: 'dom' | 'css';
  /** The `@page` ground each page paints, already resolved. */
  pageBackgrounds?: { page: number, rgb: [number, number, number] }[];
  /** The crop and registration marks each page carries, already placed. */
  printMarks?: { pages: PageMarks[] };
  /** Whether the document asked for `/Outlines`. */
  outline?: boolean;
  /** One `--pdf-page-label` declaration per page, verbatim. An empty array writes no `/PageLabels`. */
  pageLabels?: string[];
  /** The raster fallbacks the print drew, in the order it drew them; an index into this is the key. */
  rasterSpecs?: RasterSpec[];
  /** The pixels of each colour cluster, keyed by the cluster. */
  emojiRasters?: ReadonlyMap<MeasuredEmoji, DecodedSamples>;
  /** The pixels each raster fallback was drawn at. */
  rasterSamples?: ReadonlyMap<RasterSpec, DecodedSamples>;
  /** The photo rule's decision on each raster fallback's pixels, which the image pass made. */
  rasterPhotos?: ReadonlyMap<RasterSpec, PhotoDecision>;
  fonts: BuildFonts;
  images: BuildImages;
};

/** Where the font programs are, and what the report calls them. */
export type BuildFonts = {
  /** Every used instance's font program, by the URL the measurement names. */
  bytesByUrl: Map<string, Uint8Array>;
  /** The CSS family an instance belongs to. */
  familyOf: (instanceKey: string) => string;
  /** What the page loaded; where it says nothing the outline table does. */
  sourceFormatOf: (url: string) => 'ttf' | 'otf' | 'woff' | 'woff2' | undefined;
};

/** Where the image files, as the image pass prepared them, and the facsimiles are. */
export type BuildImages = {
  preparedOf: (src: string) => PreparedImage | undefined;
  facsimileOf: (src: string) => LoadedFacsimile | undefined;
};

/**
 * How many reading-order ranks one page is given before the next page's begin.
 *
 * @remarks
 * A page holds one rank per unit — a run, a colour cluster, a rectangle, an image, a vector — and a million of them on one A4 page is not a document. Page-major is what makes an element that straddles a cut begin on the earlier page, which is the page a destination to it names. The same constant as `emit/structureEmit.js`'s.
 */
const READING_RANKS_PER_PAGE = 1e6;

/** One thing to interleave, before it becomes a unit: the DOM index and the paint index are what the two orders sort on. */
export type Interleaved = { domIndex: number, paintIndex?: number, block?: number, paint?: MeasuredPaint, image?: MeasuredImage, vector?: MeasuredVector };

/** One thing a page paints, tagged by what it is, before it becomes an item. */
export type Unit = { domRank: number } & ({ kind: 'run', owner: string, line: MeasuredLine, lineIndex: number, runInLine: number }
  | { kind: 'emoji', owner: string, line: MeasuredLine, lineIndex: number, emoji: MeasuredEmoji }
  | { kind: 'paint', owner: string, paint: MeasuredPaint }
  | { kind: 'image', owner: string, image: MeasuredImage }
  | { kind: 'vector', owner: string, vector: MeasuredVector });

/** One content item: consecutive units on one page with one owner, written as one marked-content sequence. */
export type Group = {
  owner: string;
  /** The group's place in reading order across the whole document: page-major, then the DOM rank of the item the group came from, then the group's own position within that item. It is deliberately not the emission counter, because under `paintOrder: 'css'` the emission order is the painting order and a float's ink is emitted before in-flow text it follows in the document. */
  seq: number;
  units: Unit[];
};

/**
 * A deep copy of a measured record as plain data: arrays and plain objects, finite numbers, strings and booleans.
 *
 * @remarks
 * A key whose value is undefined or NaN is left out (`JSON.stringify` would write the NaN as null, and the list would no longer equal its own text), and a key called `element` holding a DOM node is left out because the list holds no DOM object. Anything else it cannot carry — a `Map`, a typed array, a function, a non-finite number — is refused with the path to it, because a list that quietly dropped it would be a list the writer could not be held to. An object met twice is copied once, so a line shared by the items of its runs stays one object.
 *
 * @throws {CasterError} A value the list cannot carry.
 */
function plain(value: unknown, memo: Map<object,unknown>, where: string): any {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw new CasterError(`caster: the display list cannot carry ${value} at ${where}`);
        return value;
    }
    if (typeof value !== 'object')
        throw new CasterError(`caster: the display list cannot carry a ${typeof value} at ${where}`);
    const held = memo.get(value);
    if (held !== undefined)
        return held;
    if (Array.isArray(value)) {
        const copy: any[] = [];
        memo.set(value, copy);
        value.forEach((entry, i) => {
            if (entry === undefined)
                throw new CasterError(`caster: the display list cannot carry an undefined at ${where}[${i}]`);
            copy.push(plain(entry, memo, `${where}[${i}]`));
        });
        return copy;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        throw new CasterError(`caster: the display list cannot carry a ${prototype?.constructor?.name ?? 'foreign object'} at ${where}`);
    const copy: Record<string,unknown> = {};
    memo.set(value, copy);
    for (const [key, entry] of Object.entries(value)) {
        // A NaN is left out as an undefined is: with the probes off (the default) `baselineProbePx` and its kin are NaN on every segment, and nothing in the file reads them.
        if (entry === undefined || (typeof entry === 'number' && Number.isNaN(entry)))
            continue;
        if (key === 'element' && typeof entry === 'object' && entry !== null && Object.getPrototypeOf(entry) !== Object.prototype && !Array.isArray(entry))
            continue;
        copy[key] = plain(entry, memo, `${where}.${key}`);
    }
    return copy;
}

/** The run's ink box on its page, `[x y w h]` in points: the colour report's record of where a run sits. */
function runRect(run: MeasuredRun, page: number): [number,number,number,number] {
    const x0 = xToPt(Math.min(...run.segments.map((s) => s.xPx)), page);
    const x1 = xToPt(Math.max(...run.segments.map((s) => s.rightPx)), page);
    const top = Math.max(...run.segments.map((s) => yToPt(s.topPx, page)));
    const baseline = Math.min(...run.segments.map((s) => yToPt(s.baselineAscentPx, page)));
    const descender = 0.2 * run.sizePx * PX_TO_PT;
    return [x0, baseline - descender, x1 - x0, top - baseline + descender];
}

/** What a run or a measured rectangle is painted with. */
function fillOf(source: { rgb: [number,number,number]; colorHint?: MeasuredRun['colorHint']; overprint?: MeasuredRun['overprint']; }): Fill {
    const hint = source.colorHint;
    let ink: Fill['ink'];
    if (hint?.kind === 'cmyk')
        ink = { cmyk: [...hint.values] };
    else if (hint)
        ink = { spot: hint.kind === 'spot' ? hint.name : hint.kind === 'all' ? 'All' : 'None', alternate: [...hint.alternate], tint: hint.tint };
    return { rgb: [...source.rgb], ...(ink ? { ink } : {}), ...(source.overprint ? { overprint: source.overprint } : {}) };
}

/** A measured rectangle as a shape: its four edges in points, by the expressions the writer used. */
function paintItem(paint: MeasuredPaint): RectItem {
    const x = xToPt(paint.xPx, paint.page);
    const top = yToPt(paint.yPx, paint.page);
    const bottom = yToPt(paint.yPx + paint.hPx, paint.page);
    const width = round3(paint.wPx * PX_TO_PT);
    const height = round3(top - bottom);
    return {
        kind: 'shape',
        owner: paint.path,
        rect: [x, bottom, width, height],
        fill: fillOf(paint),
        paint: { path: paint.path, target: paint.target ?? 'fill', page: paint.page, ...(paint.hint ? { hint: paint.hint } : {}), color: paint.color ?? '' },
    };
}

/**
 * Where one colour cluster's raster goes, in points.
 *
 * @remarks
 * x and width are the browser's own Range rect for the cluster, converted at exactly 0.75 pt/px like every other measurement; the vertical is the colour face's ascent above the baseline and its descent below it, which is the box the canvas drew into. Nothing is measured twice. Untested: the `emoji` option is dormant in `print()`.
 */
function emojiBox(cluster: MeasuredEmoji): { cm: [number,number,number,number,number,number]; rectPt: [number,number,number,number]; } {
    const x = xToPt(cluster.xPx, cluster.page);
    const widthPt = round3((cluster.rightPx - cluster.xPx) * PX_TO_PT);
    const top = yToPt(cluster.baselinePx - cluster.ascentPx, cluster.page);
    const bottom = yToPt(cluster.baselinePx + cluster.descentPx, cluster.page);
    const heightPt = round3(top - bottom);
    return { cm: [widthPt, 0, 0, heightPt, x, bottom], rectPt: [x, bottom, widthPt, heightPt] };
}

/** The run's characters, glyphs and segments as the item holds them. */
export function textColumns(run: MeasuredRun, leadingSpace: boolean, page: number): { text: string; glyphs: TextItem['glyphs']; segments: TextItem['segments']; } {
    let text = leadingSpace ? ' ' : '';
    const glyphs: TextItem['glyphs'] = { ids: [], advances: [], clusters: [] };
    const segments: TextItem['segments'] = { firstGlyph: [], start: [], x: [], spaceBefore: [] };
    run.segments.forEach((segment, index) => {
        if (index > 0 && segment.spaceBefore)
            text += ' ';
        const start = text.length;
        text += segment.text;
        segments.firstGlyph.push(glyphs.ids.length);
        segments.start.push(start);
        segments.x.push(xToPt(segment.xPx, page));
        segments.spaceBefore.push(segment.spaceBefore);
        segment.gids.forEach((gid, j) => {
            glyphs.ids.push(gid);
            glyphs.advances.push(segment.advanceUnits[j]);
            glyphs.clusters.push(segment.clusters[j] + start);
        });
    });
    return { text, glyphs, segments };
}

/** One run of one line, as a text item: every length the writer's pen is aimed with converted to points by the expressions the writer used, and the segments' glyphs flattened into structs of arrays. */
function textItem(line: MeasuredLine, runInLine: number, owner: string, lineIndex: number, page: number): { item: TextItem; origin: TextOrigin; } {
    const run = line.runs[runInLine];
    const leadingSpace = runInLine > 0 && run.segments[0].spaceBefore;
    const { text, glyphs, segments } = textColumns(run, leadingSpace, page);
    return {
        item: {
            kind: 'text',
            owner,
            lineIndex,
            font: run.instanceKey,
            size: run.sizePx * PX_TO_PT,
            letterSpacing: run.letterSpacingPx * PX_TO_PT,
            fill: fillOf(run),
            baseline: yToPt(line.baselinePx, page),
            ...(line.chain ? { transform: toPdfMatrix(line.chain, pageGeometryFor(page)) } : {}),
            ...(line.clips ? { clips: line.clips.map((clip, i) => ({ path: plain(clip.path, new Map(), `line ${lineIndex} clip ${i}`), rule: clip.evenOdd ? 'evenodd' as const : 'nonzero' as const })) } : {}),
            text,
            leadingSpace,
            space: spaceGlyph(run.url, run.features, run.coords).gid,
            glyphs,
            segments,
        },
        origin: {
            run: run.index,
            paragraph: line.paragraph,
            path: run.segments[0].blockPath,
            color: run.color,
            ...(run.hint ? { hint: run.hint } : {}),
            rectPt: runRect(run, page),
        },
    };
}

/**
 * The SHA-256 of some bytes, in hex.
 *
 * @remarks
 * `crypto.subtle` where the page has it, which is a secure context only (`http://localhost` and `https:` have it, `http://caster.test` does not); {@link sha256Bytes} where it has not. The two agree, and a test says so.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = globalThis.crypto?.subtle
        ? new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', (bytes as BufferSource)))
        : sha256Bytes(bytes);
    return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

const K = Uint32Array.from('428a2f98 71374491 b5c0fbcf e9b5dba5 3956c25b 59f111f1 923f82a4 ab1c5ed5 d807aa98 12835b01 243185be 550c7dc3 72be5d74 80deb1fe 9bdc06a7 c19bf174 e49b69c1 efbe4786 0fc19dc6 240ca1cc 2de92c6f 4a7484aa 5cb0a9dc 76f988da 983e5152 a831c66d b00327c8 bf597fc7 c6e00bf3 d5a79147 06ca6351 14292967 27b70a85 2e1b2138 4d2c6dfc 53380d13 650a7354 766a0abb 81c2c92e 92722c85 a2bfe8a1 a81a664b c24b8b70 c76c51a3 d192e819 d6990624 f40e3585 106aa070 19a4c116 1e376c08 2748774c 34b0bcb5 391c0cb3 4ed8aa4a 5b9cca4f 682e6ff3 748f82ee 78a5636f 84c87814 8cc70208 90befffa a4506ceb bef9a3f7 c67178f2'.split(' '), (h) => parseInt(h, 16));

/** FIPS 180-4 SHA-256, for a page with no `crypto.subtle`. */
export function sha256Bytes(bytes: Uint8Array): Uint8Array {
    const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000));
    view.setUint32(padded.length - 4, (bytes.length << 3) >>> 0);
    const h = Uint32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19);
    const w = new Uint32Array(64);
    const rotr = ( x: number,  n: number) => (x >>> n) | (x << (32 - n));
    for (let block = 0; block < padded.length; block += 64) {
        for (let t = 0; t < 16; t++)
            w[t] = view.getUint32(block + t * 4);
        for (let t = 16; t < 64; t++) {
            const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
            const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
            w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
        }
        let [a, b, c, d, e, f, g, i] = h;
        for (let t = 0; t < 64; t++) {
            const t1 = (i + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) | 0;
            const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
            i = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += i;
    }
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    h.forEach((word, n) => outView.setUint32(n * 4, word));
    return out;
}

/**
 * An instance's widths, asked of HarfBuzz with the font the words were shaped with, at the instance's coordinates: the call the writer used to make.
 *
 * @param gids - The glyphs to ask for; none for an instance no text is set in.
 */
function widthsOf(url: string, coords: Record<string,number>, gids: Set<number> = new Set()): FontWidths {
    const variations = shaperVariations(coords);
    const sorted = [...gids].sort((a, b) => a - b);
    return { gids: sorted, units: sorted.map((gid) => glyphAdvance(url, gid, variations)) };
}

/**
 * An `href` as an absolute, ASCII, percent-encoded URI — what §12.6.4.8's `/URI` entry is.
 *
 * @remarks
 * The URL parser resolves the `href` and percent-encodes what it must (a space, a non-ASCII letter in the path, the query or the fragment), and `encodeURI` then encodes what the parser leaves raw and RFC 3986 does not allow (`|`, `^`, a bare `%`). A triplet already percent-encoded, by the parser or by the author, is not encoded again, so every character arrives in one encoding: `a path` and `a%20path` both become `a%20path` (until 2026-11-02 the `%` of the parser's `%20` was encoded a second time, `a%2520path`; see CHANGELOG 0.1.5). `encodeURI` rather than `encodeURIComponent`, because the reserved characters that structure a URL have to survive. A value the URL parser cannot resolve is left as the author wrote it, because a link the printer cannot understand is still a link the author meant.
 *
 * @param base - The document's own URL; absent, a relative `href` is left as written.
 */
export function absoluteUri(href: string, base?: string): string {
    try {
        return encodeURI(new URL(href, base).href).replace(/%25([0-9A-Fa-f]{2})/gu, '%$1');
    } catch {
        return href;
    }
}

/**
 * One link annotation as an item: its rectangles and its destination in page points, by the expressions the writer used, and for a link that leaves the file the URI its action carries. Its elements are filled in by `buildDisplayList` once the tree is resolved.
 *
 * @param baseUri - The document's own URL, which a relative `href` resolves against.
 */
function linkItem(annot: WalkAnnot, order: number, baseUri?: string): LinkItem {
    return {
        kind: 'link',
        // The element and the destination's element are the resolver's, filled in once the tree is resolved.
        element: -1,
        order,
        rects: annot.rects.map((r) => [xToPt(r.xPx, r.page), yToPt(r.yPx, r.page), xToPt(r.xPx + r.wPx, r.page), yToPt(r.yPx + r.hPx, r.page)]),
        target: {
            href: annot.href,
            kind: annot.kind,
            ...(annot.targetId ? { targetId: annot.targetId } : {}),
            ...(annot.dest ? { dest: { page: annot.dest.page, x: xToPt(annot.dest.xPx, annot.dest.page), y: yToPt(annot.dest.yPx, annot.dest.page), element: -1, struct: annot.dest.structPath } } : { uri: absoluteUri(annot.href, baseUri) }),
        },
        contents: annot.contents,
    };
}

/** What the vector items are converted under: the forms table they fill, the copier that keeps the list plain, and the raster fallbacks' keys. */
export type VectorContext = {
  forms: Record<string, FormDefinition>;
  copy: (value: unknown, where: string) => any;
  rasterKey: Map<RasterSpec, number>;
};

/**
 * A flat paint of the collectors' as the list's.
 *
 * @returns Undefined for no paint at all.
 */
function paintOf(paint: PaintSpec, context: VectorContext, where: string): Paint|undefined {
    if (paint.kind === 'none')
        return undefined;
    if (paint.kind === 'rgb')
        return { rgb: [...paint.rgb] };
    if (paint.kind === 'cmyk')
        return { cmyk: [...paint.values] };
    return { gradient: { ...context.copy(paint.shading, where), type: paint.shading.type === 2 ? 'axial' : 'radial' } };
}

/**
 * One node of the collectors' tree as an item of the list, and everything under it.
 *
 * @remarks
 * The collectors keep their own vocabulary and this is the one place it becomes the schema's (`plan.md`), so no second vocabulary is in the list: `cm` is `transform`, `clips` carry a `rule`, `children` and a mask's `content` are `items`, a form's content is in `resources.forms` once, a path's `strokeStyle` and its stroke paint are one `stroke`. What only the report reads (labels, reasons) is in `origin`. A name that is absent means the default: no opacity below one, no blend but `Normal`, no clips.
 *
 * @throws {CasterError} A raster fallback the print never drew; two forms of one name that differ in size.
 */
function vectorItem(node: VectorNode, context: VectorContext): VectorItem {
    const where = `vector ${node.domPath}#${node.label}`;
    const { copy } = context;
    const origin: VectorOrigin = { domPath: node.domPath, label: node.label };
    const painting: Painting = { origin };
    if (node.cm)
        painting.transform = copy(node.cm, `${where} chain`);
    if (node.clips.length > 0) {
        painting.clips = node.clips.map((clip, i) => ({ path: copy(clip.path, `${where} clip ${i}`), rule: clip.evenOdd ? 'evenodd' : 'nonzero' }));
        origin.clipReasons = node.clips.map((clip) => clip.reason);
    }
    if (node.opacity < 1)
        painting.opacity = node.opacity;
    if (node.strokeOpacity < 1)
        painting.strokeOpacity = node.strokeOpacity;
    if (node.blend !== 'Normal')
        painting.blend = node.blend;
    if (node.softMask) {
        painting.softMask = {
            type: node.softMask.type === 'Alpha' ? 'alpha' : 'luminosity',
            items: node.softMask.content.map((child) => vectorItem(child, context)),
            bbox: [...node.softMask.bboxPt],
            ...(node.softMask.backdrop ? { backdrop: [...node.softMask.backdrop] } : {}),
        };
        origin.maskReason = node.softMask.reason;
    }
    if (node.kind === 'group') {
        if (node.forceForm)
            origin.isolatedReason = node.formReason;
        return { kind: 'group', ...painting, items: node.children.map((child) => vectorItem(child, context)), bbox: [...node.bboxPt], ...(node.forceForm ? { isolated: true } : {}) };
    }
    if (node.kind === 'form') {
        origin.reason = node.reason;
        // The first node to name a form defines it, as the first to be emitted always did; two that differ in size are not one form.
        const held = context.forms[node.formKey];
        if (!held)
            context.forms[node.formKey] = { bbox: [...node.bboxPt], items: node.content.map((child) => vectorItem(child, context)) };
        else if (held.bbox.some((n, i) => n !== node.bboxPt[i]))
            throw new CasterError(`caster: the form ${JSON.stringify(node.formKey)} is named by two nodes of different sizes (${node.domPath})`, { element: node.domPath });
        return { kind: 'form', ...painting, form: node.formKey, matrix: copy(node.matrix, `${where} matrix`) };
    }
    if (node.kind === 'raster') {
        const source = context.rasterKey.get(node.raster);
        if (source === undefined)
            throw new CasterError(`vectorEmit: the raster for ${node.domPath} (${node.raster.feature}) was never embedded`, { element: node.domPath });
        return { kind: 'raster', ...painting, table: 'rasters', source };
    }
    const fill = paintOf(node.fill, context, `${where} fill`);
    const strokes = node.stroke.kind !== 'none' && node.strokeStyle !== null;
    let stroke: Stroke|undefined;
    if (strokes) {
        const style = (node.strokeStyle as NonNullable<typeof node.strokeStyle>);
        stroke = {
            paint: (paintOf(node.stroke, context, `${where} stroke`) as Paint),
            width: style.widthPt,
            cap: style.cap,
            join: style.join,
            miterLimit: style.miterLimit,
            dash: [...style.dashPt],
            dashPhase: style.dashPhasePt,
        };
        origin.nonScaling = style.nonScaling;
    }
    return {
        kind: 'shape',
        ...painting,
        path: copy(node.path, `${where} path`),
        ...(fill ? { fill } : {}),
        rule: node.fillRule,
        ...(stroke ? { stroke } : {}),
        ...(fill && stroke && node.strokeFirst ? { strokeFirst: true } : {}),
    };
}

/**
 * A node's bounds on the page, `[llx lly urx ury]`.
 *
 * @remarks
 * `bboxOf` measures in the node's own coordinates, which for a node under an in-page CTM chain is the untransformed space the geometry was read in. A `/BBox` in the structure tree is a page rectangle, so the four corners go through the node's `cm` first and the answer is the box around them.
 */
function pageSpaceBbox(node: MeasuredVector['node']): [number,number,number,number] {
    const [llx, lly, urx, ury] = bboxOf([node]);
    if (!node.cm)
        return [llx, lly, urx, ury];
    const corners = [apply(node.cm, llx, lly), apply(node.cm, urx, lly), apply(node.cm, urx, ury), apply(node.cm, llx, ury)];
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * Build the display list of a measured, walked document.
 *
 * @returns The list, and beside it what only the report reads of each text item, by page and by the item's index in its page.
 * @throws {CasterError} A font or an image with no bytes; content owned by a tag that may not own it; a structure path no node has; a colour cluster with no raster; a heading that painted no text; page-label declarations that do not match the page count; a value the list cannot carry; and the structure resolver's refusals (a link with no element, a destination with no content under it, a bookmark to a pruned heading; `displayList/structure.js`).
 */
export async function buildDisplayList(measurement: MeasureResult, walk: WalkResult, inputs: BuildInputs): Promise<{ list: DisplayList; origins: TextOrigin[][]; }> {
    const rasterKey: Map<RasterSpec,number> = new Map((inputs.rasterSpecs ?? []).map((spec, index) => [spec, index]));
    const memo: Map<object,unknown> = new Map<any, any>();
    const copy = (value: unknown, where: string): any => plain(value, memo, where);

    const nodeAt: Map<string,StructureNode> = new Map<any, any>();
    const index = (node: StructureNode) => {
        if (!nodeAt.has(node.path))
            nodeAt.set(node.path, node);
        node.kids.forEach(index);
    };
    index(walk.tree);
    /**
     * The structure node at `path`.
     *
     * @throws {CasterError} No node has that path.
     */
    const nodeByPath = (path: string): StructureNode => {
        const found = nodeAt.get(path);
        if (!found)
            throw new CasterError(`caster: no structure element at ${path}`);
        return found;
    };

    const artifactByPath = new Map(walk.artifacts.map((a) => [a.path, a]));

    // The lines a given page and paragraph own, bucketed once. The page loop below asked the whole line list for every paragraph of every page — O(pages × paragraphs × lines), which grows faster than the document does and was the emit stage's own largest term.
    const linesByPageAndParagraph: Map<string,number[]> = new Map<any, any>();
    measurement.lines.forEach((line, lineIndex) => {
        const key = `${line.page}:${line.paragraph}`;
        const bucket = linesByPageAndParagraph.get(key);
        if (bucket) bucket.push(lineIndex); else linesByPageAndParagraph.set(key, [lineIndex]);
    });
    const interleaved: Interleaved[] = [
        ...measurement.paragraphs.map((p, block) => ({ domIndex: p.domIndex, paintIndex: p.paintIndex, block })),
        ...measurement.paints.map((paint) => ({ domIndex: paint.domIndex, paintIndex: paint.paintIndex, paint })),
        ...measurement.images.map((image) => ({ domIndex: image.domIndex, paintIndex: image.paintIndex, image })),
        ...measurement.vectors.map((vector) => ({ domIndex: vector.domIndex, paintIndex: vector.paintIndex, vector })),
    ].sort((a, b) => {
        // Under `css` the order is the painting order the walker computed, with the DOM index breaking a tie; under `dom` the paint index is not consulted at all, which is what keeps E3 (`text-emission.md`) through E8 (`colour.md`) byte for byte what they were.
        if (inputs.paintOrder === 'css') {
            const left = a.paintIndex ?? Number.MAX_SAFE_INTEGER;
            const right = b.paintIndex ?? Number.MAX_SAFE_INTEGER;
            if (left !== right)
                return left - right;
        }
        return a.domIndex - b.domIndex;
    });
    // The same items in DOM order, which is reading order and which is what the structure tree is ordered by whatever order the ink is laid down in. Under `dom` this is `interleaved` itself; under `css` it is not, and the difference is the defect: a float paints at Appendix E's step 4 and in-flow text at step 5, so a `.sidebar` following a paragraph was emitted before it and, `seq` being one key doing both jobs, preceded it in the parent's `/K` as well.
    const domRankOf: Map<Interleaved,number> = new Map([...interleaved].sort((a, b) => a.domIndex - b.domIndex).map((item, rank) => [item, rank]));

    // The annotations a page owns, bucketed once, each with its place among all of them.
    const linksByPage: Map<number,[WalkAnnot,number][]> = new Map<any, any>();
    walk.annots.forEach((annot, order) => {
        const bucket = linksByPage.get(annot.page);
        if (bucket) bucket.push([annot, order]); else linksByPage.set(annot.page, [[annot, order]]);
    });

    const pages: Page[] = [];
    // The content starts and the links, as the structure resolver reads them, beside the items it fills in.
    const contentRefs: ContentRef[] = [];
    const contentStarts: ContentStart[] = [];
    const linkRefs: LinkRef[] = [];
    const linkItems: LinkItem[] = [];
    // What only the report reads of each text item, by page and by the item's place in its page's list: not in the list.
    const origins: TextOrigin[][] = Array.from({ length: measurement.pageCount }, () => []);
    const paintedImages: Set<number> = new Set<any>();
    const forms: Record<string,FormDefinition> = {};
    const vectorContext = { forms, copy, rasterKey };
    for (let page = 0; page < measurement.pageCount; page++) {
        const units: Unit[] = [];
        for (const item of interleaved) {
            const domRank = (domRankOf.get(item) as number);
            if (item.paint) {
                const paint = item.paint;
                if (paint.page === page)
                    units.push({ kind: 'paint', owner: paint.path, paint, domRank });
                continue;
            }
            if (item.vector) {
                const vector = item.vector;
                if (vector.page === page)
                    units.push({ kind: 'vector', owner: vector.owner, vector, domRank });
                continue;
            }
            if (item.image) {
                const image = item.image;
                if (image.page === page)
                    units.push({ kind: 'image', owner: image.path, image, domRank });
                continue;
            }
            for (const lineIndex of linesByPageAndParagraph.get(`${page}:${item.block}`) ?? []) {
                const line = measurement.lines[lineIndex];
                // E12A (`images.md`): a colour cluster is emitted where it sits on the line, between the words it stands among, so an extractor reads "text emoji text" rather than the words followed by the pictures. Ordering is by the left edge, which is reading order for a left-to-right line and is the only order either side has in common.
                const onLine: { x: number; unit: Unit; }[] = line.runs.map((run, runInLine) => ({
                    x: Math.min(...run.segments.map((segment) => segment.xPx)),
                    unit: { kind: 'run', owner: run.owner, line, lineIndex, runInLine, domRank },
                }));
                for (const cluster of measurement.emoji) {
                    if (cluster.line !== lineIndex)
                        continue;
                    if (!inputs.emojiRasters?.has(cluster))
                        throw new CasterError(`caster: no raster for the colour cluster ${JSON.stringify(cluster.text)}`);
                    onLine.push({ x: cluster.xPx, unit: { kind: 'emoji', owner: cluster.owner, line, lineIndex, emoji: cluster, domRank } });
                }
                onLine.sort((a, b) => a.x - b.x);
                for (const entry of onLine)
                    units.push(entry.unit);
            }
        }
        // Group: consecutive run units with one owner become one content item; a paint is always its own, because a rectangle and a line of text are never the same marked-content sequence.
        const pageGroups: Group[] = [];
        // E12A (`images.md`) adds `emoji` to the joinable kinds, which is what keeps a cluster inside the marked content of the element that owns the words around it — and, for the link case, inside the `/Link` item rather than beside it.
        const joinable = (kind: Unit['kind']): boolean => kind === 'run' || kind === 'vector' || kind === 'emoji';
        // The reading-order rank of every unit on this page: the DOM rank of its item, ties broken by the order the units were built in, which within one item is the order the lines and the runs come in. A group takes its first unit's rank, and the page goes in the high digits so an element straddling a cut begins on the earlier page.
        const readingRank: Map<Unit,number> = new Map([...units.entries()]
            .sort(([leftIndex, left], [rightIndex, right]) => left.domRank - right.domRank || leftIndex - rightIndex)
            .map(([, unit], rank) => [unit, page * READING_RANKS_PER_PAGE + rank]));
        for (const unit of units) {
            const open = pageGroups[pageGroups.length - 1];
            // Consecutive runs with one owner are one content item, as E5 (`structure-tree.md`) decided. E9 (`vector-painting.md`) adds vectors to that: an inline `<svg>` is one Figure and one MCID however many paths it paints, and a decorated box is one artifact however many sides its border has.
            if (open && open.owner === unit.owner && joinable(unit.kind) && joinable(open.units[0].kind)) {
                open.units.push(unit);
                continue;
            }
            pageGroups.push({ owner: unit.owner, seq: (readingRank.get(unit) as number), units: [unit] });
        }

        const items: Item[] = [];
        // The page's own ground, before every group. `@page { background: … }` paints the page box and nothing in the DOM carries it, so it arrives the way the print marks do — resolved by the adapter, written by the writer — except that it goes first. The rectangle is the whole page box in the page's own user space; where a bleed grew the `MediaBox`, the geometry's own origin is what the rest of the stream is expressed against, so the same numbers place it.
        const background = inputs.pageBackgrounds?.find((entry) => entry.page === page);
        if (background) {
            const geometry = pageGeometryFor(page);
            items.push({ kind: 'tag', start: { artifact: { type: 'Page' } } }, { kind: 'shape', owner: '', rect: [0, 0, round3(geometry.widthPt), round3(geometry.heightPt)], fill: { rgb: (background.rgb.map((c) => Math.round((c / 255) * 1000) / 1000) as [number, number, number]) } }, { kind: 'tag', end: true });
        }
        for (const group of pageGroups) {
            const artifact = artifactByPath.get(group.owner);
            if (artifact) {
                items.push({
                    kind: 'tag',
                    start: {
                        artifact: { type: artifact.type, ...(artifact.subtype ? { subtype: artifact.subtype } : {}) },
                        path: artifact.path,
                        kind: group.units[0].kind === 'paint' ? 'paint' : group.units[0].kind === 'image' ? 'image' : 'text',
                    },
                });
            }
            else {
                const node = nodeByPath(group.owner);
                if (!ownsContent(node.tag))
                    throw new CasterError(`caster: ${node.tag} at ${node.path} may not own content`);
                const start: ContentStart = { element: -1 };
                contentRefs.push({ page, item: items.length, owner: group.owner, seq: group.seq });
                contentStarts.push(start);
                items.push({ kind: 'tag', start });
            }
            for (const unit of group.units) {
                if (unit.kind === 'paint') {
                    items.push(paintItem(unit.paint));
                    continue;
                }
                if (unit.kind === 'vector') {
                    const vector = unit.vector;
                    const drawn = vectorItem(vector.node, vectorContext);
                    items.push({ ...drawn, owner: vector.owner, origin: { ...drawn.origin, page: vector.page, paintIndex: vector.paintIndex } });
                    continue;
                }
                if (unit.kind === 'image') {
                    const placement = unit.image.placement;
                    paintedImages.add(unit.image.index);
                    items.push({
                        kind: 'image',
                        owner: unit.owner,
                        source: unit.image.index,
                        transform: copy(placement.cm, `image ${unit.image.path} cm`),
                        ...(placement.clipPath ? { clip: copy(placement.clipPath, `image ${unit.image.path} clip`) } : {}),
                        interpolate: placement.interpolate,
                    });
                    continue;
                }
                if (unit.kind === 'emoji') {
                    const box = emojiBox(unit.emoji);
                    items.push({
                        kind: 'raster',
                        owner: unit.owner,
                        table: 'emoji',
                        source: unit.emoji.index,
                        actualText: unit.emoji.text,
                        transform: box.cm,
                        ...(unit.emoji.chain ? { chain: toPdfMatrix(unit.emoji.chain, pageGeometryFor(page)) } : {}),
                        emojiOrigin: {
                            face: unit.emoji.usedFont,
                            rectLeftPt: xToPt(unit.emoji.xPx, unit.emoji.page),
                            rectWidthPt: round3((unit.emoji.rightPx - unit.emoji.xPx) * PX_TO_PT),
                            ascentPx: Math.round(unit.emoji.ascentPx * 1000) / 1000,
                            descentPx: Math.round(unit.emoji.descentPx * 1000) / 1000,
                            rectPt: box.rectPt,
                        },
                    });
                    continue;
                }
                const text = textItem(unit.line, unit.runInLine, unit.owner, unit.lineIndex, page);
                origins[page][items.length] = text.origin;
                items.push(text.item);
            }
            items.push({ kind: 'tag', end: true });
        }
        // E12d (`coordinates-and-pages.md`): the page's own marks, outside everything a reader sees, stroked in the one colourant that reaches every plate.
        const pageMarks = inputs.printMarks?.pages.find((p) => p.page === page);
        const geometry = pageGeometryFor(page);
        let media: BoxPt = [0, 0, geometry.widthPt, geometry.heightPt];
        if (pageMarks && pageMarks.shapes.length > 0) {
            items.push({ kind: 'tag', start: { artifact: { type: 'Page' }, path: `artifact:marks:page-${page + 1}`, kind: 'paint' } }, { kind: 'marks', shapes: copy(pageMarks.shapes, `marks of page ${page + 1}`) }, { kind: 'tag', end: true });
            media = pageMarks.mediaAfter;
        }
        // The page's link annotations, after everything it paints: they are not painted, and the writer collects them for the structure tree.
        for (const [annot, order] of linksByPage.get(page) ?? []) {
            const link = linkItem(annot, order, inputs.baseUri);
            linkRefs.push({ order, owner: annot.ownerPath, ...(annot.dest ? { dest: annot.dest.structPath } : {}) });
            linkItems.push(link);
            items.push(link);
        }
        pages.push({
            size: [geometry.widthPt, geometry.heightPt],
            boxes: { media, ...(geometry.trimPt ? { trim: geometry.trimPt } : {}), ...(geometry.bleedPt ? { bleed: geometry.bleedPt } : {}) },
            items,
        });
    }

    // A Figure's Layout /BBox is the rectangle its image was painted into, and the only thing that knows it is the measurement, so the builder reads it here and the resolver writes it into the Figure's Layout attribute object.
    const figureBoxes: Record<string,[number,number,number,number]> = {};
    for (const image of measurement.images) {
        if (walk.images[image.index].tag === 'Figure')
            figureBoxes[image.path] = image.placement.paintedRectPt;
    }
    for (const vector of measurement.vectors) {
        // A Layout /BBox belongs to a Figure. A list marker is painted under its `Lbl`, which has no /BBox to carry (`vectors/listMarkers.js`).
        if (vector.owner.startsWith('artifact:') || nodeByPath(vector.owner).tag !== 'Figure')
            continue;
        // `bboxOf` answers in the node's own space, which is the space *inside* the item's chain `cm`; a Layout /BBox is a rectangle on the page, so a chained figure's box is the axis-aligned box around the four mapped corners.
        const [llx, lly, urx, ury] = pageSpaceBbox(vector.node);
        const existing = figureBoxes[vector.owner];
        figureBoxes[vector.owner] = existing
            ? [
                Math.min(existing[0], llx),
                Math.min(existing[1], lly),
                Math.max(existing[0] + existing[2], urx) - Math.min(existing[0], llx),
                Math.max(existing[1] + existing[3], ury) - Math.min(existing[1], lly),
            ]
            : [llx, lly, urx - llx, ury - lly];
    }

    /** The top of a heading on its page, in points; the `y` of its destination. */
    const headingTopPt = (path: string): { page: number; topPt: number; }|null => {
        // Every paragraph with this path, not the first. A block the cut fell inside is measured twice — once as the original, once as its continuation clone, both under the element the author wrote — and *a rectangle belongs to the page its node was assigned to* (S27) means the original may keep no line at all when the whole heading fell past the cut. Taking the first index alone found an empty line list and refused a heading the file paints perfectly well.
        const indexes = new Set<any>();
        measurement.paragraphs.forEach((p, i) => { if (p.path === path) indexes.add(i); });
        if (indexes.size === 0)
            return null;
        const lines = measurement.lines.filter((line) => indexes.has(line.paragraph));
        if (lines.length === 0)
            return null;
        const first = lines[0];
        const tops = first.runs.flatMap((run) => run.segments.map((segment) => segment.topPx));
        if (tops.length === 0)
            return null;
        return { page: first.page, topPt: yToPt(Math.min(...tops), first.page) };
    };
    const headings: { path: string, entry: Omit<OutlineEntry, 'element'> }[] = [];
    if (inputs.outline) {
        for (const heading of walk.outline) {
            const where = headingTopPt(heading.path);
            if (!where)
                throw new CasterError(`caster: the heading at ${heading.path} painted no text, so no bookmark can point at it`);
            headings.push({ path: heading.path, entry: { title: heading.title, level: heading.level, page: where.page, topPt: where.topPt } });
        }
    }
    // A link's `order` is its place among the links the pages hold, 0, 1, 2 …: the walk's order, with an annotation on no page leaving no gap, as the writer always numbered `/StructParent`.
    [...linkItems.keys()].sort((a, b) => linkItems[a].order - linkItems[b].order).forEach((at, rank) => {
        linkItems[at].order = rank;
        linkRefs[at].order = rank;
    });
    // The tree, pruned, ordered and resolved (`displayList/structure.js`): the writer writes it and decides nothing.
    const resolved = resolveStructure(walk.tree, contentRefs, linkRefs, figureBoxes, headings.map((h) => h.path));
    contentStarts.forEach((start, i) => { start.element = resolved.contentElement[i]; });
    linkItems.forEach((link, i) => {
        link.element = resolved.linkElement[i];
        if (link.target.dest)
            link.target.dest.element = resolved.destElement[i] as number;
    });
    const outline: OutlineEntry[] = headings.map((h, i) => ({ element: resolved.headingElement[i], ...h.entry }));
    let pageLabels: DisplayList['pageLabels'] = [];
    if (inputs.pageLabels && inputs.pageLabels.length > 0) {
        if (inputs.pageLabels.length !== measurement.pageCount) {
            throw new CasterError(`caster: ${inputs.pageLabels.length} page-label declaration(s) for ${measurement.pageCount} page(s); every page is asked, and a page that declares nothing continues the run above it`);
        }
        pageLabels = copy(pageLabelRuns(inputs.pageLabels).runs, 'page labels');
    }

    // The bytes behind the resources, keyed by their SHA-256. A blob is held once however many things name it: a variable face is one file under many instances.
    const blobs: Record<string,Uint8Array> = {};
    const blobOf = async (bytes: Uint8Array) => {
        const key = await sha256Hex(bytes);
        blobs[key] ??= bytes;
        return key;
    };
    const resources: Resources = { blobs, fonts: [], images: {}, forms, rasters: {}, emoji: {} };
    const upemOf: Map<string,number> = new Map<any, any>();
    for (const segment of measurement.segments) {
        if (!upemOf.has(segment.instanceKey))
            upemOf.set(segment.instanceKey, segment.upem);
    }
    // Every glyph each instance's text items show, and every space glyph they name: the glyphs the writer asks a width for.
    const shown: Map<string,Set<number>> = new Map<any, any>();
    for (const page of pages) {
        for (const item of page.items) {
            if (item.kind !== 'text')
                continue;
            const set = shown.get(item.font) ?? new Set<number>();
            for (const gid of item.glyphs.ids)
                set.add(gid);
            set.add(item.space);
            shown.set(item.font, set);
        }
    }
    for (const instance of measurement.usedInstances) {
        const bytes = inputs.fonts.bytesByUrl.get(instance.url);
        if (!bytes)
            throw new CasterError(`caster: no bytes registered for ${instance.url}`);
        const upem = upemOf.get(instance.instanceKey);
        resources.fonts.push({
            key: instance.instanceKey,
            blob: await blobOf(bytes),
            url: instance.url,
            faceId: instance.faceId,
            family: inputs.fonts.familyOf(instance.instanceKey),
            sourceFormat: inputs.fonts.sourceFormatOf(instance.url) ?? (outlineTableOf(bytes) === 'glyf' ? 'ttf' : 'otf'),
            coords: copy(instance.coords, `font ${instance.instanceKey}`),
            ...(upem !== undefined ? { upem } : {}),
            widths: widthsOf(instance.url, instance.coords, shown.get(instance.instanceKey)),
        });
    }
    for (const [key, request] of walk.images.entries()) {
        const source: ImageSource = {
            src: request.src,
            kind: request.kind,
            tag: request.tag,
            domPath: request.domPath,
            ...(request.alt !== undefined ? { alt: request.alt } : {}),
            ...(request.facsimile ? { facsimile: copy(request.facsimile, `image ${key}`) } : {}),
        };
        resources.images[key] = source;
        // Only a painted image has bytes: an image the measurement placed nowhere is walked and left out.
        if (!paintedImages.has(key))
            continue;
        if (request.kind === 'facsimile') {
            const loaded = inputs.images.facsimileOf(request.src);
            if (!loaded)
                throw new CasterError(`caster: the facsimile at ${request.domPath} was walked but never loaded`, { element: request.domPath });
            source.blob = await blobOf(loaded.bytes);
            continue;
        }
        const prepared = inputs.images.preparedOf(request.src);
        if (!prepared)
            throw new CasterError(`caster: no bytes registered for ${request.src}`);
        // What the image pass made of the file: the photo rule's JPEG, a reduced JPEG that carries its profile (a file to the writer), the browser's pixels, fast-png's samples of a PNG no predictor describes, or the file as it is.
        if (prepared.jpeg)
            source.jpeg = await blobOf(prepared.jpeg);
        else if (prepared.carried) {
            source.blob = await blobOf(prepared.carried);
            source.mime = 'image/jpeg';
        }
        else if (prepared.samples)
            source.samples = { blob: await blobOf(rgbaOf(prepared.samples)), width: prepared.samples.width, height: prepared.samples.height, colorSpace: 'DeviceRGB', bitsPerComponent: 8, alpha: true };
        else if (prepared.png) {
            const png = prepared.png;
            source.samples = { blob: await blobOf(png.data), width: png.width, height: png.height, colorSpace: png.colorSpace, bitsPerComponent: png.bitsPerComponent, alpha: png.alpha, ...(png.palette ? { palette: await blobOf(png.palette) } : {}), ...(png.icc ? { icc: await blobOf(png.icc) } : {}) };
        }
        else {
            source.blob = await blobOf(prepared.file.bytes);
            source.mime = prepared.file.mimeType;
        }
        if (prepared.jpeg || prepared.carried || prepared.samples || prepared.png)
            source.original = { format: prepared.format ?? prepared.file.mimeType, bytes: prepared.file.bytes.length, ...(prepared.gammaOnly ? { gammaOnly: true } : {}), ...(prepared.png?.why ? { why: prepared.png.why } : {}) };
        if (prepared.photo)
            source.photo = evidenceOf(prepared.photo);
        if (prepared.refusal !== undefined)
            source.refusal = prepared.refusal;
    }
    for (const [spec, key] of rasterKey) {
        const raster: RasterSource = { feature: spec.feature, reason: spec.reason, rectPt: spec.rectPt, dpi: spec.dpi, cm: spec.cm };
        const samples = inputs.rasterSamples?.get(spec);
        if (samples)
            Object.assign(raster, { blob: await blobOf(rgbaOf(samples)), width: samples.width, height: samples.height });
        const photo = inputs.rasterPhotos?.get(spec);
        if (photo) {
            raster.photo = evidenceOf(photo);
            if (photo.jpeg)
                raster.jpeg = await blobOf(photo.jpeg);
        }
        resources.rasters[key] = raster;
    }
    for (const cluster of measurement.emoji) {
        const samples = inputs.emojiRasters?.get(cluster);
        resources.emoji[cluster.index] = {
            text: cluster.text,
            sizePx: cluster.sizePx,
            ...(samples ? { blob: await blobOf(rgbaOf(samples)), width: samples.width, height: samples.height } : {}),
        };
    }

    const { colour, ...writing } = inputs.writing;
    const listWriting: Writing = {
        ...writing,
        ...(colour ? { colour: { profiles: { cmyk: await blobOf(colour.profileBytes), srgb: await blobOf(colour.srgbBytes) }, condition: colour.condition, info: colour.info, blackText: colour.blackText } } : {}),
    };
    const list: DisplayList = {
        version: 7,
        info: {
            lang: walk.lang,
            title: inputs.title,
            conformance: inputs.conformance,
            pageCount: measurement.pageCount,
            created: inputs.created,
        },
        writing: listWriting,
        resources,
        structure: resolved.structure,
        outline,
        pageLabels,
        pages,
    };
    // *PDF/UA-2 is a flag, not a given* (S103): the builder knows the flag, so a gap PDF/UA-2 forbids is refused here, before either writer is asked; the writers' validators hold the same rule for a list that reaches them some other way.
    checkGaps(list);
    return { list, origins };
}

/** The photo rule's decision as the list records it: everything but the JPEG, which is a blob, and the time it took, which the report takes from the pass. */
function evidenceOf(photo: PhotoDecision): PhotoEvidence {
    return { isPhoto: photo.isPhoto, reason: photo.reason, pixels: photo.pixels, uniqueRatio: photo.uniqueRatio, longestRun: photo.longestRun, candidates: photo.candidates.map((c) => ({ ...c })), chosenQuality: photo.chosenQuality };
}

/**
 * Every table in the report's shape.
 *
 * @remarks
 * The maps the plan names — the grid, the header map, the scopes and the spans — are keyed by the emitted element's structure path rather than by its `/ID`, because an empty `TD` has no `/ID` and still has a place in the grid and a set of headers. The values of `headerMap` *are* `/ID`s, because that is what `/Headers` carries and the node checker compares the two directly.
 *
 * Moved here from `emit/structureEmit.js` (stage 2): it reads the walk's tables, which the writer no longer sees, and `print()` adds the result to the report.
 *
 * @param caseOf - The fixture case a table belongs to; a table with none carries no `case`.
 */
export function tableSidecar(tables: WalkTable[], edges: ReportCollapsedEdge[], caseOf?: (table: WalkTable) => number): ReportTable[] {
    return tables.map((table) => {
        const model = table.model;
        const headerMap: Record<string,string[]> = {};
        for (const [cell, headers] of table.headerMap)
            headerMap[table.cellPaths[cell]] = headers.map((i) => table.cellIds[i]);
        const scopes: Record<string,'Column'|'Row'|'Both'> = {};
        const spans: Record<string,[number,number]> = {};
        for (const cell of model.cells) {
            const path = table.cellPaths[cell.index];
            if (cell.kind === 'th')
                scopes[path] = scopeNameOf(model, cell.index);
            if (cell.rowSpan > 1 || cell.colSpan > 1)
                spans[path] = [cell.rowSpan, cell.colSpan];
        }
        return {
            ...(caseOf && caseOf(table) > 0 ? { case: caseOf(table) } : {}),
            path: table.path,
            key: table.key,
            rows: model.rows,
            columns: model.columns,
            collapsed: table.collapsed,
            grid: model.grid.map(( row: (number|null)[]) => row.map(( cell: number|null) => (cell === null ? null : table.cellPaths[cell]))),
            headerMap,
            scopes,
            spans,
            cells: model.cells.map(( cell: TableCell) => ({
                index: cell.index,
                kind: cell.kind,
                path: table.cellPaths[cell.index],
                id: table.cellIds[cell.index],
                domId: cell.id,
                row: cell.row,
                col: cell.col,
                rowSpan: cell.rowSpan,
                colSpan: cell.colSpan,
                section: cell.section,
                rowGroup: cell.rowGroup,
                ...(cell.kind === 'th' ? { scope: scopeNameOf(model, cell.index) } : {}),
                empty: cell.empty,
                synthetic: cell.synthetic,
                fragment: cell.fragment,
                domPath: cell.domPath,
            })),
            fragments: table.fragmentPages.map((page, fragment) => ({
                page,
                rows: table.rows.filter((r) => r.fragment === fragment && !r.repeated).map((r) => r.path),
                repeatedRows: table.rows.filter((r) => r.fragment === fragment && r.repeated).map((r) => r.path),
            })),
            collapsedEdges: edges.filter((edge) => edge.table === table.key),
            warnings: table.warnings,
        };
    });
}
