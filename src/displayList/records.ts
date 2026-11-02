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
import { CasterError } from '../errors.ts';

import type { DisplayList, ImageSource, ImageUse, ListPlace, TextItem, TextOrigin, WriterPen, WrittenColour } from '../displayList.ts';
import type { ReportColor, ReportColorElement, ReportRun, ReportWorklistEntry } from '../report.ts';

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
        words.push({ page, item: at, mcid, ordinal, xPt, spaceEmitted: ordinal === 0 ? item.leadingSpace : item.segments.spaceBefore[ordinal], emittedAdj: adjustments[ordinal] ?? null });
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
  if (source.jpeg !== undefined) {
    const chose = `the photo rule chose JPEG at quality ${source.photo?.chosenQuality ?? null}`;
    return { format, bytesIn, reason: format === 'image/png' ? chose : `no PDF filter reads ${format}; ${chose}` };
  }
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
  const why = info.hasAlphaChannel
    ? 'an alpha channel PDF has to carry as a separate /SMask'
    : info.interlace !== 0
      ? 'Adam7 interlacing, which /Predictor 15 does not describe'
      : 'a palette with tRNS, whose alpha is a per-pixel lookup';
  return { format: 'image/png', bytesIn: bytes.length, reason: `decoded because of ${why}` };
}

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
