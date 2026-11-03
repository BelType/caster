/**
 * `images/resample.js` — Caster's own image resampler: a separable two-pass kernel over interleaved samples.
 *
 * @remarks
 * The kernel is plain arithmetic, so the same input gives the same bytes in every engine and on every machine. The browser's canvas was measured and refused for this work: it resamples with a filter of its own choosing, undocumented, and its bytes depend on whether the canvas is accelerated, so a list recorded from it would depend on the recording machine's graphics (the image-handling survey, section 2, and Egildo's ruling 3 of 2026-11-03). Catmull-Rom needs no `Math.sin`, which is why `bicubic` is it and not Lanczos. The three filters are Distiller's: `bicubic` is Catmull-Rom (Adobe's default), `average` the area average, and `subsample` the nearest pixel.
 *
 * Samples are 1 to 4 channels, 8 or 16 bits (a `Uint8Array` or a `Uint16Array`); with `alpha` the last channel is alpha and the colour is resampled premultiplied, so a transparent edge does not darken. The first pass runs along the rows into a `Float32Array`, the second down the columns; the result is rounded and clamped, since the negative lobes of Catmull-Rom overshoot.
 *
 * @packageDocumentation
 */
import { CasterError } from '../errors.ts';

/** The filter a reduction uses, by the name `downsampleType` gives it. */
export type ResampleFilter = 'bicubic' | 'average' | 'subsample';

/** Interleaved samples, row-major from the top. */
export type Samples = Uint8Array | Uint16Array;

/** One axis's taps: for output `i`, the source indices `first[i]` to `first[i] + count[i] - 1` weighted by `weights` from `offset[i]`. */
type Taps = { first: Int32Array, count: Int32Array, offset: Int32Array, weights: Float64Array };

/** Catmull-Rom (a = -0.5), the cubic that passes through its samples. */
const catmullRom = (x: number): number => {
  const t = Math.abs(x);
  if (t < 1) return (1.5 * t - 2.5) * t * t + 1;
  if (t < 2) return ((-0.5 * t + 2.5) * t - 4) * t + 2;
  return 0;
};

/**
 * The taps of one axis, reducing `from` samples to `to`.
 *
 * @remarks
 * Each output sample's centre sits at `(i + 0.5) * scale` in source units; a bicubic reduction stretches its kernel by `scale` so it covers every source sample, and the weights of an output sample are normalised to sum to one, which also renormalises at an edge where taps fall off the image.
 */
function tapsOf(from: number, to: number, filter: ResampleFilter): Taps {
  const scale = from / to;
  const first = new Int32Array(to);
  const count = new Int32Array(to);
  const offset = new Int32Array(to);
  const lists: number[][] = [];
  let total = 0;
  for (let i = 0; i < to; i++) {
    const weights: number[] = [];
    let start: number;
    if (filter === 'subsample') {
      start = Math.min(from - 1, Math.floor((i + 0.5) * scale));
      weights.push(1);
    } else if (filter === 'average') {
      const lo = i * scale;
      const hi = (i + 1) * scale;
      start = Math.floor(lo);
      for (let j = start; j < Math.min(from, Math.ceil(hi)); j++) weights.push(Math.min(hi, j + 1) - Math.max(lo, j));
    } else {
      const stretch = Math.max(1, scale);
      const centre = (i + 0.5) * scale;
      start = Math.max(0, Math.ceil(centre - 2 * stretch - 0.5));
      const stop = Math.min(from - 1, Math.floor(centre + 2 * stretch - 0.5));
      for (let j = start; j <= stop; j++) weights.push(catmullRom((j + 0.5 - centre) / stretch));
    }
    let sum = 0;
    for (const w of weights) sum += w;
    first[i] = start;
    count[i] = weights.length;
    offset[i] = total;
    total += weights.length;
    lists.push(weights.map((w) => w / sum));
  }
  const flat = new Float64Array(total);
  lists.forEach((weights, i) => flat.set(weights, offset[i]));
  return { first, count, offset, weights: flat };
}

/**
 * Reduce an image to `toWidth` by `toHeight`.
 *
 * @param channels - Samples a pixel, 1 to 4, alpha included.
 * @param alpha - The last channel is alpha, and colour is resampled premultiplied.
 * @returns A new array of the input's type; the input itself where the size does not change.
 * @throws {CasterError} A size or channel count outside what the kernel reads, or a buffer of another length.
 */
export function resample(source: Samples, width: number, height: number, channels: number, alpha: boolean, toWidth: number, toHeight: number, filter: ResampleFilter): Samples {
  if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isInteger(toWidth) || !Number.isInteger(toHeight) || width < 1 || height < 1 || toWidth < 1 || toHeight < 1) {
    throw new CasterError(`resample: ${width}x${height} to ${toWidth}x${toHeight} is not a size`);
  }
  if (channels < 1 || channels > 4 || (alpha && channels % 2 === 1)) throw new CasterError(`resample: ${channels} channels${alpha ? ' with alpha' : ''} is not a layout this kernel reads`);
  if (source.length !== width * height * channels) throw new CasterError(`resample: ${source.length} samples for ${width}x${height} at ${channels} channels`);
  if (toWidth === width && toHeight === height) return source;
  const max = source instanceof Uint16Array ? 65535 : 255;
  const colour = alpha ? channels - 1 : channels;
  const across = tapsOf(width, toWidth, filter);
  const down = tapsOf(height, toHeight, filter);

  // Pass one: along each row, into premultiplied floats.
  const middle = new Float32Array(toWidth * height * channels);
  const acc = new Float64Array(channels);
  for (let y = 0; y < height; y++) {
    const row = y * width * channels;
    for (let x = 0; x < toWidth; x++) {
      acc.fill(0);
      const f = across.first[x];
      const n = across.count[x];
      const o = across.offset[x];
      for (let k = 0; k < n; k++) {
        const w = across.weights[o + k];
        const at = row + (f + k) * channels;
        if (alpha) {
          const a = source[at + colour];
          for (let c = 0; c < colour; c++) acc[c] += w * source[at + c] * a;
          acc[colour] += w * a;
        } else {
          for (let c = 0; c < channels; c++) acc[c] += w * source[at + c];
        }
      }
      const out = (y * toWidth + x) * channels;
      for (let c = 0; c < channels; c++) middle[out + c] = acc[c];
    }
  }

  // Pass two: down each column, then un-premultiply, round and clamp.
  const result = source instanceof Uint16Array ? new Uint16Array(toWidth * toHeight * channels) : new Uint8Array(toWidth * toHeight * channels);
  for (let y = 0; y < toHeight; y++) {
    const f = down.first[y];
    const n = down.count[y];
    const o = down.offset[y];
    for (let x = 0; x < toWidth; x++) {
      acc.fill(0);
      for (let k = 0; k < n; k++) {
        const w = down.weights[o + k];
        const at = ((f + k) * toWidth + x) * channels;
        for (let c = 0; c < channels; c++) acc[c] += w * middle[at + c];
      }
      const out = (y * toWidth + x) * channels;
      if (alpha) {
        const a = acc[colour];
        for (let c = 0; c < colour; c++) result[out + c] = a > 0 ? clamp(acc[c] / a, max) : 0;
        result[out + colour] = clamp(a, max);
      } else {
        for (let c = 0; c < channels; c++) result[out + c] = clamp(acc[c], max);
      }
    }
  }
  return result;
}

/** A sample rounded to the nearest whole value inside the depth's range. */
const clamp = (value: number, max: number): number => (value <= 0 ? 0 : value >= max ? max : Math.round(value));
