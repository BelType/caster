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
 * The whole of this module is one decision made per image, and the decision is always the same shape: *is there a PDF filter that already reads this file?* When there is, the file's own bytes become the stream and nothing is decoded, nothing is re-compressed and nothing is lost. When there is not, the samples are decoded once, before the display list, and written as raw samples under Flate: by fast-png in the image pass (`images/imagePass.js`) for a PNG whose alpha, interlacing or palette transparency the filter cannot describe, at the file's own depth and in its own colour space, and by the browser in the same pass for a file no filter reads; both reach this module as samples, and it decodes nothing (version 6 of the list, Egildo's ruling of 2026-11-03 amending S102). The opaque-photo rule and its JPEG re-encode run in the same pass, so a JPEG it chose reaches this module as a JPEG, and its evidence stays in the list, where the report reads it (`displayList/records.js`); this module calls no decoder of the browser's and no canvas (stage 3 of `.claude/plans/the-rust-writer/plan-close-the-list.md`).
 *
 * Two of those filters are worth stating because they are easy to miss. `/DCTDecode` reads a JPEG's entropy-coded data verbatim, including a progressive one, so every JPEG a browser can display is a JPEG a PDF can carry — the component count is the colour space, the APP14 marker is the CMYK inversion, and the APP2 profile is the `/ICCBased` stream. `/FlateDecode` with `/Predictor 15` *is* the PNG filter set, and a PNG's concatenated `IDAT` is already a zlib stream, so a non-interlaced PNG with no alpha needs no decoder either — including a 16-bit one, which no canvas could have given back.
 *
 * Deduplication is by content, not by URL: the SHA-256 of the source bytes together with every parameter that changed how they were interpreted. A logo painted in a running header on three pages is one stream and three references; the same file placed twice at different `image-rendering` values is two, because the two files a reader gets are not the same object.
 *
 * @packageDocumentation
 */
import { capability } from '../capabilities.ts';
import { jpegColorSpaceName, parseJpeg } from './jpeg.ts';
import { canPassThroughIdat, colourKeyMask, inflate, parsePng, PngColorType } from './png.ts';
import { CasterError } from '../errors.ts';

import type { DecodedSamples } from './samples.ts';
import type { JpegInfo } from './jpeg.ts';
import type { PngInfo } from './png.ts';
import type { WrittenImageInfo } from '../displayList.ts';

/**
 * One XObject in the file, and the record of how it got there.
 *
 * @remarks
 * `ref` and `name` stay `any`, as the harness typed them: `vectors/vectorEmit.js` consumes this shape, so narrowing them to the pdf-lib globals is a change to that slice's contract rather than to this file.
 */
export type EmbeddedImage = {
  ref: PDFRef;
  hash: string;
  info: WrittenImageInfo;
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
};

/** A fresh image context for one document. */
export function createImageContext(pdf: PDFContext): ImageContext {
  return { pdf, byHash: new Map<any, any>(), onPage: new Map<any, any>() };
}

/**
 * What the caller hands over: a file, decoded samples, or the JPEG the opaque-photo rule chose for them.
 *
 * @remarks
 * Each member is one the dedupe key or a byte reads: `label` names samples in the key, `format` names the JPEG's source in it (the file's MIME type, or `canvas` for a raster fallback), and `gammaOnly` is recorded for a JPEG or samples whose source PNG the list no longer holds. Samples are 8-bit `DeviceRGB` unless `shape` says otherwise (a PNG's own, version 6), and `samples.rgb` is then the colour plane in that shape. What the report says of a source beyond that (its format, its length, why the road was taken) is `recordsOf`'s (`displayList/records.js`).
 */
export type EmbedSource =
  | { kind: 'bytes', bytes: Uint8Array, mimeType: string, interpolate: boolean }
  | { kind: 'samples', samples: DecodedSamples, interpolate: boolean, label: string, shape?: SampleShape, gammaOnly?: boolean }
  | { kind: 'jpeg', jpeg: Uint8Array, interpolate: boolean, format: string, gammaOnly: boolean };

/** What samples are other than 8-bit `DeviceRGB`: a decoded PNG's own depth and colour space, its palette and its profile. */
export type SampleShape = {
  colorSpace: 'DeviceRGB' | 'DeviceGray' | 'Indexed';
  bitsPerComponent: 8 | 16;
  /** The `PLTE`'s RGB triples, with `Indexed`. */
  palette?: Uint8Array;
  /** The ICC profile the colour components are in. */
  icc?: Uint8Array;
};

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

/**
 * Zlib-wrapped deflate, which is what `/FlateDecode` reads: pdf-lib's own pako, the compressor of every other stream in the file.
 *
 * @remarks
 * pako is JavaScript and deterministic, so one list deflates to the same bytes in the page and in node, and replay matches by construction; the platform's `CompressionStream('deflate')` wrote these streams until stage 3 of `.claude/plans/the-rust-writer/plan-close-the-list.md` and made the bytes the platform zlib's (Egildo's ruling of 2026-11-02, a library deflate, re-recorded once). pako reaches Caster inside the vendored pdf-lib and pdf-lib exports no deflate, so `flateStream` is asked for one: the stream it makes is never registered, so only its contents reach the file.
 */
export function deflate(context: PDFContext, bytes: Uint8Array): Uint8Array {
  return context.flateStream(bytes).getContents();
}

/** An `/ICCBased` colour-space array over a Flate-compressed profile. */
async function iccColorSpace(context: PDFContext, profile: Uint8Array, components: number): Promise<any> {
  const compressed = deflate(context, profile);
  const ref = context.register(context.stream(compressed, { N: components, Filter: 'FlateDecode', Length: compressed.length }));
  return context.register(context.obj(['ICCBased', ref]));
}

/** An 8- or 16-bit grayscale `/SMask` stream over an alpha plane. */
async function smaskRef(context: PDFContext, width: number, height: number, bitsPerComponent: number, alpha: Uint8Array): Promise<{ ref: any; bytes: number; }> {
  const compressed = deflate(context, alpha);
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
 * Embed one image, deduplicating by content.
 *
 * @remarks
 * The hash covers the source bytes *and* every parameter that changed their meaning, because two placements of one file that were interpreted differently are two different objects in the file even though they came from the same URL.
 *
 * @throws {CasterError} A JPEG whose frame PDF cannot carry, or one at other than 8 bits per sample; a palettised PNG with no `PLTE`; a file no PDF filter reads, which the image pass decodes before the list; and whatever the decoders refuse (`png.js`, `jpeg.js`).
 */
export async function embedImage(context: ImageContext, source: EmbedSource): Promise<EmbeddedImage> {
  const parameters =
    source.kind === 'bytes'
      ? `bytes|${source.mimeType}|interpolate=${source.interpolate}`
      : source.kind === 'jpeg'
        ? `jpeg|${source.format}|interpolate=${source.interpolate}`
        : `samples|${source.label}|${source.samples.width}x${source.samples.height}|interpolate=${source.interpolate}${shapeKey(source.shape)}`;
  const payload = source.kind === 'bytes' ? source.bytes : source.kind === 'jpeg' ? source.jpeg : source.samples.rgb;
  const alphaPayload = source.kind === 'samples' && source.samples.alpha ? source.samples.alpha : new Uint8Array(0);
  const none = new Uint8Array(0);
  const shape = source.kind === 'samples' ? source.shape : undefined;
  const hash = await sha256(payload, alphaPayload, shape?.palette ?? none, shape?.icc ?? none, parameters);

  const hit = context.byHash.get(hash);
  if (hit) return hit;

  const embedded = await build(context, source, hash);
  context.byHash.set(hash, embedded);
  return embedded;
}

/** What the dedupe key adds for samples that are not 8-bit `DeviceRGB`: nothing for those, so their key is what it was before version 6. */
function shapeKey(shape: SampleShape | undefined): string {
  if (!shape || (shape.colorSpace === 'DeviceRGB' && shape.bitsPerComponent === 8 && !shape.palette && !shape.icc)) return '';
  return `|${shape.colorSpace}|${shape.bitsPerComponent}${shape.palette ? '|palette' : ''}${shape.icc ? '|icc' : ''}`;
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

/** Build the XObject {@link embedImage} did not find by hash: the format's own road, the photo rule's JPEG, or decoded samples. */
async function build(context: ImageContext, source: EmbedSource, hash: string): Promise<EmbeddedImage> {
  const { PDFName } = capability('pdf');
  const name = PDFName.of(`Im${context.byHash.size}`);
  const built = source.kind === 'samples' ? await fromSamples(context, source) : source.kind === 'jpeg' ? photoJpeg(context.pdf, source) : await fromFile(context, source);
  return { ref: built.ref, hash, info: built.info, name };
}

/**
 * A file, through the road its format has.
 *
 * @throws {CasterError} A JPEG whose frame PDF cannot carry, or one at other than 8 bits per sample; a file no PDF filter reads.
 */
async function fromFile(context: ImageContext, source: Extract<EmbedSource, { kind: 'bytes' }>): Promise<Built> {
  const { bytes, mimeType, interpolate } = source;
  if (mimeType === 'image/jpeg') {
    const info = parseJpeg(bytes);
    if (info.unsupportedFrame) throw new CasterError(`imageEmbed: a JPEG frame marker 0x${info.sofMarker.toString(16)} PDF cannot carry`);
    // `/DCTDecode` is defined over 8-bit samples. A 12-bit JPEG (an extended sequential SOF1, which the frame check above accepts) fell past the 8-bit branch into the arithmetic fallback and was passed through declaring `/BitsPerComponent 8`, which is a file that says one thing and holds another. Refuse by name; a 12-bit source is re-saved at 8 bits or carried as a raster.
    if (info.precision !== 8) throw new CasterError(`imageEmbed: a JPEG at ${info.precision} bits per sample cannot be carried by /DCTDecode, which is defined over 8-bit samples; re-save it at 8 bits`);
    // An arithmetic-coded JPEG reaches here as a file because the image pass asked the browser for its pixels and was refused (`images/imagePass.js` says why both realms refuse): its entropy-coded data goes to `/DCTDecode` unread, and the report says so.
    return jpegPassthrough(context.pdf, bytes, info, interpolate);
  }
  if (mimeType === 'image/png') return fromPng(context, bytes, interpolate);
  throw new CasterError(`imageEmbed: no PDF filter reads ${mimeType}, and the display list holds the file and not its pixels; the image pass decodes such a file before the list`);
}

export type Built = {
  ref: PDFRef;
  info: WrittenImageInfo;
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
      path: 'passthrough',
      filter: 'DCTDecode',
      bitsPerComponent: 8,
      colorSpace: info.iccProfile ? 'ICCBased' : spaceName,
      hasSMask: false,
      ...(decode ? { decode } : {}),
      width: info.width,
      height: info.height,
      interpolate,
      bytesOut: bytes.length,
      decodeMs: 0,
      encodeMs: 0,
      icc: info.iccProfile ? 'embedded' : 'none',
      gammaOnly: false,
    },
  };
}

async function fromPng(context: ImageContext, bytes: Uint8Array, interpolate: boolean): Promise<Built> {
  const pdf = context.pdf;
  const info = parsePng(bytes);
  const gammaOnly = info.gama !== null && info.iccpDeflated === null && info.srgbIntent === null;

  if (canPassThroughIdat(info)) {
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
        path: 'passthrough',
        filter: 'FlateDecode',
        bitsPerComponent: info.bitDepth,
        colorSpace: space.name,
        hasSMask: false,
        width: info.width,
        height: info.height,
        interpolate,
        bytesOut: info.idat.length,
        decodeMs: 0,
        encodeMs: 0,
        icc: space.icc ? 'embedded' : 'none',
        gammaOnly,
      },
    };
  }

  // Alpha, interlacing or a palette with tRNS: the image pass decodes such a file before the list (version 6), so it reaches here only in a list the builder did not write.
  throw new CasterError('imageEmbed: a PNG whose IDAT /Predictor 15 cannot describe (an alpha channel, Adam7 interlace, a palette with tRNS) reaches the display list as samples; the image pass decodes it before the list');
}

/** The JPEG the opaque-photo rule chose in the image pass, under `/DCTDecode`. */
function photoJpeg(pdf: PDFContext, source: Extract<EmbedSource, { kind: 'jpeg' }>): Built {
  const { jpeg, interpolate } = source;
  const frame = parseJpeg(jpeg);
  const ref = pdf.register(
    pdf.stream(jpeg, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: frame.width,
      Height: frame.height,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
      Filter: 'DCTDecode',
      Interpolate: interpolate,
      Length: jpeg.length,
    }),
  );
  return {
    ref,
    info: {
      path: 'decode-jpeg',
      filter: 'DCTDecode',
      bitsPerComponent: 8,
      colorSpace: 'DeviceRGB',
      hasSMask: false,
      width: frame.width,
      height: frame.height,
      interpolate,
      bytesOut: jpeg.length,
      decodeMs: 0,
      encodeMs: 0,
      icc: 'none',
      gammaOnly: source.gammaOnly,
    },
  };
}

/**
 * Decoded samples, into a stream and its `/SMask`: 8-bit `DeviceRGB` unless the source's `shape` says otherwise.
 *
 * @remarks
 * The colour space is made before the streams, so an `/ICCBased` profile is registered first, as it was when this module decoded PNGs itself.
 */
async function fromSamples(context: ImageContext, source: Extract<EmbedSource, { kind: 'samples' }>): Promise<Built> {
  const pdf = context.pdf;
  const { samples, interpolate } = source;
  const shape: SampleShape = source.shape ?? { colorSpace: 'DeviceRGB', bitsPerComponent: 8 };
  const bitsPerComponent = shape.bitsPerComponent;
  const space = await samplesColorSpace(pdf, shape);
  const compressed = deflate(pdf, samples.rgb);
  const mask = samples.alpha ? await smaskRef(pdf, samples.width, samples.height, bitsPerComponent, samples.alpha) : null;
  const ref = pdf.register(
    pdf.stream(compressed, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: samples.width,
      Height: samples.height,
      ColorSpace: space.value,
      BitsPerComponent: bitsPerComponent,
      Filter: 'FlateDecode',
      Interpolate: interpolate,
      ...(mask ? { SMask: mask.ref } : {}),
      Length: compressed.length,
    }),
  );
  return {
    ref,
    info: {
      path: 'decode-flate',
      filter: 'FlateDecode',
      bitsPerComponent,
      colorSpace: space.name,
      hasSMask: mask !== null,
      width: samples.width,
      height: samples.height,
      interpolate,
      bytesOut: compressed.length + (mask?.bytes ?? 0),
      decodeMs: samples.decodeMs,
      encodeMs: 0,
      icc: space.icc ? 'embedded' : 'none',
      gammaOnly: source.gammaOnly === true,
    },
  };
}

/** The colour space of samples: the device space, a palette's `/Indexed` over `DeviceRGB`, or the profile's `/ICCBased`. */
async function samplesColorSpace(context: PDFContext, shape: SampleShape): Promise<{ value: any; name: string; icc: boolean; }> {
  const { PDFHexString } = capability('pdf');
  if (shape.colorSpace === 'Indexed') {
    const palette = shape.palette as Uint8Array;
    return { value: context.obj(['Indexed', 'DeviceRGB', palette.length / 3 - 1, PDFHexString.of(hex(palette))]), name: 'Indexed', icc: false };
  }
  if (shape.icc) return { value: await iccColorSpace(context, shape.icc, shape.colorSpace === 'DeviceRGB' ? 3 : 1), name: 'ICCBased', icc: true };
  return { value: shape.colorSpace, name: shape.colorSpace, icc: false };
}
