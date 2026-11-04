/**
 * `emit/structureEmit.js` — the composition: the text, the vectors, the images, the colour and the structure tree that makes it all readable.
 *
 * Ported from `harness/src/export/structureEmit.ts` (E5, E7, E8, E9, E10, E11, E12A–F). Guide: `docs/guide/structure-tree.md`, and every capability document under it.
 *
 * THE WRITER (stages 2 and 4 of `.claude/plans/the-display-list/`). `emitStructure` reads a {@link DisplayList} and nothing else: the deciding half (what goes on which page, in which order, under which marked content, and the structure tree resolved: which elements survive, every `/K` in reading order, where a destination lands) lives in `displayList/build.js` and `displayList/structure.js`, the writer numbering each page's content starts as MCIDs and writing what it is given, the bytes it needs are in `resources.blobs`, and every length arrives in the page's points. It reads no page geometry, no measurement and no walk, and is handed nothing beside the list: `emitStructure(list)` returns the file and the writer's records (`WriterResult`, `displayList.js`), never a report. What the report derives from the list and the records is `recordsOf`'s (`displayList/records.js`), and what it keeps of the measurement and the walk is joined by `print()` (stage 4 of `.claude/plans/the-rust-writer/plan-close-the-list.md`). The file is byte-identical to the one the same document had before the move (`npm run identity`).
 *
 * WHAT THE PORT CHANGED (PLAN.md P2, P6, D7). pdf-lib is a capability handle. `import selfSource from './structureEmit.ts?raw'` is deleted with the statistic it fed: the report's `builderLines` counted this module's own lines between two region markers, for an exit note's table, and a printer has no reader for it. `sidecarVersion`, `fixture`, `chromiumPrinted` and `chromiumError` go with the report's fixture-only fields.
 *
 * This module is where the port's spine met its painting, and it meets it through the names `structureEmit.ts` already declared — `ColorEmitter`, `ShadingBuilder`, `TransparencyBuilder`, `ResourceScope`, `vectorOperators`, `createImageContext`/`embedImage`/`useOnPage`, `collectTableBorders`, `pageMarksOf`/`circleSegments`/`MARK_STROKE_PT`, `buildOutline`, `pageLabelRuns`. The port was split between two agents by the module graph (PLAN.md D10), neither editing the other's files, and keeping every exported name is what let the two halves land without a meeting.
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
import { ResourceScope, holdsOpenBlend, vectorOperators } from '../vectors/vectorEmit.ts';
import { embedFace } from '../fonts/fontEmbed.ts';
import { createImageContext, embedImage, useOnPage } from '../images/imageEmbed.ts';
import { embedFacsimiles, reopenFacsimile } from '../images/facsimile.ts';
import { mul } from '../coordinates/matrix.ts';
import { addXmpMetadata, createDocument, serialize, setInfo } from './document.ts';
import { emitRun, fontOf, fontsByKey, lineWrap, listSegments, round3, setupPages } from './textEmit.ts';
import { buildToUnicode } from '../fonts/toUnicode.ts';
import { samplesFromRgba, samplesOf } from '../images/samples.ts';
import { MARK_STROKE_PT, circleSegments } from '../coordinates/printMarks.ts';
import { buildOutline } from './outline.ts';
import { ATTRIBUTE_KEYS, validateList } from '../displayList/validate.ts';

/** What wrote the file, for the Info dictionary and the XMP packet alike. Named once here rather than at the two call sites, so the two can never disagree — a reader is entitled to consult either. */
const PRODUCER = 'BelType Caster';

const pdf = () => capability('pdf');

import type { CidFont, CidFontStats } from '../fonts/fontEmbed.ts';
import type { EmbeddedImage, EmbedSource } from '../images/imageEmbed.ts';
import type { LoadedFacsimile } from '../images/facsimile.ts';
import type { Matrix } from '../images/imagePlace.ts';
import type { DisplayList, ImageSource, ImageUse, StructAttribute, StructElement, FontInstance, ImageItem, LinkItem, LinkTarget, PlacedVector, RectItem, TextItem, ArtifactStart, WriterPen, WriterRecords, WriterResult } from '../displayList.ts';

import type { ReportPaint } from '../report.ts';

export type ArtifactDescriptor = ArtifactStart['artifact'];

/** The marked-content sequence a page is inside: the element that owns it, and the MCID the writer gave it. */
export type Group = {
  element: number;
  page: number;
  mcid: number;
};
/** The written tree, as the outline needs it. */
export type BuildResult = {
  /** Each element's object, by its index in `structure.elements`. */
  refs: PDFRef[];
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
 * The whole file, from the list and nothing else: every page's content items, the structure tree over them, and every document-level object the list asks for; and the records of what the writer chose.
 *
 * @remarks
 * The records (`WriterRecords`, `displayList.js`) are what a writer returns beside the file: the MCIDs it numbered, its pen adjustments and counters, what each font and image became, the vector rows and resource counts, the colour record. Everything else the report says of the file is a function of the list and these records, made by `recordsOf` (`displayList/records.js`), and what it says of the measurement and the walk is `print()`'s to join.
 *
 * @throws {CasterError} Every refusal of `validateList` (`displayList/validate.js`), first: a list of another version, a blob, font, width, image or element the list names and does not hold, marked content not closed, a tree that is not one, link orders with a gap; then what only writing finds: an image no filter reads (naming its element, *an SVG that arrives through an `<img>` is a drawing*, DESIGN.md S44); a colour cluster with no raster; print marks without colour options; two elements with one `/ID`; and every refusal of the modules it composes.
 */
export async function emitStructure(list: DisplayList): Promise<WriterResult> {
    const pdfDoc = await createDocument();
    const context = pdfDoc.context;
    // A list the writer could not write is refused before a byte is written, each refusal a sentence (`displayList/validate.js`).
    validateList(list);
    // How the list asks to be written: the font profile and the colour story are the list's, and no option reaches a byte.
    const profile = list.writing.fontProfile;
    // The document-wide ToUnicode map with its ambiguity rule, from the list's glyph-to-text clusters: each CID maps to the string most of the document shows it for, and every other occurrence is wrapped in `/ActualText`.
    const toUnicode = buildToUnicode(listSegments(list));
    const fonts = new Map<any, any>();
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
            ? { kind: 'jpeg', jpeg: blobOf(list, spec.jpeg), interpolate: true, format: 'canvas', gammaOnly: false }
            : { kind: 'samples', samples, interpolate: true, label: `${spec.feature}@${spec.dpi}dpi` }));
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
    const paint: ReportPaint[] = [];
    const vectorContext = {
        context,
        shadings,
        transparency,
        images: imageContext,
        rasters: rasterImages,
        resources: list.resources,
        records: paint,
        ...(colour ? { blendingSpace: () => context.obj([pdf().PDFName.of('ICCBased'), colour.resources.srgbRef()]) } : {}),
    };
    const pageScopes: ResourceScope[] = Array.from({ length: list.info.pageCount }, () => new ResourceScope());
    const pens: WriterPen[] = [];
    const imageUses: ImageUse[] = [];
    const emojiUses: ImageUse[] = [];
    const linkItems: { item: LinkItem; page: number; }[] = [];
    const pageStreams = [];
    // The MCID of each content start, by page and by the start's index in the page's items: the writer's own numbering, 0, 1, 2 … in item order on each page.
    const mcidAt: Map<number,number>[] = [];
    let kernAdjustments = 0;
    let actualTextSpans = 0;
    for (const [page, { items }] of list.pages.entries()) {
        const operators: PDFOperator[] = [];
        const pageMcids = new Map<number,number>();
        mcidAt.push(pageMcids);
        // The marked-content sequence the item being written sits in: `artifact` for one that owns no structure element, `group` for one that does.
        let artifact = false;
        let group: Group|null = null;
        let openLine: TextItem|null = null;
        let openLineIndex = -1;
        // `ET` and the line's wrapper, exactly as a line end writes them. Only text-object operators may sit inside `BT … ET` (ISO 32000-2, 9.4), so every item that paints anything but text closes the open line, and the next run opens a new one as a fresh line would; a page end closes it too.
        const closeLine = () => {
            if (openLine)
                operators.push(pdf().PDFOperator.of(pdf().PDFOperatorNames.EndText), ...lineWrap(openLine.transform, openLine.clips).close);
            openLine = null;
        };
        for (const [at, item] of items.entries()) {
            if (item.kind !== 'tag' && item.kind !== 'text' && item.kind !== 'link')
                closeLine();
            if (item.kind === 'tag') {
                if ('end' in item) {
                    closeLine();
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
                }
                else {
                    const element = elementOf(elements, start.element, `the marked content at item ${at} of page ${page + 1}`);
                    artifact = false;
                    group = { element: start.element, page, mcid: pageMcids.size };
                    pageMcids.set(at, group.mcid);
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
                imageUses.push({ page, item: at, source: item.source, name: name.asString().slice(1), hash: embedded.hash, info: embedded.info });
                continue;
            }
            if (item.kind === 'raster' && item.table === 'emoji') {
                const cluster = list.resources.emoji[item.source];
                const embedded = emojiImages.get(item.source);
                if (!embedded)
                    throw new CasterError(`caster: no raster for the colour cluster ${JSON.stringify(cluster.text)}`);
                // A picture is not a text object, so the open line was closed before it, above, and the next run reopens it. The `/Span` around it carries no MCID and is therefore not a content item — which is what makes it legal inside the group's own `BDC`, and is exactly the mechanism E4 (`font-embedding.md`) already uses for a glyph whose ToUnicode cannot name it.
                const name = useOnPage(imageContext, embedded, pages[page], page);
                // `q … Q` around the whole of it, for the reason of E7 (`images.md`): a `cm` is not undone by anything else, and a picture that left one behind would move every word after it on the page. The chain of E10 (`coordinates-and-pages.md`), when the cluster carries one, goes inside the same pair.
                const chained = lineWrap(item.chain);
                operators.push(pdf().PDFOperator.of(pdf().PDFOperatorNames.BeginMarkedContentSequence, [pdf().PDFName.of('Span'), `<</ActualText <FEFF${utf16beHexOf((item.actualText as string))}> >>`]), pdf().PDFOperator.of(pdf().PDFOperatorNames.PushGraphicsState), ...chained.open, pdf().PDFOperator.of(pdf().PDFOperatorNames.ConcatTransformationMatrix, (item.transform as Matrix).map((n) => pdf().PDFNumber.of(n))), pdf().PDFOperator.of(pdf().PDFOperatorNames.DrawObject, [name]), ...chained.close, pdf().PDFOperator.of(pdf().PDFOperatorNames.PopGraphicsState), pdf().PDFOperator.of(pdf().PDFOperatorNames.EndMarkedContent));
                actualTextSpans += 1;
                emojiUses.push({ page, item: at, source: item.source, name: name.asString().slice(1), hash: embedded.hash, info: embedded.info });
                continue;
            }
            if (item.kind === 'text') {
                if (item.lineIndex !== openLineIndex || !openLine) {
                    closeLine();
                    operators.push(...lineWrap(item.transform, item.clips).open, pdf().PDFOperator.of(pdf().PDFOperatorNames.BeginText));
                    openLine = item;
                    openLineIndex = item.lineIndex;
                }
                const face = fontOf(fontByKey, item);
                const adjustments = emitRun(operators, item, {
                    context,
                    font: (fonts.get(item.font) as CidFont),
                    name: (names[page].get(item.font) as PDFName),
                    upem: (face.upem as number),
                    onKern: () => {
                        kernAdjustments += 1;
                    },
                    actualTextFor: toUnicode.actualTextFor,
                    onActualText: () => {
                        actualTextSpans += 1;
                    },
                    ...(colour ? { colorOperators: (textItem) => colour.runOperators(textItem, { page, item: at }) } : {}),
                });
                pens.push({ page, item: at, adjustments });
                continue;
            }
            if (item.kind === 'link') {
                // Not painted: the structure tree collects it, below.
                linkItems.push({ item, page });
                continue;
            }
            // A vector item: a shape, a group or a form of the node's own, or a raster fallback.
            const vector = (item as PlacedVector);
            // A BDC/EMC pair may sit inside a text object but a path may not, so the open line was closed before the geometry, above — and if that line was wrapped in the `q <cm>` of E10 (`coordinates-and-pages.md`), the `Q` went with it. Nesting rather than interleaving: every `q` the emitter opens is closed before the next one is opened, whether it came from `lineWrap` or from a vector item's own chain.
            // One by one, as the slices below: a drawing's operators can outnumber the call arguments the engine's stack holds.
            for (const op of vectorOperators(vector, vectorContext, pageScopes[page], artifact)) operators.push(op);
        }
        closeLine();
        // A blend no group isolates mixes with the page, so the page's group is its blending space (Egildo's ruling 15a of the Rust writer): the document's sRGB profile, as Chromium's page is an RGB stacking context.
        if (vectorContext.blendingSpace && items.some((item) => (item.kind === 'shape' || item.kind === 'group' || item.kind === 'form' || (item.kind === 'raster' && 'table' in item)) && holdsOpenBlend(item as PlacedVector)))
            pages[page].node.set(pdf().PDFName.of('Group'), context.obj({ Type: 'Group', S: 'Transparency', CS: vectorContext.blendingSpace() }));
        pageScopes[page].applyToPage(context, pages[page]);
        // pdf-lib takes the operators as call arguments, and a page of a large drawing holds tens of thousands, so they go in slices.
        for (let at = 0; at < operators.length; at += 10_000) pages[page].pushOperators(...operators.slice(at, at + 10_000));
        pageStreams.push(`${operators.map((op) => op.toString()).join('\n')}\n`);
    }
    const built = buildStructure(context, pages, list, mcidAt, linkItems.sort((a, b) => a.item.order - b.item.order));
    // --- E12F (`structure-tree.md`): the two catalog entries a reader expects and no rule demands ---
    if (list.outline.length > 0) {
        const headings = [];
        for (const heading of list.outline) {
            const element = elementOf(elements, heading.element, `the bookmark ${JSON.stringify(heading.title)}`);
            headings.push({ path: element.path, ref: built.refs[heading.element], title: heading.title, level: heading.level, page: heading.page, topPt: heading.topPt });
        }
        const outline = buildOutline(context, headings);
        if (outline)
            pdfDoc.catalog.set(pdf().PDFName.of('Outlines'), outline);
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
    const faces: CidFontStats[] = list.resources.fonts.map((instance) => fonts.get(instance.key).finish());
    // The colour resources go on last: a resource name is allocated the first time an element asks for it, so the complete set is only known once every page has been emitted.
    const colourRecord = colour ? await colour.finish(pages, pdfDoc.catalog) : undefined;
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
    const records: WriterRecords = {
        mcids: mcidAt.map((pageMcids) => [...pageMcids.keys()]),
        pens,
        kernAdjustments,
        actualTextSpans,
        faces,
        images: imageUses,
        xobjects: imageContext.byHash.size,
        paint,
        vectorResources: { shadings: shadings.count, patterns: shadings.patternCount, extGStates: transparency.stateCount, forms: transparency.formCount },
        ...(colourRecord ? { colour: colourRecord } : {}),
        emoji: emojiUses,
    };
    return { bytes, records, pageStreams };
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
    const format = source.original?.format ?? source.mime ?? '';
    if (source.jpeg !== undefined)
        return { kind: 'jpeg', jpeg: blobOf(list, source.jpeg), interpolate, format, gammaOnly: source.original?.gammaOnly === true };
    if (source.samples !== undefined) {
        const { blob, width, height, colorSpace, bitsPerComponent, alpha, palette, icc } = source.samples;
        const samples = samplesOf(blobOf(list, blob), width, height, colorSpace === 'DeviceRGB' ? 3 : colorSpace === 'DeviceCMYK' ? 4 : 1, alpha, bitsPerComponent / 8);
        const shape = { colorSpace, bitsPerComponent, ...(palette !== undefined ? { palette: blobOf(list, palette) } : {}), ...(icc !== undefined ? { icc: blobOf(list, icc) } : {}) };
        return { kind: 'samples', samples, interpolate, label: format, shape, gammaOnly: source.original?.gammaOnly === true };
    }
    return { kind: 'bytes', bytes: blobOf(list, source.blob as string), mimeType: source.mime as string, interpolate };
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
/** A link's `/QuadPoints`, eight numbers per line rectangle, upper-left first, and its `/Rect`, their union. */
export function linkGeometry(link: LinkItem): { rectPt: [number, number, number, number]; quads: number[] } {
    const quads = link.rects.flatMap(([x0, top, x1, bottom]) => [x0, top, x1, top, x0, bottom, x1, bottom]);
    const xs = quads.filter((_, i) => i % 2 === 0);
    const ys = quads.filter((_, i) => i % 2 === 1);
    return { rectPt: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], quads };
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
 * Write the structure tree, the ParentTree, the link annotations and the catalog entries that point at them.
 *
 * @remarks
 * The tree is the list's, resolved by the builder (`displayList/structure.js`): the writer prunes, orders and looks up nothing. Refs are allocated in the array's order before any dictionary is filled, because the tree is doubly linked: an element names its parent and its parent lists its kids. What the writer derives, it derives from the children: `/P`; `/Pg` with bare MCIDs where all of an element's content is on one page, `/MCR` dictionaries otherwise; the ParentTree, one array per page indexed by MCID, then one entry per link an element ends with; the `/IDTree`.
 *
 * @param mcidAt - Each page's MCIDs, by the index of the content start in its items.
 * @param linkItems - The list's link items with the page each sits on, in `order`.
 * @throws {CasterError} Two elements with one `/ID`; a trailer with no Root. The tree's own shape and the links' orders are `validateList`'s, checked before the writer starts.
 */
function buildStructure(context: PDFContext, pages: PDFPage[], list: DisplayList, mcidAt: Map<number,number>[], linkItems: { item: LinkItem; page: number; }[]): BuildResult {
    const elements = list.structure.elements;
    const pageCount = list.pages.length;
    // The tree is one, `validateList` has seen to it: each element's parent is the element that lists it, and the root's is -1.
    const parent = elements.map(() => -1);
    elements.forEach((element, index) => element.children.forEach((child) => { if (typeof child === 'number') parent[child] = index; }));
    const namespaceRef = context.register(context.obj({ Type: 'Namespace', NS: pdf().PDFString.of(PDF_2_NAMESPACE) }));
    const annotRefs: PDFRef[] = [];
    const pendingDestinations: { dict: PDFDict; dest: NonNullable<LinkTarget['dest']>; }[] = [];
    for (const { item: annot, page: annotPage } of linkItems) {
        const structParent = pageCount + annot.order;
        const page = pages[annotPage];
        const { rectPt, quads } = linkGeometry(annot);
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
        page.node.addAnnot(annotRef);
        // 8.9.3.3 t1: a page carrying an annotation has to declare a tab order. /S is "use the structure order", which is the only honest answer for a file whose reading order is the structure tree.
        page.node.set(pdf().PDFName.of('Tabs'), pdf().PDFName.of('S'));
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
    return { refs };
}
/** One attribute object as pdf-lib writes it: every string a name, but a `Headers` entry, which is a byte string, and the keys in `ATTRIBUTE_KEYS` order (`/O` first, then `StructAttribute`'s), whatever order the list holds them in, so the dictionary does not depend on the order a JSON reader kept. */
function attributeObject(attribute: StructAttribute): Record<string, string|number|number[]|PDFString[]> {
    const entries = attribute as Record<string, string|number|number[]|string[]|undefined>;
    return Object.fromEntries(ATTRIBUTE_KEYS.filter((key) => entries[key] !== undefined).map((key) => [key, key === 'Headers' ? (entries[key] as string[]).map((id) => pdf().PDFString.of(id)) : (entries[key] as string|number|number[])]));
}
