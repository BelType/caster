/**
 * `host/gateway.js` — the byte gateway: how the printer gets at the file behind an image, a font or a profile.
 *
 * Ported from `harness/src/export/gateway.ts` (E7; E12E added the colour endpoint). Guide: `docs/guide/images.md`.
 *
 * WHAT THE PORT CHANGED. (1) `CrossOriginImageError` is `src/errors.js`'s, so it is a `BelTypeError` and carries `{ element }`. (2) `convertColors` is gone from the interface's live half: BelType serves no colour endpoint, so `convertRgb: 'endpoint'` refuses by name (§10.2) rather than reaching for a hook nothing implements. The optional method stays declared, because a host that grows one later is the lawful door and the refusal names it. (3) The manifest is BelType's `rewrites` in practice: the editing tools serve the venue at one origin, so `createGateway(new Map())` — same-origin only — is what the panel builds, and the manifest parameter survives for a headless host that serves from two places.
 *
 * The harness's header, carried over: an exporter that reads pixels off the element gets what the compositor decided to show — colour-managed, possibly downsampled, always 8-bit, always sRGB. The original file is a different and better thing: it is what PDF can usually carry verbatim, and it is the only version that still knows its bit depth, its colour profile and its EXIF orientation. So the source of truth for an `<img>` is the bytes at `img.currentSrc`, and the canvas is a fallback for the formats PDF has no filter for. Fetching those bytes is a capability the page may not have; the gateway is the one place that decides whether a URL may be read, and it answers with a named error rather than a silent skip: an image the exporter cannot read is an export that has to fail, not a page with a hole in it. The MIME type is sniffed from the first bytes rather than taken from the response header — a dev server labels `.avif` as `application/octet-stream` often enough that the header is not evidence — and the header's claim is recorded beside the sniffed answer so a disagreement is visible.
 *
 * @packageDocumentation
 */

import { CasterError, CrossOriginImageError } from '../errors.ts';

/** The bytes behind one URL, and what they are. */
export type GatewayBytes = {
  bytes: Uint8Array;
  /** Sniffed from the magic bytes; this is what the embedder branches on. */
  mimeType: string;
  /** What the server claimed, for the record. Empty when it claimed nothing. */
  declaredMimeType: string;
  /** The URL after resolution against the document. */
  url: string;
};

/**
 * The one place that decides whether a URL may be read, and reads it.
 *
 * @remarks
 * `getBytes` refuses with a `CrossOriginImageError` for a URL `allows` refuses, and with a `CasterError` for an empty source, a response that is not ok, or bytes `sniffMimeType` cannot identify.
 */
export type Gateway = {
  getBytes: (url: string) => Promise<GatewayBytes>;
  /** Whether the gateway would read this URL at all, without reading it. */
  allows: (url: string) => boolean;
  /** The colour endpoint of `colour.md` (E12E). Optional, and BelType supplies none: `convertRgb: 'endpoint'` refuses naming this method. */
  convertColors?: (colors: readonly [number, number, number][], outputCondition: string) => Promise<[number, number, number, number][]>;
};

/**
 * Magic-byte sniffing for every format E7 (`images.md`) can meet; unknown bytes are an error, not a guess.
 *
 * @throws {CasterError} The bytes match no format this printer meets.
 */
export function sniffMimeType(bytes: Uint8Array): string {
  const at = ( i: number): number => (i < bytes.length ? bytes[i] : -1);
  const ascii = ( start: number,  text: string): boolean => {
    for (let i = 0; i < text.length; i++) if (at(start + i) !== text.charCodeAt(i)) return false;
    return true;
  };
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (at(0) === 0x89 && ascii(1, 'PNG')) return 'image/png';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  // ISO base media: a `ftyp` box whose brand says which of the HEIF family it is.
  if (ascii(4, 'ftyp')) {
    if (ascii(8, 'avif') || ascii(8, 'avis')) return 'image/avif';
    if (ascii(8, 'heic') || ascii(8, 'heix') || ascii(8, 'mif1')) return 'image/heif';
  }
  if (ascii(0, '<svg') || ascii(0, '<?xml')) return 'image/svg+xml';
  // A page of another PDF, for the facsimile (DESIGN.md S80). The header may follow up to 1024 bytes of junk in a real file; a file that starts with anything but `%PDF-` is not one this printer reads.
  if (ascii(0, '%PDF-')) return 'application/pdf';
  // The font formats the printer meets through the same door (`font-embedding.md`, E4). WOFF2 is sniffed so the font table can route it to its decoder (*BelType ships faces of its own, and WOFF2 is decoded*, S46) rather than meet it as an unknown blob.
  if (ascii(0, 'wOFF')) return 'font/woff';
  if (ascii(0, 'wOF2')) return 'font/woff2';
  if (ascii(0, 'OTTO')) return 'font/otf';
  if (at(0) === 0x00 && at(1) === 0x01 && at(2) === 0x00 && at(3) === 0x00) return 'font/ttf';
  if (ascii(0, 'true') || ascii(0, 'ttcf')) return 'font/ttf';
  throw new CasterError(`caster: the gateway cannot identify the format of ${bytes.length} bytes beginning ${[...bytes.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
}

/**
 * A gateway over an asset manifest.
 *
 * @remarks
 * `manifest` maps a file name to the URL a host serves it at; every value in it is readable, and so is anything on the page's own origin. A `data:` or `blob:` URL is readable too, because it is already the page's own bytes. Everything else throws.
 *
 * @param manifest - File name to the URL a host serves it at; empty, the gateway is same-origin only, which is what the panel builds.
 */
export function createGateway(manifest: ReadonlyMap<string,string> = new Map<any, any>()): Gateway {
  const allowed: Set<string> = new Set<any>();
  for (const url of manifest.values()) allowed.add(new URL(url, location.href).href);

  const resolve = ( url: string): string => new URL(url, location.href).href;

  const allows = ( url: string): boolean => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return true;
    const absolute = resolve(url);
    if (allowed.has(absolute)) return true;
    return new URL(absolute).origin === location.origin;
  };

  return {
    allows,
    async getBytes(url) {
      if (url === '') throw new CasterError('caster: the gateway was handed an empty source');
      if (!allows(url)) throw new CrossOriginImageError(`caster: ${url} is neither same-origin nor in the asset manifest, so its bytes cannot be read`, { element: url });
      const absolute = url.startsWith('data:') || url.startsWith('blob:') ? url : resolve(url);
      const response = await fetch(absolute);
      if (!response.ok) throw new CasterError(`caster: the gateway asked for ${absolute} and got ${response.status} ${response.statusText}`, { element: url });
      const declaredMimeType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { bytes, mimeType: sniffMimeType(bytes), declaredMimeType, url: absolute };
    }
  };
}

/**
 * The URL an `<img>` actually loaded.
 *
 * @remarks
 * `currentSrc` is only meaningful once the resource selection algorithm has run, which is why every caller has to have awaited `decode()` — or its rejection — first. An element whose `currentSrc` is still empty is a bug in the caller's ordering and says so.
 *
 * @throws {CasterError} The element has neither a `currentSrc` nor a `src` yet.
 */
export function currentSourceOf(image: HTMLImageElement) {
  const source = image.currentSrc || image.src;
  if (source === '') throw new CasterError('caster: an <img> has no currentSrc yet; await decode() before reading it', { element: image.tagName.toLowerCase() });
  return source;
}

/** The one raster URL in a computed `background-image`, or null when there is none. */
export function backgroundUrlOf(style: CSSStyleDeclaration): string|null {
  const value = style.backgroundImage;
  if (!value || value === 'none') return null;
  const match = /url\((['"]?)([^'")]+)\1\)/.exec(value);
  if (!match) return null;
  const url = match[2];
  // SVG backgrounds belong to `vector-painting.md` (E9), and a gradient is not an image at all.
  return url.endsWith('.svg') ? null : url;
}

/**
 * The refusal `convertRgb: 'endpoint'` gets.
 *
 * @remarks
 * Stated here, where the hook it names lives, rather than in the colour modules that would call it.
 *
 * @throws {CasterError} The gateway has no `convertColors` — which BelType's never has — carrying `flag: 'convertRgb'`.
 */
export function requireColourEndpoint(gateway: Gateway) {
  if (typeof gateway.convertColors !== 'function') {
    throw new CasterError("caster: `convertRgb: 'endpoint'` needs a gateway with a `convertColors` method, and BelType serves no colour endpoint. Use `convertRgb: 'wasm'` (lcms-wasm, measured at 0.000000 against the endpoint) or `'none'` (a compliant RIP lands within one 255th anyway).", { flag: 'convertRgb' });
  }
  return gateway.convertColors;
}
