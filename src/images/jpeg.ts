/**
 * `images/jpeg.js` — a JPEG header reader, and nothing more.
 *
 * Ported from `harness/src/export/jpeg.ts` (E7, E12A). Guide: `docs/guide/images.md` §"The passthrough table", §"The CMYK `/Decode` array, decided by measurement".
 *
 * The harness's own header follows.
 *
 * A JPEG header reader, and nothing more.
 *
 * PDF's `/DCTDecode` takes a JPEG's entropy-coded data verbatim, so the whole of the embedding decision for a JPEG is made out of its markers: how many components the frame has decides `/ColorSpace`, the frame marker decides whether a decoder exists at all, `APP14` decides whether the CMYK samples are Adobe-inverted, `APP2` carries the ICC profile that becomes `/ICCBased`, and `APP1` carries the orientation that has to be folded into the placement matrix because the browser has already applied it.
 *
 * There is no decoder here on purpose. Decoding a JPEG to re-encode it is the one thing this experiment exists to avoid.
 *
 * @packageDocumentation
 */
import { CasterError } from '../errors.ts';

/** Start-of-frame markers, by what the frame is. */
const SOF_BASELINE = 0xc0;
const SOF_EXTENDED = 0xc1;
const SOF_PROGRESSIVE = 0xc2;
const SOF_LOSSLESS = 0xc3;
const SOF_ARITHMETIC_EXTENDED = 0xc9;
const SOF_ARITHMETIC_PROGRESSIVE = 0xca;

/** Markers that carry no length and are skipped as two bytes. */
const STANDALONE = new Set([0x01, 0xd8, 0xd9, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);

export type JpegInfo = {
  width: number;
  height: number;
  /** 1 for grayscale, 3 for YCbCr, 4 for CMYK or YCCK. This is the `/ColorSpace`. */
  components: number;
  /** Sample precision in bits; PDF only accepts 8 here. */
  precision: number;
  /** The SOF marker the frame opened with, e.g. 0xc2 for progressive. */
  sofMarker: number;
  progressive: boolean;
  /** SOF9 or SOF10: no free decoder, so the file has to go through a canvas. */
  arithmetic: boolean;
  /** SOF3, SOF5..7, SOF11..15: hierarchical or lossless, which PDF cannot carry either. */
  unsupportedFrame: boolean;
  /** EXIF IFD0 tag 0x0112, or 1 when there is no APP1 EXIF at all. */
  exifOrientation: number;
  /** The reassembled APP2 `ICC_PROFILE` payload, or null. */
  iccProfile: Uint8Array | null;
  /** Whether an APP14 `Adobe` marker is present, which is what inverts CMYK. */
  adobe: boolean;
  /** The APP14 transform byte: 0 none, 1 YCbCr, 2 YCCK. Null when there is no APP14. */
  adobeTransform: number | null;
  /** `[horizontal, vertical]` sampling factors per component, from the frame header. */
  samplingFactors: Array<[number, number]>;
};

/** Whether the four bytes at `at` spell `text` in ASCII. */
function matches(bytes: Uint8Array, at: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

/**
 * EXIF orientation out of an APP1 payload.
 *
 * @remarks
 * The payload is `Exif\0\0` then a TIFF header whose byte order its first two bytes declare, then IFD0. Only tag 0x0112 is wanted, and only from IFD0: an orientation in a thumbnail IFD is the thumbnail's, not the image's.
 */
function exifOrientationFrom(payload: Uint8Array): number {
  if (payload.length < 14 || !matches(payload, 0, 'Exif')) return 1;
  const tiff = payload.subarray(6);
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  const big = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!little && !big) return 1;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  if (view.getUint16(2, little) !== 42) return 1;
  const ifd0 = view.getUint32(4, little);
  if (ifd0 + 2 > tiff.length) return 1;
  const count = view.getUint16(ifd0, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > tiff.length) break;
    if (view.getUint16(entry, little) !== 0x0112) continue;
    const value = view.getUint16(entry + 8, little);
    return value >= 1 && value <= 8 ? value : 1;
  }
  return 1;
}

/**
 * Read every marker up to the first scan.
 *
 * @remarks
 * An ICC profile larger than a marker payload is split over several APP2 markers, each numbered; they are collected and concatenated in the order the chunk numbers give rather than the order they appear, because the specification permits the two to differ.
 *
 * @throws {CasterError} No SOI marker; a byte where a marker should be that is not one; no start-of-frame before the first scan.
 */
export function parseJpeg(bytes: Uint8Array): JpegInfo {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new CasterError('jpeg: no SOI marker');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let width = 0;
  let height = 0;
  let components = 0;
  let precision = 0;
  let sofMarker = 0;
  let exifOrientation = 1;
  let adobe = false;
  let adobeTransform: number|null = null;
  const samplingFactors: Array<[number,number]> = [];
  const iccChunks: { index: number; bytes: Uint8Array; }[] = [];

  let at = 2;
  while (at + 1 < bytes.length) {
    if (bytes[at] !== 0xff) throw new CasterError(`jpeg: expected a marker at byte ${at}, found 0x${bytes[at].toString(16)}`);
    let marker = bytes[at + 1];
    // Fill bytes: any number of 0xff may precede a marker code.
    while (marker === 0xff && at + 2 < bytes.length) {
      at += 1;
      marker = bytes[at + 1];
    }
    if (STANDALONE.has(marker)) {
      at += 2;
      continue;
    }
    if (at + 4 > bytes.length) break;
    const length = view.getUint16(at + 2);
    const payload = bytes.subarray(at + 4, at + 2 + length);

    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      sofMarker = marker;
      precision = payload[0];
      height = (payload[1] << 8) | payload[2];
      width = (payload[3] << 8) | payload[4];
      components = payload[5];
      samplingFactors.length = 0;
      for (let c = 0; c < components; c++) {
        const at3 = 6 + c * 3 + 1;
        samplingFactors.push([payload[at3] >> 4, payload[at3] & 0x0f]);
      }
    } else if (marker === 0xe1 && matches(payload, 0, 'Exif')) {
      // APP1 is not the Exif segment's private marker: XMP uses it too, and Photoshop, Lightroom and most cameras write the XMP packet after the Exif one. Reading every APP1 meant the last of them decided, and a file with Exif then XMP came back as orientation 1 — the picture printed sideways with nothing to say so. The `Exif` identifier is what tells them apart (ISO 12234-2 §4.5.4).
      exifOrientation = exifOrientationFrom(payload);
    } else if (marker === 0xe2 && matches(payload, 0, 'ICC_PROFILE\0')) {
      iccChunks.push({ index: payload[12], bytes: payload.subarray(14) });
    } else if (marker === 0xee && matches(payload, 0, 'Adobe')) {
      adobe = true;
      adobeTransform = payload[payload.length - 1];
    } else if (marker === 0xda) {
      break;
    }
    at += 2 + length;
  }

  if (sofMarker === 0) throw new CasterError('jpeg: no start-of-frame marker before the first scan');

  let iccProfile: Uint8Array|null = null;
  if (iccChunks.length > 0) {
    iccChunks.sort((a, b) => a.index - b.index);
    const total = iccChunks.reduce((sum, chunk) => sum + chunk.bytes.length, 0);
    iccProfile = new Uint8Array(total);
    let offset = 0;
    for (const chunk of iccChunks) {
      iccProfile.set(chunk.bytes, offset);
      offset += chunk.bytes.length;
    }
  }

  const arithmetic = sofMarker === SOF_ARITHMETIC_EXTENDED || sofMarker === SOF_ARITHMETIC_PROGRESSIVE;
  const supported = sofMarker === SOF_BASELINE || sofMarker === SOF_EXTENDED || sofMarker === SOF_PROGRESSIVE || arithmetic;

  return {
    width,
    height,
    components,
    precision,
    sofMarker,
    progressive: sofMarker === SOF_PROGRESSIVE || sofMarker === SOF_ARITHMETIC_PROGRESSIVE,
    arithmetic,
    unsupportedFrame: !supported || sofMarker === SOF_LOSSLESS,
    exifOrientation,
    iccProfile,
    adobe,
    adobeTransform,
    samplingFactors,
  };
}

/**
 * Chroma subsampling in the `J:a:b` notation, from the frame's sampling factors.
 *
 * @remarks
 * The luma component's factors set the sampling grid and the chroma components are read against it, so `2x2` luma beside `1x1` chroma is 4:2:0 and equal factors everywhere are 4:4:4. This exists because a JPEG encoder's choice of subsampling by quality is a thing to measure rather than to look up.
 */
export function subsamplingOf(info: JpegInfo): string {
  const factors = info.samplingFactors;
  if (factors.length === 0) return 'unknown';
  if (factors.length === 1) return 'grayscale';
  const [lh, lv] = factors[0];
  const chroma = factors.slice(1);
  if (chroma.every(([h, v]) => h === lh && v === lv)) return '4:4:4';
  if (lh === 2 && lv === 2 && chroma.every(([h, v]) => h === 1 && v === 1)) return '4:2:0';
  if (lh === 2 && lv === 1 && chroma.every(([h, v]) => h === 1 && v === 1)) return '4:2:2';
  if (lh === 1 && lv === 2 && chroma.every(([h, v]) => h === 1 && v === 1)) return '4:4:0';
  return factors.map(([h, v]) => `${h}x${v}`).join(' ');
}

/**
 * How the SOF component count is spelled in a PDF image dictionary.
 *
 * @throws {CasterError} A component count other than 1, 3 or 4.
 */
export function jpegColorSpaceName(components: number): 'DeviceGray'|'DeviceRGB'|'DeviceCMYK' {
  if (components === 1) return 'DeviceGray';
  if (components === 3) return 'DeviceRGB';
  if (components === 4) return 'DeviceCMYK';
  throw new CasterError(`jpeg: a frame with ${components} components has no PDF colour space`);
}
