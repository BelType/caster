/**
 * `emit/structureEmit.js` — the composition: the text, the vectors, the images, the colour and the structure tree that makes it all readable.
 *
 * Ported from `harness/src/export/structureEmit.ts` (E5, E7, E8, E9, E10, E11, E12A–F). Guide: `docs/guide/structure-tree.md`, and every capability document under it.
 *
 * THE WRITER (stages 2 and 4 of `.claude/plans/the-display-list/`). `emitStructure` reads a {@link DisplayList} and nothing else: the deciding half (what goes on which page, in which order, under which marked content, and the structure tree resolved: which elements survive, every `/K` in reading order, where a destination lands) lives in `displayList/build.js` and `displayList/structure.js`, the writer numbering each page's content starts as MCIDs and writing what it is given, the bytes it needs are in `resources.blobs`, and every length arrives in the page's points. It reads no page geometry, no measurement and no walk. The file is byte-identical to the one the same document had before the move (`npm run identity`). What the report keeps of the measurement and the walk is added by `print()`.
 *
 * WHAT THE PORT CHANGED (PLAN.md P2, P6, D7). pdf-lib is a capability handle. `import selfSource from './structureEmit.ts?raw'` is deleted with the statistic it fed: the report's `builderLines` counted this module's own lines between two region markers, for an exit note's table, and a printer has no reader for it. `sidecarVersion`, `fixture`, `chromiumPrinted` and `chromiumError` go with the report's fixture-only fields; what is left is a partial `Report` the composition in `src/index.js` folds into the one it hands back.
 *
 * This module is where the port's spine met its painting, and it meets it through the names `structureEmit.ts` already declared — `ColorEmitter`, `ShadingBuilder`, `TransparencyBuilder`, `ResourceScope`, `vectorOperators`, `createImageContext`/`embedImage`/`useOnPage`, `collectTableBorders`, `pageMarksOf`/`circleSegments`/`MARK_STROKE_PT`, `buildOutline`, `pageLabelRuns`, `clusterKindOf`/`codePointsOf`. The port was split between two agents by the module graph (PLAN.md D10), neither editing the other's files, and keeping every exported name is what let the two halves land without a meeting.
 *
 * The harness's own header follows.
 *
 * The emitter of `structure-tree.md` (E5): the text of `text-emission.md` (E3) plus the structure tree that makes it readable.
 *
 * The text emission is that of E3 (`text-emission.md`), unchanged and imported rather than restated: `setupPages` for the pages and the font resource names, `emitRun` for the `Tf`/`rg`/`Tc`/`Tm`/`TJ` of one run. What E5 (`structure-tree.md`) adds is the layer above it — which marked-content sequence each run belongs to, which structure element owns that sequence, and the objects that say so.
 *
 * The content-item rule, in one sentence: a content item is a maximal run of consecutive `(line, run)` pairs on one page with the same owning structure element, written as `/<Tag> <</MCID n>> BDC`, one `BT … ET` per line inside it, then `EMC`. That generalises the per-paragraph-per-page rule of E3 (`text-emission.md`) without changing it — a paragraph with no inline markup is still exactly one MCID per page — and it is forced by two nesting constraints that cannot both be satisfied any other way: a `BDC`/`EMC` pair may not straddle a `BT`/`ET`, and content items carrying MCIDs may not nest. A paragraph with an `em` in the middle of a line is therefore three content items, not one containing another.
 *
 * Everything that is not real content is an artifact: `/Artifact <</Type /Pagination /Subtype /Header>> BDC … EMC` for a running header, page number or footer, `/Artifact <</Type /Layout>>` for a rule or a decorative box. Artifacts carry no MCID and appear nowhere in the tree.
 *
 * @packageDocumentation
 */
import { capability } from '../capabilities.ts';
import { CasterError } from '../errors.ts';
import { ColorEmitter } from '../colour/colorResources.ts';
import { ShadingBuilder } from '../vectors/shading.ts';
import { TransparencyBuilder } from '../vectors/transparency.ts';
import { ResourceScope, vectorOperators } from '../vectors/vectorEmit.ts';
import { embedFace } from '../fonts/fontEmbed.ts';
import { createImageContext, embedImage, useOnPage } from '../images/imageEmbed.ts';
import { embedFacsimiles, reopenFacsimile } from '../images/facsimile.ts';
import { mul } from '../coordinates/matrix.ts';
import { addXmpMetadata, createDocument, serialize, setInfo } from './document.ts';
import { COLUMN_WIDTH_PX } from '../coordinates/units.ts';
import { emitRun, fontOf, fontsByKey, lineWrap, listSegments, round3, setupPages } from './textEmit.ts';
import { buildToUnicode } from '../fonts/toUnicode.ts';
import { samplesFromRgba } from '../images/samples.ts';
import { MARK_STROKE_PT, circleSegments } from '../coordinates/printMarks.ts';
import { buildOutline } from './outline.ts';

/** What wrote the file, for the Info dictionary and the XMP packet alike. Named once here rather than at the two call sites, so the two can never disagree — a reader is entitled to consult either. */
const PRODUCER = 'BelType Caster';
import { clusterKindOf, codePointsOf } from '../fonts/clusters.ts';

const pdf = () => capability('pdf');

import type { CidFont, CidFontStats } from '../fonts/fontEmbed.ts';
import type { EmbeddedImage, EmbedSource } from '../images/imageEmbed.ts';
import type { LoadedFacsimile } from '../images/facsimile.ts';
import type { Matrix } from '../images/imagePlace.ts';
import type { DisplayList, ImageSource, StructAttribute, StructElement, FontInstance, EmojiOrigin, Fill, FormItem, GroupItem, ImageItem, LinkItem, LinkTarget, PlacedVector, RasterItem, RectItem, TextItem, TextOrigin, ArtifactStart } from '../displayList.ts';
import type { WordRecord } from './textEmit.ts';

/** One image the writer painted: which one, and what it became in the file. */
export type ImageUse = {
  /** Key into `resources.images`. */
  source: number;
  embedded: EmbeddedImage;
  /** The XObject's resource name on its page, without the slash. */
  name: string;
};
import type { Report, ReportContainer, ReportTiming, ReportPageBox, ReportFace as ReportEmissionFace, ReportEmission, ReportStructure, ReportParagraph as ReportEmissionParagraph, ReportImage, ReportStructureNode, ReportStructureArtifact, ReportStructureAnnot, ReportPaint, ReportEmojiCluster, ReportRun as ReportEmissionRun, ReportWord as ReportEmissionWord, ReportColor, ReportOutlineItem, ReportPageLabel, ReportPrintMarks, ReportTable, ReportDecoderComparison, ReportPhotoRule, ReportSkipInk, ReportConversion, ReportDeferred, ReportStackingContext, ReportDecoration, ReportCtmReading, ReportCollapsedEdge, ReportComputedBorderWidth, ReportEmoji, ReportLink, ReportVectorNotes, ReportCtmNode } from '../report.ts';

export type ArtifactDescriptor = ArtifactStart['artifact'];

/** The members of the report's `emission` that only the measurement knows, which `print()` adds. */
export type MeasuredEmissionKeys = 'trailingLetterSpacing' | 'trailingSamples' | 'baselineAgreementPt' | 'usableProbes' | 'probeMoved' | 'probeOffLine' | 'probeBeforeOffLine' | 'containerScrollWidthPx' | 'paragraphs' | 'words' | 'marginPt' | 'pageWidthPt' | 'pageHeightPt';

/**
 * The half of the emitter options that belongs to E9 (`vector-painting.md`): the painting-order contract, the raster pixels the browser drew, and everything the report records about painting.
 *
 * @remarks
 * Absent, nothing changes at all — no vector unit exists, the order stays DOM order, and the file is byte for byte what E3 (`text-emission.md`) through E8 (`colour.md`) wrote.
 */
export type VectorEmitOptions = {
  /** `dom` is every fixture before E9 (`vector-painting.md`): units are emitted in DOM order, which is also reading order. `css` is CSS 2.1 Appendix E, which is the order a browser paints in and the only order that is right when anything overlaps. The structure tree is DOM order under both, and that is now true rather than merely written down: a group's place in its parent's `/K` is a key built from the DOM rank of the item it came from, never from the counter that numbers the groups as they are emitted. Under `dom` the two are the same number and nothing moved; under `css` they are not, and a float — the addendum's `.sidebar` is one — painted at Appendix E's step 4 used to precede in-flow text at step 5 in the tree as well as on the page. */
  paintOrder: 'dom'|'css';
  rasterDpi: number;
  /** The element paths in CSS painting order, as the walker emitted them. */
  order: string[];
  deferred: ReportDeferred[];
  stackingContexts: ReportStackingContext[];
  decorations: ReportDecoration[];
  ctmReadings: ReportCtmReading[];
  figures: { path: string; tag: string; alt: string }[];
};

/** Everything `emitStructure` is told beyond the list; every member is optional because each is an experiment's addition, and each is absent in every fixture before it. */
export type EmitStructureOptions = {
  /** The PNG-decoder comparison the browser measured, for the report. */
  decoderComparison?: ReportDecoderComparison;
  /** E9 (`vector-painting.md`): vector painting. Absent, no vector is emitted and the order is DOM order. */
  vector?: VectorEmitOptions;
  /** What only the report reads of the text item at `index` in page `page`'s list: its run, paragraph, block path, computed colour, hint and ink box. `print()` holds it; the list does not. */
  originOf: (page: number, index: number) => TextOrigin;
  /** E10 (`coordinates-and-pages.md`): what the container frame recovered, for the report. */
  container?: ReportContainer;
  /** E10 (`coordinates-and-pages.md`): the measurement phase's cost, for the report. */
  timing?: ReportTiming;
  /** E11 (`tables.md`): what the collapsed-border resolver found. The tables themselves come from the walker, so a document with a table gets a `tables` block whether or not it asked for one; this is only the half of the record the painter owns. */
  tables?: { collapsedEdges: ReportCollapsedEdge[], computedWidths: ReportComputedBorderWidth[], gridLineSpreadPx: number };
  /** The `@page` background each page paints, already resolved. Second member of the category `printMarks` opened: a thing in a page's stream that belongs to no element, because it comes from the page box. It is written first rather than last, since a background is behind everything by definition, and as the same `/Artifact <</Type /Page>>` — a page's own ground is decoration, and a reader that walked it would be reading furniture. Absent, no page gains a byte. */
  pageBackgrounds?: { page: number, rgb: [number, number, number] }[];
  /** E12F (`structure-tree.md`): the document-level entries a reader expects and PDF/UA never asks for. Absent, the catalog carries neither, which is every fixture before E12. */
  smallItems?: SmallItemsOptions;
  /** E12A (`images.md`): the half of the emoji record the caller owns — the route and its provenance. */
  emoji?: Omit<ReportEmoji, 'clusters'|'xobjects'>;
  /** E12E (`colour.md`): what the RGB→CMYK tier converted. */
  conversion?: ReportConversion;
};
/** The document-level entries of `structure-tree.md` (E12F): the skip-ink record. The outline and the page labels are the list's. */
export type SmallItemsOptions = {
  /** The skip-ink measurement, which only the browser side can take. */
  skipInk?: ReportSkipInk;
};
/** The file, its streams, its part of the report, and the font programs it embedded. */
export type EmitStructureResult = {
  bytes: Uint8Array;
  /** One content stream's text per page. */
  pageStreams: string[];
  /** The composition in `src/index.js` folds this into the one report `print()` hands back (PLAN.md D7), adding what only the measurement and the walk know. */
  report: Partial<Report>;
  /** One entry per embedded instance, in first-use order. */
  fontStats: ReportEmissionFace[];
  /** The bytes actually embedded, by instance key, for the instance check. */
  fontPrograms: Map<string, Uint8Array>;
  /** The marked content each paragraph's lines were written under, by the paragraph's index in the measurement; the composition joins it to the paragraph's text for the report. */
  paragraphMcids: Map<number, { page: number, mcid: number }[]>;
  /** Every image the pages painted, in painting order: the composition joins each to the measurement's placement for the report's `images`. */
  imageUses: ImageUse[];
  /** How many distinct image XObjects the file holds. */
  xobjects: number;
  /** What the writer knows of every word it wrote, in the order it wrote them; the composition joins each to the measurement's segment for the report's `words`. */
  wordRecords: WordRecord[];
  /** Every `/ID` in the file, in the order the `/IDTree` lists them. */
  idTree: string[];
};
/** The marked-content sequence a page is inside: the element that owns it, and the MCID the writer gave it. */
export type Group = {
  element: number;
  page: number;
  mcid: number;
};
/** The written tree, and what the outline, the links, the report and the `/IDTree` need to know about it. */
export type BuildResult = {
  /** Each element's object, by its index in `structure.elements`. */
  refs: PDFRef[];
  annots: ReportStructureAnnot[];
  /** Every `/ID` in the file, in the order the `/IDTree` lists them. */
  ids: string[];
  /** E12F (`structure-tree.md`): every link and which of the two actions it became. */
  links: ReportLink[];
  /** The tree in the report's shape. */
  expectedTree: ReportStructureNode;
};

/**
 * A text string an entry carries, as the PDF object that can hold it.
 *
 * @remarks
 * pdf-lib's `pdf().PDFString.of` writes a literal string by `charCodeAt`, so a character above U+00FF goes in as its low byte and a `(` in the text goes in unescaped. E12A (`images.md`) found both at once: a link whose text contains ✨ (U+2728) came out as an unbalanced `(a link about ( emoji)` and made the file unparseable past that object. A hex string with a byte-order mark has neither problem, and 7.9.2.2 says a text string may be either.
 *
 * The literal is kept for text that is plain printable ASCII with no parenthesis and no backslash in it, which is every link, every `/Alt` and every title of every fixture before E12 (`structure-tree.md`): those files are byte for byte what they were, and only a string that would have been written wrong changes shape.
 */
function textString(value: string): PDFString|PDFHexString {
    return /^[\x20-\x7e]*$/.test(value) && !/[()\\]/.test(value) ? pdf().PDFString.of(value) : pdf().PDFHexString.fromText(value);
}
/** The PDF 2.0 standard structure namespace; every element points at it. */
export const PDF_2_NAMESPACE = 'http://iso.org/pdf2/ssn';
/** Annotation flag bit 3, Print. Required of every annotation by PDF/UA. */
const ANNOTATION_PRINT_FLAG = 4;
/**
 * The whole file: every page's content items, the structure tree over them, and every document-level object the options ask for.
 *
 * @throws {CasterError} A used instance or an image with no bytes, images with no `imageAssets`, an image no decoder tier could carry (naming its element, *an SVG that arrives through an `<img>` is a drawing*, DESIGN.md S44); a colour cluster with no raster; print marks without colour options; a structure tree that is not one, or an element index no element has (see `checkTree`); two elements with one `/ID`; and every refusal of the modules it composes.
 */
export async function emitStructure(list: DisplayList, options: EmitStructureOptions): Promise<EmitStructureResult> {
    const pdfDoc = await createDocument();
    const context = pdfDoc.context;
    if (list.version !== 5)
        throw new CasterError(`caster: the writer reads a display list of version 5, and this one is version ${String(list.version)}; a list is written again by print(), never upgraded`);
    // How the list asks to be written: the font profile and the colour story are the list's, and no option reaches a byte.
    const profile = list.writing.fontProfile;
    // The document-wide ToUnicode map with its ambiguity rule, from the list's glyph-to-text clusters: each CID maps to the string most of the document shows it for, and every other occurrence is wrapped in `/ActualText`.
    const toUnicode = buildToUnicode(listSegments(list));
    const fonts = new Map<any, any>();
    const fontPrograms = new Map<any, any>();
    const fontByKey = fontsByKey(list);
    for (const instance of list.resources.fonts) {
        const instanceKey = instance.key;
        const bytes = blobOf(list, instance.blob);
        const perInstance = toUnicode.byInstance.get(instanceKey);
        fonts.set(instanceKey, embedFace(context, {
            id: instanceKey,
            faceId: instance.faceId,
            family: instance.family,
            bytes,
            sourceFormat: instance.sourceFormat,
            coords: instance.coords,
            advanceOf: widthsOf(instanceKey, instance),
            profile,
            ...(perInstance ? { toUnicodeText: perInstance.text, cidToText: perInstance.cidToText } : {}),
            ...(perInstance ? { ambiguousCids: perInstance.ambiguous.map((a) => a.cid) } : {}),
            onProgram: (programBytes) => fontPrograms.set(instanceKey, programBytes),
        }));
    }
    const { pages, names } = setupPages(pdfDoc, fonts, list.pages);
    const elements = list.structure.elements;
    const colourWriting = list.writing.colour;
    const colour = colourWriting
        ? new ColorEmitter(context, { profileBytes: blobOf(list, colourWriting.profiles.cmyk), srgbBytes: blobOf(list, colourWriting.profiles.srgb), condition: colourWriting.condition, info: colourWriting.info, blackText: colourWriting.blackText })
        : null;
    // Every image is embedded before a page is written, because a page's /Resources /XObject has to name the streams the page's content refers to, and dedupe means one stream can be named by three pages. The list names each image by the walk's own index, and an item says which one it paints — by the index rather than by position since *the raster half of a continuation's drawing* (S42), because the measurement drops a picture that fell inside a straddling block's clipped tail. A resource no item paints is exactly that picture: nothing on any page refers to its stream, so nothing is embedded for it and its slot stays empty, which is what keeps `embeddedImages[image.index]` an answer.
    const imageContext = createImageContext(context);
    const embeddedImages: (EmbeddedImage|null)[] = [];
    // What each painted image is interpolated by: the item says, and the last item to paint an image decides, as the last measurement did.
    const interpolateOf: Map<number,boolean> = new Map<any, any>();
    for (const page of list.pages)
        for (const item of page.items)
            if (item.kind === 'image')
                interpolateOf.set(item.source, item.interpolate);
    const facsimileSlots: { index: number; loaded: LoadedFacsimile; }[] = [];
    for (const [key, request] of Object.entries(list.resources.images)) {
        const index = Number(key);
        const interpolate = interpolateOf.get(index);
        if (interpolate === undefined || (request.blob === undefined && request.samples === undefined && request.jpeg === undefined)) {
            embeddedImages.push(null);
            continue;
        }
        if (request.kind === 'facsimile') {
            // Embedded after the loop, all together (one copier per source file; DESIGN.md S80); the slot is filled there.
            facsimileSlots.push({ index, loaded: await reopenFacsimile(blobOf(list, request.blob as string), (request.facsimile as NonNullable<typeof request.facsimile>), request.domPath) });
            embeddedImages.push(null);
            continue;
        }
        // The image pass prepared every image before the list: a file passed through, the photo rule's JPEG, or the browser's pixels; the writer decodes nothing a browser must. A refusal names the element, as every refusal of this printer does (*an SVG that arrives through an `<img>` is a drawing*, S44).
        try {
            embeddedImages.push(await embedImage(imageContext, embedSourceOf(list, request, interpolate)));
        }
        catch (error) {
            if (error instanceof CasterError && error.element)
                throw error;
            throw new CasterError(`caster: the ${request.mime ?? request.original?.format} at ${request.domPath} (${request.src}) could not be carried into the file: ${error instanceof Error ? error.message : String(error)}`, { element: request.domPath });
        }
    }
    const facsimileEmbeds = await embedFacsimiles(imageContext, pdfDoc, facsimileSlots.map((slot) => slot.loaded));
    for (const [n, slot] of facsimileSlots.entries())
        embeddedImages[slot.index] = facsimileEmbeds[n];
    // The raster fallbacks of E9 (`vector-painting.md`) are images like any other, so they go through the writer of E7 (`images.md`) and share its dedupe: two identical shadows are one XObject. Each is keyed by the index the list gave it.
    const rasterImages: Map<number,EmbeddedImage> = new Map<any, any>();
    for (const [key, spec] of Object.entries(list.resources.rasters)) {
        if (spec.blob === undefined)
            continue;
        const samples = samplesFromRgba(blobOf(list, spec.blob), (spec.width as number), (spec.height as number));
        rasterImages.set(Number(key), await embedImage(imageContext, spec.jpeg
            ? { kind: 'jpeg', jpeg: blobOf(list, spec.jpeg), interpolate: true, format: 'canvas', bytesIn: samples.rgb.length, gammaOnly: false, ...(spec.photo ? { photo: spec.photo } : {}) }
            : { kind: 'samples', samples, interpolate: true, label: `${spec.feature}@${spec.dpi}dpi`, format: 'canvas', bytesIn: samples.rgb.length, ...(spec.photo ? { photo: spec.photo } : {}) }));
    }
    // E12A (`images.md`): one XObject per colour cluster, through the writer of E7 like every other image, so the `/SMask` and the dedupe are the ones E7 decided. Two occurrences of the same emoji at the same size are the same pixels and therefore the same object, which is the dedupe doing its job rather than a rule of E12's own. Untested: the `emoji` option is dormant in `print()`.
    const emojiImages: Map<number,EmbeddedImage> = new Map<any, any>();
    for (const [key, cluster] of Object.entries(list.resources.emoji)) {
        if (cluster.blob === undefined)
            continue;
        const samples = samplesFromRgba(blobOf(list, cluster.blob), (cluster.width as number), (cluster.height as number));
        emojiImages.set(Number(key), await embedImage(imageContext, { kind: 'samples', samples, interpolate: true, label: `emoji:${cluster.text}@${cluster.sizePx}px`, format: 'canvas', bytesIn: samples.rgb.length }));
    }
    const shadings = new ShadingBuilder(context);
    const transparency = new TransparencyBuilder(context);
    const sidecarPaints: ReportPaint[] = [];
    const vectorContext = {
        context,
        shadings,
        transparency,
        images: imageContext,
        rasters: rasterImages,
        resources: list.resources,
        records: sidecarPaints,
    };
    const pageScopes: ResourceScope[] = Array.from({ length: list.info.pageCount }, () => new ResourceScope());
    const streamOrder: string[] = [];
    const paragraphMcids: Map<number,{ page: number; mcid: number; }[]> = new Map<any, any>();
    const sidecarRuns: ReportEmissionRun[] = [];
    const sidecarWords: WordRecord[] = [];
    const sidecarArtifacts: ReportStructureArtifact[] = [];
    const imageUses: ImageUse[] = [];
    const linkItems: { item: LinkItem; page: number; }[] = [];
    const sidecarEmoji = [];
    const mcidOwnersByPage: string[][] = [];
    const pageStreams = [];
    // The MCID of each content start, by page and by the start's index in the page's items: the writer's own numbering, 0, 1, 2 … in item order on each page.
    const mcidAt: Map<number,number>[] = [];
    let kernAdjustments = 0;
    let actualTextSpans = 0;
    for (const [page, { items }] of list.pages.entries()) {
        const operators: PDFOperator[] = [];
        const mcidOwners = [];
        const pageMcids = new Map<number,number>();
        mcidAt.push(pageMcids);
        // The marked-content sequence the item being written sits in: `artifact` for one that owns no structure element, `group` for one that does.
        let artifact = false;
        let group: Group|null = null;
        let openLine: TextItem|null = null;
        let openLineIndex = -1;
        for (const [at, item] of items.entries()) {
            if (item.kind === 'tag') {
                if ('end' in item) {
                    if (openLine)
                        operators.push(pdf().PDFOperator.of(pdf().PDFOperatorNames.EndText), ...lineWrap(openLine.transform).close);
                    openLine = null;
                    operators.push(pdf().PDFOperator.of(pdf().PDFOperatorNames.EndMarkedContent));
                    artifact = false;
                    group = null;
                    continue;
                }
                const start = item.start;
                if ('artifact' in start) {
                    artifact = true;
                    group = null;
                    operators.push(pdf().PDFOperator.of(pdf().PDFOperatorNames.BeginMarkedContentSequence, [pdf().PDFName.of('Artifact'), artifactProperties(start.artifact)]));
                    if (start.path !== undefined) {
                        sidecarArtifacts.push({
                            path: start.path,
                            type: start.artifact.type,
                            ...(start.artifact.subtype ? { subtype: (start.artifact.subtype as 'Header' | 'Footer' | 'PageNum') } : {}),
                            page,
                            kind: (start.kind as 'paint' | 'image' | 'text'),
                        });
                    }
                }
                else {
                    const element = elementOf(elements, start.element, `the marked content at item ${at} of page ${page + 1}`);
                    artifact = false;
                    group = { element: start.element, page, mcid: pageMcids.size };
                    pageMcids.set(at, group.mcid);
                    mcidOwners[group.mcid] = element.path;
                    // pdf-lib's PDFOperatorArg union has no PDFDict member, so the inline property list is written as the literal it serialises to anyway.
                    operators.push(pdf().PDFOperator.of(pdf().PDFOperatorNames.BeginMarkedContentSequence, [pdf().PDFName.of(element.type), `<</MCID ${group.mcid}>>`]));
                }
                continue;
            }
            if (item.kind === 'shape' && 'rect' in item) {
                // A rectangle: a measured paint, in the colour the engine computed for it or, from E8 (`colour.md`) on, the colour the author declared, inside the overprint state the author asked for; or the page's own ground (`@page { background: … }`), which paints the page box and nothing in the DOM carries, goes first, and is not the colour emitter's to decide.
                operators.push(...rectOperators(item, item.paint ? colour : null));
                continue;
            }
            if (item.kind === 'marks') {
                // E12d (`coordinates-and-pages.md`): the page's own marks, outside everything a reader sees, stroked in the one colourant that reaches every plate.
                if (!colour) {
                    throw new CasterError('caster: print marks are stroked in the /All separation, which needs the colour options');
                }
                operators.push(pdf().PDFOperator.of(pdf().PDFOperatorNames.PushGraphicsState), ...colour.resources.strokeOperators({ kind: 'all', alternate: [1, 1, 1, 1], tint: 1 }), pdf().PDFOperator.of(pdf().PDFOperatorNames.SetLineWidth, [pdf().PDFNumber.of(MARK_STROKE_PT)]), pdf().PDFOperator.of(pdf().PDFOperatorNames.SetLineCapStyle, [pdf().PDFNumber.of(0)]), pdf().PDFOperator.of(pdf().PDFOperatorNames.SetLineJoinStyle, [pdf().PDFNumber.of(0)]), pdf().PDFOperator.of(pdf().PDFOperatorNames.SetLineDashPattern, ['[]', pdf().PDFNumber.of(0)]));
                const mark = (n: number): PDFNumber => pdf().PDFNumber.of(round3(n));
                for (const shape of item.shapes) {
                    for (const [ax, ay, bx, by] of shape.segments) {
                        operators.push(pdf().PDFOperator.of(pdf().PDFOperatorNames.MoveTo, [mark(ax), mark(ay)]), pdf().PDFOperator.of(pdf().PDFOperatorNames.LineTo, [mark(bx), mark(by)]));
                    }
                    if (shape.circle) {
                        const [start, ...curves] = circleSegments(shape.circle[0], shape.circle[1], shape.circle[2]);
                        operators.push(pdf().PDFOperator.of(pdf().PDFOperatorNames.MoveTo, start.map(mark)));
                        for (const curve of curves)
                            operators.push(pdf().PDFOperator.of(pdf().PDFOperatorNames.AppendBezierCurve, curve.map(mark)));
                    }
                }
                operators.push(pdf().PDFOperator.of(pdf().PDFOperatorNames.StrokePath), pdf().PDFOperator.of(pdf().PDFOperatorNames.PopGraphicsState));
                continue;
            }
            if (item.kind === 'image') {
                const embedded = (embeddedImages[item.source] as EmbeddedImage);
                const name = useOnPage(imageContext, embedded, pages[page], page);
                operators.push(...imageOperators(item, name, embedded.info.path === 'form' ? [embedded.info.width, embedded.info.height] : null));
                imageUses.push({ source: item.source, embedded, name: name.asString().slice(1) });
                continue;
            }
            if (item.kind === 'raster' && item.table === 'emoji') {
                const cluster = list.resources.emoji[item.source];
                const origin = (item.emojiOrigin as EmojiOrigin);
                const embedded = emojiImages.get(item.source);
                if (!embedded)
                    throw new CasterError(`caster: no raster for the colour cluster ${JSON.stringify(cluster.text)}`);
                // Same nesting rule as a vector: a picture is not a text object, so the open line is closed before it and reopened after. The `/Span` around it carries no MCID and is therefore not a content item — which is what makes it legal inside the group's own `BDC`, and is exactly the mechanism E4 (`font-embedding.md`) already uses for a glyph whose ToUnicode cannot name it.
                if (openLine) {
                    operators.push(pdf().PDFOperator.of(pdf().PDFOperatorNames.EndText), ...lineWrap(openLine.transform).close);
                    openLine = null;
                }
                const name = useOnPage(imageContext, embedded, pages[page], page);
                // `q … Q` around the whole of it, for the reason of E7 (`images.md`): a `cm` is not undone by anything else, and a picture that left one behind would move every word after it on the page. The chain of E10 (`coordinates-and-pages.md`), when the cluster carries one, goes inside the same pair.
                const chained = lineWrap(item.chain);
                operators.push(pdf().PDFOperator.of(pdf().PDFOperatorNames.BeginMarkedContentSequence, [pdf().PDFName.of('Span'), `<</ActualText <FEFF${utf16beHexOf((item.actualText as string))}> >>`]), pdf().PDFOperator.of(pdf().PDFOperatorNames.PushGraphicsState), ...chained.open, pdf().PDFOperator.of(pdf().PDFOperatorNames.ConcatTransformationMatrix, (item.transform as Matrix).map((n) => pdf().PDFNumber.of(n))), pdf().PDFOperator.of(pdf().PDFOperatorNames.DrawObject, [name]), ...chained.close, pdf().PDFOperator.of(pdf().PDFOperatorNames.PopGraphicsState), pdf().PDFOperator.of(pdf().PDFOperatorNames.EndMarkedContent));
                actualTextSpans += 1;
                sidecarEmoji.push({
                    owner: item.owner,
                    text: cluster.text,
                    codePoints: codePointsOf(cluster.text),
                    kind: clusterKindOf(cluster.text),
                    page,
                    face: origin.face,
                    rectLeftPt: origin.rectLeftPt,
                    rectWidthPt: origin.rectWidthPt,
                    placedRectPt: origin.rectPt,
                    xDeviationPt: round3(origin.rectPt[0] - origin.rectLeftPt),
                    ascentPx: origin.ascentPx,
                    descentPx: origin.descentPx,
                    xobjectName: name.asString().slice(1),
                    xobjectHash: embedded.hash,
                    hasSMask: embedded.info.hasSMask,
                    rasterPx: [embedded.info.width, embedded.info.height],
                    dpi: options.emoji?.rasterDpi ?? 0,
                });
                continue;
            }
            if (item.kind === 'text') {
                if (item.lineIndex !== openLineIndex || !openLine) {
                    if (openLine)
                        operators.push(pdf().PDFOperator.of(pdf().PDFOperatorNames.EndText), ...lineWrap(openLine.transform).close);
                    operators.push(...lineWrap(item.transform).open, pdf().PDFOperator.of(pdf().PDFOperatorNames.BeginText));
                    openLine = item;
                    openLineIndex = item.lineIndex;
                }
                const face = fontOf(fontByKey, item);
                const origin = options.originOf(page, at);
                emitRun(operators, item, {
                    origin,
                    context,
                    page,
                    mcid: group?.mcid ?? -1,
                    font: (fonts.get(item.font) as CidFont),
                    name: (names[page].get(item.font) as PDFName),
                    faceId: face.faceId,
                    upem: (face.upem as number),
                    sidecarRuns,
                    sidecarWords,
                    onKern: () => {
                        kernAdjustments += 1;
                    },
                    actualTextFor: toUnicode.actualTextFor,
                    onActualText: () => {
                        actualTextSpans += 1;
                    },
                    ...(colour ? { colorOperators: (textItem, textOrigin, textPage) => colour.runOperators(textItem, textOrigin, textPage) } : {}),
                });
                const mcids = paragraphMcids.get(origin.paragraph) ?? [];
                if (group?.mcid !== undefined && !mcids.some((m) => m.page === page && m.mcid === group?.mcid)) {
                    mcids.push({ page, mcid: group.mcid });
                    paragraphMcids.set(origin.paragraph, mcids);
                }
                continue;
            }
            if (item.kind === 'link') {
                // Not painted: the structure tree collects it, below.
                linkItems.push({ item, page });
                continue;
            }
            // A vector item: a shape, a group or a form of the node's own, or a raster fallback.
            const vector = (item as PlacedVector);
            // A BDC/EMC pair may sit inside a text object but a path may not, so an open line is closed before the geometry goes down — and if that line was wrapped in the `q <cm>` of E10 (`coordinates-and-pages.md`), the `Q` goes with it. Nesting rather than interleaving: every `q` the emitter opens is closed before the next one is opened, whether it came from `lineWrap` or from a vector item's own chain.
            if (openLine) {
                operators.push(pdf().PDFOperator.of(pdf().PDFOperatorNames.EndText), ...lineWrap(openLine.transform).close);
                openLine = null;
            }
            operators.push(...vectorOperators(vector, vectorContext, pageScopes[page], artifact));
            streamOrder.push(`${vector.origin.domPath}#${vector.origin.label}`);
        }
        mcidOwnersByPage.push(mcidOwners);
        pageScopes[page].applyToPage(context, pages[page]);
        pages[page].pushOperators(...operators);
        pageStreams.push(`${operators.map((op) => op.toString()).join('\n')}\n`);
    }
    const built = buildStructure(context, pages, list, mcidAt, linkItems.sort((a, b) => a.item.order - b.item.order));
    // --- E12F (`structure-tree.md`): the two catalog entries a reader expects and no rule demands ---
    let outlineItems;
    if (list.outline.length > 0) {
        const headings = [];
        for (const heading of list.outline) {
            const element = elementOf(elements, heading.element, `the bookmark ${JSON.stringify(heading.title)}`);
            headings.push({ path: element.path, ref: built.refs[heading.element], title: heading.title, level: heading.level, page: heading.page, topPt: heading.topPt });
        }
        const outline = buildOutline(context, headings);
        if (outline) {
            pdfDoc.catalog.set(pdf().PDFName.of('Outlines'), outline.ref);
            outlineItems = outline.items;
        }
    }
    if (list.pageLabels.length > 0) {
        const nums: (number|PDFDict)[] = [];
        // ISO 32000-2 §12.4.2: the number tree's first key is 0. A document whose first labelled page is not the first page still has to say what pages 0..n−1 are called, and an empty dictionary is the legal way to say "the default": decimal, no prefix, starting at 1. Without it the tree is non-conforming and a reader is entitled to ignore the whole of it.
        if (list.pageLabels[0].page !== 0) nums.push(0, context.obj({}));
        for (const run of list.pageLabels) {
            nums.push(run.page, context.obj({
                ...(run.label.style !== '' ? { S: pdf().PDFName.of(run.label.style) } : {}),
                // A text string, not a literal: `PDFString.of` escapes nothing, so a prefix carrying a parenthesis or a non-ASCII letter would break the object or arrive mangled.
                ...(run.label.prefix !== '' ? { P: textString(run.label.prefix) } : {}),
                ...(run.label.start !== 1 ? { St: run.label.start } : {}),
            }));
        }
        pdfDoc.catalog.set(pdf().PDFName.of('PageLabels'), context.register(context.obj({ Nums: nums })));
    }
    const faces: ReportEmissionFace[] = [];
    for (const instance of list.resources.fonts) {
        const stats = fonts.get(instance.key).finish();
        faces.push({ ...stats, url: instance.url });
    }
    // The colour resources go on last: a resource name is allocated the first time an element asks for it, so the complete set is only known once every page has been emitted.
    const colorSidecar = colour ? await colour.finish(pages, pdfDoc.catalog) : undefined;
    const info = {
        language: list.info.lang,
        title: list.info.title,
        // The producer is this package, not the harness it was ported from. The port kept every rule the experiments measured (P1) and kept this string with them, so every PDF BelType has printed so far names a repository its reader has no way to reach. `xmp:CreatorTool` and `pdf:Producer` both restate it — a PDF 2.0 reader is entitled to consult only the packet — so both are the same one string.
        producer: PRODUCER,
        creator: PRODUCER,
        // *The printer guesses, says so, and withdraws the claim* (S90): a guess in the tree withdraws the claim.
        conformance: list.info.conformance,
        created: list.info.created,
    };
    setInfo(pdfDoc, info);
    addXmpMetadata(pdfDoc, info);
    const bytes = await serialize(pdfDoc);
    // What the measurement alone knows (the trailing letter-spacing samples, the baseline probes, the paragraphs' text) and the walk alone knows (the headings, the tables, the languages) is the composition's to add: the writer reads the list and nothing else.
    const emission: Omit<ReportEmission,MeasuredEmissionKeys> = {
        pageCount: list.info.pageCount,
        baselineMethod: 'measureText',
        columnWidthPx: COLUMN_WIDTH_PX,
        kernAdjustments,
        actualTextSpans,
        faces,
        runs: sidecarRuns,
    };
    const structure: Omit<ReportStructure,'headings'> = {
        namespace: PDF_2_NAMESPACE,
        lang: list.info.lang,
        expectedTree: built.expectedTree,
        annots: built.annots,
        artifacts: sidecarArtifacts,
        pages: mcidOwnersByPage.map((mcidOwners) => ({ mcidOwners })),
        tagCounts: tagCountsOf(elements),
    };
    // D7: the report's version and fixture are gone; this is a partial report `src/index.js` folds into the one it hands back.
    const report = (({
        elements: [],
        emission,
        structure,
        ...(options.container ? { container: options.container } : {}),
        ...(options.pageBackgrounds?.length ? { pageBackgrounds: options.pageBackgrounds } : {}),
        ...(options.timing ? { timing: options.timing } : {}),
        ...(outlineItems ? { outline: outlineItems } : {}),
        ...(built.links.length > 0 ? { links: built.links } : {}),
        ...(options.smallItems?.skipInk ? { skipInk: options.smallItems.skipInk } : {}),
        ...(options.emoji
            ? { emoji: { ...options.emoji, clusters: sidecarEmoji, xobjects: new Set(sidecarEmoji.map((c) => c.xobjectHash)).size } }
            : {}),
        ...(options.conversion ? { conversion: options.conversion } : {}),
        ...(options.tables && options.tables.computedWidths.length > 0
            ? { computedBorderWidths: options.tables.computedWidths, gridLineSpreadPx: options.tables.gridLineSpreadPx }
            : {}),
        ...(options.decoderComparison ? { decoderComparison: options.decoderComparison } : {}),
        ...(colorSidecar ? { color: colorSidecar } : {}),
        ...(options.vector
            ? {
                paint: sidecarPaints,
                paintOrder: options.vector.order,
                deferred: options.vector.deferred,
                rasterDpi: options.vector.rasterDpi,
                vectorNotes: {
                    paintOrderMode: options.vector.paintOrder,
                    stackingContexts: options.vector.stackingContexts,
                    decorations: options.vector.decorations,
                    ctmReadings: options.vector.ctmReadings,
                    resources: {
                        shadings: shadings.count,
                        patterns: shadings.patternCount,
                        extGStates: transparency.stateCount,
                        forms: transparency.formCount,
                    },
                    streamOrder,
                    figures: options.vector.figures,
                },
            }
            : {}),
    } as unknown) as Partial<Report>);
    return { bytes, pageStreams, report, fontStats: faces, fontPrograms, paragraphMcids, wordRecords: sidecarWords, imageUses, xobjects: imageContext.byHash.size, idTree: built.ids };
}
/**
 * One image: the clip, the matrix, the `Do`.
 *
 * @remarks
 * `q … Q` around all of it, because a `cm` is not undone by anything else and a clip is not undone at all — an image that left either behind would move every word after it on the page. The clip goes in before the matrix so its path is in page coordinates and does not have to be un-transformed first.
 *
 * @param name - The XObject's resource name on this page.
 * @param formSize - A Form XObject's own width and height in points (a facsimile, DESIGN.md S80): the placement maps the UNIT SQUARE, and a form is drawn in its own units, so the matrix is scaled down to the unit square first.
 */
function imageOperators(image: ImageItem, name: PDFName, formSize: [number,number]|null = null): PDFOperator[] {
    const operators: PDFOperator[] = [pdf().PDFOperator.of(pdf().PDFOperatorNames.PushGraphicsState)];
    const clip = image.clip;
    if (clip) {
        for (const segment of clip) {
            if (segment.op === 'm')
                operators.push(pdf().PDFOperator.of(pdf().PDFOperatorNames.MoveTo, segment.to.map((n) => pdf().PDFNumber.of(n))));
            else if (segment.op === 'l')
                operators.push(pdf().PDFOperator.of(pdf().PDFOperatorNames.LineTo, segment.to.map((n) => pdf().PDFNumber.of(n))));
            else if (segment.op === 'c') {
                operators.push(pdf().PDFOperator.of(pdf().PDFOperatorNames.AppendBezierCurve, [...segment.c1, ...segment.c2, ...segment.to].map((n) => pdf().PDFNumber.of(n))));
            }
            else
                operators.push(pdf().PDFOperator.of(pdf().PDFOperatorNames.ClosePath));
        }
        operators.push(pdf().PDFOperator.of(pdf().PDFOperatorNames.ClipNonZero), pdf().PDFOperator.of(pdf().PDFOperatorNames.EndPath));
    }
    const cm = formSize ? mul([1 / formSize[0], 0, 0, 1 / formSize[1], 0, 0], image.transform) : image.transform;
    operators.push(pdf().PDFOperator.of(pdf().PDFOperatorNames.ConcatTransformationMatrix, cm.map((n) => pdf().PDFNumber.of(n))), pdf().PDFOperator.of(pdf().PDFOperatorNames.DrawObject, [name]), pdf().PDFOperator.of(pdf().PDFOperatorNames.PopGraphicsState));
    return operators;
}
/**
 * What one image source hands the embed: the photo rule's JPEG, the decoded samples, or the file.
 *
 * @throws {CasterError} A source that names no blob the list holds.
 */
function embedSourceOf(list: DisplayList, source: ImageSource, interpolate: boolean): EmbedSource {
    const photo = source.photo ? { photo: source.photo } : {};
    const bytesIn = source.original?.bytes ?? 0;
    const format = source.original?.format ?? source.mime ?? '';
    if (source.jpeg !== undefined)
        return { kind: 'jpeg', jpeg: blobOf(list, source.jpeg), interpolate, format, bytesIn, gammaOnly: source.original?.gammaOnly === true, ...photo };
    if (source.samples !== undefined) {
        const { blob, width, height, colorSpace, bitsPerComponent } = source.samples;
        if (colorSpace !== 'DeviceRGB' || bitsPerComponent !== 8)
            throw new CasterError(`caster: the samples of ${source.domPath} are ${String(colorSpace)} at ${String(bitsPerComponent)} bits, and the writer reads 8-bit DeviceRGB samples only`);
        return { kind: 'samples', samples: samplesFromRgba(blobOf(list, blob), width, height), interpolate, label: format, format, bytesIn, ...photo };
    }
    return { kind: 'bytes', bytes: blobOf(list, source.blob as string), mimeType: source.mime as string, interpolate, ...photo, ...(source.refusal !== undefined ? { refusal: source.refusal } : {}) };
}
/**
 * The `/URI` of a link that leaves the file, as the list resolved it.
 *
 * @throws {CasterError} A link with no destination and no URI.
 */
function uriOf(link: LinkItem): string {
    if (link.target.uri === undefined)
        throw new CasterError(`caster: the link of order ${link.order} has neither a destination in the file nor a URI; the builder resolves one for every link without a destination`);
    return link.target.uri;
}
/**
 * An instance's advance for a glyph, read from the list's widths and from nowhere else.
 *
 * @throws {CasterError} A glyph the list holds no width for, naming the instance and the glyph.
 */
function widthsOf(instanceKey: string, instance: FontInstance): (gid: number) => number {
    const byGid = new Map(instance.widths.gids.map((gid, at) => [gid, instance.widths.units[at]]));
    return (gid) => {
        const units = byGid.get(gid);
        if (units === undefined)
            throw new CasterError(`caster: the display list holds no width for glyph ${gid} of ${instanceKey}; the builder writes one for every glyph a text item shows and every space glyph it names`);
        return units;
    };
}
/**
 * The bytes a blob key names.
 *
 * @throws {CasterError} A key the list holds no bytes for.
 */
function blobOf(list: DisplayList, key: string): Uint8Array {
    const bytes = list.resources.blobs[key];
    if (!bytes)
        throw new CasterError(`caster: the display list names the blob ${key} and holds no bytes for it`);
    return bytes;
}
/** UTF-16BE hex, which is what an `/ActualText` value is once the BOM is on it. */
function utf16beHexOf(text: string): string {
    let out = '';
    for (let i = 0; i < text.length; i++)
        out += text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
    return out;
}
/** The literal an artifact's property list serialises to. */
function artifactProperties(artifact: ArtifactDescriptor): string {
    return artifact.subtype
        ? `<</Type /${artifact.type} /Subtype /${artifact.subtype}>>`
        : `<</Type /${artifact.type}>>`;
}
/**
 * One filled rectangle: a measured paint, or the page's own ground.
 *
 * @remarks
 * In the colour the engine computed for it — or, from E8 (`colour.md`) on, in the colour the author declared for it, inside the overprint state the author asked for. The ground passes no colour emitter and is `rg` always. The rectangle's numbers are the builder's, already to thousandths.
 */
function rectOperators(item: RectItem, colour: ColorEmitter|null): PDFOperator[] {
    const [x, bottom, width, height] = item.rect;
    const fill = item.fill;
    const colours = colour?.paintOperators(item, [x, bottom, width, height]);
    return [
        pdf().PDFOperator.of(pdf().PDFOperatorNames.PushGraphicsState),
        ...(colours?.setup ?? []),
        ...(colours ? colours.fill : [pdf().PDFOperator.of(pdf().PDFOperatorNames.NonStrokingColorRgb, fill.rgb.map((c) => pdf().PDFNumber.of(round3(c))))]),
        pdf().PDFOperator.of(pdf().PDFOperatorNames.AppendRectangle, [
            pdf().PDFNumber.of(x),
            pdf().PDFNumber.of(bottom),
            pdf().PDFNumber.of(width),
            pdf().PDFNumber.of(height),
        ]),
        pdf().PDFOperator.of(pdf().PDFOperatorNames.FillNonZero),
        ...(colours?.reset ?? []),
        pdf().PDFOperator.of(pdf().PDFOperatorNames.PopGraphicsState),
    ];
}
/**
 * The element at `index`.
 *
 * @param what - What names it, for the refusal.
 * @throws {CasterError} No element has that index.
 */
function elementOf(elements: StructElement[], index: number, what: string): StructElement {
    const element = Number.isInteger(index) ? elements[index] : undefined;
    if (!element)
        throw new CasterError(`caster: ${what} names structure element ${String(index)}, and the list's tree has ${elements.length}`);
    return element;
}
/**
 * Hold the list's tree to the shape the writer writes from: a tree rooted at element 0, every child index in range and listed once, every content child a content start that names the element back, every link child a link owned by it.
 *
 * @returns Each element's parent, by index; the root's is -1.
 * @throws {CasterError} The first thing in the tree that is not so, named.
 */
function checkTree(list: DisplayList, mcidAt: Map<number,number>[], linkOwners: Map<number,number>): number[] {
    const elements = list.structure.elements;
    if (elements.length === 0)
        throw new CasterError('caster: the display list\'s structure tree has no elements; element 0 is the root');
    const parent: number[] = elements.map(() => -2);
    parent[0] = -1;
    const claimed = new Set<string>();
    elements.forEach((element, index) => {
        for (const child of element.children) {
            const where = `structure element ${index} (${element.path})`;
            if (typeof child === 'number') {
                if (!Number.isInteger(child) || child <= 0 || child >= elements.length)
                    throw new CasterError(`caster: ${where} lists child ${String(child)}, which is not an element below the root`);
                if (parent[child] !== -2)
                    throw new CasterError(`caster: ${where} lists element ${child}, which ${parent[child] === index ? 'it already lists' : `element ${parent[child]} lists too`}; an element has one parent`);
                parent[child] = index;
            }
            else if ('link' in child) {
                if (linkOwners.get(child.link) !== index)
                    throw new CasterError(`caster: ${where} lists the link of order ${String(child.link)}, which ${linkOwners.has(child.link) ? `element ${linkOwners.get(child.link)} owns` : 'no link item has'}`);
            }
            else {
                const page = list.pages[child.page];
                const item = page?.items[child.item];
                if (!item || item.kind !== 'tag' || !('start' in item) || !('element' in item.start))
                    throw new CasterError(`caster: ${where} lists item ${String(child.item)} of page ${String(child.page)}, which is not a content start`, { listItem: { page: child.page, item: child.item } });
                if (item.start.element !== index)
                    throw new CasterError(`caster: ${where} lists item ${child.item} of page ${child.page + 1}, which opens content for element ${item.start.element}`, { listItem: { page: child.page, item: child.item } });
                const key = `${child.page}:${child.item}`;
                if (claimed.has(key))
                    throw new CasterError(`caster: ${where} lists item ${child.item} of page ${child.page + 1} twice`, { listItem: { page: child.page, item: child.item } });
                claimed.add(key);
            }
        }
    });
    const orphan = parent.indexOf(-2);
    if (orphan >= 0)
        throw new CasterError(`caster: structure element ${orphan} (${elements[orphan].path}) is no element's child, so the tree does not reach it`);
    // One parent each and the root nobody's child: an element the root does not reach sits on a cycle.
    elements.forEach((_, index) => {
        const seen = new Set<number>();
        for (let at = index; at !== -1; at = parent[at]) {
            if (seen.has(at))
                throw new CasterError(`caster: structure element ${index} (${elements[index].path}) is its own ancestor; the tree has a cycle`);
            seen.add(at);
        }
    });
    mcidAt.forEach((mcids, page) => {
        for (const item of mcids.keys()) {
            if (!claimed.has(`${page}:${item}`))
                throw new CasterError(`caster: the content start at item ${item} of page ${page + 1} is in no element's children`, { listItem: { page, item } });
        }
    });
    return parent;
}
/**
 * Write the structure tree, the ParentTree, the link annotations and the catalog entries that point at them.
 *
 * @remarks
 * The tree is the list's, resolved by the builder (`displayList/structure.js`): the writer prunes, orders and looks up nothing. Refs are allocated in the array's order before any dictionary is filled, because the tree is doubly linked: an element names its parent and its parent lists its kids. What the writer derives, it derives from the children: `/P`; `/Pg` with bare MCIDs where all of an element's content is on one page, `/MCR` dictionaries otherwise; the ParentTree, one array per page indexed by MCID, then one entry per link an element ends with; the `/IDTree`.
 *
 * @param mcidAt - Each page's MCIDs, by the index of the content start in its items.
 * @param linkItems - The list's link items with the page each sits on, in `order`.
 * @throws {CasterError} A tree that is not one (see `checkTree`); a link whose `order` is not its place; a link with neither a destination nor a URI; two elements with one `/ID`; a trailer with no Root.
 */
function buildStructure(context: PDFContext, pages: PDFPage[], list: DisplayList, mcidAt: Map<number,number>[], linkItems: { item: LinkItem; page: number; }[]): BuildResult {
    const elements = list.structure.elements;
    const pageCount = list.pages.length;
    const linkOwners = new Map<number,number>();
    linkItems.forEach(({ item }, index) => {
        if (item.order !== index)
            throw new CasterError(`caster: the link at place ${index} among the document's links has order ${item.order}; the orders run 0, 1, 2 …, and the /StructParent numbering follows them`);
        elementOf(elements, item.element, `the link of order ${item.order}`);
        linkOwners.set(item.order, item.element);
    });
    const parent = checkTree(list, mcidAt, linkOwners);
    const namespaceRef = context.register(context.obj({ Type: 'Namespace', NS: pdf().PDFString.of(PDF_2_NAMESPACE) }));
    const annots: ReportStructureAnnot[] = [];
    const links: ReportLink[] = [];
    const annotRefs: PDFRef[] = [];
    const pendingDestinations: { dict: PDFDict; dest: NonNullable<LinkTarget['dest']>; }[] = [];
    for (const { item: annot, page: annotPage } of linkItems) {
        const structParent = pageCount + annot.order;
        const page = pages[annotPage];
        const quads = annot.rects.flatMap(([x0, top, x1, bottom]) => [x0, top, x1, top, x0, bottom, x1, bottom]);
        const xs = quads.filter((_, i) => i % 2 === 0);
        const ys = quads.filter((_, i) => i % 2 === 1);
        const rectPt: [number,number,number,number] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        // E12F (`structure-tree.md`): a link inside the file is a destination, not an action. `/Dest` takes the reader to a place in this document with its own history and back button; a `/URI` naming a fragment would send it out to a resolver that has no idea what document it is already in. External addresses and `mailto:` stay `/URI`, which is what they are.
        // No /Alt on the Link element: 8.9.4.2 t1 makes an /Alt that differs from the annotation's /Contents a failure, and there is nothing an /Alt could say here that the link text does not already say.
        const annotDict = context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: rectPt,
            QuadPoints: quads,
            // An internal link's `/Dest` is filled in after the tree is allocated: it names a structure element, and no element has a ref yet.
            // §12.6.4.8: the URI is an ASCII string, and it is the absolute one. `PDFString.of` escapes nothing, so a non-ASCII IRI arrived truncated at the first byte above 127, and a relative `href` shipped as the author wrote it, which resolves against nothing once the file leaves the server.
            ...(annot.target.dest ? {} : { A: { S: 'URI', URI: textString(uriOf(annot)) } }),
            Contents: textString(annot.contents),
            F: ANNOTATION_PRINT_FLAG,
            Border: [0, 0, 0],
            StructParent: structParent,
            P: page.ref,
        });
        const annotRef = context.register(annotDict);
        annotRefs.push(annotRef);
        if (annot.target.dest)
            pendingDestinations.push({ dict: annotDict, dest: annot.target.dest });
        const ownerPath = elements[annot.element].path;
        links.push({
            ownerPath,
            href: annot.target.href,
            kind: annot.target.kind,
            action: annot.target.dest ? 'Dest' : 'URI',
            page: annotPage,
            ...(annot.target.targetId ? { targetId: annot.target.targetId } : {}),
            ...(annot.target.dest
                ? {
                    destPage: annot.target.dest.page,
                    destLeftPt: annot.target.dest.x,
                    destTopPt: annot.target.dest.y,
                    destStructPath: annot.target.dest.struct,
                }
                : {}),
        });
        page.node.addAnnot(annotRef);
        // 8.9.3.3 t1: a page carrying an annotation has to declare a tab order. /S is "use the structure order", which is the only honest answer for a file whose reading order is the structure tree.
        page.node.set(pdf().PDFName.of('Tabs'), pdf().PDFName.of('S'));
        annots.push({ structParent, page: annotPage, ownerPath, href: annot.target.href, contents: annot.contents, rectPt, quads });
    }
    const refs = elements.map(() => context.nextRef());
    const rootRef = context.nextRef();
    const parentsByPage: PDFRef[][] = Array.from({ length: pageCount }, () => []);
    const parentsByAnnot: PDFRef[] = [];
    /** Every element that carries an `/ID`, in the array's order. */
    const idRefs: { id: string; ref: PDFRef; }[] = [];
    const contentsOf = (element: StructElement) => element.children.filter((c): c is { page: number, item: number } => typeof c === 'object' && 'page' in c);
    elements.forEach((element, index) => {
        const ref = refs[index];
        const contents = contentsOf(element);
        const mcidOf = (c: { page: number, item: number }) => mcidAt[c.page].get(c.item) as number;
        for (const c of contents)
            parentsByPage[c.page][mcidOf(c)] = ref;
        // A single page behind every content item lets /K carry bare integers and the element carry /Pg; content on two pages has to name its page per item through /MCR dictionaries, and then /Pg would be a lie.
        const onePage = contents.length > 0 && contents.every((c) => c.page === contents[0].page);
        const kids = element.children.map((child) => {
            if (typeof child === 'number')
                return refs[child];
            if ('link' in child) {
                parentsByAnnot[child.link] = ref;
                return context.obj({ Type: 'OBJR', Pg: pages[linkItems[child.link].page].ref, Obj: annotRefs[child.link] });
            }
            return onePage ? mcidOf(child) : context.obj({ Type: 'MCR', Pg: pages[child.page].ref, MCID: mcidOf(child) });
        });
        const attributes = (element.attributes ?? []).map(attributeObject);
        if (element.id)
            idRefs.push({ id: element.id, ref });
        context.assign(ref, context.obj({
            Type: 'StructElem',
            S: element.type,
            NS: namespaceRef,
            P: parent[index] === -1 ? rootRef : refs[parent[index]],
            ...(onePage ? { Pg: pages[contents[0].page].ref } : {}),
            ...(element.lang ? { Lang: pdf().PDFString.of(element.lang) } : {}),
            ...(element.alt ? { Alt: textString(element.alt) } : {}),
            // E12F (`structure-tree.md`): `/E` is the expansion of an abbreviation, and 32000-2 still has it as a structure-element entry — probed against veraPDF rather than assumed.
            ...(element.expansion ? { E: textString(element.expansion) } : {}),
            // 14.7.5.2: an element's /ID is a byte string, and it is what /Headers and the /IDTree name it by.
            ...(element.id ? { ID: pdf().PDFString.of(element.id) } : {}),
            // `/A` is the dictionary itself when there is one, which is byte for byte what E5 through E10 (`coordinates-and-pages.md`) wrote, and an array when there is more than one.
            ...(attributes.length === 1 ? { A: attributes[0] } : {}),
            ...(attributes.length > 1 ? { A: attributes } : {}),
            K: kids,
        }));
    });
    // One flat number tree: page keys first, then one key per annotation. A page entry is an array indexed by MCID; an annotation entry is the element itself. Nothing here needs /Kids until a document has thousands of pages.
    const nums: (number|PDFRef[]|PDFRef)[] = [];
    parentsByPage.forEach((pageRefs, page) => {
        pages[page].node.set(pdf().PDFName.of('StructParents'), pdf().PDFNumber.of(page));
        nums.push(page, pageRefs);
    });
    parentsByAnnot.forEach((ref, index) => nums.push(pageCount + index, ref));
    const parentTreeRef = context.register(context.obj({ Nums: nums }));
    // The /IDTree is a name tree and a name tree's keys are sorted by byte value (7.9.6), so the sort is a plain code-unit comparison of the ids as written rather than a locale one. One flat node: /Kids exists for a tree with more keys than a reader wants to scan, and a document's worth of table cells is not that. Duplicates are the one thing that would make the tree a lie, so they throw here rather than being resolved to whichever came last.
    const sortedIds = [...idRefs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (let i = 1; i < sortedIds.length; i++) {
        if (sortedIds[i].id === sortedIds[i - 1].id)
            throw new CasterError(`caster: two elements carry the /ID ${JSON.stringify(sortedIds[i].id)}`);
    }
    const idTreeRef = sortedIds.length > 0
        ? context.register(context.obj({ Names: sortedIds.flatMap((entry) => [pdf().PDFString.of(entry.id), entry.ref]) }))
        : null;
    context.assign(rootRef, context.obj({
        Type: 'StructTreeRoot',
        K: [refs[0]],
        Namespaces: [namespaceRef],
        ParentTree: parentTreeRef,
        ParentTreeNextKey: pageCount + parentsByAnnot.length,
        ...(idTreeRef ? { IDTree: idTreeRef } : {}),
    }));
    // The catalog is reached the way the plan asks for it, through the trailer, rather than through the PDFDocument wrapper: the builder is handed a context and nothing else, which is the shape a replacement writer would have to offer.
    const catalog = (context.lookup(context.trailerInfo.Root) as PDFDict);
    if (!catalog)
        throw new CasterError('caster: the trailer has no Root');
    catalog.set(pdf().PDFName.of('StructTreeRoot'), rootRef);
    catalog.set(pdf().PDFName.of('MarkInfo'), context.obj({ Marked: true }));
    // E12F (`structure-tree.md`): the structure destinations, now that every element has a ref. The element is the builder's: the first at or under the one the fragment named with content of its own, whose `/Pg` gives the destination its page.
    for (const { dict, dest } of pendingDestinations) {
        elementOf(elements, dest.element, `the destination at ${dest.struct}`);
        dict.set(pdf().PDFName.of('Dest'), context.obj([refs[dest.element], pdf().PDFName.of('XYZ'), dest.x, dest.y, null]));
    }
    /** The tree in the report's shape, which is the shape the node checker reads back: content in the order it was written, kids in reading order. */
    const expected = (index: number): ReportStructureNode => {
        const element = elements[index];
        const contents = contentsOf(element).sort((a, b) => a.page - b.page || a.item - b.item);
        const onePage = contents.length > 0 && contents.every((c) => c.page === contents[0].page);
        const link = element.children.find((c): c is { link: number } => typeof c === 'object' && 'link' in c);
        return {
            tag: element.type,
            path: element.path,
            ...(onePage ? { pg: contents[0].page } : {}),
            mcids: contents.map((c) => ({ page: c.page, mcid: mcidAt[c.page].get(c.item) as number })),
            attrs: reportAttrs(element),
            ...(link ? { objr: { page: linkItems[link.link].page, structParent: pageCount + link.link } } : {}),
            kids: element.children.filter((c): c is number => typeof c === 'number').map(expected),
        };
    };
    return { refs, annots, ids: sortedIds.map((entry) => entry.id), links, expectedTree: expected(0) };
}
/** One attribute object as pdf-lib writes it: every string a name, but a `Headers` entry, which is a byte string. The keys keep the list's order. */
function attributeObject(attribute: StructAttribute): Record<string, string|number|number[]|PDFString[]> {
    return Object.fromEntries(Object.entries(attribute).map(([key, value]) => [key, key === 'Headers' ? (value as string[]).map((id) => pdf().PDFString.of(id)) : (value as string|number|number[])]));
}
/** What the report's tree records of an element's attributes, in the walk's names. */
function reportAttrs(element: StructElement): ReportStructureNode['attrs'] {
    const attrs: ReportStructureNode['attrs'] = {};
    for (const attribute of element.attributes ?? []) {
        if (attribute.O === 'List')
            attrs.listNumbering = attribute.ListNumbering;
        else if (attribute.O === 'Table') {
            if (attribute.Scope)
                attrs.scope = attribute.Scope;
            if (attribute.Headers)
                attrs.headers = attribute.Headers;
            if (attribute.RowSpan)
                attrs.rowSpan = attribute.RowSpan;
            if (attribute.ColSpan)
                attrs.colSpan = attribute.ColSpan;
        }
        else if ('TextPosition' in attribute)
            attrs.textPosition = attribute.TextPosition;
    }
    if (element.lang)
        attrs.lang = element.lang;
    if (element.alt)
        attrs.alt = element.alt;
    if (element.expansion)
        attrs.expansion = element.expansion;
    if (element.id)
        attrs.id = element.id;
    return attrs;
}
/** How many elements of each type the tree carries, sorted by type. */
function tagCountsOf(elements: StructElement[]): { tag: string; count: number; }[] {
    const counts = new Map<string,number>();
    for (const element of elements)
        counts.set(element.type, (counts.get(element.type) ?? 0) + 1);
    return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([tag, count]) => ({ tag, count }));
}
