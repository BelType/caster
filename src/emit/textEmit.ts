/**
 * `emit/textEmit.js` — the word-level emission model: `BT` per line, `TJ` per run, real space glyphs, and the pen.
 *
 * Ported from `harness/src/export/textEmit.ts` (E3, E4, E8, E9, E10, E12A, E12F). Guide: `docs/guide/text-emission.md`.
 *
 * WHAT THE PORT CHANGED (PLAN.md P2, P5, D7). pdf-lib is a capability handle. The harness's `emitText`, which wrote the whole file from the measurement, is gone: `emitStructure` is the one emitter and `emitRun` reads a display list's text item (*the display list, version 2*, `.claude/plans/the-display-list/plan-v2.md`), so the run's lengths arrive in points, its glyph advances in font units and its segments' positions where the browser put them.
 *
 * The harness's own header follows.
 *
 * The emitter of `text-emission.md` (E3): measured word positions in, a PDF 2.0 file out.
 *
 * The model, in one paragraph. One `BT … ET` per line. One `Tf`/`rg`/`Tc`/`Tm` and one `TJ` array per run. Inside the array, each segment's glyph ids as one hex string; between two segments, a space glyph when DOM whitespace separated them, and then a number that moves the pen to where the browser put the next segment. `Tw` never appears: it applies to single-byte code 32 and does nothing at all to an Identity-H CID font, so justification is adjustments and only adjustments. `Tz`, `Ts`, `TL` and `Td` are unused.
 *
 * The pen is tracked analytically rather than measured back, and it is tracked in the renderer's terms, not the shaper's: a viewer advances by the `/W` entry plus `Tc`, so wherever HarfBuzz's advance differs from the font's hmtx advance — which is exactly where GPOS kerned the pair — the difference is written into the `TJ` array as its own adjustment and the pen stays exact. Without that, a kerned line would be laid out to the font's uncorrected widths and every word after the first kern pair would drift.
 *
 * @packageDocumentation
 */
import { capability } from '../capabilities.ts';
import { CasterError } from '../errors.ts';
import { clipOperators } from '../vectors/vectorEmit.ts';

const pdf = () => capability('pdf');

import type { CidFont } from '../fonts/fontEmbed.ts';
import type { ClipPath, DisplayList, FontInstance, Page, TextItem } from '../displayList.ts';
import type { Matrix } from '../images/imagePlace.ts';

/** The document's pages, and each face's resource name on each. */
export type PageSetup = {
  pages: PDFPage[];
  /** Page-indexed, keyed by instance key. */
  names: Map<string, PDFName>[];
};
/** Everything {@link emitRun} needs that is not the item. */
export type RunContext = {
  context: PDFContext;
  font: CidFont;
  name: PDFName;
  /** The font's units per em, which the item's advances are in. */
  upem: number;
  onKern: () => void;
  /** The text one glyph really stands for, when the ToUnicode CMap cannot say it. A CID that the document paints for two different strings gets the most frequent one in the CMap and every other occurrence wrapped in `/Span <</ActualText (…)>> BDC … EMC`, which is the only place a reader can be told the truth about that one glyph. Absent, nothing is wrapped and the run is one `TJ` exactly as E3 (`text-emission.md`) wrote it. */
  actualTextFor?: (segment: TextSegment, glyphIndex: number) => string|null;
  /** Counted for the report: how many glyph occurrences were wrapped. */
  onActualText?: (text: string) => void;
  /** The colour switch of `colour.md` (E8). When present, what it returns replaces the run's `rg` and may wrap the run in an overprint graphics state. Absent, the run is painted `rg` from the computed style exactly as E3 (`text-emission.md`) wrote it, which is what keeps the content streams of E3, E4 (`font-embedding.md`) and E5 (`structure-tree.md`) byte-identical. */
  colorOperators?: (item: TextItem) => RunColorOperators;
};
/** The colour a run is painted in, as the operators around and instead of its `rg` (`colour.md`, E8). */
export type RunColorOperators = {
  /** Written before the run's `Tf`; the overprint `gs`, when there is one. */
  setup: PDFOperator[];
  /** Replaces the run's `rg`: `c m y k k`, or `/CSn cs t scn`. */
  fill: PDFOperator[];
  /** Written after the run's last operator. A `q`/`Q` pair may not straddle a `BT … ET`, so an overprint state set inside a text object can only be put back by setting another one. */
  reset: PDFOperator[];
};

import { glyphString } from '../fonts/cidFont.ts';
import { clusterGroups } from '../fonts/clusters.ts';
import { round3 } from '../coordinates/units.ts';
/**
 * The largest gap, in thousandths of an em, between the shaped advance and the /W entry that is rounding rather than a kern.
 *
 * @remarks
 * Below this the gap is the rounding of /W to an integer — at most half a thousandth per glyph — and is left to accumulate inside the word, where it stays under a tenth of a point and is cleared by the next word's adjustment. Above it, the gap is a GPOS kern: Crimson Text's are sixty thousandths of an em and up.
 */
const KERN_EPSILON = 2;
export { round3 };
/**
 * The `q <cm>` and `Q` a line under an in-page transform is wrapped in.
 *
 * @remarks
 * One line per chain, because the wrapper cannot straddle a text object: a `q`/`Q` pair may not cross a `BT`/`ET`, which is what makes the line rather than the run the unit a transform is carried on. With no chain both halves are empty and the stream is exactly what it was before E10 (`coordinates-and-pages.md`).
 *
 * @param chain - The `cm` the builder made of the line's chain, already in the page's points.
 * @param clips - The line's clips, applied after the `cm` inside the same `q`/`Q`; a line that hides its overflow is wrapped when it has no chain too.
 */
export function lineWrap(chain: Matrix|undefined, clips: ClipPath[] = []) {
    if (!chain && clips.length === 0)
        return { open: [], close: [] };
    return {
        open: [
            pdf().PDFOperator.of(pdf().PDFOperatorNames.PushGraphicsState),
            ...(chain ? [pdf().PDFOperator.of(pdf().PDFOperatorNames.ConcatTransformationMatrix, chain.map((n) => pdf().PDFNumber.of(n)))] : []),
            ...clips.flatMap(clipOperators),
        ],
        close: [pdf().PDFOperator.of(pdf().PDFOperatorNames.PopGraphicsState)],
    };
}
/**
 * Add the document's pages and give every face a stable resource name on each.
 *
 * @remarks
 * `setFontDictionary` rather than `newFontDictionary`: the latter appends a random suffix to the tag, so the same face would be `/F-7098480789` on one run and `/F-9750469207` on the next and every `page-n.txt` would differ from the last run for no reason. The names are the faces' own order instead. A resource name is per page, so the map is page-indexed.
 *
 * @param pageList - The list's pages: each one's size and boxes.
 */
export function setupPages(pdfDoc: PDFDocument, fonts: Map<string,CidFont>, pageList: Page[]): PageSetup {
    const pages: PDFPage[] = [];
    const names = [];
    for (const { size, boxes } of pageList) {
        // The page box is the list's: its nominal size, and the media box grown by the page's printer's marks where it grew.
        const pdfPage = pdfDoc.addPage(size);
        if (boxes.media[0] !== 0 || boxes.media[1] !== 0 || boxes.media[2] !== size[0] || boxes.media[3] !== size[1])
            pdfPage.setMediaBox(...boxArgs(boxes.media));
        if (boxes.trim)
            pdfPage.setTrimBox(...boxArgs(boxes.trim));
        if (boxes.bleed)
            pdfPage.setBleedBox(...boxArgs(boxes.bleed));
        // `/Tabs /S` — annotation tab order follows the structure tree. Required of every page by PDF/UA (ISO 14289-1 §7.18.3, carried into UA-2), and absent from every file this printer had written: Acrobat's checker reports it as "Tab order is consistent with structure order — Failed". The value is not a preference and there is no other right one here: a tagged document that let a viewer tab in some other order would be handing a keyboard user a reading order the tree does not describe.
        pdfPage.node.set(pdf().PDFName.of('Tabs'), pdf().PDFName.of('S'));
        pages.push(pdfPage);
        const perInstance = new Map<any, any>();
        [...fonts].forEach(([id, font], index) => {
            const name = pdf().PDFName.of(`F${index}`);
            pdfPage.node.setFontDictionary(name, font.ref);
            perInstance.set(id, name);
        });
        names.push(perInstance);
    }
    return { pages, names };
}
/** A PDF box's two corners as the `(x, y, width, height)` pdf-lib's box setters take. */
const boxArgs = (box: [number,number,number,number]): [number,number,number,number] => [
    box[0],
    box[1],
    box[2] - box[0],
    box[3] - box[1],
];
/** Which way a segment's glyphs run, read off its clusters. */
export function directionOf(clusters: number[]): 'ltr'|'rtl' {
    return clusters.length > 1 && clusters[0] > clusters[clusters.length - 1] ? 'rtl' : 'ltr';
}

/** One measured segment as the writer and the ToUnicode map read it: the word, its glyphs, and nothing the browser knows. */
export type TextSegment = {
  text: string;
  /** The shaper's cluster per glyph, as a UTF-16 offset into `text`. */
  clusters: number[];
  gids: number[];
  /** In font units. */
  advanceUnits: number[];
  upem: number;
  spaceBefore: boolean;
  instanceKey: string;
  /** Where the segment's item sits in the display list, which a refusal of the ToUnicode map names. Absent on a view made before the map asked. */
  place?: { page: number, item: number };
};

/** The text of each of an item's segments: the run's string, cut where one segment ends and the next begins, less the space between them when DOM whitespace put one there. */
export function segmentTexts(item: TextItem): string[] {
    const { start, spaceBefore } = item.segments;
    return start.map((from, index) => item.text.slice(from, index + 1 < start.length ? start[index + 1] - (spaceBefore[index + 1] ? 1 : 0) : item.text.length));
}

/** The views of one item's segments, made once: the ToUnicode map's occurrences are keyed by the view, so the map and the writer must hold the same objects. */
const segmentViewCache = new WeakMap<any, any>();

/**
 * A text item's segments, each as the structs of arrays hold it.
 *
 * @remarks
 * The item holds the run as one string and its glyphs as flat arrays; a segment is cut back out of them by `segments.start` and `firstGlyph`, and its clusters moved back onto its own text, which is what `textForGlyph` and the map read.
 *
 * @param upem - The font's units per em (the `upem` of the instance `item.font` names).
 * @param place - Where the item sits in the display list, which a refusal of the ToUnicode map names; the first call decides, and the views are kept.
 */
export function segmentViews(item: TextItem, upem: number, place?: { page: number, item: number }): TextSegment[] {
    const held = segmentViewCache.get(item);
    if (held)
        return held;
    const { start, firstGlyph, spaceBefore } = item.segments;
    const texts = segmentTexts(item);
    const views = start.map((from, index) => {
        const glyphs = (index + 1 < firstGlyph.length ? firstGlyph[index + 1] : item.glyphs.ids.length) - firstGlyph[index];
        const first = firstGlyph[index];
        return {
            text: texts[index],
            clusters: item.glyphs.clusters.slice(first, first + glyphs).map((cluster) => cluster - from),
            gids: item.glyphs.ids.slice(first, first + glyphs),
            advanceUnits: item.glyphs.advances.slice(first, first + glyphs),
            upem,
            spaceBefore: spaceBefore[index],
            instanceKey: item.font,
            ...(place ? { place } : {}),
        };
    });
    segmentViewCache.set(item, views);
    return views;
}

/**
 * The list's font instances by their key, in the list's order.
 *
 * @throws {CasterError} Two instances with one key.
 */
export function fontsByKey(list: DisplayList): Map<string,FontInstance> {
    const byKey = new Map<string,FontInstance>();
    for (const instance of list.resources.fonts) {
        if (byKey.has(instance.key))
            throw new CasterError(`caster: the display list holds two font instances under the key ${instance.key}`);
        byKey.set(instance.key, instance);
    }
    return byKey;
}

/**
 * The instance a text item names.
 *
 * @throws {CasterError} A key the list holds no instance for.
 */
export function fontOf(fonts: Map<string,FontInstance>, item: TextItem): FontInstance {
    const instance = fonts.get(item.font);
    if (!instance)
        throw new CasterError(`caster: a text item names the font ${item.font}, and the display list holds no instance under that key`);
    return instance;
}

/** Every segment the list sets, in painting order, as the writer reads them: what the ToUnicode map is built over, each view knowing its item's place. */
export function listSegments(list: DisplayList): TextSegment[] {
    const fonts = fontsByKey(list);
    const segments: TextSegment[] = [];
    for (const [at, page] of list.pages.entries()) {
        for (const [index, item] of page.items.entries()) {
            if (item.kind === 'text')
                segments.push(...segmentViews(item, (fontOf(fonts, item).upem as number), { page: at, item: index }));
        }
    }
    return segments;
}

/**
 * One segment's glyph-index → text map, built once.
 *
 * @remarks
 * A segment is a word, so this is a handful of entries; the cache is here because `buildToUnicode` and `emitRun` both ask for every glyph of every segment.
 */
const glyphTextCache = new WeakMap<any, any>();

/**
 * The text one glyph stands for, from the shaper's clusters.
 *
 * @remarks
 * The first glyph of a cluster carries the cluster's characters and every later member of the same cluster carries the empty string — which is what a base-plus-mark pair, an Indic syllable and an Arabic run all are. Slicing to the next glyph's cluster, as this did, is only correct when every cluster holds exactly one glyph and the run is left-to-right: `é` shaped as base + combining acute gave the mark a zero-width slice, and an RTL run, whose glyphs come back in visual order, gave every glyph after the first one an empty slice and refused at `toUnicode.js` blaming the font's coverage. `clusterGroups` in `fonts/words.js` already did the grouping correctly and nothing called it.
 *
 * The direction is read off the clusters themselves: they are monotonic within a run, so a run whose first cluster is greater than its last came back in visual order and is RTL. Nothing on the segment records it, and inferring it from the one thing that carries the evidence is better than storing a second copy of it.
 */
export function textForGlyph(segment: Pick<TextSegment,'text'|'clusters'>, index: number): string {
    let byGlyph = glyphTextCache.get(segment);
    if (!byGlyph) {
        byGlyph = new Map<any, any>();
        for (const group of clusterGroups(segment.clusters, directionOf(segment.clusters), segment.text.length)) {
            byGlyph.set(group.glyphIndexes[0], group.end > group.start ? segment.text.slice(group.start, group.end) : '');
        }
        glyphTextCache.set(segment, byGlyph);
    }
    return byGlyph.get(index) ?? '';
}

/**
 * Whether this glyph is the first of its cluster, which is the glyph the cluster's characters ride on.
 *
 * @remarks
 * A later member's empty text is ordinary; a cluster start with no text is a glyph standing for nothing.
 */
export function isClusterStart(segment: Pick<TextSegment,'text'|'clusters'>, index: number): boolean {
    textForGlyph(segment, index);
    return (glyphTextCache.get(segment) as Map<number, string>).has(index);
}
/**
 * One run: the state operators, then a single `TJ`.
 *
 * @remarks
 * `pen` is where the renderer's text position will be, in points from the left edge of the page, after everything pushed so far. It is advanced by the /W entry the font will carry plus `Tc` per glyph, and by the rounded value of every adjustment actually written, so it never drifts from what a viewer computes.
 *
 * @param operators - The page's stream so far; the run is appended to it.
 * @returns The pen adjustment written before each segment, in thousandths of an em, null for the first: the writer's record of the item (`WriterRecords.pens`).
 */
export function emitRun(operators: PDFOperator[], item: TextItem, ctx: RunContext): (number|null)[] {
    const sizePt = item.size;
    const tcPt = item.letterSpacing;
    const segments = segmentViews(item, ctx.upem);
    const space = { gid: item.space };
    const spaceAdvPt = (ctx.font.width(space.gid) / 1000) * sizePt;
    const baselinePt = item.baseline;
    // A run boundary with DOM whitespace across it — `phrase</strong> on` — still owes the reader one space glyph, and the run that starts after it is the only place left to put it: the previous run's TJ has already been closed by its own Tf/Tc state. The run therefore starts one space to the left of its first word and shows the space first, which puts the pen exactly on the measured x with no adjustment at all. Without this the gap is a jump between two text objects, MuPDF infers a space where there is no glyph, and an extraction that inhibits inferred spaces loses the word boundary.
    // A face with no space glyph has `space: 0`, and a list that claims nothing writes its gaps as positioning with no glyph (*PDF/UA-2 is a flag, not a given*, S103; a list claiming PDF/UA-2 with such a gap was refused by `validateList`).
    const gap = item.space !== 0;
    const leadingSpace = item.leadingSpace && gap;
    const startPt = round3(item.segments.x[0] - (leadingSpace ? spaceAdvPt + tcPt : 0));
    const colour = ctx.colorOperators?.(item);
    operators.push(...(colour?.setup ?? []), pdf().PDFOperator.of(pdf().PDFOperatorNames.SetFontAndSize, [ctx.name, pdf().PDFNumber.of(round3(sizePt))]), ...(colour ? colour.fill : [pdf().PDFOperator.of(pdf().PDFOperatorNames.NonStrokingColorRgb, item.fill.rgb.map((c) => pdf().PDFNumber.of(round3(c))))]), pdf().PDFOperator.of(pdf().PDFOperatorNames.SetCharacterSpacing, [pdf().PDFNumber.of(round3(tcPt))]), pdf().PDFOperator.of(pdf().PDFOperatorNames.SetTextMatrix, [
        pdf().PDFNumber.of(1),
        pdf().PDFNumber.of(0),
        pdf().PDFNumber.of(0),
        pdf().PDFNumber.of(1),
        pdf().PDFNumber.of(startPt),
        pdf().PDFNumber.of(baselinePt),
    ]));
    const items: (PDFHexString|PDFNumber)[] = [];
    let pen = startPt;
    const adjustments: (number|null)[] = [];
    // The array is flushed as one `TJ` at the end of the run, which is the whole output of `text-emission.md` (E3), and mid-run wherever a glyph needs an `/ActualText` span around it: a BDC/EMC pair may sit inside a text object but not inside a `TJ` operand, so the only way to wrap one glyph is to close the array before it and open a new one after. Successive `TJ`s under one `Tm` continue from the pen the previous one left, so nothing about the geometry changes.
    const flush = () => {
        if (items.length === 0)
            return;
        operators.push(pdf().PDFOperator.of(pdf().PDFOperatorNames.ShowTextAdjusted, [ctx.context.obj([...items])]));
        items.length = 0;
    };
    if (leadingSpace) {
        items.push(glyphString([space.gid]));
        ctx.font.use(space.gid, ' ');
        pen += spaceAdvPt + tcPt;
    }
    segments.forEach((segment, index) => {
        let emittedAdj: number|null = null;
        if (index > 0) {
            const nextPt = item.segments.x[index];
            // The space glyph, when there was DOM whitespace, is shown before the adjustment, so the adjustment closes whatever gap is left after it.
            const spaced = segment.spaceBefore && gap;
            const adj = spaced
                ? round3((-(nextPt - pen - spaceAdvPt - tcPt) / sizePt) * 1000)
                : round3((-(nextPt - pen) / sizePt) * 1000);
            if (spaced) {
                items.push(glyphString([space.gid]));
                ctx.font.use(space.gid, ' ');
                pen += spaceAdvPt + tcPt;
            }
            items.push(pdf().PDFNumber.of(adj));
            pen -= (adj / 1000) * sizePt;
            emittedAdj = adj;
        }
        let pending: number[] = [];
        const closePending = () => {
            if (pending.length === 0)
                return;
            items.push(glyphString(pending));
            pending = [];
        };
        segment.gids.forEach((gid, j) => {
            const actualText = ctx.actualTextFor ? ctx.actualTextFor(segment, j) : null;
            if (actualText !== null) {
                closePending();
                flush();
                // PDFOperatorArg has no PDFDict member, so the property list is the literal it would serialise to. The value is a UTF-16BE text string with its byte-order mark, written as hex so no character in it can need escaping.
                operators.push(pdf().PDFOperator.of(pdf().PDFOperatorNames.BeginMarkedContentSequence, [
                    pdf().PDFName.of('Span'),
                    `<</ActualText <FEFF${utf16beHex(actualText)}> >>`,
                ]));
                ctx.onActualText?.(actualText);
            }
            pending.push(gid);
            ctx.font.use(gid, textForGlyph(segment, j));
            const shapedThousandths = (segment.advanceUnits[j] * 1000) / segment.upem;
            const written = ctx.font.width(gid);
            const delta = shapedThousandths - written;
            pen += (written / 1000) * sizePt + tcPt;
            if (Math.abs(delta) > KERN_EPSILON) {
                closePending();
                const kern = round3(-delta);
                items.push(pdf().PDFNumber.of(kern));
                pen -= (kern / 1000) * sizePt;
                ctx.onKern();
            }
            if (actualText !== null) {
                closePending();
                flush();
                operators.push(pdf().PDFOperator.of(pdf().PDFOperatorNames.EndMarkedContent));
            }
        });
        closePending();
        adjustments.push(emittedAdj);
    });
    // PDFOperatorArg admits a PDFArray, and PDFContext.obj passes PDFObject members through untouched, so the TJ operand is built as an ordinary array of hex strings and numbers rather than through a pdf-lib text helper.
    flush();
    if (colour)
        operators.push(...colour.reset);
    return adjustments;
}
/** UTF-16BE hex, which is what an `/ActualText` value is once the BOM is on it. */
function utf16beHex(text: string): string {
    let out = '';
    for (let i = 0; i < text.length; i++)
        out += text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
    return out;
}
