/**
 * `images/png.js` — a PNG chunk reader, and the JS decoder behind it.
 *
 * Ported from `harness/src/export/png.ts` (E7, E12A). Guide: `docs/guide/images.md` §"The passthrough table", §"The decoder tiers".
 *
 * WHAT THE PORT CHANGED (P2). The harness's `import { decode } from 'fast-png'` is a `capability('fastPng')` handle, so this module evaluates in node with no bundle present and the registry decides whether the 33 kB decoder is downloaded at all.
 *
 * The harness's own header follows.
 *
 * A PNG chunk reader, and the JS decoder behind it.
 *
 * The reader exists because of one fact that turns most of the PNG rows of the passthrough table into no work at all: **a PNG's concatenated `IDAT` payload is already a valid `/FlateDecode` stream**, and the PNG filter set is exactly PDF's `/Predictor 15`. So a non-interlaced PNG with no alpha needs no decoder, no re-compression and no loss — the same bytes go into the file, with `/DecodeParms << /Predictor 15 /Colors n /BitsPerComponent b /Columns w >>` telling the reader how to unfilter them. That covers 8- and 16-bit RGB, gray and palette.
 *
 * The decoder is for the three cases where that does not hold. Alpha has to become a separate `/SMask` stream, and PDF has no way to split an interleaved RGBA scanline. Adam7 interleaves seven reduced images that PDF's predictor knows nothing about. And a palette with `tRNS` needs the alpha looked up per pixel. In all three the samples come out of `fast-png`, which reads the file's own bit depth rather than a canvas's eight bits.
 *
 * The decode runs in the image pass, before the display list, and {@link pngPixels} shapes its samples as the list carries them (version 6, Egildo's ruling of 2026-11-03 amending *the same list prints the same bytes*, S102); the writer reads this module's chunk reader and never its decoder.
 *
 * @packageDocumentation
 */
import { capability } from '../capabilities.ts';
import { CasterError } from '../errors.ts';

import type { PngDecodeReason } from '../displayList.ts';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * PNG colour types, by the IHDR byte.
 *
 * @remarks
 * Port note (P1): a TypeScript `const enum` becomes a frozen object; the member names and values are the harness's.
 */
export type PngColorTypeValue = 0 | 2 | 3 | 4 | 6;
export const PngColorType = Object.freeze({
  Gray: (0 as 0),
  Rgb: (2 as 2),
  Palette: (3 as 3),
  GrayAlpha: (4 as 4),
  Rgba: (6 as 6),
});

export type PngInfo = {
  width: number;
  height: number;
  bitDepth: number;
  colorType: PngColorTypeValue;
  interlace: number;
  /** Samples per pixel in the stored scanlines: 1 for gray and palette, 3 for RGB, and so on. */
  channels: number;
  /** True for colour types 4 and 6. */
  hasAlphaChannel: boolean;
  /** PLTE, three bytes per entry, or null. */
  palette: Uint8Array | null;
  /** tRNS verbatim: one alpha byte per palette entry, or the key colour. */
  trns: Uint8Array | null;
  /** gAMA's value in its stored form (gamma × 100000), or null. */
  gama: number | null;
  /** The iCCP profile name, or null. */
  iccpName: string | null;
  /** The iCCP profile, still deflated. Inflating needs a stream, so callers do it. */
  iccpDeflated: Uint8Array | null;
  /** The sRGB rendering intent, or null. */
  srgbIntent: number | null;
  /** Every IDAT payload concatenated: a complete zlib stream. */
  idat: Uint8Array;
  /** The chunk types in file order, for the record. */
  chunks: string[];
};

/**
 * Read every chunk the embedding decision needs, and concatenate the `IDAT`s.
 *
 * @throws {CasterError} Bytes without the PNG signature, or with no `IHDR`.
 */
export function parsePng(bytes: Uint8Array): PngInfo {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new CasterError('png: not a PNG signature');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType: PngColorTypeValue = PngColorType.Rgb;
  let interlace = 0;
  let palette: Uint8Array|null = null;
  let trns: Uint8Array|null = null;
  let gama: number|null = null;
  let iccpName: string|null = null;
  let iccpDeflated: Uint8Array|null = null;
  let srgbIntent: number|null = null;
  const idatParts: Uint8Array[] = [];
  const chunks: string[] = [];

  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const payload = bytes.subarray(at + 8, at + 8 + length);
    chunks.push(type);

    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      bitDepth = payload[8];
      colorType = (payload[9] as PngColorTypeValue);
      interlace = payload[12];
    } else if (type === 'PLTE') {
      palette = payload.slice();
    } else if (type === 'tRNS') {
      trns = payload.slice();
    } else if (type === 'gAMA') {
      gama = view.getUint32(at + 8);
    } else if (type === 'sRGB') {
      srgbIntent = payload[0];
    } else if (type === 'iCCP') {
      const nul = payload.indexOf(0);
      iccpName = String.fromCharCode(...payload.subarray(0, nul));
      // payload[nul + 1] is the compression method, always 0 (zlib deflate).
      iccpDeflated = payload.subarray(nul + 2).slice();
    } else if (type === 'IDAT') {
      idatParts.push(payload);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }

  if (width === 0 || height === 0) throw new CasterError('png: no IHDR');
  const total = idatParts.reduce((sum, part) => sum + part.length, 0);
  const idat = new Uint8Array(total);
  let offset = 0;
  for (const part of idatParts) {
    idat.set(part, offset);
    offset += part.length;
  }

  const channels =
    colorType === PngColorType.Rgb ? 3 : colorType === PngColorType.Rgba ? 4 : colorType === PngColorType.GrayAlpha ? 2 : 1;

  return {
    width,
    height,
    bitDepth,
    colorType,
    interlace,
    channels,
    hasAlphaChannel: colorType === PngColorType.GrayAlpha || colorType === PngColorType.Rgba,
    palette,
    trns,
    gama,
    iccpName,
    iccpDeflated,
    srgbIntent,
    idat,
    chunks,
  };
}

/**
 * The `/Mask` colour key a Gray or RGB PNG's `tRNS` chunk names, or null where there is none.
 *
 * @remarks
 * A `tRNS` on a Gray or an RGB image is not an alpha plane; it names one sample value that is fully transparent, and PDF's colour-key masking says the same thing with a `/Mask` array of min/max pairs in the image's own component range (ISO 32000-2 §8.9.6.4). Without it the chunk was simply dropped on the passthrough road and every transparent pixel printed opaque. PNG stores each value as two bytes whatever the bit depth, and only the low `bitDepth` bits are significant, so the 16-bit read is the right one at every depth.
 */
export function colourKeyMask(info: PngInfo): number[]|null {
  const trns = info.trns;
  if (trns === null) return null;
  const at = ( i: number) => (trns[i * 2] << 8) | trns[i * 2 + 1];
  if (info.colorType === PngColorType.Gray && trns.length >= 2) { const v = at(0); return [v, v]; }
  if (info.colorType === PngColorType.Rgb && trns.length >= 6) return [at(0), at(0), at(1), at(1), at(2), at(2)];
  return null;
}

/**
 * Whether the file's own `IDAT` can go into the PDF untouched.
 *
 * @remarks
 * Three things stop it. Alpha has to leave the colour samples and become an `/SMask`, and no predictor can split an interleaved scanline. Adam7 stores seven reduced images and PDF's `/Predictor 15` describes one. A palette with `tRNS` needs a per-pixel alpha that only a lookup can produce. Everything else — gray, RGB, palette, 8-bit or 16-bit — passes through, and a Gray or RGB `tRNS` rides along as the `/Mask` colour key `colourKeyMask` reads.
 */
export function canPassThroughIdat(info: PngInfo): boolean {
  if (info.hasAlphaChannel) return false;
  if (info.interlace !== 0) return false;
  if (info.colorType === PngColorType.Palette && info.trns !== null) return false;
  return true;
}

/** Samples as the file stores them, at the file's own bit depth. */
export type PngSamples = {
  width: number;
  height: number;
  /** 1 for gray and palette, 3 for RGB, 2 and 4 with alpha. */
  channels: number;
  depth: number;
  data: Uint8Array | Uint16Array;
  /** RGBA entries when the file is palettised; fast-png folds `tRNS` into them. */
  palette: number[][] | null;
};

/**
 * Decode through fast-png, at the file's own bit depth.
 *
 * @throws {CapabilityError} The `fastPng` capability was not loaded.
 */
export function decodePng(bytes: Uint8Array): PngSamples {
  const { decode: decodePngBytes } = capability('fastPng');
  const decoded = decodePngBytes(bytes);
  return {
    width: decoded.width,
    height: decoded.height,
    channels: decoded.channels,
    depth: decoded.depth,
    // fast-png declares `PngDataArray`, which also names `Uint8ClampedArray` — an encoder input. `decode` answers `Uint8Array` at depth ≤ 8 and `Uint16Array` at 16, so the cast states the decoder's half and changes nothing.
    data: (decoded.data as Uint8Array | Uint16Array),
    palette: decoded.palette ?? null,
  };
}

/** Inflate a zlib stream in the browser, which is the only place `iCCP` has to be read. */
export async function inflate(deflated: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([(deflated as BlobPart)]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * One sample per byte, from a PNG's packed sub-byte rows.
 *
 * @remarks
 * A PNG scanline of depth 1, 2 or 4 is packed most-significant bit first and padded to a whole byte at the end of each row, so the stride is `ceil(width * depth / 8)` and the last bits of a row are not the first pixels of the next. fast-png hands the packed buffer over as it stands; the list wants one sample a byte.
 *
 * @param depth - 1, 2 or 4.
 */
export function unpackSubByte(packed: Uint8Array, depth: number, width: number, height: number): Uint8Array {
  const perByte = 8 / depth;
  const mask = (1 << depth) - 1;
  const stride = Math.ceil((width * depth) / 8);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byte = packed[y * stride + Math.floor(x / perByte)] ?? 0;
      const shift = (perByte - 1 - (x % perByte)) * depth;
      out[y * width + x] = (byte >> shift) & mask;
    }
  }
  return out;
}

/** A decoded PNG as the display list carries it: an `ImageSamples` with its bytes in place of its blob keys. `DeviceCMYK` is the image pass's own conversion of one (version 7), never a PNG's decode. */
export type PngPixels = {
  width: number;
  height: number;
  /** Interleaved, row-major from the top: each pixel's colour components, then its alpha where `alpha` is set; big-endian at 16 bits. */
  data: Uint8Array;
  colorSpace: 'DeviceRGB' | 'DeviceGray' | 'Indexed' | 'DeviceCMYK';
  bitsPerComponent: 8 | 16;
  alpha: boolean;
  /** The `PLTE`, with `Indexed`. */
  palette?: Uint8Array;
  /** The `iCCP` profile, inflated, never with `Indexed`. */
  icc?: Uint8Array;
  /** Why the pass decoded a PNG whose `IDAT` no predictor describes; absent where the pass decoded it to reduce it. */
  why?: PngDecodeReason;
};

/**
 * Decode a PNG whose `IDAT` no predictor describes, into the samples the list carries: the file's own depth (a depth under 8 unpacked to one sample a byte), its own colour space, the palette's index with its `tRNS` alpha beside it, the profile inflated.
 *
 * @throws {CapabilityError} The `fastPng` capability was not loaded.
 * @throws {CasterError} A palettised PNG with no `PLTE`.
 */
export async function pngPixels(bytes: Uint8Array, info: PngInfo): Promise<PngPixels> {
  const decoded = decodePng(bytes);
  const { width, height } = info;
  const pixels = width * height;
  const why: PngDecodeReason = info.hasAlphaChannel ? 'alpha' : info.interlace !== 0 ? 'interlace' : 'palette-trns';
  const icc = info.iccpDeflated && info.colorType !== PngColorType.Palette ? { icc: await inflate(info.iccpDeflated) } : {};
  if (info.colorType === PngColorType.Palette) {
    if (!info.palette) throw new CasterError('png: a palettised PNG with no PLTE');
    const indices = decoded.depth < 8 ? unpackSubByte((decoded.data as Uint8Array), decoded.depth, width, height) : (decoded.data as Uint8Array);
    // fast-png folds `tRNS` into its RGBA palette entries; an entry it gives no alpha is opaque.
    let data = indices;
    if (info.trns !== null) {
      data = new Uint8Array(pixels * 2);
      for (let i = 0; i < pixels; i++) {
        const entry = decoded.palette?.[indices[i]];
        data[i * 2] = indices[i];
        data[i * 2 + 1] = entry && entry.length > 3 ? entry[3] : 255;
      }
    }
    return { width, height, data, colorSpace: 'Indexed', bitsPerComponent: 8, alpha: info.trns !== null, palette: info.palette, why };
  }
  const colorSpace = info.colorType === PngColorType.Rgb || info.colorType === PngColorType.Rgba ? 'DeviceRGB' : 'DeviceGray';
  let data: Uint8Array;
  if (decoded.depth === 16) {
    const samples = (decoded.data as Uint16Array);
    data = new Uint8Array(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
      data[i * 2] = samples[i] >> 8;
      data[i * 2 + 1] = samples[i] & 0xff;
    }
  } else {
    data = decoded.depth < 8 ? unpackSubByte((decoded.data as Uint8Array), decoded.depth, width, height) : (decoded.data as Uint8Array);
  }
  return { width, height, data, colorSpace, bitsPerComponent: decoded.depth === 16 ? 16 : 8, alpha: info.hasAlphaChannel, ...icc, why };
}
