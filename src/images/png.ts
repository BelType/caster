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
 * @packageDocumentation
 */
import { capability } from '../capabilities.ts';
import { CasterError } from '../errors.ts';

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
