/**
 * `images/canvasDecode.js` — the decoder of last resort: the browser's own.
 *
 * Ported from `harness/src/export/canvasDecode.ts` (E7, E9, E12A). Guide: `docs/guide/images.md` §"The decoder tiers", and `docs/guide/vector-painting.md` for the raster fallback.
 *
 * The harness's own header follows.
 *
 * The decoder of last resort: the browser's own.
 *
 * WebP, AVIF, GIF and an arithmetic-coded JPEG have no PDF filter and no JS decoder in this stack, so the only way to get their pixels is to ask the engine that already decoded them for the screen. What comes back is always 8-bit sRGB, always unpremultiplied, and — for anything with a colour profile — already converted, which is exactly why this is a fallback and not the default path: it is the *displayed* image, not the *stored* one.
 *
 * The samples come out split, RGB in one plane and alpha in another, because that is the shape a PDF image and its `/SMask` need; interleaved RGBA is a shape no PDF object has.
 *
 * @packageDocumentation
 */
import { CasterError } from '../errors.ts';

export type DecodedSamples = {
  width: number;
  height: number;
  /** Three bytes per pixel, row-major from the top. */
  rgb: Uint8Array;
  /** One byte per pixel, or null when every pixel was opaque. */
  alpha: Uint8Array | null;
  hasAlpha: boolean;
  /** Milliseconds from the first decode call to the last sample read. */
  decodeMs: number;
};

/** Split an `ImageData` into the two planes, and say whether the alpha one is worth keeping. */
export function splitImageData(data: ImageData): { rgb: Uint8Array; alpha: Uint8Array|null; hasAlpha: boolean; } {
  const pixels = data.width * data.height;
  const rgb = new Uint8Array(pixels * 3);
  const alpha = new Uint8Array(pixels);
  let hasAlpha = false;
  for (let i = 0; i < pixels; i++) {
    rgb[i * 3] = data.data[i * 4];
    rgb[i * 3 + 1] = data.data[i * 4 + 1];
    rgb[i * 3 + 2] = data.data[i * 4 + 2];
    const a = data.data[i * 4 + 3];
    alpha[i] = a;
    if (a !== 255) hasAlpha = true;
  }
  return { rgb, alpha: hasAlpha ? alpha : null, hasAlpha };
}

/** The RGBA bytes of decoded samples, row-major from the top: the form a raster travels in the display list. {@link samplesFromRgba} is the way back, exactly (an opaque alpha plane is kept as null by the same rule). */
export function rgbaOf(samples: DecodedSamples): Uint8Array {
  const pixels = samples.width * samples.height;
  const out = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    out[i * 4] = samples.rgb[i * 3];
    out[i * 4 + 1] = samples.rgb[i * 3 + 1];
    out[i * 4 + 2] = samples.rgb[i * 3 + 2];
    out[i * 4 + 3] = samples.alpha ? samples.alpha[i] : 255;
  }
  return out;
}

/** Samples from RGBA bytes. The decode time is not carried: it is a measurement of a decode that happened elsewhere, and the writer's report has no use for it on a raster. */
export function samplesFromRgba(rgba: Uint8Array, width: number, height: number): DecodedSamples {
  const { rgb, alpha, hasAlpha } = splitImageData((({ width, height, data: rgba } as unknown) as ImageData));
  return { width, height, rgb, alpha, hasAlpha, decodeMs: 0 };
}

/**
 * An `OffscreenCanvas` context, or the reason there is none.
 *
 * @throws {CasterError} The `OffscreenCanvas` offers no 2d context.
 */
function context2d(width: number, height: number): OffscreenCanvasRenderingContext2D {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new CasterError('canvasDecode: no 2d context on an OffscreenCanvas');
  return ctx;
}

/**
 * Decode encoded bytes through the browser.
 *
 * @remarks
 * `createImageBitmap` takes the first frame of an animated GIF, which is the only frame a PDF image can be; `premultiplyAlpha: 'none'` asks for the unpremultiplied samples an `/SMask` needs, so a low-alpha pixel keeps whatever colour precision the engine has rather than being rounded through a premultiplied intermediate.
 *
 * @throws {CasterError} The browser cannot decode the bytes as `mimeType`, or offers no 2d context.
 */
export async function decodeThroughCanvas(bytes: Uint8Array, mimeType: string): Promise<DecodedSamples> {
  const started = performance.now();
  const blob = new Blob([(bytes as BlobPart)], { type: mimeType });
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
  } catch (error) {
    throw new CasterError(`canvasDecode: the browser could not decode ${mimeType}: ${String(error)}`);
  }
  const ctx = context2d(bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  const split = splitImageData(data);
  return { width: data.width, height: data.height, ...split, decodeMs: performance.now() - started };
}

/**
 * A `<canvas>` element's own pixels, which for a canvas are the source of truth.
 *
 * @throws {CasterError} The canvas has no 2d context.
 */
export function decodeCanvasElement(canvas: HTMLCanvasElement): DecodedSamples {
  const started = performance.now();
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new CasterError('canvasDecode: <canvas> has no 2d context');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const split = splitImageData(data);
  return { width: data.width, height: data.height, ...split, decodeMs: performance.now() - started };
}

/** Put RGB samples back on a canvas, which is what the JPEG re-encoder needs. */
export function canvasFromRgb(width: number, height: number, rgb: Uint8Array): OffscreenCanvas {
  const ctx = context2d(width, height);
  const data = ctx.createImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    data.data[i * 4] = rgb[i * 3];
    data.data[i * 4 + 1] = rgb[i * 3 + 1];
    data.data[i * 4 + 2] = rgb[i * 3 + 2];
    data.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  return ctx.canvas;
}

/**
 * The raster fallback of `vector-painting.md` (E9): an isolated SVG document, drawn by the browser.
 *
 * @remarks
 * The only renderer in this stack that can draw a Gaussian blur, a drop shadow or a conic gradient is the one that already drew them on the screen, so the fragment that cannot be painted as vector is serialised into its own SVG document, handed back to the engine as an image, and read out as pixels. The data URL is same-origin, so the canvas is not tainted and `getImageData` answers; a fragment that reached for an external resource would not, which is the other reason the serialiser inlines everything it keeps.
 *
 * The size is the painted rectangle in *points* at the chosen DPI, so a 300 dpi fallback of a 72-point box is 300 pixels across whatever the screen's own scale happens to be.
 *
 * @throws {CasterError} The browser refused the serialised document, or offers no 2d context.
 */
export async function rasterizeSvg(svg: string, widthPt: number, heightPt: number, dpi: number): Promise<DecodedSamples> {
  const started = performance.now();
  const width = Math.max(1, Math.round((widthPt / 72) * dpi));
  const height = Math.max(1, Math.round((heightPt / 72) * dpi));
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const image = new Image();
  image.width = width;
  image.height = height;
  await new Promise<any>((resolve, reject) => {
    image.onload = () => resolve(undefined);
    image.onerror = () => reject(new CasterError('canvasDecode: the browser refused the serialised SVG fallback'));
    image.src = url;
  });
  const ctx = context2d(width, height);
  ctx.drawImage(image, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height);
  const split = splitImageData(data);
  return { width, height, ...split, decodeMs: performance.now() - started };
}
