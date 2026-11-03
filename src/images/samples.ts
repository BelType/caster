/**
 * `images/samples.js` — decoded pixels as the writer reads them: the RGB and alpha planes an image and its `/SMask` need, and the RGBA bytes a raster travels in the display list.
 *
 * @remarks
 * Pure byte shuffling with no import and no DOM (an `ImageData` is read as a shape, never made), so the writer turns a list's RGBA into planes without reaching the browser's decoder in `images/canvasDecode.js`, where these lived (moved in stage 2 of `.claude/plans/the-rust-writer/plan-close-the-list.md`).
 *
 * @packageDocumentation
 */

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

/**
 * Samples from interleaved bytes as the display list carries them (version 6): `components` colour samples a pixel, then an alpha sample where `alpha` is set, each `bytesPerSample` bytes. The colour plane is `rgb` whatever its components; the alpha plane is kept only where some pixel is not opaque, which is every alpha byte `0xff` at either depth.
 */
export function samplesOf(bytes: Uint8Array, width: number, height: number, components: number, alpha: boolean, bytesPerSample: number): DecodedSamples {
  if (!alpha) return { width, height, rgb: bytes, alpha: null, hasAlpha: false, decodeMs: 0 };
  const pixels = width * height;
  const colourBytes = components * bytesPerSample;
  const stride = colourBytes + bytesPerSample;
  const colour = new Uint8Array(pixels * colourBytes);
  const plane = new Uint8Array(pixels * bytesPerSample);
  let opaque = true;
  for (let i = 0; i < pixels; i++) {
    colour.set(bytes.subarray(i * stride, i * stride + colourBytes), i * colourBytes);
    for (let b = 0; b < bytesPerSample; b++) {
      const a = bytes[i * stride + colourBytes + b];
      plane[i * bytesPerSample + b] = a;
      if (a !== 0xff) opaque = false;
    }
  }
  return { width, height, rgb: colour, alpha: opaque ? null : plane, hasAlpha: !opaque, decodeMs: 0 };
}

/** Samples from RGBA bytes. The decode time is not carried: it is a measurement of a decode that happened elsewhere, and the writer's report has no use for it on a raster. */
export function samplesFromRgba(rgba: Uint8Array, width: number, height: number): DecodedSamples {
  const { rgb, alpha, hasAlpha } = splitImageData((({ width, height, data: rgba } as unknown) as ImageData));
  return { width, height, rgb, alpha, hasAlpha, decodeMs: 0 };
}
