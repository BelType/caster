/**
 * `images/imagePass.js` — the image pass: what the browser does to an image before the display list holds it.
 *
 * @remarks
 * A file no PDF filter reads (WebP, AVIF, GIF) has its pixels asked of the browser, which decoded it for the screen and is the only decoder of it in this stack (`canvasDecode.js`); an opaque 8-bit RGB PNG over the pixel threshold, and every decoded or rasterised set of pixels, goes past the opaque-photo rule, whose JPEG re-encode and PSNR read-back are the browser's canvas too (`photoRule.js`). Both used to run inside the writer; they run here, in `print()` before the builder, so the list holds bytes the writer embeds and nothing it must still decode, and the writer reaches no browser API (*the same list prints the same bytes*, DESIGN.md S102, a draft; stage 3 of `.claude/plans/the-rust-writer/plan-close-the-list.md`). A PNG whose `IDAT` no `/Predictor 15` describes (an alpha channel, Adam7, a palette with `tRNS`) is decoded here by fast-png, at its own depth and in its own colour space (`png.js`'s `pngPixels`), since version 6 of the list: the writer decodes nothing at all (Egildo's ruling of 2026-11-03 amending S102). Every other file is handed through untouched: a JPEG to `/DCTDecode`, a PNG's `IDAT` to `/FlateDecode`, and the writer's own refusals (a frame PDF cannot carry, a JPEG at other than 8 bits) stay the writer's.
 *
 * A file that prints above `imageResolution × downsampleThreshold` is reduced here first (`reduce` below, `resample.js`'s own kernel), at the smallest resolution over every use of it; what the reduction yields goes the way any pixels go, to the photo rule and then to samples or a JPEG, so nothing a writer reads changes (the image-handling survey, `.claude/plans/image-handling/`, Egildo's rulings of 2026-11-03).
 *
 * One file is prepared once however many elements paint it: the pass is keyed by `src`, as the fetch is, and identical pixels name one blob in the list, so the writer's dedupe by content makes one XObject of them.
 *
 * @packageDocumentation
 */
import { decodeThroughCanvas } from './canvasDecode.ts';
import { applyPhotoRule, photoRuleOff, PHOTO_PIXEL_THRESHOLD, PHOTO_QUALITIES } from './photoRule.ts';
import { parseJpeg, withIccProfile } from './jpeg.ts';
import { canPassThroughIdat, decodePng, parsePng, pngPixels, PngColorType } from './png.ts';
import { resample } from './resample.ts';
import { CasterError } from '../errors.ts';
import { canvasFromRgb } from './canvasDecode.ts';
import { rgbaOf, samplesFromRgba } from './samples.ts';

import type { ResampleFilter } from './resample.ts';
import type { DecodedSamples } from './samples.ts';
import type { PhotoDecision } from './photoRule.ts';
import type { PngPixels } from './png.ts';

/** A file as the gateway fetched it. */
export type ImageFile = { bytes: Uint8Array, mimeType: string };

/**
 * What the pass made of one file, for the builder to write into the list: the file itself where nothing else is set, the decoded pixels where no PDF filter reads it, the photo rule's JPEG where the rule chose one.
 */
export type PreparedImage = {
  file: ImageFile;
  /** The pixels the browser decoded. */
  samples?: DecodedSamples;
  /** The samples fast-png decoded from a PNG whose `IDAT` no predictor describes, as the list carries them. */
  png?: PngPixels;
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
  /** Where the pass reduced the file to `imageResolution`: its stored size, the size it was reduced to, the smallest resolution it prints at over all its uses, and the filter. Report only; the list holds the reduced pixels and nothing says they were reduced. */
  resampled?: { from: [number, number], to: [number, number], ppi: number, type: ResampleFilter };
  /** The reduced JPEG carrying the source's ICC profile, which travels as a file (`/ICCBased`), because the writer reads a profile off a JPEG file and writes `DeviceRGB` for the photo rule's `jpeg`. */
  carried?: Uint8Array;
  /** Why a file that qualified for reduction was left as it was: a CMYK JPEG, a one-bit image, an indexed PNG, a frame the browser cannot decode. Report only. */
  notResampled?: string;
  decodeMs: number;
  encodeMs: number;
  /** Milliseconds spent in the resampler, `0` where nothing was reduced. */
  resampleMs?: number;
};

/** What the pass was asked to do about resolution: `downsampleImages` and its three companions, as the flag table resolves them. */
export type DownsamplePlan = { on: boolean, resolution: number, threshold: number, type: ResampleFilter };

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


/** A file that qualifies for reduction, with the smallest resolution it prints at over every use. */
type Reduction = DownsamplePlan & { ppi: number };

/**
 * The size a file is reduced to: its stored size scaled by the target resolution over the one it prints at, in whole pixels and never below one.
 *
 * @remarks
 * A file placed on a page at several sizes is one XObject, so `ppi` is the smallest of its uses and the file keeps enough pixels for the largest box (*the measured resolution of an image is the smallest over all its uses*, the image-handling survey, section 1).
 */
export function reducedSize(width: number, height: number, ppi: number, resolution: number): [number, number] {
  const scale = resolution / ppi;
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

/** Big-endian 16-bit samples, as the list carries them, read as numbers. */
function samples16(bytes: Uint8Array): Uint16Array {
  const out = new Uint16Array(bytes.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = (bytes[i * 2] << 8) | bytes[i * 2 + 1];
  return out;
}

/** The same samples back in the list's byte order. */
function bytes16(samples: Uint16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) { out[i * 2] = samples[i] >> 8; out[i * 2 + 1] = samples[i] & 0xff; }
  return out;
}

/** A JPEG of RGB pixels at one quality, by the browser's encoder. */
async function jpegAt(rgb: Uint8Array, width: number, height: number, quality: number): Promise<Uint8Array> {
  return new Uint8Array(await (await canvasFromRgb(width, height, rgb).convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer());
}

/** The encoded JPEG as the list holds it: with the source's profile it is a file the writer reads as `/ICCBased`, without one the photo rule's `jpeg`. */
function jpegOf(encoded: Uint8Array, profile: Uint8Array | null): { jpeg: Uint8Array } | { carried: Uint8Array } {
  const profiled = withIccProfile(encoded, profile);
  return profiled === encoded ? { jpeg: encoded } : { carried: profiled };
}

/**
 * Reduce one file to the resolution asked, decode and resample and encode.
 *
 * @remarks
 * A JPEG, WebP, AVIF or GIF is decoded by the browser in the order its file stores the pixels (no EXIF turn, which the placement's matrix applies once). A JPEG is decoded with no colour conversion, so its numbers are the file's and its APP2 profile, spliced back into the encoded JPEG, still describes them; WebP, AVIF and GIF keep the browser's conversion to sRGB, since nothing here reads or carries their profile. A PNG is decoded by fast-png at its own depth and colour space, its `iCCP` kept. The samples are resampled by `resample.js`, and then the photo rule decides as it does for any pixels: a lossless source becomes a JPEG only if it is photographic and clears 40 dB, else it travels as samples; a JPEG source is a JPEG again, at the rule's measured quality, or at the highest the rule tries where the rule declined or is off.
 *
 * ponytail: this runs on the page's main thread, and a 36 MP photograph costs about 0.8 s of Catmull-Rom there (the image-handling survey, section 2). The upgrade is a dedicated worker, as the write has; a document of a few photographs does not need it.
 *
 * @returns The prepared file, or the reason a file that qualified was left as it was, or `null` where the format is not one this reduces.
 */
async function reduce(file: ImageFile, photoRule: boolean, reduction: Reduction): Promise<PreparedImage | string | null> {
  const { bytes, mimeType } = file;
  const { ppi, resolution, type } = reduction;
  if (mimeType === 'image/png') {
    const info = parsePng(bytes);
    if (info.colorType === PngColorType.Palette) return 'an indexed PNG is left alone';
    if (info.bitDepth < 8) return 'a PNG under eight bits a sample is left alone';
    if (info.trns !== null && !info.hasAlphaChannel) return 'a PNG with a transparent colour key is left alone';
    const [width, height] = reducedSize(info.width, info.height, ppi, resolution);
    if (width >= info.width && height >= info.height) return 'already at or below the target size';
    const gammaOnly = info.gama !== null && info.iccpDeflated === null && info.srgbIntent === null;
    const decodeStarted = performance.now();
    const png = await pngPixels(bytes, info);
    const decodeMs = performance.now() - decodeStarted;
    const channels = (png.colorSpace === 'DeviceRGB' ? 3 : 1) + (png.alpha ? 1 : 0);
    const resampleStarted = performance.now();
    const reduced = resample(png.bitsPerComponent === 16 ? samples16(png.data) : png.data, info.width, info.height, channels, png.alpha, width, height, type);
    const resampleMs = performance.now() - resampleStarted;
    const data = reduced instanceof Uint16Array ? bytes16(reduced) : reduced;
    const resampled = { from: [info.width, info.height] as [number, number], to: [width, height] as [number, number], ppi, type };
    const carried = { file, format: mimeType, ...(gammaOnly ? { gammaOnly } : {}), resampled, decodeMs, resampleMs };
    if (png.colorSpace === 'DeviceRGB' && png.bitsPerComponent === 8 && !png.alpha) {
      const photo = photoRule ? await applyPhotoRule({ width, height, rgb: data, hasAlpha: false }) : photoRuleOff(width * height);
      if (photo.jpeg) return { ...carried, photo, ...jpegOf(photo.jpeg, png.icc ?? null), encodeMs: photo.encodeMs };
      return { ...carried, photo, png: { width, height, data, colorSpace: png.colorSpace, bitsPerComponent: 8, alpha: false, ...(png.icc ? { icc: png.icc } : {}) }, encodeMs: photo.encodeMs };
    }
    return { ...carried, png: { width, height, data, colorSpace: png.colorSpace, bitsPerComponent: png.bitsPerComponent, alpha: png.alpha, ...(png.icc ? { icc: png.icc } : {}) }, encodeMs: 0 };
  }
  if (mimeType !== 'image/jpeg' && mimeType !== 'image/webp' && mimeType !== 'image/avif' && mimeType !== 'image/gif') return null;
  const jpeg = mimeType === 'image/jpeg' ? parseJpeg(bytes) : null;
  if (jpeg && jpeg.components === 4) return 'a CMYK JPEG is left alone';
  if (jpeg && (jpeg.unsupportedFrame || jpeg.precision !== 8)) return 'a JPEG frame the browser cannot decode is left alone';
  if (jpeg && jpeg.arithmetic) return 'an arithmetic-coded JPEG has no browser decoder';
  const decoded = await decodeThroughCanvas(bytes, mimeType, { colorSpaceConversion: jpeg ? 'none' : 'default' });
  const [width, height] = reducedSize(decoded.width, decoded.height, ppi, resolution);
  if (width >= decoded.width && height >= decoded.height) return 'already at or below the target size';
  const resampleStarted = performance.now();
  let samples: DecodedSamples;
  if (decoded.hasAlpha) {
    samples = samplesFromRgba(resample(rgbaOf(decoded), decoded.width, decoded.height, 4, true, width, height, type) as Uint8Array, width, height);
  } else {
    samples = { width, height, rgb: resample(decoded.rgb, decoded.width, decoded.height, 3, false, width, height, type) as Uint8Array, alpha: null, hasAlpha: false, decodeMs: 0 };
  }
  const resampleMs = performance.now() - resampleStarted;
  const photo = await photoOf(samples, photoRule);
  let encoded = photo.jpeg;
  let encodeMs = photo.encodeMs;
  if (!encoded && jpeg) {
    const started = performance.now();
    encoded = await jpegAt(samples.rgb, width, height, PHOTO_QUALITIES[PHOTO_QUALITIES.length - 1]);
    encodeMs += performance.now() - started;
  }
  return {
    file, format: mimeType, photo, decodeMs: decoded.decodeMs, encodeMs, resampleMs,
    resampled: { from: [decoded.width, decoded.height], to: [width, height], ppi, type },
    ...(encoded ? jpegOf(encoded, jpeg?.iccProfile ?? null) : { samples })
  };
}

/**
 * Prepare one file for the list.
 *
 * @param reduction - Set where the file qualifies for downsampling; a file it cannot reduce is prepared as it would be without, naming why in `notResampled`.
 * @throws {CasterError} The browser cannot decode a file no PDF filter reads (`canvasDecode.js`), and whatever `png.js` refuses.
 * @throws {CapabilityError} A PNG to decode with no `fastPng` loaded.
 */
export async function prepareImage(file: ImageFile, photoRule: boolean, reduction?: Reduction): Promise<PreparedImage> {
  if (reduction) {
    const reduced = await reduce(file, photoRule, reduction);
    if (reduced !== null && typeof reduced !== 'string') return reduced;
    const kept = await prepareImage(file, photoRule);
    return reduced === null ? kept : { ...kept, notResampled: reduced };
  }
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
    const gammaOnly = info.gama !== null && info.iccpDeflated === null && info.srgbIntent === null;
    if (!canPassThroughIdat(info)) {
      const started = performance.now();
      const png = await pngPixels(bytes, info);
      return { file, png, format: mimeType, ...(gammaOnly ? { gammaOnly } : {}), decodeMs: performance.now() - started, encodeMs: 0 };
    }
    // The photo rule still gets a look at an opaque RGB PNG, because a photograph stored losslessly is the case it exists for; it needs the samples to decide, and it only gets them when it might act. Any other PNG the predictor describes is the writer's, passed through.
    const pixels = info.width * info.height;
    if (info.colorType !== PngColorType.Rgb || info.bitDepth !== 8 || pixels <= PHOTO_PIXEL_THRESHOLD) return { file, decodeMs: 0, encodeMs: 0 };
    const started = performance.now();
    const decoded = decodePng(bytes);
    const decodeMs = performance.now() - started;
    // The `photoRule` flag reaches here and nowhere else. It ran unconditionally once, so the flag was accepted, reported, and inert: a document printed with it off still had its opaque photographs re-encoded as JPEG.
    const photo = photoRule ? await applyPhotoRule({ width: info.width, height: info.height, rgb: decoded.data as Uint8Array, hasAlpha: false }) : photoRuleOff(pixels);
    return { file, photo, gammaOnly, ...(photo.jpeg ? { jpeg: photo.jpeg, format: mimeType } : {}), decodeMs, encodeMs: photo.encodeMs };
  }
  // WebP, AVIF, GIF: no PDF filter at all.
  return fromPixels(file, await decodeThroughCanvas(bytes, mimeType), mimeType, photoRule);
}

/** One image the print paints: where its file is, and what a refusal names. */
export type PaintedImage = { src: string, domPath: string, kind: string, ppi?: number };

/**
 * Prepare every painted image's file, once per `src`.
 *
 * @remarks
 * Every refusal in this printer names an element, and the decoder tiers are where a browser's own refusal enters (*an SVG that arrives through an `<img>` is a drawing*, S44): `decodeThroughCanvas` throws whatever the browser refused with, so a refusal that does not already name an element is raised again naming the first element that paints the file, its type and its source.
 *
 * @throws {CasterError} An image no tier could prepare, naming its element.
 */
export async function prepareImages(painted: PaintedImage[], fileOf: (src: string) => ImageFile | undefined, photoRule: boolean, downsample?: DownsamplePlan): Promise<Map<string, PreparedImage>> {
  const prepared = new Map<string, PreparedImage>();
  // The smallest resolution each file prints at over all its uses: `ppi` is the effective resolution of one placement, as `imagePlace.js` records it.
  const smallest = new Map<string, number>();
  for (const image of painted) if (image.ppi !== undefined) smallest.set(image.src, Math.min(smallest.get(image.src) ?? Infinity, image.ppi));
  for (const image of painted) {
    if (image.kind === 'facsimile' || prepared.has(image.src)) continue;
    const file = fileOf(image.src);
    if (!file) continue;
    const ppi = smallest.get(image.src);
    const reduction = downsample?.on && ppi !== undefined && ppi > downsample.resolution * downsample.threshold ? { ...downsample, ppi } : undefined;
    try {
      prepared.set(image.src, await prepareImage(file, photoRule, reduction));
    } catch (error) {
      if (error instanceof CasterError && error.element) throw error;
      throw new CasterError(`caster: the ${file.mimeType} at ${image.domPath} (${image.src}) could not be carried into the file: ${error instanceof Error ? error.message : String(error)}`, { element: image.domPath });
    }
  }
  return prepared;
}
