/**
 * `images/imagePass.js` — the image pass: what the browser does to an image before the display list holds it.
 *
 * @remarks
 * A file no PDF filter reads (WebP, AVIF, GIF) has its pixels asked of the browser, which decoded it for the screen and is the only decoder of it in this stack (`canvasDecode.js`); an opaque 8-bit RGB PNG over the pixel threshold, and every decoded or rasterised set of pixels, goes past the opaque-photo rule, whose JPEG re-encode and PSNR read-back are the browser's canvas too (`photoRule.js`). Both used to run inside the writer; they run here, in `print()` before the builder, so the list holds bytes the writer embeds and nothing it must still decode, and the writer reaches no browser API (*the same list prints the same bytes*, DESIGN.md S102, a draft; stage 3 of `.claude/plans/the-rust-writer/plan-close-the-list.md`). Every other file is handed through untouched: a JPEG to `/DCTDecode`, a PNG's `IDAT` to `/FlateDecode`, and the writer's own refusals (a frame PDF cannot carry, a JPEG at other than 8 bits) stay the writer's.
 *
 * One file is prepared once however many elements paint it: the pass is keyed by `src`, as the fetch is, and identical pixels name one blob in the list, so the writer's dedupe by content makes one XObject of them.
 *
 * @packageDocumentation
 */
import { decodeThroughCanvas } from './canvasDecode.ts';
import { applyPhotoRule, photoRuleOff, PHOTO_PIXEL_THRESHOLD } from './photoRule.ts';
import { parseJpeg } from './jpeg.ts';
import { canPassThroughIdat, decodePng, parsePng, PngColorType } from './png.ts';
import { CasterError } from '../errors.ts';

import type { DecodedSamples } from './samples.ts';
import type { PhotoDecision } from './photoRule.ts';

/** A file as the gateway fetched it. */
export type ImageFile = { bytes: Uint8Array, mimeType: string };

/**
 * What the pass made of one file, for the builder to write into the list: the file itself where nothing else is set, the decoded pixels where no PDF filter reads it, the photo rule's JPEG where the rule chose one.
 */
export type PreparedImage = {
  file: ImageFile;
  /** The pixels the browser decoded. */
  samples?: DecodedSamples;
  /** The JPEG the photo rule chose. */
  jpeg?: Uint8Array;
  /** The source format as the report names it, where the list holds pixels or a JPEG and not the file. */
  format?: string;
  /** The photo rule's decision, wherever it was consulted. */
  photo?: PhotoDecision;
  /** The browser's refusal, where the pass asked for pixels and handed the file through instead. */
  refusal?: string;
  /** A PNG with a `gAMA` and no `iCCP` or `sRGB`, recorded for the report. */
  gammaOnly?: boolean;
  decodeMs: number;
  encodeMs: number;
};

/** The photo rule over decoded or rasterised pixels, or its record when the flag says not to ask. */
export async function photoOf(samples: DecodedSamples, photoRule: boolean): Promise<PhotoDecision> {
  return photoRule
    ? applyPhotoRule({ width: samples.width, height: samples.height, rgb: samples.rgb, hasAlpha: samples.hasAlpha })
    : photoRuleOff(samples.width * samples.height);
}

/** Decoded pixels, past the photo rule. */
async function fromPixels(file: ImageFile, samples: DecodedSamples, format: string, photoRule: boolean): Promise<PreparedImage> {
  const photo = await photoOf(samples, photoRule);
  return { file, format, photo, ...(photo.jpeg ? { jpeg: photo.jpeg } : { samples }), decodeMs: samples.decodeMs, encodeMs: photo.encodeMs };
}

/**
 * Prepare one file for the list.
 *
 * @throws {CasterError} The browser cannot decode a file no PDF filter reads (`canvasDecode.js`), and whatever `png.js` refuses.
 */
export async function prepareImage(file: ImageFile, photoRule: boolean): Promise<PreparedImage> {
  const { bytes, mimeType } = file;
  if (mimeType === 'image/jpeg') {
    const info = parseJpeg(bytes);
    if (!info.arithmetic || info.unsupportedFrame || info.precision !== 8) return { file, decodeMs: 0, encodeMs: 0 };
    // Arithmetic coding: the spec's rule is to decode it through the browser, and Chromium has no arithmetic decoder at all — `createImageBitmap` refuses the file outright, and node has no `createImageBitmap`. So the browser is asked, and when it refuses (in both realms, measured: the stage 0 replay took the same pass-through in node as the print did in the page) the file is handed through, and the writer gives the entropy-coded data to `/DCTDecode` unread: arithmetic coding is part of ISO/IEC 10918-1, which is what the filter is defined against, and whether a reader implements it is measured on the other side rather than assumed here. The refusal travels with the file for the report, so the fallback records itself rather than passing silently.
    try {
      return await fromPixels(file, await decodeThroughCanvas(bytes, mimeType), 'image/jpeg (arithmetic)', photoRule);
    } catch (error) {
      return { file, refusal: String(error), decodeMs: 0, encodeMs: 0 };
    }
  }
  if (mimeType === 'image/png') {
    const info = parsePng(bytes);
    // The photo rule still gets a look at an opaque RGB PNG, because a photograph stored losslessly is the case it exists for; it needs the samples to decide, and it only gets them when it might act. Any other PNG is the writer's, passed through or decoded by fast-png, which is pure.
    const pixels = info.width * info.height;
    if (!canPassThroughIdat(info) || info.colorType !== PngColorType.Rgb || info.bitDepth !== 8 || pixels <= PHOTO_PIXEL_THRESHOLD) return { file, decodeMs: 0, encodeMs: 0 };
    const started = performance.now();
    const decoded = decodePng(bytes);
    const decodeMs = performance.now() - started;
    // The `photoRule` flag reaches here and nowhere else. It ran unconditionally once, so the flag was accepted, reported, and inert: a document printed with it off still had its opaque photographs re-encoded as JPEG.
    const photo = photoRule ? await applyPhotoRule({ width: info.width, height: info.height, rgb: decoded.data as Uint8Array, hasAlpha: false }) : photoRuleOff(pixels);
    const gammaOnly = info.gama !== null && info.iccpDeflated === null && info.srgbIntent === null;
    return { file, photo, gammaOnly, ...(photo.jpeg ? { jpeg: photo.jpeg, format: mimeType } : {}), decodeMs, encodeMs: photo.encodeMs };
  }
  // WebP, AVIF, GIF: no PDF filter at all.
  return fromPixels(file, await decodeThroughCanvas(bytes, mimeType), mimeType, photoRule);
}

/** One image the print paints: where its file is, and what a refusal names. */
export type PaintedImage = { src: string, domPath: string, kind: string };

/**
 * Prepare every painted image's file, once per `src`.
 *
 * @remarks
 * Every refusal in this printer names an element, and the decoder tiers are where a browser's own refusal enters (*an SVG that arrives through an `<img>` is a drawing*, S44): `decodeThroughCanvas` throws whatever the browser refused with, so a refusal that does not already name an element is raised again naming the first element that paints the file, its type and its source.
 *
 * @throws {CasterError} An image no tier could prepare, naming its element.
 */
export async function prepareImages(painted: PaintedImage[], fileOf: (src: string) => ImageFile | undefined, photoRule: boolean): Promise<Map<string, PreparedImage>> {
  const prepared = new Map<string, PreparedImage>();
  for (const image of painted) {
    if (image.kind === 'facsimile' || prepared.has(image.src)) continue;
    const file = fileOf(image.src);
    if (!file) continue;
    try {
      prepared.set(image.src, await prepareImage(file, photoRule));
    } catch (error) {
      if (error instanceof CasterError && error.element) throw error;
      throw new CasterError(`caster: the ${file.mimeType} at ${image.domPath} (${image.src}) could not be carried into the file: ${error instanceof Error ? error.message : String(error)}`, { element: image.domPath });
    }
  }
  return prepared;
}
