/**
 * `displayList/records.js` — what the report says of a printed list that the list itself decides, so a writer returns only what it chose.
 *
 * Caster's own (stage 4 of `.claude/plans/the-rust-writer/plan-close-the-list.md`). A writer, this one or a foreign one, returns its records beside the file: the choices it made, keyed by the list's own places (a page and an item index). Everything else the report records of the file is a function of the list and of those choices, and is made here, in node or in the page alike, with no DOM, no measurement and no pdf-lib.
 *
 * @packageDocumentation
 */

import { parseJpeg } from '../images/jpeg.ts';
import { parsePng } from '../images/png.ts';
import { CasterError } from '../errors.ts';

import type { DisplayList, ImageSource, ImageUse } from '../displayList.ts';

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
