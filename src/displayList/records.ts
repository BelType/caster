/**
 * `displayList/records.js` — what the report says of a printed list that the list itself decides, so a writer returns only what it chose.
 *
 * Caster's own (stage 4 of `.claude/plans/the-rust-writer/plan-close-the-list.md`). A writer, this one or a foreign one, returns its records beside the file: the choices it made, keyed by the list's own places (a page and an item index). Everything else the report records of the file is a function of the list and of those choices, and is made here, in node or in the page alike, with no DOM, no measurement and no pdf-lib.
 *
 * @packageDocumentation
 */

import { parseJpeg } from '../images/jpeg.ts';
import { parsePng } from '../images/png.ts';
import { fontOf, fontsByKey, round3, segmentTexts } from '../emit/textEmit.ts';
import { linkGeometry, PDF_2_NAMESPACE } from '../emit/structureEmit.ts';
import { outlineItems } from '../emit/outline.ts';
import { COLUMN_WIDTH_PX } from '../coordinates/units.ts';
import { CasterError } from '../errors.ts';

import type { DisplayList, ImageSource, ImageUse, PngDecodeReason, LinkItem, ListPlace, StructElement, TextItem, TextOrigin, WriterPen, WriterRecords, WrittenColour } from '../displayList.ts';
import type { ReportColor, ReportColorElement, ReportEmission, ReportLink, ReportOutlineItem, ReportRun, ReportStructure, ReportStructureAnnot, ReportStructureArtifact, ReportStructureNode, ReportWorklistEntry } from '../report.ts';

/** The members of the report's `emission` that the measurement holds or joins, which `print()` adds. */
export type MeasuredEmissionKeys = 'runs' | 'trailingLetterSpacing' | 'trailingSamples' | 'baselineAgreementPt' | 'usableProbes' | 'probeMoved' | 'probeOffLine' | 'probeBeforeOffLine' | 'containerScrollWidthPx' | 'paragraphs' | 'words' | 'marginPt' | 'pageWidthPt' | 'pageHeightPt';

/**
 * Everything the report says of the file that the list and the writer's records decide: derivable, with no measurement in it.
 *
 * @remarks
 * Keyed as the report keys it, or by the item where `print()` still joins the measurement (`runs`, `words`).
 */
export type ListRecords = {
  /** The emission's own members: the list's page count and two constants, the writer's counters, and each face with its URL. */
  emission: Omit<ReportEmission, MeasuredEmissionKeys>;
  runs: RunNote[];
  words: WordNote[];
  /** The structure tree as written, its annotations and artifacts, each page's MCID owners and the tag counts; the headings are the walk's. */
  structure: Omit<ReportStructure, 'headings'>;
  /** Present when the list has bookmarks. */
  outline?: ReportOutlineItem[];
  /** Every link and which of the two actions it became, in `order`. */
  links: ReportLink[];
  /** Every `/ID` in the file, in the order the `/IDTree` lists them. */
  idTree: string[];
  /** The element paths the content streams painted vectors for, in stream order. */
  streamOrder: string[];
  /** One note per image the writer painted, parallel to `WriterRecords.images`. */
  images: ImageNote[];
};

/**
 * What the report says of a printed list, from the list and the writer's records.
 *
 * @remarks
 * A pure function: node and the page give the same answer, and a foreign writer that returns `WriterRecords` gets the same report as this one wherever its choices agree.
 *
 * @throws {CasterError} A record naming an item, a source or a blob the list does not hold (`textNotesOf`, `imageNotesOf`).
 */
export function recordsOf(list: DisplayList, written: WriterRecords): ListRecords {
  const elements = list.structure.elements;
  const pageCount = list.pages.length;
  const mcidAt = written.mcids.map((items) => new Map(items.map((item, mcid) => [item, mcid])));
  // The links in `order`, which is the order the annotations are written and numbered in.
  const linkItems = list.pages.flatMap((page, at) => page.items.filter((item): item is LinkItem => item.kind === 'link').map((item) => ({ item, page: at }))).sort((a, b) => a.item.order - b.item.order);
  const annots: ReportStructureAnnot[] = [];
  const links: ReportLink[] = [];
  for (const { item: link, page } of linkItems) {
    const { rectPt, quads } = linkGeometry(link);
    const ownerPath = elements[link.element].path;
    const dest = link.target.dest;
    links.push({
      ownerPath,
      href: link.target.href,
      kind: link.target.kind,
      action: dest ? 'Dest' : 'URI',
      page,
      ...(link.target.targetId ? { targetId: link.target.targetId } : {}),
      ...(dest ? { destPage: dest.page, destLeftPt: dest.x, destTopPt: dest.y, destStructPath: dest.struct } : {}),
    });
    annots.push({ structParent: pageCount + link.order, page, ownerPath, href: link.target.href, contents: link.contents, rectPt, quads });
  }
  const artifacts: ReportStructureArtifact[] = [];
  const streamOrder: string[] = [];
  list.pages.forEach(({ items }, page) => {
    for (const item of items) {
      if (item.kind === 'tag') {
        if ('start' in item && 'artifact' in item.start && item.start.path !== undefined) {
          const start = item.start;
          artifacts.push({ path: start.path as string, type: start.artifact.type, ...(start.artifact.subtype ? { subtype: (start.artifact.subtype as 'Header' | 'Footer' | 'PageNum') } : {}), page, kind: (start.kind as 'paint' | 'image' | 'text') });
        }
        continue;
      }
      // What the writer paints through the vector writer: everything but a rectangle, the marks, an image, a colour cluster, a run and a link.
      if ((item.kind === 'shape' && 'rect' in item) || item.kind === 'marks' || item.kind === 'image' || (item.kind === 'raster' && item.table === 'emoji') || item.kind === 'text' || item.kind === 'link') continue;
      streamOrder.push(`${item.origin.domPath}#${item.origin.label}`);
    }
  });
  const mcidOwners = written.mcids.map((items, page) => items.map((at) => {
    const start = list.pages[page].items[at];
    return elements[(start as { start: { element: number } }).start.element].path;
  }));
  /** The tree in the report's shape, which is the shape the node checker reads back: content in the order it was written, kids in reading order. */
  const expected = (index: number): ReportStructureNode => {
    const element = elements[index];
    const contents = element.children.filter((c): c is ListPlace => typeof c === 'object' && 'page' in c).sort((a, b) => a.page - b.page || a.item - b.item);
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
  const { runs, words } = textNotesOf(list, written.mcids, written.pens);
  return {
    emission: {
      pageCount: list.info.pageCount,
      baselineMethod: 'measureText',
      columnWidthPx: COLUMN_WIDTH_PX,
      kernAdjustments: written.kernAdjustments,
      actualTextSpans: written.actualTextSpans,
      faces: written.faces.map((stats, at) => ({ ...stats, url: list.resources.fonts[at].url })),
    },
    runs,
    words,
    structure: {
      namespace: PDF_2_NAMESPACE,
      lang: list.info.lang,
      expectedTree: expected(0),
      annots,
      artifacts,
      pages: mcidOwners.map((owners) => ({ mcidOwners: owners })),
      tagCounts: tagCountsOf(elements),
    },
    ...(list.outline.length > 0 ? { outline: outlineItems(list.outline.map((heading) => ({ path: elements[heading.element].path, title: heading.title, level: heading.level, page: heading.page, topPt: heading.topPt }))) } : {}),
    links,
    // The `/IDTree` is a name tree, sorted by byte value: a plain code-unit comparison of the ids as written.
    idTree: elements.flatMap((element) => (element.id ? [element.id] : [])).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    streamOrder,
    images: imageNotesOf(list, written.images),
  };
}

/** A text item as the report's `runs` see it, without the two members the measurement holds (the run's index and its computed colour), which `print()` joins by the item. Derivable. */
export type RunNote = ListPlace & Omit<ReportRun, 'index' | 'page' | 'color'>;

/** One segment as the report's `words` see it, without what the measurement holds, which `print()` joins by the item: derivable but for `emittedAdj`, the writer's pen. */
export type WordNote = ListPlace & {
  /** The MCID of the marked content the word sits in, -1 inside an artifact. */
  mcid: number;
  /** The segment's place in its item. */
  ordinal: number;
  /** Where the pen was aimed (`segments.x`). */
  xPt: number;
  /** Whether a space glyph was written before the word: the run's leading space for the first, DOM whitespace for the rest. */
  spaceEmitted: boolean;
  emittedAdj: number | null;
};

/**
 * The report's runs and words, keyed by item, from the list and the writer's MCIDs and pens.
 *
 * @remarks
 * A run's MCID is that of the content start its item sits under, by the writer's numbering (`mcids`), and -1 inside an artifact.
 *
 * @param mcids - Per page, the item index of the content start each MCID opens, by MCID.
 * @param pens - The writer's pen adjustments, one entry per text item.
 * @throws {CasterError} A text item the writer has no pen for.
 */
export function textNotesOf(list: DisplayList, mcids: number[][], pens: WriterPen[]): { runs: RunNote[]; words: WordNote[] } {
  const fonts = fontsByKey(list);
  const penAt = new Map(pens.map((pen) => [`${pen.page}:${pen.item}`, pen.adjustments]));
  const runs: RunNote[] = [];
  const words: WordNote[] = [];
  list.pages.forEach(({ items }, page) => {
    const mcidOf = new Map((mcids[page] ?? []).map((item, mcid) => [item, mcid]));
    let mcid = -1;
    items.forEach((item, at) => {
      if (item.kind === 'tag') {
        mcid = 'start' in item && 'element' in item.start ? (mcidOf.get(at) ?? -1) : -1;
        return;
      }
      if (item.kind !== 'text') return;
      const adjustments = penAt.get(`${page}:${at}`);
      if (!adjustments) throw new CasterError(`caster: the writer's records hold no pen for the text item ${at} of page ${page + 1}`, { listItem: { page, item: at } });
      runs.push({ page, item: at, line: item.lineIndex, faceId: fontOf(fonts, item).faceId, instanceKey: item.font, sizePt: round3(item.size), letterSpacingPt: round3(item.letterSpacing), mcid });
      item.segments.x.forEach((xPt, ordinal) => {
        words.push({ page, item: at, mcid, ordinal, xPt, spaceEmitted: item.space !== 0 && (ordinal === 0 ? item.leadingSpace : item.segments.spaceBefore[ordinal]), emittedAdj: adjustments[ordinal] ?? null });
      });
    });
  });
  return { runs, words };
}

/** The report's runs: each note joined to its item's origin. */
export function runsWith(runs: RunNote[], originAt: (at: ListPlace) => TextOrigin): ReportRun[] {
  return runs.map(({ page, item, line, faceId, instanceKey, sizePt, letterSpacingPt, mcid }) => {
    const origin = originAt({ page, item });
    return { index: origin.run, page, line, faceId, instanceKey, sizePt, color: origin.color, letterSpacingPt, mcid };
  });
}

/** The marked content each paragraph's lines were written under, by the paragraph's index in the measurement, in the order first written. */
export function paragraphMcidsOf(runs: RunNote[], originAt: (at: ListPlace) => TextOrigin): Map<number, { page: number, mcid: number }[]> {
  const out = new Map<number, { page: number, mcid: number }[]>();
  for (const { page, item, mcid } of runs) {
    if (mcid < 0) continue;
    const paragraph = originAt({ page, item }).paragraph;
    const held = out.get(paragraph) ?? [];
    if (!held.some((m) => m.page === page && m.mcid === mcid)) held.push({ page, mcid });
    out.set(paragraph, held);
  }
  return out;
}

/**
 * The report's colour record: the writer's, with each text run's row and work-list entry completed from the list and the item's origin.
 *
 * @remarks
 * The path is the item's owner, or the paragraph's where it has none; the hint, the ink box and the computed colour are the origin's; the text is the item's segments.
 */
export function colourWith(list: DisplayList, colour: WrittenColour, originAt: (at: ListPlace) => TextOrigin): ReportColor {
  const itemAt = (at: ListPlace) => list.pages[at.page].items[at.item] as TextItem;
  const elements: ReportColorElement[] = colour.elements.map((row) => {
    if (!('at' in row)) return row;
    const { at, target, resolved, overprint, operator, ...extra } = row;
    const item = itemAt(at);
    const origin = originAt(at);
    return { path: item.owner || origin.path, target, ...(origin.hint ? { hint: origin.hint } : {}), resolved, ...(overprint ? { overprint } : {}), operator, text: segmentTexts(item).join(' '), rectPt: origin.rectPt, page: at.page, ...extra };
  });
  const worklist: ReportWorklistEntry[] = colour.worklist.map((entry) => {
    if (!('at' in entry)) return entry;
    const origin = originAt(entry.at);
    return { path: itemAt(entry.at).owner || origin.path, target: entry.target, rgb: entry.rgb, css: origin.color, uses: entry.uses };
  });
  return { ...colour, elements, worklist };
}

/** What the report says of one painted image's source: derivable from the list and the writer's road. */
export type ImageNote = {
  /** The source format: the file's MIME type, the original's where the image pass decoded or re-encoded it, `application/pdf` for a facsimile. */
  format: string;
  /** Source bytes in: the file's length, or the original's. */
  bytesIn: number;
  /** Why the road was taken, in one phrase. */
  reason: string;
};

/**
 * The report's note on each image the writer painted, in the order of its uses.
 *
 * @remarks
 * Derivable: the source is the list's, and the one choice the phrase depends on is the writer's road (`info.path`), since a PNG the filter can read is passed through by this writer and could be decoded by another.
 *
 * @throws {CasterError} A use naming a source or a blob the list does not hold.
 */
export function imageNotesOf(list: DisplayList, uses: ImageUse[]): ImageNote[] {
  return uses.map((use) => {
    const source = list.resources.images[use.source];
    if (!source) throw new CasterError(`caster: the writer's records name image ${use.source}, which the display list does not hold`);
    return imageNote(list, source, use.info.path);
  });
}

/** One source's note. */
function imageNote(list: DisplayList, source: ImageSource, path: ImageUse['info']['path']): ImageNote {
  if (source.kind === 'facsimile' && source.facsimile) {
    return { format: 'application/pdf', bytesIn: blobOf(list, source.blob).length, reason: `page ${source.facsimile.page} of ${source.facsimile.url}, embedded as a Form XObject: vectors, text and fonts stay what they were` };
  }
  const format = source.original?.format ?? source.mime ?? '';
  const bytesIn = source.original?.bytes ?? 0;
  // A JPEG or PNG whose pixels the image pass reduced to `imageResolution` (the report's `resampled` says from what to what, which the list does not hold): a JPEG source reaches the list as a JPEG of the pass's making, a PNG as samples.
  const reduced = format === 'image/jpeg' || (format === 'image/png' && source.samples !== undefined && source.original?.why === undefined);
  if (source.jpeg !== undefined) {
    const chose = source.photo?.chosenQuality != null ? `the photo rule chose JPEG at quality ${source.photo.chosenQuality}` : 'the photo rule declined, so the pass encoded JPEG at the highest quality it tries';
    return { format, bytesIn, reason: format === 'image/png' || format === 'image/jpeg' ? chose : `no PDF filter reads ${format}; ${chose}` };
  }
  if (source.mime === 'image/jpeg' && source.original) return { format, bytesIn, reason: 'reduced by the image pass, its ICC profile kept' };
  if (source.samples !== undefined && source.original?.why !== undefined) return { format, bytesIn, reason: `decoded because of ${PNG_DECODE_REASONS[source.original.why]}` };
  if (reduced) return { format, bytesIn, reason: 'reduced by the image pass, carried as samples' };
  if (source.samples !== undefined) {
    return { format, bytesIn, reason: source.photo ? `no PDF filter reads ${format}; the photo rule declined: ${source.photo.reason}` : `no PDF filter reads ${format}` };
  }
  const bytes = blobOf(list, source.blob);
  if (source.mime === 'image/jpeg') {
    const info = parseJpeg(bytes);
    // An arithmetic-coded JPEG is a file because the image pass asked the browser for its pixels and was refused.
    const reason = info.arithmetic
      ? `arithmetic coding, and no browser decoder: ${source.refusal ?? 'none was asked'}; the entropy-coded data goes to /DCTDecode unread`
      : `SOF 0x${info.sofMarker.toString(16)}, ${info.components} components${info.adobe ? ', APP14 Adobe' : ''}`;
    return { format: 'image/jpeg', bytesIn: bytes.length, reason };
  }
  if (path === 'passthrough') {
    // The image pass gave the photo rule a look at an opaque RGB PNG over the threshold, and the rule declined, or the PNG would be its JPEG.
    return { format: 'image/png', bytesIn: bytes.length, reason: source.photo ? `IDAT passthrough with /Predictor 15; the photo rule declined: ${source.photo.reason}` : 'IDAT passthrough with /Predictor 15' };
  }
  const info = parsePng(bytes);
  const why = info.hasAlphaChannel ? 'alpha' : info.interlace !== 0 ? 'interlace' : 'palette-trns';
  return { format: 'image/png', bytesIn: bytes.length, reason: `decoded because of ${PNG_DECODE_REASONS[why]}` };
}

/** Why a PNG was decoded, as the report says it. */
const PNG_DECODE_REASONS: Record<PngDecodeReason, string> = {
  alpha: 'an alpha channel PDF has to carry as a separate /SMask',
  interlace: 'Adam7 interlacing, which /Predictor 15 does not describe',
  'palette-trns': 'a palette with tRNS, whose alpha is a per-pixel lookup',
};

/**
 * The bytes a blob key names.
 *
 * @throws {CasterError} A key the list holds no bytes for.
 */
function blobOf(list: DisplayList, key: string | undefined): Uint8Array {
  const bytes = key === undefined ? undefined : list.resources.blobs[key];
  if (!bytes) throw new CasterError(`caster: the display list names the blob ${String(key)} and holds no bytes for it`);
  return bytes;
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
