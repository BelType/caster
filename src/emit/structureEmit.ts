/**
 * `emit/structureEmit.js` — the composition: the text, the vectors, the images, the colour and the structure tree that makes it all readable.
 *
 * Ported from `harness/src/export/structureEmit.ts` (E5, E7, E8, E9, E10, E11, E12A–F). Guide: `docs/guide/structure-tree.md`, and every capability document under it.
 *
 * THE WRITER (stages 2 and 4 of `.claude/plans/the-display-list/`). `emitStructure` reads a {@link DisplayList} and nothing else: the deciding half (what goes on which page, in which order, under which marked content, with which MCID) lives in `displayList/build.js`, the bytes it needs are in `resources.blobs`, and every length arrives in the page's points. It reads no page geometry, no measurement and no walk. The file is byte-identical to the one the same document had before the move (`npm run identity`). What the report keeps of the measurement and the walk is added by `print()`.
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
import { shaperVariations } from '../fonts/axisMap.ts';
import { embedFace, WHOLE_FONT_PROFILE } from '../fonts/fontEmbed.ts';
import { glyphAdvance } from '../fonts/hbShaper.ts';
import { createImageContext, embedImage, useOnPage } from '../images/imageEmbed.ts';
import { embedFacsimiles, reopenFacsimile } from '../images/facsimile.ts';
import { mul } from '../images/imagePlace.ts';
import { PHOTO_PIXEL_THRESHOLD, PHOTO_PSNR_TARGET, PHOTO_RUN_THRESHOLD, PHOTO_UNIQUE_RATIO_THRESHOLD } from '../images/photoRule.ts';
import { addXmpMetadata, createDocument, serialize, setInfo } from './document.ts';
import { COLUMN_WIDTH_PX } from '../coordinates/units.ts';
import { keepWhenEmpty } from '../walk/structure.ts';
import { emitRun, lineWrap, round3, setupPages } from './textEmit.ts';
import { samplesFromRgba } from '../images/canvasDecode.ts';
import { MARK_STROKE_PT, circleSegments } from '../coordinates/printMarks.ts';
import { buildOutline } from './outline.ts';

/** What wrote the file, for the Info dictionary and the XMP packet alike. Named once here rather than at the two call sites, so the two can never disagree — a reader is entitled to consult either. */
const PRODUCER = 'BelType Caster';
import { clusterKindOf, codePointsOf } from '../measure/emoji.ts';

const pdf = () => capability('pdf');

import type { CidFont, FontProfile, CidFontStats } from '../fonts/fontEmbed.ts';
import type { ToUnicodeResult } from '../fonts/toUnicode.ts';
import type { EmbeddedImage } from '../images/imageEmbed.ts';
import type { LoadedFacsimile } from '../images/facsimile.ts';
import type { Matrix } from '../images/imagePlace.ts';
import type { DisplayList, EmojiOrigin, Fill, FormItem, GroupItem, ImageItem, LinkItem, LinkTarget, PlacedVector, RasterItem, RectItem, TextItem, TextOrigin, ArtifactStart } from '../displayList.ts';
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

/** The records the list holds, named for what the writer reads of them; each is a type the list owns (`displayList.js`). What this module still imports from the walk and the measurement is three pure functions of a tag or a string (`keepWhenEmpty`, `clusterKindOf`, `codePointsOf`) and one cell type, and no record either produced. */
export type StructureNode = DisplayList['structure'];

export type ArtifactDescriptor = ArtifactStart['artifact'];

/** The members of the report's `emission` that only the measurement knows, which `print()` adds. */
export type MeasuredEmissionKeys = 'trailingLetterSpacing' | 'trailingSamples' | 'baselineAgreementPt' | 'usableProbes' | 'probeMoved' | 'probeOffLine' | 'probeBeforeOffLine' | 'containerScrollWidthPx' | 'paragraphs' | 'words' | 'marginPt' | 'pageWidthPt' | 'pageHeightPt';

/**
 * The colour options, as `emitStructure` is handed them.
 *
 * @remarks
 * `any`, and not `colour/colorResources.js`'s `ColorOptions` (the harness declared it in `colorHints.ts`): `src/index.js` builds this object with `convertRgb` as the flag's string, where `ColorOptions.convertRgb` is a `{ mode, cmykOf }` transform. The string never arrives — `index.js` refuses every `convertRgb` other than `'none'` before it builds the options — so the mismatch is unreachable, and naming the type here would fail the check in a file this one does not own.
 */
export type ColorOptions = any;

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

/** One attribute object's entries, before they become a `/A` dictionary. */
export type AttributeDict = Record<string, string|number|PDFString|number[]|PDFString[]>;

/** Everything `emitStructure` is told beyond the list; every member is optional because each is an experiment's addition, and each is absent in every fixture before it. */
export type EmitStructureOptions = {
  /** How the fonts are written. The default is that of E5 (`structure-tree.md`): the whole file, integer widths, no axes — which is what keeps E5's content streams byte-identical to the ones E3 (`text-emission.md`) wrote. */
  fontProfile?: FontProfile;
  /** The document-wide ToUnicode map with its ambiguity rule. Without it each glyph's destination is the first text it was used for, which is the rule of E3 (`text-emission.md`) and is right for a document where no CID is ambiguous. */
  toUnicode?: ToUnicodeResult;
  /** The PNG-decoder comparison the browser measured, for the report. */
  decoderComparison?: ReportDecoderComparison;
  /** The colour story of E8 (`colour.md`): the profiles, the output condition and the black-text policy. Absent, every colour is `rg` from the computed style, no page carries a `/ColorSpace` and the catalog carries no `/OutputIntents`, which is the file of E3 (`text-emission.md`), E4 (`font-embedding.md`) and E5 (`structure-tree.md`) byte for byte. */
  color?: ColorOptions;
  /** E9 (`vector-painting.md`): vector painting. Absent, no vector is emitted and the order is DOM order. */
  vector?: VectorEmitOptions;
  /** What only the report reads of the text item at `index` in page `page`'s list: its run, paragraph, block path, computed colour, hint and ink box. `print()` holds it; the list does not. */
  originOf: (page: number, index: number) => TextOrigin;
  /** Whether the opaque-photo rule may re-encode a raster as JPEG: the `photoRule` flag. */
  photoRule?: boolean;
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
  /** The document's own URL, which a relative `href` in a link annotation resolves against. Absent, a relative href ships as written. */
  baseUri?: string;
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
/** One content item that owns a structure element: consecutive units on one page with one owner, written as one `BDC … EMC`. An artifact group carries no MCID and appears nowhere in the tree, so the list's tag starts that open one are not groups. */
export type Group = {
  owner: string;
  page: number;
  /** The group's place in reading order across the whole document: page-major, then the DOM rank of the item the group came from, then the group's own position within that item. It is the only ordering key the structure tree has — `/K` is sorted on it and a destination's page is the page of the lowest one — and it is deliberately not the emission counter, because under `paintOrder: 'css'` the emission order is the painting order and a float's ink is emitted before in-flow text it follows in the document. */
  seq: number;
  mcid: number;
};
/** One structure element as the builder holds it: its node, its kept kids, and the content it owns. */
export type Built = {
  node: StructureNode;
  kids: Built[];
  mcids: { page: number; mcid: number; seq: number }[];
  /** The link annotation a `Link` element points at. */
  objr?: { page: number; structParent: number; annot: PDFRef; seq: number };
  /** Allocated before any dictionary is filled. */
  ref?: PDFRef;
};
/** The allocated tree, and what the outline, the links and the `/IDTree` need to know about it. */
export type BuildResult = {
  root: Built;
  annots: ReportStructureAnnot[];
  /** Every `/ID` in the file, in the order the `/IDTree` lists them. */
  ids: string[];
  /** E12F (`structure-tree.md`): every link and which of the two actions it became. */
  links: ReportLink[];
  /** E12F (`structure-tree.md`): the structure element every kept path became. A destination inside the file has to name a structure element (PDF/UA-2 8.8 t1), so the outline needs the ref of the heading it points at and the link needs the ref of the section it points at; both are known only once the tree has been allocated, and this is how they reach the caller. */
  refByPath: Map<string, PDFRef>;
  /** E12F (`structure-tree.md`): for an element with content on exactly one page, that page. A structure destination resolves its page through the element's `/Pg`, and a grouping element that owns no content of its own has none — so the emitter walks down to the first descendant that does, and this is the map it walks with. */
  pageByPath: Map<string, number>;
  /** E12F (`structure-tree.md`): the tree as paths, so the walk down to a page-bearing descendant is possible. */
  kidPathsByPath: Map<string, string[]>;
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
/**
 * An `href` as an absolute, ASCII, percent-encoded URI — what §12.6.4.8's `/URI` entry is.
 *
 * @remarks
 * `encodeURI` rather than `encodeURIComponent`: the reserved characters that structure a URL have to survive. A value the URL parser cannot resolve is left as the author wrote it, because a link the printer cannot understand is still a link the author meant.
 *
 * @param base - The document's own URL; absent, a relative `href` is left as written.
 */
function absoluteUri(href: string, base?: string): string {
    try {
        return encodeURI(new URL(href, base).href);
    } catch {
        return href;
    }
}

/** The PDF 2.0 standard structure namespace; every element points at it. */
export const PDF_2_NAMESPACE = 'http://iso.org/pdf2/ssn';
/** Annotation flag bit 3, Print. Required of every annotation by PDF/UA. */
const ANNOTATION_PRINT_FLAG = 4;
/**
 * The whole file: every page's content items, the structure tree over them, and every document-level object the options ask for.
 *
 * @throws {CasterError} A used instance or an image with no bytes, images with no `imageAssets`, an image no decoder tier could carry (naming its element, *an SVG that arrives through an `<img>` is a drawing*, DESIGN.md S44); a colour cluster with no raster; a structure path no element has; print marks without colour options; a bookmark to a heading that was pruned; a link or destination with no structure element; two elements with one `/ID`; and every refusal of the modules it composes.
 */
export async function emitStructure(list: DisplayList, options: EmitStructureOptions): Promise<EmitStructureResult> {
    const pdfDoc = await createDocument();
    const context = pdfDoc.context;
    const profile = options.fontProfile ?? WHOLE_FONT_PROFILE;
    const fonts = new Map<any, any>();
    const fontPrograms = new Map<any, any>();
    for (const [instanceKey, instance] of Object.entries(list.resources.fonts)) {
        const bytes = blobOf(list, instance.blob);
        const perInstance = options.toUnicode?.byInstance.get(instanceKey);
        fonts.set(instanceKey, embedFace(context, {
            id: instanceKey,
            faceId: instance.faceId,
            family: instance.family,
            bytes,
            sourceFormat: instance.sourceFormat,
            coords: instance.coords,
            advanceOf: (gid) => glyphAdvance(instance.url, gid, shaperVariations(instance.coords)),
            profile,
            ...(perInstance ? { toUnicodeText: perInstance.text, cidToText: perInstance.cidToText } : {}),
            ...(perInstance ? { ambiguousCids: perInstance.ambiguous.map((a) => a.cid) } : {}),
            onProgram: (programBytes) => fontPrograms.set(instanceKey, programBytes),
        }));
    }
    const { pages, names } = setupPages(pdfDoc, fonts, list.pages);
    // Every structure node by its path, read once: the list's tree is not changed by the writer, and `buildStructure` prunes its own copy of it.
    const nodes = nodesByPath(list.structure);
    const colour = options.color ? new ColorEmitter(context, options.color) : null;
    // Every image is embedded before a page is written, because a page's /Resources /XObject has to name the streams the page's content refers to, and dedupe means one stream can be named by three pages. The list names each image by the walk's own index, and an item says which one it paints — by the index rather than by position since *the raster half of a continuation's drawing* (S42), because the measurement drops a picture that fell inside a straddling block's clipped tail. A resource no item paints is exactly that picture: nothing on any page refers to its stream, so nothing is embedded for it and its slot stays empty, which is what keeps `embeddedImages[image.index]` an answer.
    const imageContext = createImageContext(context, { photoRule: options.photoRule });
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
        if (interpolate === undefined || request.blob === undefined) {
            embeddedImages.push(null);
            continue;
        }
        if (request.kind === 'facsimile') {
            // Embedded after the loop, all together (one copier per source file; DESIGN.md S80); the slot is filled there.
            facsimileSlots.push({ index, loaded: await reopenFacsimile(blobOf(list, request.blob), (request.facsimile as NonNullable<typeof request.facsimile>), request.domPath) });
            embeddedImages.push(null);
            continue;
        }
        const file = { bytes: blobOf(list, request.blob), mimeType: (request.mime as string) };
        // Every refusal in this printer names an element, and the decoder tiers are the one place where one did not (*an SVG that arrives through an `<img>` is a drawing*, S44). `decodeThroughCanvas` throws whatever the browser refused with — `InvalidStateError` on an SVG with no intrinsic size, and the same shape for a truncated file — and a refusal that names no element is a refusal the author has to bisect for.
        try {
            embeddedImages.push(await embedImage(imageContext, {
                kind: 'bytes',
                bytes: file.bytes,
                mimeType: file.mimeType,
                interpolate,
            }));
        }
        catch (error) {
            if (error instanceof CasterError && error.element)
                throw error;
            throw new CasterError(`caster: the ${file.mimeType} at ${request.domPath} (${request.src}) could not be carried into the file: ${error instanceof Error ? error.message : String(error)}`, { element: request.domPath });
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
        rasterImages.set(Number(key), await embedImage(imageContext, { kind: 'samples', samples, interpolate: true, label: `${spec.feature}@${spec.dpi}dpi` }));
    }
    // E12A (`images.md`): one XObject per colour cluster, through the writer of E7 like every other image, so the `/SMask` and the dedupe are the ones E7 decided. Two occurrences of the same emoji at the same size are the same pixels and therefore the same object, which is the dedupe doing its job rather than a rule of E12's own. Untested: the `emoji` option is dormant in `print()`.
    const emojiImages: Map<number,EmbeddedImage> = new Map<any, any>();
    for (const [key, cluster] of Object.entries(list.resources.emoji)) {
        if (cluster.blob === undefined)
            continue;
        const samples = samplesFromRgba(blobOf(list, cluster.blob), (cluster.width as number), (cluster.height as number));
        emojiImages.set(Number(key), await embedImage(imageContext, { kind: 'samples', samples, interpolate: true, label: `emoji:${cluster.text}@${cluster.sizePx}px` }));
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
    const groups = [];
    let kernAdjustments = 0;
    let actualTextSpans = 0;
    const structureAt = new Map<any, any>();
    const indexStructure = (node: StructureNode) => {
        if (!structureAt.has(node.path))
            structureAt.set(node.path, node);
        node.kids.forEach(indexStructure);
    };
    indexStructure(list.structure);
    for (const [page, { items }] of list.pages.entries()) {
        const operators: PDFOperator[] = [];
        const mcidOwners = [];
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
                    const node = nodeByPath(nodes, start.struct);
                    artifact = false;
                    group = { owner: start.struct, page, seq: start.seq, mcid: start.mcid };
                    mcidOwners[start.mcid] = start.struct;
                    // pdf-lib's PDFOperatorArg union has no PDFDict member, so the inline property list is written as the literal it serialises to anyway.
                    operators.push(pdf().PDFOperator.of(pdf().PDFOperatorNames.BeginMarkedContentSequence, [pdf().PDFName.of(node.tag), `<</MCID ${start.mcid}>>`]));
                    groups.push(group);
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
                const face = list.resources.fonts[item.font];
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
                    ...(options.toUnicode ? { actualTextFor: options.toUnicode.actualTextFor } : {}),
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
    const bboxByPath = new Map(Object.entries(list.figureBoxes));
    const built = buildStructure(context, pages, list, groups, mcidOwnersByPage.length, bboxByPath, linkItems.sort((a, b) => a.item.order - b.item.order), options.baseUri);
    // --- E12F (`structure-tree.md`): the two catalog entries a reader expects and no rule demands ---
    let outlineItems;
    if (list.outline.length > 0) {
        const headings = [];
        for (const heading of list.outline) {
            const ref = built.refByPath.get(heading.path);
            if (!ref)
                throw new CasterError(`caster: the heading at ${heading.path} was pruned, so no bookmark can name it`);
            headings.push({ path: heading.path, ref, title: heading.title, level: heading.level, page: heading.page, topPt: heading.topPt });
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
    for (const [instanceKey, instance] of Object.entries(list.resources.fonts)) {
        const stats = fonts.get(instanceKey).finish();
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
        expectedTree: expectedTreeOf(built.root),
        annots: built.annots,
        artifacts: sidecarArtifacts,
        pages: mcidOwnersByPage.map((mcidOwners) => ({ mcidOwners })),
        tagCounts: tagCountsOf(built.root),
    };
    const photoRule = photoRuleRecord((embeddedImages.filter((embedded) => embedded !== null) as EmbeddedImage[]));
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
        ...(photoRule ? { photoRule } : {}),
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
 * The Table attributes of one cell.
 *
 * @remarks
 * `/Scope` on a `TH`, `/Headers` on any cell whose header set is not empty, and `/RowSpan`/`/ColSpan` only where they are above 1 — a span of one is the default and writing it would be noise a reader has to skip. `/Headers` is written even where `/Scope` alone would satisfy a checker, because a `/Scope` tells a reader which axis a header claims and a `/Headers` tells it which cells; the group scopes have no PDF name at all and only `/Headers` carries their extent.
 *
 * @returns Null for a node that is not a cell, or a cell with nothing to say.
 */
function tableAttributes(node: StructureNode): AttributeDict|null {
    if (node.tag !== 'TH' && node.tag !== 'TD')
        return null;
    const { scope, headers, rowSpan, colSpan } = node.attrs;
    const dict: AttributeDict = {};
    if (scope)
        dict.Scope = scope;
    if (headers && headers.length > 0)
        dict.Headers = headers.map((id) => pdf().PDFString.of(id));
    if (rowSpan && rowSpan > 1)
        dict.RowSpan = rowSpan;
    if (colSpan && colSpan > 1)
        dict.ColSpan = colSpan;
    if (Object.keys(dict).length === 0)
        return null;
    return { O: 'Table', ...dict };
}
/** A PDF rectangle, `[llx lly urx ury]`, from the report's `[x y w h]`. */
function rectangleOf([x, y, w, h]: [number,number,number,number]): [number,number,number,number] {
    return [round3(x), round3(y), round3(x + w), round3(y + h)];
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
/**
 * The photo rule's own record: what it ran with, what it chose, and the case it had to refuse.
 *
 * @remarks
 * Neither asset is named here. The rule was consulted for several images and the record is derived from what it actually did — the one it re-encoded, and the one it looked at and turned down — so a fixture that renamed its files would change nothing.
 *
 * @returns Undefined when the rule was consulted for no image.
 */
function photoRuleRecord(images: EmbeddedImage[]): ReportPhotoRule|undefined {
    const consulted = images.map((i) => i.info.photo).filter((p) => p !== undefined);
    if (consulted.length === 0)
        return undefined;
    const chosen = consulted.filter((p) => p.chosenQuality !== null).sort((a, b) => b.pixels - a.pixels)[0];
    const refused = consulted.filter((p) => p.chosenQuality === null && p.pixels > PHOTO_PIXEL_THRESHOLD)[0];
    return {
        pixelThreshold: PHOTO_PIXEL_THRESHOLD,
        uniqueRatioThreshold: PHOTO_UNIQUE_RATIO_THRESHOLD,
        runThreshold: PHOTO_RUN_THRESHOLD,
        psnrTargetDb: PHOTO_PSNR_TARGET,
        candidates: chosen ? chosen.candidates.map((c) => ({
            quality: c.quality,
            bytes: c.bytes,
            psnrDb: Math.round(c.psnrDb * 100) / 100,
            subsampling: c.subsampling,
        })) : [],
        chosenQuality: chosen ? chosen.chosenQuality : null,
        photoUniqueRatio: chosen ? Math.round(chosen.uniqueRatio * 10000) / 10000 : 0,
        photoLongestRun: chosen ? chosen.longestRun : 0,
        screenshotRejected: refused !== undefined,
        reason: refused ? refused.reason : 'nothing above the pixel threshold was refused',
    };
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
 * The structure node at `path`.
 *
 * @param nodes - From `nodesByPath`.
 * @throws {CasterError} No node has that path.
 */
function nodeByPath(nodes: Map<string,StructureNode>, path: string): StructureNode {
    const found = nodes.get(path);
    if (!found)
        throw new CasterError(`caster: no structure element at ${path}`);
    return found;
}
/**
 * Every node under `tree` by its path, depth first, the first one kept where two share a path.
 *
 * @remarks
 * Measured 2026-10-29 on the manual (304 pages): a depth-first search per lookup, once per content group and once per vector, was 1.2 s of the writer.
 */
function nodesByPath(tree: StructureNode): Map<string,StructureNode> {
    const nodes: Map<string,StructureNode> = new Map<any, any>();
    const visit = (node: StructureNode) => {
        if (!nodes.has(node.path))
            nodes.set(node.path, node);
        for (const kid of node.kids)
            visit(kid);
    };
    visit(tree);
    return nodes;
}
/**
 * Build the structure tree, the ParentTree, the link annotations and the catalog entries that point at them.
 *
 * @remarks
 * Refs are allocated before any dictionary is filled, because the tree is doubly linked: an element names its parent and its parent lists its kids. Empty elements are pruned first — an element with no content items, no annotation and no surviving kids is a DOM node the engine painted nothing for, and PDF/UA-2 has no use for it.
 *
 * @param bboxByPath - Each Figure's Layout `/BBox`, by structure path.
 * @param linkItems - The list's link items with the page each sits on, in the walk's order.
 * @param baseUri - The document's own URL, which a relative link `href` resolves against.
 * @throws {CasterError} A link with no structure element; two elements with one `/ID`; a trailer with no Root; a destination with no content under it.
 */
function buildStructure(context: PDFContext, pages: PDFPage[], list: DisplayList, groups: Group[], pageCount: number, bboxByPath: Map<string,[number,number,number,number]>, linkItems: { item: LinkItem; page: number; }[], baseUri?: string): BuildResult {
    const built = new Map<any, any>();
    /** The builder's mirror of one node and everything under it, registered by path. */
    const attach = (node: StructureNode): Built => {
        const entry: Built = { node, kids: node.kids.map(attach), mcids: [] };
        built.set(node.path, entry);
        return entry;
    };
    const root = attach(list.structure);
    for (const group of groups) {
        built.get(group.owner).mcids.push({ page: group.page, mcid: group.mcid, seq: group.seq });
    }
    const namespaceRef = context.register(context.obj({ Type: 'Namespace', NS: pdf().PDFString.of(PDF_2_NAMESPACE) }));
    const annots: ReportStructureAnnot[] = [];
    const links: ReportLink[] = [];
    const pendingDestinations: { dict: PDFDict; dest: NonNullable<LinkTarget['dest']>; }[] = [];
    linkItems.forEach(({ item: annot, page: annotPage }, index) => {
        const owner = built.get(annot.struct);
        if (!owner)
            throw new CasterError(`caster: the link at ${annot.struct} has no structure element`);
        const structParent = pageCount + index;
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
            ...(annot.target.dest ? {} : { A: { S: 'URI', URI: textString(absoluteUri(annot.target.href, baseUri)) } }),
            Contents: textString(annot.contents),
            F: ANNOTATION_PRINT_FLAG,
            Border: [0, 0, 0],
            StructParent: structParent,
            P: page.ref,
        });
        const annotRef = context.register(annotDict);
        if (annot.target.dest)
            pendingDestinations.push({ dict: annotDict, dest: annot.target.dest });
        links.push({
            ownerPath: annot.struct,
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
        owner.objr = { page: annotPage, structParent, annot: annotRef, seq: Number.MAX_SAFE_INTEGER };
        annots.push({ structParent, page: annotPage, ownerPath: annot.struct, href: annot.target.href, contents: annot.contents, rectPt, quads });
    });
    /** Drop every kid that owns nothing; whether this entry itself survives. */
    const prune = (entry: Built): boolean => {
        entry.kids = entry.kids.filter(prune);
        // E11 (`tables.md`): an empty `TD` is the one element that earns its place by existing. The rest of the rule is that of E5 (`structure-tree.md`) — an element the engine painted nothing for is a hole in the reading order, not an element.
        if (keepWhenEmpty(entry.node.tag))
            return true;
        return entry.mcids.length > 0 || entry.objr !== undefined || entry.kids.length > 0;
    };
    prune(root);
    /** Give an entry and every kid under it a ref, before any dictionary is filled. */
    const allocate = (entry: Built) => {
        entry.ref = context.nextRef();
        for (const kid of entry.kids)
            allocate(kid);
    };
    allocate(root);
    const rootRef = context.nextRef();
    const parentsByPage: PDFRef[][] = Array.from({ length: pageCount }, () => []);
    const parentsByAnnot: PDFRef[] = [];
    /** Every element that carries an `/ID`, in the order the tree was filled. */
    const idRefs: { id: string; ref: PDFRef; }[] = [];
    /** Write one element's dictionary, its `/K` in reading order, and then its kids'. */
    const fill = ( entry: Built,  parentRef: PDFRef) => {
        const ref = (entry.ref as PDFRef);
        for (const { page, mcid } of entry.mcids)
            parentsByPage[page][mcid] = ref;
        if (entry.objr)
            parentsByAnnot[entry.objr.structParent - pageCount] = ref;
        // A single page behind every content item lets /K carry bare integers and the element carry /Pg; content on two pages has to name its page per item through /MCR dictionaries, and then /Pg would be a lie.
        const onePage = entry.mcids.length > 0 && entry.mcids.every(( m: { page: number; }) => m.page === entry.mcids[0].page);
        // Kids are ordered by the earliest content anywhere under them, which is content order and therefore reading order. E11 (`tables.md`) introduced the one kind of element that has no content anywhere under it — an empty `TD`, which exists to make a row rectangular — and such an element has no place in content order at all, so it takes the place of the last sibling that had one and keeps the position it was declared in. Every element of every fixture before E11 owns content, so nothing there moves by a byte.
        const kidSeqs = entry.kids.map(seqOf);
        let previous = Number.MIN_SAFE_INTEGER;
        for (let i = 0; i < kidSeqs.length; i++) {
            if (kidSeqs[i] === Number.MAX_SAFE_INTEGER)
                kidSeqs[i] = previous;
            else
                previous = kidSeqs[i];
        }
        const kidOrder = entry.kids
            .map(( kid: Built,  index: number) => ({ kid, seq: kidSeqs[index], index }))
            .sort(( a: { seq: number; index: number; },  b: { seq: number; index: number; }) => a.seq - b.seq || a.index - b.index);
        entry.kids = kidOrder.map(( k: { kid: Built; }) => k.kid);
        const ordered: { seq: number; value: number|PDFRef|PDFDict; }[] = [
            ...entry.mcids.map(( m: { page: number; mcid: number; seq: number; }) => ({
                seq: m.seq,
                value: onePage ? m.mcid : context.obj({ Type: 'MCR', Pg: pages[m.page].ref, MCID: m.mcid }),
            })),
            ...kidOrder.map(( { kid, seq }: { kid: Built; seq: number; }) => ({ seq, value: (kid.ref as PDFRef) })),
            ...(entry.objr ? [{ seq: entry.objr.seq, value: context.obj({ Type: 'OBJR', Pg: pages[entry.objr.page].ref, Obj: entry.objr.annot }) }] : []),
        ].sort((a, b) => a.seq - b.seq);
        // Attributes are a list rather than a field per owner: E5 (`structure-tree.md`) had exactly one case (`/ListNumbering`) and could spread it inline, E7 (`images.md`) added the Layout `/BBox` beside it, and E11 (`tables.md`) adds a Table dictionary that a `TD` can carry at the same time as neither. `/A` is written as the dictionary itself when there is one — which is byte for byte what E5 through E10 (`coordinates-and-pages.md`) wrote — and as an array when there is more than one.
        const attributes: AttributeDict[] = [];
        if (entry.node.attrs.listNumbering)
            attributes.push({ O: 'List', ListNumbering: entry.node.attrs.listNumbering });
        // The Layout /BBox is a PDF rectangle — [llx lly urx ury] — not the [x y w h] the report records, because 14.8.5.4.3 says a rectangle and a reader that met four numbers meaning something else would place the figure somewhere the page has no ink.
        if (bboxByPath.has(entry.node.path))
            attributes.push({ O: 'Layout', BBox: rectangleOf((bboxByPath.get(entry.node.path) as [number, number, number, number])) });
        const table = tableAttributes(entry.node);
        if (table)
            attributes.push(table);
        // E12F (`structure-tree.md`): `<sub>` and `<sup>`. The 2.0 Layout attribute is the one thing in the standard that means what CSS means by them; the `Sub` *element* is a sub-division of a block and would say something else entirely.
        if (entry.node.attrs.textPosition)
            attributes.push({ O: 'Layout', TextPosition: entry.node.attrs.textPosition });
        if (entry.node.attrs.id)
            idRefs.push({ id: entry.node.attrs.id, ref });
        context.assign(ref, context.obj({
            Type: 'StructElem',
            S: entry.node.tag,
            NS: namespaceRef,
            P: parentRef,
            ...(onePage ? { Pg: pages[entry.mcids[0].page].ref } : {}),
            ...(entry.node.attrs.lang ? { Lang: pdf().PDFString.of(entry.node.attrs.lang) } : {}),
            ...(entry.node.attrs.alt ? { Alt: textString(entry.node.attrs.alt) } : {}),
            // E12F (`structure-tree.md`): `/E` is the expansion of an abbreviation, and 32000-2 still has it as a structure-element entry — probed against veraPDF rather than assumed.
            ...(entry.node.attrs.expansion ? { E: textString(entry.node.attrs.expansion) } : {}),
            // 14.7.5.2: an element's /ID is a byte string, and it is what /Headers and the /IDTree name it by.
            ...(entry.node.attrs.id ? { ID: pdf().PDFString.of(entry.node.attrs.id) } : {}),
            ...(attributes.length === 1 ? { A: attributes[0] } : {}),
            ...(attributes.length > 1 ? { A: attributes } : {}),
            K: ordered.map((k) => k.value),
        }));
        for (const kid of entry.kids)
            fill(kid, ref);
    };
    fill(root, rootRef);
    // One flat number tree: page keys first, then one key per annotation. A page entry is an array indexed by MCID; an annotation entry is the element itself. Nothing here needs /Kids until a document has thousands of pages.
    const nums: (number|PDFRef[]|PDFRef)[] = [];
    parentsByPage.forEach((refs, page) => {
        pages[page].node.set(pdf().PDFName.of('StructParents'), pdf().PDFNumber.of(page));
        nums.push(page, refs);
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
        K: [root.ref],
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
    // --- E12F (`structure-tree.md`): the structure destinations, now that every element has a ref ---
    const refByPath = new Map<any, any>();
    const pageByPath = new Map<any, any>();
    const kidPathsByPath = new Map<any, any>();
    /** Record every kept element's ref, its kids and the page it begins on. */
    const collect = (entry: Built) => {
        refByPath.set(entry.node.path, entry.ref);
        kidPathsByPath.set(entry.node.path, entry.kids.map((kid) => kid.node.path));
        // The page a destination lands on is the page the element begins on, and an element whose content items straddle a cut begins on the first of them. Recording a page only for the elements that sit wholly on one page made a straddling heading unreachable — `pageBearing` walked past it into its kids and, finding none, refused with "no content anywhere under it", which named neither the cause nor the truth.
        if (entry.mcids.length > 0) {
            let first = entry.mcids[0];
            for (const mcid of entry.mcids) if (mcid.seq < first.seq) first = mcid;
            pageByPath.set(entry.node.path, first.page);
        }
        for (const kid of entry.kids)
            collect(kid);
    };
    collect(root);
    /**
     * The element a destination should actually name.
     *
     * @remarks
     * A structure destination resolves its page through the element's own `/Pg`, and a grouping element — a `Sect` around a heading and three paragraphs — has none, because its content is its descendants'. The first descendant in reading order that does carry a page is what a reader would land on anyway, so that is the element the destination names.
     */
    const pageBearing = (path: string): string|null => {
        if (pageByPath.has(path))
            return path;
        for (const kid of kidPathsByPath.get(path) ?? []) {
            const found = pageBearing(kid);
            if (found)
                return found;
        }
        return null;
    };
    for (const { dict, dest } of pendingDestinations) {
        const path = pageBearing(dest.struct);
        if (!path) {
            throw new CasterError(`caster: the destination at ${dest.struct} has no content anywhere under it, so no structure destination can name a page`);
        }
        dict.set(pdf().PDFName.of('Dest'), context.obj([refByPath.get(path), pdf().PDFName.of('XYZ'), dest.x, dest.y, null]));
    }
    return { root, annots, ids: sortedIds.map((entry) => entry.id), links, refByPath, pageByPath, kidPathsByPath };
}
/** The earliest content anywhere under an element; its place in its parent's /K. */
function seqOf(entry: Built): number {
    const own = entry.mcids.map((m) => m.seq);
    const kids = entry.kids.map(seqOf);
    return Math.min(...own, ...kids, Number.MAX_SAFE_INTEGER);
}
// #endregion builder
/** The tree in the report's shape, which is the shape the node checker reads back. */
function expectedTreeOf(entry: Built): ReportStructureNode {
    const onePage = entry.mcids.length > 0 && entry.mcids.every((m) => m.page === entry.mcids[0].page);
    return {
        tag: entry.node.tag,
        path: entry.node.path,
        ...(onePage ? { pg: entry.mcids[0].page } : {}),
        mcids: entry.mcids.map((m) => ({ page: m.page, mcid: m.mcid })),
        attrs: entry.node.attrs,
        ...(entry.objr ? { objr: { page: entry.objr.page, structParent: entry.objr.structParent } } : {}),
        kids: entry.kids.map(expectedTreeOf),
    };
}
/** How many elements of each tag the kept tree carries, sorted by tag. */
function tagCountsOf(root: Built): { tag: string; count: number; }[] {
    const counts = new Map<any, any>();
    const visit = (entry: Built) => {
        counts.set(entry.node.tag, (counts.get(entry.node.tag) ?? 0) + 1);
        for (const kid of entry.kids)
            visit(kid);
    };
    visit(root);
    return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([tag, count]) => ({ tag, count }));
}
