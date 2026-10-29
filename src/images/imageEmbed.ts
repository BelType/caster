/**
 * `images/imageEmbed.js` — image XObjects: the original bytes wherever PDF has a filter for them.
 *
 * Ported from `harness/src/export/imageEmbed.ts` (E7, E12A). Guide: `docs/guide/images.md` §"The passthrough table", §"The CMYK `/Decode` array", §"Dedupe".
 *
 * WHAT THE PORT CHANGED (P2). Pdf-lib arrives through `capability('pdf')` rather than a static import, so this module evaluates with no bundle present.
 *
 * The harness's own header follows.
 *
 * Image XObjects: the original bytes wherever PDF has a filter for them.
 *
 * The whole of this module is one decision made per image, and the decision is always the same shape: *is there a PDF filter that already reads this file?* When there is, the file's own bytes become the stream and nothing is decoded, nothing is re-compressed and nothing is lost. When there is not, the samples are decoded once — by a JS decoder where one exists, by the browser where none does — and written as raw samples under Flate, unless the opaque-photo rule says a JPEG re-encode is the better trade.
 *
 * Two of those filters are worth stating because they are easy to miss. `/DCTDecode` reads a JPEG's entropy-coded data verbatim, including a progressive one, so every JPEG a browser can display is a JPEG a PDF can carry — the component count is the colour space, the APP14 marker is the CMYK inversion, and the APP2 profile is the `/ICCBased` stream. `/FlateDecode` with `/Predictor 15` *is* the PNG filter set, and a PNG's concatenated `IDAT` is already a zlib stream, so a non-interlaced PNG with no alpha needs no decoder either — including a 16-bit one, which no canvas could have given back.
 *
 * Deduplication is by content, not by URL: the SHA-256 of the source bytes together with every parameter that changed how they were interpreted. A logo painted in a running header on three pages is one stream and three references; the same file placed twice at different `image-rendering` values is two, because the two files a reader gets are not the same object.
 *
 * @packageDocumentation
 */
import { capability } from '../capabilities.ts';
import { decodeThroughCanvas } from './canvasDecode.ts';
import { jpegColorSpaceName, parseJpeg } from './jpeg.ts';
import { applyPhotoRule } from './photoRule.ts';
import { canPassThroughIdat, colourKeyMask, decodePng, inflate, parsePng, PngColorType } from './png.ts';
import { CasterError } from '../errors.ts';

import type { DecodedSamples } from './canvasDecode.ts';
import type { JpegInfo } from './jpeg.ts';
import type { PngInfo } from './png.ts';
import type { PhotoDecision } from './photoRule.ts';
import type { MeasuredImage } from '../measure/textMeasure.ts';
import type { WalkImage } from '../walk/structure.ts';
import type { ReportImage } from '../report.ts';

/** How the samples got into the file. */
export type EmbedPath = 'passthrough' | 'decode-flate' | 'decode-jpeg' | 'form';

/** Everything the report and the checkers want to know about one embedded image. */
export type EmbeddedImageInfo = {
  /** The source format, as the gateway sniffed it. */
  format: string;
  path: EmbedPath;
  filter: string;
  bitsPerComponent: number;
  /** `/DeviceRGB`, `/DeviceGray`, `/DeviceCMYK`, `/Indexed`, `/ICCBased`. */
  colorSpace: string;
  hasSMask: boolean;
  /** The `/Decode` array, when one is written. */
  decode?: number[];
  width: number;
  height: number;
  interpolate: boolean;
  /** Source bytes in. */
  bytesIn: number;
  /** Stream bytes out, the `/SMask` included. */
  bytesOut: number;
  decodeMs: number;
  encodeMs: number;
  icc: 'embedded' | 'none';
  /** A `gAMA` with no `iCCP` and no `sRGB`: recorded, deliberately not acted on. */
  gammaOnly: boolean;
  /** The photo rule's verdict, present whenever the rule was consulted. */
  photo?: PhotoDecision;
  /** Why this path was taken, in one phrase. */
  reason: string;
};

/**
 * One XObject in the file, and the record of how it got there.
 *
 * @remarks
 * `ref` and `name` stay `any`, as the harness typed them: `vectors/vectorEmit.js` consumes this shape, so narrowing them to the pdf-lib globals is a change to that slice's contract rather than to this file.
 */
export type EmbeddedImage = {
  ref: PDFRef;
  hash: string;
  info: EmbeddedImageInfo;
  /** The resource name this XObject gets on every page that paints it. */
  name: PDFName;
};

/**
 * The pdf-lib context plus everything one document's images share.
 *
 * @remarks
 * `pdf`, every `context` and `ref` the helpers below pass around, and {@link EmbeddedImage}'s handles are the pdf-lib object types `types/vendor.d.ts` declares — the harness typed them `any`, and the TypeScript round (2026-09-21) narrowed them once `vectors/vectorEmit.js`, their consumer, was typed the same way. They are reached through `capability('pdf')`, never imported.
 */
export type ImageContext = {
  pdf: PDFContext;
  byHash: Map<string, EmbeddedImage>;
  /** Pages a given XObject has already been added to, so resources are written once. */
  onPage: Map<string, Set<number>>;
  /** Whether the opaque-photo rule may re-encode a raster as JPEG. The `photoRule` flag, and the only place it reaches. */
  photoRule: boolean;
};

/** A fresh image context for one document. */
export function createImageContext(pdf: PDFContext, options: { photoRule?: boolean; } = {}): ImageContext {
  return { pdf, byHash: new Map<any, any>(), onPage: new Map<any, any>(), photoRule: options.photoRule !== false };
}

/** What the caller hands over: either a file, or a canvas's samples. */
export type ImageSource = { kind: 'bytes', bytes: Uint8Array, mimeType: string, interpolate: boolean } | { kind: 'samples', samples: DecodedSamples, interpolate: boolean, label: string };

const hex = (bytes: Uint8Array): string => {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
};

async function sha256(...parts: (Uint8Array|string)[]): Promise<string> {
  const encoder = new TextEncoder();
  const buffers = parts.map((part) => (typeof part === 'string' ? encoder.encode(part) : part));
  const total = buffers.reduce((sum, b) => sum + b.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const buffer of buffers) {
    joined.set(buffer, at);
    at += buffer.length;
  }
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', joined)));
}

/** Zlib-wrapped deflate, which is what `/FlateDecode` reads. */
export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([(bytes as BlobPart)]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 16-bit samples as big-endian bytes, which is the only order a PDF stream has. */
function toBigEndian(samples: Uint16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    out[i * 2] = samples[i] >> 8;
    out[i * 2 + 1] = samples[i] & 0xff;
  }
  return out;
}

/** An `/ICCBased` colour-space array over a Flate-compressed profile. */
async function iccColorSpace(context: PDFContext, profile: Uint8Array, components: number): Promise<any> {
  const compressed = await deflate(profile);
  const ref = context.register(context.stream(compressed, { N: components, Filter: 'FlateDecode', Length: compressed.length }));
  return context.register(context.obj(['ICCBased', ref]));
}

/** An 8- or 16-bit grayscale `/SMask` stream over an alpha plane. */
async function smaskRef(context: PDFContext, width: number, height: number, bitsPerComponent: number, alpha: Uint8Array): Promise<{ ref: any; bytes: number; }> {
  const compressed = await deflate(alpha);
  const ref = context.register(
    context.stream(compressed, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: width,
      Height: height,
      ColorSpace: 'DeviceGray',
      BitsPerComponent: bitsPerComponent,
      Filter: 'FlateDecode',
      Length: compressed.length,
    }),
  );
  return { ref, bytes: compressed.length };
}

/**
 * The PNG colour space, which is the one place `/Indexed` and `iCCP` both land.
 *
 * @throws {CasterError} A palettised PNG with no `PLTE`.
 */
async function pngColorSpace(context: PDFContext, info: PngInfo): Promise<{ value: any; name: string; components: number; icc: boolean; }> {
  const { PDFHexString } = capability('pdf');
  if (info.colorType === PngColorType.Palette) {
    if (!info.palette) throw new CasterError('imageEmbed: a palettised PNG with no PLTE');
    const hival = info.palette.length / 3 - 1;
    return {
      value: context.obj(['Indexed', 'DeviceRGB', hival, PDFHexString.of(hex(info.palette))]),
      name: 'Indexed',
      components: 1,
      icc: false,
    };
  }
  const components = info.colorType === PngColorType.Rgb || info.colorType === PngColorType.Rgba ? 3 : 1;
  if (info.iccpDeflated) {
    const profile = await inflate(info.iccpDeflated);
    return { value: await iccColorSpace(context, profile, components), name: 'ICCBased', components, icc: true };
  }
  return {
    value: components === 3 ? 'DeviceRGB' : 'DeviceGray',
    name: components === 3 ? 'DeviceRGB' : 'DeviceGray',
    components,
    icc: false,
  };
}

/**
 * One sample per byte, from a PNG's packed sub-byte rows.
 *
 * @remarks
 * A PNG scanline of depth 1, 2 or 4 is packed most-significant bit first and padded to a whole byte at the end of each row, so the stride is `ceil(width * depth / 8)` and the last bits of a row are not the first pixels of the next. fast-png hands the packed buffer over as it stands; every caller in this file wants indices.
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

/** The alpha plane a palettised PNG's `tRNS` implies, one byte per pixel. */
function paletteAlpha(indices: Uint8Array, palette: number[][]): Uint8Array {
  const alpha = new Uint8Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    const entry = palette[indices[i]];
    alpha[i] = entry && entry.length > 3 ? entry[3] : 255;
  }
  return alpha;
}

/** The decision the opaque-photo rule would have made, when the flag says not to ask. The record is written the same way either way, because the report's reader has to be able to tell "not a photograph" from "never examined". */
function photoRuleOff(pixels: number): PhotoDecision {
  return { isPhoto: false, reason: 'the photoRule flag is off', pixels, uniqueRatio: 0, longestRun: 0, candidates: [], chosenQuality: null, jpeg: null, encodeMs: 0 };
}

/**
 * Embed one image, deduplicating by content.
 *
 * @remarks
 * The hash covers the source bytes *and* every parameter that changed their meaning, because two placements of one file that were interpreted differently are two different objects in the file even though they came from the same URL.
 *
 * @throws {CasterError} A JPEG whose frame PDF cannot carry, or one at other than 8 bits per sample; a palettised PNG with no `PLTE`; and whatever the decoders refuse (`png.js`, `jpeg.js`, `canvasDecode.js`).
 */
export async function embedImage(context: ImageContext, source: ImageSource): Promise<EmbeddedImage> {
  const parameters =
    source.kind === 'bytes'
      ? `bytes|${source.mimeType}|interpolate=${source.interpolate}`
      : `samples|${source.label}|${source.samples.width}x${source.samples.height}|interpolate=${source.interpolate}`;
  const payload = source.kind === 'bytes' ? source.bytes : source.samples.rgb;
  const alphaPayload = source.kind === 'samples' && source.samples.alpha ? source.samples.alpha : new Uint8Array(0);
  const hash = await sha256(payload, alphaPayload, parameters);

  const hit = context.byHash.get(hash);
  if (hit) return hit;

  const embedded = await build(context, source, hash);
  context.byHash.set(hash, embedded);
  return embedded;
}

/**
 * Add an XObject to a page's resources, once per page.
 *
 * @returns The name to paint it by on this page.
 */
export function useOnPage(context: ImageContext, image: EmbeddedImage, page: PDFPage, pageIndex: number): PDFName {
  let pages = context.onPage.get(image.hash);
  if (!pages) {
    pages = new Set<any>();
    context.onPage.set(image.hash, pages);
  }
  if (!pages.has(pageIndex)) {
    page.node.setXObject(image.name, image.ref);
    pages.add(pageIndex);
  }
  return image.name;
}

/** Build the XObject {@link embedImage} did not find by hash: the format's own road, or a decode. */
async function build(context: ImageContext, source: ImageSource, hash: string): Promise<EmbeddedImage> {
  const { PDFName } = capability('pdf');
  const pdf = context.pdf;
  const name = PDFName.of(`Im${context.byHash.size}`);

  if (source.kind === 'samples') {
    const built = await fromSamples(context, source.samples, source.interpolate, 'canvas', source.samples.rgb.length);
    return { ref: built.ref, hash, info: built.info, name };
  }

  const { bytes, mimeType, interpolate } = source;

  if (mimeType === 'image/jpeg') {
    const info = parseJpeg(bytes);
    if (info.unsupportedFrame) throw new CasterError(`imageEmbed: a JPEG frame marker 0x${info.sofMarker.toString(16)} PDF cannot carry`);
    // `/DCTDecode` is defined over 8-bit samples. A 12-bit JPEG (an extended sequential SOF1, which the frame check above accepts) fell past the 8-bit branch into the arithmetic fallback and was passed through declaring `/BitsPerComponent 8`, which is a file that says one thing and holds another. Refuse by name; a 12-bit source is re-saved at 8 bits or carried as a raster.
    if (info.precision !== 8) throw new CasterError(`imageEmbed: a JPEG at ${info.precision} bits per sample cannot be carried by /DCTDecode, which is defined over 8-bit samples; re-save it at 8 bits`);
    if (!info.arithmetic && info.precision === 8) {
      const built = await jpegPassthrough(pdf, bytes, info, interpolate);
      return { ref: built.ref, hash, info: built.info, name };
    }
    // Arithmetic coding: the spec's rule is to decode it through the browser, and Chromium has no arithmetic decoder at all — `createImageBitmap` refuses the file outright. So the browser is asked, and when it refuses, the entropy-coded data goes to `/DCTDecode` anyway: arithmetic coding is part of ISO/IEC 10918-1, which is what the filter is defined against, and whether a reader implements it is measured on the other side rather than assumed here. The cost of being wrong is a reader that shows nothing, so the fallback records itself in `reason` rather than passing silently.
    try {
      const samples = await decodeThroughCanvas(bytes, mimeType);
      const built = await fromSamples(context, samples, interpolate, 'image/jpeg (arithmetic)', bytes.length, samples.decodeMs);
      return { ref: built.ref, hash, info: built.info, name };
    } catch (error) {
      const built = await jpegPassthrough(pdf, bytes, info, interpolate);
      built.info.reason = `arithmetic coding, and no browser decoder: ${String(error)}; the entropy-coded data goes to /DCTDecode unread`;
      return { ref: built.ref, hash, info: built.info, name };
    }
  }

  if (mimeType === 'image/png') {
    const built = await fromPng(context, bytes, interpolate);
    return { ref: built.ref, hash, info: built.info, name };
  }

  // WebP, AVIF, GIF: no PDF filter at all.
  const samples = await decodeThroughCanvas(bytes, mimeType);
  const built = await fromSamples(context, samples, interpolate, mimeType, bytes.length, samples.decodeMs);
  return { ref: built.ref, hash, info: built.info, name };
}

export type Built = {
  ref: PDFRef;
  info: EmbeddedImageInfo;
};

async function jpegPassthrough(pdf: PDFContext, bytes: Uint8Array, info: JpegInfo, interpolate: boolean): Promise<Built> {
  const spaceName = jpegColorSpaceName(info.components);
  const colorSpace = info.iccProfile ? await iccColorSpace(pdf, info.iccProfile, info.components) : spaceName;
  // Adobe writes CMYK JPEGs with the samples inverted, and there is nothing in the entropy-coded data that says so; the APP14 marker is the whole signal and `/Decode` is the whole remedy. The sign was asserted by the harness's node test against a rendering of the same stream with the array flipped.
  const decode = info.components === 4 && info.adobe ? [1, 0, 1, 0, 1, 0, 1, 0] : undefined;
  const ref = pdf.register(
    pdf.stream(bytes, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: info.width,
      Height: info.height,
      ColorSpace: colorSpace,
      BitsPerComponent: 8,
      Filter: 'DCTDecode',
      Interpolate: interpolate,
      ...(decode ? { Decode: decode } : {}),
      Length: bytes.length,
    }),
  );
  return {
    ref,
    info: {
      format: 'image/jpeg',
      path: 'passthrough',
      filter: 'DCTDecode',
      bitsPerComponent: 8,
      colorSpace: info.iccProfile ? 'ICCBased' : spaceName,
      hasSMask: false,
      ...(decode ? { decode } : {}),
      width: info.width,
      height: info.height,
      interpolate,
      bytesIn: bytes.length,
      bytesOut: bytes.length,
      decodeMs: 0,
      encodeMs: 0,
      icc: info.iccProfile ? 'embedded' : 'none',
      gammaOnly: false,
      reason: `SOF 0x${info.sofMarker.toString(16)}, ${info.components} components${info.adobe ? ', APP14 Adobe' : ''}`,
    },
  };
}

async function fromPng(context: ImageContext, bytes: Uint8Array, interpolate: boolean): Promise<Built> {
  const pdf = context.pdf;
  const info = parsePng(bytes);
  const gammaOnly = info.gama !== null && info.iccpDeflated === null && info.srgbIntent === null;

  if (canPassThroughIdat(info)) {
    // The photo rule still gets a look at an opaque RGB PNG, because a photograph stored losslessly is the case it exists for; it needs the samples to decide, and it only gets them when it might act.
    const rgbCandidate = info.colorType === PngColorType.Rgb && info.bitDepth === 8 && info.width * info.height > 250_000;
    if (rgbCandidate) {
      const started = performance.now();
      const decoded = decodePng(bytes);
      const decodeMs = performance.now() - started;
      const rgb = (decoded.data as Uint8Array);
      // The `photoRule` flag reaches here and nowhere else. It ran unconditionally, so the flag was accepted, reported, and inert: a document exported with it off still had its opaque photographs re-encoded as JPEG.
      const decision = context.photoRule
        ? await applyPhotoRule({ width: info.width, height: info.height, rgb, hasAlpha: false })
        : photoRuleOff(info.width * info.height);
      if (decision.jpeg) {
        const ref = pdf.register(
          pdf.stream(decision.jpeg, {
            Type: 'XObject',
            Subtype: 'Image',
            Width: info.width,
            Height: info.height,
            ColorSpace: 'DeviceRGB',
            BitsPerComponent: 8,
            Filter: 'DCTDecode',
            Interpolate: interpolate,
            Length: decision.jpeg.length,
          }),
        );
        return {
          ref,
          info: {
            format: 'image/png',
            path: 'decode-jpeg',
            filter: 'DCTDecode',
            bitsPerComponent: 8,
            colorSpace: 'DeviceRGB',
            hasSMask: false,
            width: info.width,
            height: info.height,
            interpolate,
            bytesIn: bytes.length,
            bytesOut: decision.jpeg.length,
            decodeMs,
            encodeMs: decision.encodeMs,
            icc: 'none',
            gammaOnly,
            photo: decision,
            reason: `the photo rule chose JPEG at quality ${decision.chosenQuality}`,
          },
        };
      }
      const space = await pngColorSpace(pdf, info);
      const ref = pdf.register(
        pdf.stream(info.idat, {
          Type: 'XObject',
          Subtype: 'Image',
          Width: info.width,
          Height: info.height,
          ColorSpace: space.value,
          BitsPerComponent: info.bitDepth,
          Filter: 'FlateDecode',
          DecodeParms: { Predictor: 15, Colors: space.components, BitsPerComponent: info.bitDepth, Columns: info.width },
          ...(colourKeyMask(info) ? { Mask: colourKeyMask(info) } : {}),
          Interpolate: interpolate,
          Length: info.idat.length,
        }),
      );
      return {
        ref,
        info: {
          format: 'image/png',
          path: 'passthrough',
          filter: 'FlateDecode',
          bitsPerComponent: info.bitDepth,
          colorSpace: space.name,
          hasSMask: false,
          width: info.width,
          height: info.height,
          interpolate,
          bytesIn: bytes.length,
          bytesOut: info.idat.length,
          decodeMs,
          encodeMs: 0,
          icc: space.icc ? 'embedded' : 'none',
          gammaOnly,
          photo: decision,
          reason: `IDAT passthrough with /Predictor 15; the photo rule declined: ${decision.reason}`,
        },
      };
    }

    const space = await pngColorSpace(pdf, info);
    const ref = pdf.register(
      pdf.stream(info.idat, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: info.width,
        Height: info.height,
        ColorSpace: space.value,
        BitsPerComponent: info.bitDepth,
        Filter: 'FlateDecode',
        DecodeParms: { Predictor: 15, Colors: space.components, BitsPerComponent: info.bitDepth, Columns: info.width },
        // A Gray or RGB `tRNS` names a fully transparent sample value, and PDF says it with a colour-key `/Mask`. Dropped, every transparent pixel printed opaque.
        ...(colourKeyMask(info) ? { Mask: colourKeyMask(info) } : {}),
        Interpolate: interpolate,
        Length: info.idat.length,
      }),
    );
    return {
      ref,
      info: {
        format: 'image/png',
        path: 'passthrough',
        filter: 'FlateDecode',
        bitsPerComponent: info.bitDepth,
        colorSpace: space.name,
        hasSMask: false,
        width: info.width,
        height: info.height,
        interpolate,
        bytesIn: bytes.length,
        bytesOut: info.idat.length,
        decodeMs: 0,
        encodeMs: 0,
        icc: space.icc ? 'embedded' : 'none',
        gammaOnly,
        reason: 'IDAT passthrough with /Predictor 15',
      },
    };
  }

  // Alpha, interlacing or a palette with tRNS: the samples have to be rearranged, which means decoding them, which the JS decoder does at the file's own bit depth rather than a canvas's eight.
  const started = performance.now();
  const decoded = decodePng(bytes);
  const decodeMs = performance.now() - started;
  const pixels = info.width * info.height;

  let colour: Uint8Array;
  let alpha: Uint8Array|null = null;
  let bitsPerComponent = decoded.depth;
  let space: { value: any; name: string; components: number; icc: boolean; };

  if (info.colorType === PngColorType.Palette) {
    // fast-png keeps a sub-byte depth packed — a 4-bit palette comes back as one byte per two pixels, a 1-bit one as one byte per eight — and every byte was being read as a palette index. The image was garbage and the tRNS `/SMask` was width×height/2 bytes long for a stream that declared width×height. Unpacked to one index per byte, everything below works on the same shape whatever the file's depth, which is why `bitsPerComponent` is 8 here.
    colour = decoded.depth < 8 ? unpackSubByte((decoded.data as Uint8Array), decoded.depth, info.width, info.height) : (decoded.data as Uint8Array);
    alpha = decoded.palette ? paletteAlpha(colour, decoded.palette) : null;
    space = await pngColorSpace(pdf, info);
    bitsPerComponent = 8;
  } else if (decoded.depth < 8) {
    // The same unpacking for a sub-byte gray image, and for the same reason: `/BitsPerComponent 8` with one sample per byte is a shape everything downstream already handles, and the alternative is a `/Decode` array and a stride nobody else in this file knows about.
    colour = unpackSubByte((decoded.data as Uint8Array), decoded.depth, info.width, info.height);
    bitsPerComponent = 8;
    space = await pngColorSpace(pdf, info);
  } else if (decoded.depth === 16) {
    const samples = (decoded.data as Uint16Array);
    const channels = decoded.channels;
    const colourChannels = channels === 4 ? 3 : channels === 2 ? 1 : channels;
    const colour16 = new Uint16Array(pixels * colourChannels);
    const alpha16 = channels === 4 || channels === 2 ? new Uint16Array(pixels) : null;
    for (let i = 0; i < pixels; i++) {
      for (let c = 0; c < colourChannels; c++) colour16[i * colourChannels + c] = samples[i * channels + c];
      if (alpha16) alpha16[i] = samples[i * channels + colourChannels];
    }
    colour = toBigEndian(colour16);
    alpha = alpha16 ? toBigEndian(alpha16) : null;
    space = await pngColorSpace(pdf, info);
  } else {
    const samples = (decoded.data as Uint8Array);
    const channels = decoded.channels;
    const colourChannels = channels === 4 ? 3 : channels === 2 ? 1 : channels;
    const colour8 = new Uint8Array(pixels * colourChannels);
    const alpha8 = channels === 4 || channels === 2 ? new Uint8Array(pixels) : null;
    for (let i = 0; i < pixels; i++) {
      for (let c = 0; c < colourChannels; c++) colour8[i * colourChannels + c] = samples[i * channels + c];
      if (alpha8) alpha8[i] = samples[i * channels + colourChannels];
    }
    colour = colour8;
    alpha = alpha8;
    space = await pngColorSpace(pdf, info);
  }

  const compressed = await deflate(colour);
  const mask = alpha ? await smaskRef(pdf, info.width, info.height, bitsPerComponent, alpha) : null;
  const ref = pdf.register(
    pdf.stream(compressed, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: info.width,
      Height: info.height,
      ColorSpace: space.value,
      BitsPerComponent: bitsPerComponent,
      Filter: 'FlateDecode',
      Interpolate: interpolate,
      ...(mask ? { SMask: mask.ref } : {}),
      Length: compressed.length,
    }),
  );
  const why = info.hasAlphaChannel
    ? 'an alpha channel PDF has to carry as a separate /SMask'
    : info.interlace !== 0
      ? 'Adam7 interlacing, which /Predictor 15 does not describe'
      : 'a palette with tRNS, whose alpha is a per-pixel lookup';
  return {
    ref,
    info: {
      format: 'image/png',
      path: 'decode-flate',
      filter: 'FlateDecode',
      bitsPerComponent,
      colorSpace: space.name,
      hasSMask: mask !== null,
      width: info.width,
      height: info.height,
      interpolate,
      bytesIn: bytes.length,
      bytesOut: compressed.length + (mask?.bytes ?? 0),
      decodeMs,
      encodeMs: 0,
      icc: space.icc ? 'embedded' : 'none',
      gammaOnly,
      reason: `decoded because of ${why}`,
    },
  };
}

/** Decoded RGB(+alpha) samples, through the photo rule and then into a stream. */
async function fromSamples(context: ImageContext, samples: DecodedSamples, interpolate: boolean, format: string, bytesIn: number, decodeMs: number = samples.decodeMs): Promise<Built> {
  const pdf = context.pdf;
  const decision = context.photoRule
    ? await applyPhotoRule({ width: samples.width, height: samples.height, rgb: samples.rgb, hasAlpha: samples.hasAlpha })
    : photoRuleOff(samples.width * samples.height);

  if (decision.jpeg) {
    const ref = pdf.register(
      pdf.stream(decision.jpeg, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: samples.width,
        Height: samples.height,
        ColorSpace: 'DeviceRGB',
        BitsPerComponent: 8,
        Filter: 'DCTDecode',
        Interpolate: interpolate,
        Length: decision.jpeg.length,
      }),
    );
    return {
      ref,
      info: {
        format,
        path: 'decode-jpeg',
        filter: 'DCTDecode',
        bitsPerComponent: 8,
        colorSpace: 'DeviceRGB',
        hasSMask: false,
        width: samples.width,
        height: samples.height,
        interpolate,
        bytesIn,
        bytesOut: decision.jpeg.length,
        decodeMs,
        encodeMs: decision.encodeMs,
        icc: 'none',
        gammaOnly: false,
        photo: decision,
        reason: `no PDF filter reads ${format}; the photo rule chose JPEG at quality ${decision.chosenQuality}`,
      },
    };
  }

  const compressed = await deflate(samples.rgb);
  const mask = samples.alpha ? await smaskRef(pdf, samples.width, samples.height, 8, samples.alpha) : null;
  const ref = pdf.register(
    pdf.stream(compressed, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: samples.width,
      Height: samples.height,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
      Filter: 'FlateDecode',
      Interpolate: interpolate,
      ...(mask ? { SMask: mask.ref } : {}),
      Length: compressed.length,
    }),
  );
  return {
    ref,
    info: {
      format,
      path: 'decode-flate',
      filter: 'FlateDecode',
      bitsPerComponent: 8,
      colorSpace: 'DeviceRGB',
      hasSMask: mask !== null,
      width: samples.width,
      height: samples.height,
      interpolate,
      bytesIn,
      bytesOut: compressed.length + (mask?.bytes ?? 0),
      decodeMs,
      encodeMs: decision.encodeMs,
      icc: 'none',
      gammaOnly: false,
      photo: decision,
      reason: `no PDF filter reads ${format}; the photo rule declined: ${decision.reason}`,
    },
  };
}

/**
 * Everything about one painted image, in the shape the node checker reads back: what the file became (`embedded`) beside where the measurement put it (`image`).
 *
 * @remarks
 * Moved from the writer: it reads the placement, which is the measurement's and not the display list's, so `print()` makes it from the writer's `imageUses`.
 *
 * @param name - The XObject's resource name, without the slash.
 */
export function imageRecord(image: MeasuredImage, walk: Pick<WalkImage,'src'|'domPath'|'tag'|'alt'>, embedded: EmbeddedImage, name: string): ReportImage {
  const info = embedded.info;
  const placement = image.placement;
  return {
    src: walk.src,
    domPath: walk.domPath,
    format: info.format,
    path: info.path,
    filter: info.filter,
    bpc: info.bitsPerComponent,
    colorSpace: info.colorSpace,
    hasSMask: info.hasSMask,
    ...(info.decode ? { decode: info.decode } : {}),
    intrinsic: [info.width, info.height],
    displayedIntrinsic: placement.displayedIntrinsic,
    paintedRectPt: placement.paintedRectPt,
    ...(placement.clipRectPt ? { clipRectPt: placement.clipRectPt } : {}),
    ...(placement.clipReason ? { clipReason: placement.clipReason } : {}),
    cm: placement.cm,
    xobjectHash: embedded.hash,
    xobjectName: name,
    page: image.page,
    tag: walk.tag,
    ...(walk.alt ? { alt: walk.alt } : {}),
    effectiveDpi: placement.effectiveDpi,
    bytesIn: info.bytesIn,
    bytesOut: info.bytesOut,
    decodeMs: Math.round(info.decodeMs * 100) / 100,
    encodeMs: Math.round(info.encodeMs * 100) / 100,
    ...(placement.exifOrientation !== 1 ? { exifOrientation: placement.exifOrientation } : {}),
    ...(placement.imageOrientation ? { imageOrientation: placement.imageOrientation } : {}),
    ...(placement.declaredExifOrientation !== undefined ? { declaredExifOrientation: placement.declaredExifOrientation } : {}),
    icc: info.icc,
    gammaOnly: info.gammaOnly,
    interpolate: info.interpolate,
    objectFit: placement.objectFit,
    objectPosition: placement.objectPosition,
    transform: placement.transform,
    reason: info.reason,
  };
}
