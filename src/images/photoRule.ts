/**
 * `images/photoRule.js` — the opaque-photo rule: when a lossless image is worth re-encoding as JPEG.
 *
 * Ported from `harness/src/export/photoRule.ts` (E7, E12A). Guide: `docs/guide/images.md` §"The opaque-photo rule" — the rule and its four gates.
 *
 * The harness's own header follows.
 *
 * The opaque-photo rule: when a lossless image is worth re-encoding as JPEG.
 *
 * A photograph stored as PNG is a bad trade in a PDF — the exporter has the samples anyway, and Flate over photographic noise buys almost nothing, so the file carries megabytes to describe grain no reader will ever look at. A screenshot is the opposite case: flat colour, hard edges, text. Flate is near-perfect on it and JPEG would visibly destroy it. The rule has to separate the two without being told which is which.
 *
 * Four gates, all of which have to open, and then a measurement. No alpha, because JPEG has none. Not palettised and not grayscale, because those are already the cheap cases and both are usually graphics. More than a quarter of a million pixels, because below that nothing is saved worth the loss. And a photographic look: sampled pixels are mostly distinct, and no sampled row contains a long run of identical pixels — a run is what a flat background looks like and a photograph does not have one.
 *
 * Then the quality is measured rather than assumed: the image is encoded at three qualities, each is decoded back, and the lowest quality whose PSNR against the source clears 40 dB wins. 40 dB is the point at which the difference stops being visible on a photograph at print size; the table of what each quality actually scored goes in the report so the threshold can be argued with rather than believed.
 *
 * @packageDocumentation
 */
import { canvasFromRgb } from './canvasDecode.ts';
import { parseJpeg, subsamplingOf } from './jpeg.ts';
import { CasterError } from '../errors.ts';

/** Below this many pixels nothing is worth losing. */
export const PHOTO_PIXEL_THRESHOLD = 250_000;

/** Sampled pixels that have to be distinct, as a fraction of the sample. */
export const PHOTO_UNIQUE_RATIO_THRESHOLD = 0.3;

/** The longest run of identical neighbouring pixels a photograph may contain. */
export const PHOTO_RUN_THRESHOLD = 64;

/** How many pixels the heuristic looks at, and how many rows it scans for runs. */
const SAMPLE_PIXELS = 10_000;
const SAMPLE_ROWS = 64;

/** The qualities tried, cheapest first. */
export const PHOTO_QUALITIES = Object.freeze([0.85, 0.9, 0.95]);

/** The PSNR a re-encode has to reach. */
export const PHOTO_PSNR_TARGET = 40;

export type PhotoVerdict = {
  isPhoto: boolean;
  /** Why not, or `photographic` when it is. */
  reason: string;
  pixels: number;
  uniqueRatio: number;
  longestRun: number;
};

export type PhotoCandidate = {
  quality: number;
  bytes: number;
  psnrDb: number;
  /** What the browser's own encoder chose at this quality, read back off the frame. */
  subsampling: string;
};

export type PhotoDecision = PhotoVerdict & { candidates: PhotoCandidate[], chosenQuality: number | null, jpeg: Uint8Array | null, encodeMs: number };

/** A deterministic sampler, so two runs of the heuristic see the same pixels. */
function sampler(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type PhotoInput = {
  width: number;
  height: number;
  rgb: Uint8Array;
  hasAlpha: boolean;
  /** Palettised and grayscale sources are excluded by kind, not by measurement. */
  palettised?: boolean;
  grayscale?: boolean;
};

/** The four gates, and the sampled look of the pixels behind them. */
export function photoVerdict(input: PhotoInput): PhotoVerdict {
  const pixels = input.width * input.height;
  const base = { pixels, uniqueRatio: 0, longestRun: 0 };
  if (input.hasAlpha) return { isPhoto: false, reason: 'has an alpha channel', ...base };
  if (input.palettised) return { isPhoto: false, reason: 'palettised', ...base };
  if (input.grayscale) return { isPhoto: false, reason: 'grayscale', ...base };
  if (pixels <= PHOTO_PIXEL_THRESHOLD) {
    return { isPhoto: false, reason: `${pixels} pixels, at or below the ${PHOTO_PIXEL_THRESHOLD} threshold`, ...base };
  }

  const random = sampler(0x7e10);
  const seen: Set<number> = new Set<any>();
  for (let i = 0; i < SAMPLE_PIXELS; i++) {
    const x = Math.floor(random() * input.width);
    const y = Math.floor(random() * input.height);
    const at = (y * input.width + x) * 3;
    seen.add((input.rgb[at] << 16) | (input.rgb[at + 1] << 8) | input.rgb[at + 2]);
  }
  const uniqueRatio = seen.size / SAMPLE_PIXELS;

  let longestRun = 0;
  for (let s = 0; s < SAMPLE_ROWS; s++) {
    const y = Math.floor(random() * input.height);
    let run = 1;
    for (let x = 1; x < input.width; x++) {
      const at = (y * input.width + x) * 3;
      const before = at - 3;
      const same =
        input.rgb[at] === input.rgb[before] && input.rgb[at + 1] === input.rgb[before + 1] && input.rgb[at + 2] === input.rgb[before + 2];
      if (same) run += 1;
      else {
        if (run > longestRun) longestRun = run;
        run = 1;
      }
    }
    if (run > longestRun) longestRun = run;
  }

  const measured = { pixels, uniqueRatio, longestRun };
  if (uniqueRatio <= PHOTO_UNIQUE_RATIO_THRESHOLD) {
    return { isPhoto: false, reason: `unique-colour ratio ${uniqueRatio.toFixed(4)} at or below ${PHOTO_UNIQUE_RATIO_THRESHOLD}`, ...measured };
  }
  if (longestRun > PHOTO_RUN_THRESHOLD) {
    return { isPhoto: false, reason: `an identical-pixel run of ${longestRun}, above ${PHOTO_RUN_THRESHOLD}`, ...measured };
  }
  return { isPhoto: true, reason: 'photographic', ...measured };
}

/**
 * Peak signal-to-noise ratio in decibels between two RGB planes of the same size.
 *
 * @throws {CasterError} Two planes of different lengths.
 */
export function psnr(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) throw new CasterError(`photoRule: ${a.length} samples against ${b.length}`);
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  const mse = sum / a.length;
  return mse === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10((255 * 255) / mse);
}

/** A blob's bytes. */
async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Decode a JPEG the browser just produced, so its PSNR is measured and not estimated.
 *
 * @throws {CasterError} The `OffscreenCanvas` offers no 2d context.
 */
async function decodeJpegSamples(bytes: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([(bytes as BlobPart)], { type: 'image/jpeg' }));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new CasterError('photoRule: no 2d context');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const data = ctx.getImageData(0, 0, width, height);
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = data.data[i * 4];
    rgb[i * 3 + 1] = data.data[i * 4 + 1];
    rgb[i * 3 + 2] = data.data[i * 4 + 2];
  }
  return rgb;
}

/**
 * Run the rule and, when it opens, the re-encode.
 *
 * @remarks
 * Every quality is encoded and measured even after one has won, because the table is the point: the record has to be able to say what the two qualities that were not chosen would have cost and scored.
 */
export async function applyPhotoRule(input: PhotoInput): Promise<PhotoDecision> {
  const verdict = photoVerdict(input);
  if (!verdict.isPhoto) return { ...verdict, candidates: [], chosenQuality: null, jpeg: null, encodeMs: 0 };

  const started = performance.now();
  const canvas = canvasFromRgb(input.width, input.height, input.rgb);
  const candidates: PhotoCandidate[] = [];
  const encoded: Map<number,Uint8Array> = new Map<any, any>();
  for (const quality of PHOTO_QUALITIES) {
    const bytes = await blobBytes(await canvas.convertToBlob({ type: 'image/jpeg', quality }));
    encoded.set(quality, bytes);
    const back = await decodeJpegSamples(bytes, input.width, input.height);
    candidates.push({
      quality,
      bytes: bytes.length,
      psnrDb: psnr(input.rgb, back),
      subsampling: subsamplingOf(parseJpeg(bytes)),
    });
  }
  const encodeMs = performance.now() - started;

  const winner = candidates.find((c) => c.psnrDb >= PHOTO_PSNR_TARGET);
  if (!winner) {
    // No quality reached the target, so nothing is re-encoded: the lossless path is still correct and is what the file gets.
    return {
      ...verdict,
      isPhoto: false,
      reason: `photographic, but no quality reached ${PHOTO_PSNR_TARGET} dB`,
      candidates,
      chosenQuality: null,
      jpeg: null,
      encodeMs,
    };
  }
  return { ...verdict, candidates, chosenQuality: winner.quality, jpeg: (encoded.get(winner.quality) as Uint8Array), encodeMs };
}
