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
import { splitImageData } from './samples.ts';

import type { DecodedSamples } from './samples.ts';

export type { DecodedSamples } from './samples.ts';

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
 * @param stored - Set by the image pass's downsampling: the file's own pixel order and, with `'none'`, its own numbers.
 * @throws {CasterError} The browser cannot decode the bytes as `mimeType`, or offers no 2d context.
 */
export async function decodeThroughCanvas(bytes: Uint8Array, mimeType: string, stored?: { colorSpaceConversion: 'none' | 'default' }): Promise<DecodedSamples> {
  const started = performance.now();
  const blob = new Blob([(bytes as BlobPart)], { type: mimeType });
  let bitmap: ImageBitmap;
  try {
    // `stored` asks for the pixels as the file keeps them, in the order it keeps them: no EXIF turn, so the placement's own matrix still applies it once, and with `'none'` no conversion to sRGB, so a profile the caller keeps still describes them (the image pass's downsampling, which resamples what is stored).
    bitmap = await createImageBitmap(blob, stored ? { premultiplyAlpha: 'none', colorSpaceConversion: stored.colorSpaceConversion, imageOrientation: 'none' } : { premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
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
 * @remarks
 * A canvas with a 2d context answers `getImageData` directly (the context is the one the page made, so the attributes asked here are ignored); a canvas whose context is another kind (`webgl`, `bitmaprenderer`) has no 2d context to ask, so it is drawn onto a `willReadFrequently` canvas of the same size and read from there. Either way the samples are eight-bit RGBA, unpremultiplied, as `getImageData` gives them.
 *
 * @throws {CasterError} The canvas has no pixels (a width or height of zero), or the browser refuses to read them: a canvas that drew a cross-origin image without CORS is tainted.
 */
export function decodeCanvasElement(canvas: HTMLCanvasElement): DecodedSamples {
  const started = performance.now();
  if (canvas.width === 0 || canvas.height === 0) throw new CasterError(`canvasDecode: <canvas> is ${canvas.width} by ${canvas.height} pixels, so there is nothing to print`);
  try {
    const own = canvas.getContext('2d', { willReadFrequently: true });
    const ctx = own ?? context2d(canvas.width, canvas.height);
    if (!own) ctx.drawImage(canvas, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const split = splitImageData(data);
    return { width: data.width, height: data.height, ...split, decodeMs: performance.now() - started };
  } catch (error) {
    if (error instanceof CasterError) throw error;
    throw new CasterError(`canvasDecode: the browser will not let the printer read the pixels of the <canvas> (a canvas that drew an image from another origin without CORS is tainted): ${String(error)}`);
  }
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
