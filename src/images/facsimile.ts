/**
 * `images/facsimile.js` — a page of another PDF, carried into the file as the vector figure it is.
 *
 * Caster's own; no harness source. The embedded-PDF round, stage 3 (`.claude/plans/the-embedded-pdf/plan.md`); the record is DESIGN.md S80.
 *
 * An `<object is="beltype-facsimile" data-src data-page>` on a presented page names a page of a PDF the author shipped. The preview draws it with a `<canvas>`; the print must not, because a raster of a vector page is a worse file in every way that matters to a print shop and to PDF/UA-2 (the page's text would stop being text). So the PDF is fetched through the gateway in the frame the printer runs in (S20), opened with pdf-lib, and the page embedded as a Form XObject — vectors, fonts and all — which the emitter draws exactly where it draws an image, clipped by the form's own `/BBox`.
 *
 * Two phases, because the measurement needs the page's size before it places anything and the writer does not exist until emission. {@link loadFacsimile} runs BEFORE the measurement, with the refusals; {@link embedFacsimiles} runs inside `emitStructure`, once per distinct page, deduplicated by content like every image.
 *
 * Refusals, never fallbacks, each naming the element: an encrypted file, a page past the file's end, a page whose fonts are not embedded (PDF 2.0 and PDF/UA-2 require the programs), a rotated page. A file that cannot be read as a PDF at all is refused the same way.
 *
 * @packageDocumentation
 */
import { capability } from '../capabilities.ts';
import { CasterError } from '../errors.ts';

import type { PDFDocument, PDFPage } from 'pdf-lib';
import type { Gateway } from '../host/gateway.ts';
import type { EmbeddedImage, ImageContext } from './imageEmbed.ts';

/** One page of another PDF, opened and checked, not yet embedded. */
export type LoadedFacsimile = {
  /** The absolute URL the bytes came from. */
  url: string;
  /** Zero-based, in the source file. */
  pageIndex: number;
  /** The source file, for the dedupe hash. */
  bytes: Uint8Array;
  page: PDFPage;
  /** The CropBox (the MediaBox where there is none): what a reader shows, in the source's own coordinates. */
  box: { left: number, bottom: number, right: number, top: number };
  widthPt: number;
  heightPt: number;
  /** The author's element, for the refusals that come later. */
  domPath: string;
};

/**
 * The facsimiles every distinct source needs, loaded and checked.
 *
 * @param images - The walk's list; only `kind: 'facsimile'` entries are read.
 * @returns Keyed by the walk's `src` (`facsimile:<url>#<page>`).
 * @throws {CasterError} Each refusal in the file's header, naming the element.
 */
export async function loadFacsimiles(images: import('../walk/structure.ts').WalkImage[], gateway: Gateway): Promise<Map<string,LoadedFacsimile>> {
  const out: Map<string,LoadedFacsimile> = new Map<any, any>();
  const sources: Map<string,{ bytes: Uint8Array; source: PDFDocument; }> = new Map<any, any>();
  for (const request of images) {
    if (request.kind !== 'facsimile' || !request.facsimile || out.has(request.src)) continue;
    const { url, page } = request.facsimile;
    let opened = sources.get(url);
    if (!opened) {
      const fetched = await gateway.getBytes(url);
      if (fetched.mimeType !== 'application/pdf') throw new CasterError(`caster: the facsimile at ${request.domPath} names ${url}, which is not a PDF (the bytes are ${fetched.mimeType})`, { element: request.domPath });
      const { PDFDocument, EncryptedPDFError } = capability('pdf');
      try {
        opened = { bytes: fetched.bytes, source: await PDFDocument.load(fetched.bytes, { updateMetadata: false }) };
      } catch (error) {
        if (error instanceof EncryptedPDFError) throw new CasterError(`caster: the facsimile at ${request.domPath} names ${url}, which is encrypted; an encrypted file cannot be carried into a PDF/UA-2 file, and the printer asks for no password. Ship the page from an unencrypted copy`, { element: request.domPath });
        throw new CasterError(`caster: the facsimile at ${request.domPath} names ${url}, which cannot be read as a PDF: ${error instanceof Error ? error.message : String(error)}`, { element: request.domPath });
      }
      sources.set(url, opened);
    }
    const count = opened.source.getPageCount();
    if (page < 1 || page > count) throw new CasterError(`caster: the facsimile at ${request.domPath} asks for page ${page} of ${url}, which has ${count} ${count === 1 ? 'page' : 'pages'}`, { element: request.domPath });
    const source = opened.source.getPage(page - 1);
    const rotation = source.getRotation().angle;
    if (rotation !== 0) throw new CasterError(`caster: page ${page} of ${url} (the facsimile at ${request.domPath}) is rotated ${rotation} degrees, and the printer places a page upright only; save it unrotated`, { element: request.domPath });
    const unembedded = firstUnembeddedFont(source);
    if (unembedded) throw new CasterError(`caster: page ${page} of ${url} (the facsimile at ${request.domPath}) uses the font ${unembedded}, which is not embedded in the file; PDF 2.0 and PDF/UA-2 require every font program to travel with the file, so a page that leans on the reader's own fonts cannot be carried. Embed the font in the source PDF`, { element: request.domPath });
    // ponytail: the CropBox is used as it stands; its intersection with the MediaBox is not computed, and a CropBox that overhangs the MediaBox shows blank where it does.
    const crop = source.getCropBox();
    out.set(request.src, {
      url,
      pageIndex: page - 1,
      bytes: opened.bytes,
      page: source,
      box: { left: crop.x, bottom: crop.y, right: crop.x + crop.width, top: crop.y + crop.height },
      widthPt: crop.width,
      heightPt: crop.height,
      domPath: request.domPath,
    });
  }
  return out;
}

/** The source documents {@link reopenFacsimile} has opened, by the bytes they came from, so the pages of one file share one document and `embedPages` copies them with one copier (DESIGN.md S80). */
const reopened = new WeakMap<any, any>();

/**
 * A facsimile again from the bytes the display list holds, in the writer: the checks ran in {@link loadFacsimiles}, before the measurement, and the file they passed is the file these bytes are.
 *
 * @param bytes - The source PDF.
 * @param facsimile - The source's URL and the one-based page.
 * @param domPath - The author's element, for the refusals that come later.
 */
export async function reopenFacsimile(bytes: Uint8Array, facsimile: { url: string; page: number; }, domPath: string): Promise<LoadedFacsimile> {
  const { PDFDocument } = capability('pdf');
  let source: Promise<PDFDocument>|undefined = reopened.get(bytes);
  if (!source) {
    source = PDFDocument.load(bytes, { updateMetadata: false });
    reopened.set(bytes, source);
  }
  const page = (await source).getPage(facsimile.page - 1);
  // The check of {@link loadFacsimiles} again, for what it does and not for what it finds: reading a page's resources makes pdf-lib normalise its content streams (a `q` before, a `Q` after), and the copy of those streams in the file is part of the bytes a facsimile has always had.
  firstUnembeddedFont(page);
  const crop = page.getCropBox();
  return {
    url: facsimile.url,
    pageIndex: facsimile.page - 1,
    bytes,
    page,
    box: { left: crop.x, bottom: crop.y, right: crop.x + crop.width, top: crop.y + crop.height },
    widthPt: crop.width,
    heightPt: crop.height,
    domPath,
  };
}

/**
 * The first font on a page — through its resources, its forms' resources and theirs — whose program is not in the file.
 *
 * @remarks
 * A font is embedded when its descriptor carries a `/FontFile`, `/FontFile2` or `/FontFile3`; a composite (`Type0`) font's descriptor is its descendant's. A Type 3 font draws its glyphs from content streams inside the file, so it is embedded by construction. ponytail: patterns and annotation appearances are not walked; add when a customer's file hides a font there.
 *
 * @returns The font's `/BaseFont` (its resource name where it has none), or null when every font is embedded.
 */
function firstUnembeddedFont(page: PDFPage): string|null {
  const { PDFDict, PDFArray, PDFName, PDFStream } = capability('pdf');
  const context = page.node.context;
  const key = ( name: string) => PDFName.of(name);
  const seen: Set<object> = new Set<any>();
  const search = (resources: unknown): string|null => {
    if (!(resources instanceof PDFDict) || seen.has(resources)) return null;
    seen.add(resources);
    const fonts = resources.lookupMaybe(key('Font'), PDFDict);
    if (fonts) {
      for (const [resourceName, ref] of fonts.entries()) {
        const font = context.lookupMaybe(ref, PDFDict);
        if (!font) continue;
        const subtype = String(font.get(key('Subtype')));
        if (subtype === '/Type3') continue;
        const descendant = subtype === '/Type0' ? context.lookupMaybe(font.lookupMaybe(key('DescendantFonts'), PDFArray)?.get(0), PDFDict) : font;
        const descriptor = descendant?.lookupMaybe(key('FontDescriptor'), PDFDict);
        if (!descriptor || !['FontFile', 'FontFile2', 'FontFile3'].some((entry) => descriptor.has(key(entry)))) {
          return String(font.get(key('BaseFont')) ?? resourceName).replace(/^\//u, '');
        }
      }
    }
    const xobjects = resources.lookupMaybe(key('XObject'), PDFDict);
    if (xobjects) {
      for (const [, ref] of xobjects.entries()) {
        const xobject = context.lookup(ref);
        if (xobject instanceof PDFStream && String(xobject.dict.get(key('Subtype'))) === '/Form') {
          const found = search(xobject.dict.lookupMaybe(key('Resources'), PDFDict));
          if (found) return found;
        }
      }
    }
    return null;
  };
  return search(page.node.normalizedEntries().Resources);
}

/**
 * Embed loaded pages as Form XObjects, once per distinct page of a distinct file, and one `embedPages` call per file.
 *
 * @remarks
 * The form's `/BBox` is the crop box and its `/Matrix` moves that box to the origin (pdf-lib's own default for an explicit box), so after the `Do` the page occupies `[0, widthPt] x [0, heightPt]`; the emitter's `cm` then scales that into the placed box. pdf-lib copies a page's content and resources, the font programs included, into this document at `flush()`, and its copier remembers what it has copied only within ONE call — so the pages of one source are embedded in one call (Measured 2026-10-14: two pages of a 100 kB font in two calls wrote the font twice).
 *
 * @param pages - May repeat a page; a repeat is the one XObject.
 * @returns In `pages` order.
 */
export async function embedFacsimiles(context: ImageContext, pdfDoc: PDFDocument, pages: LoadedFacsimile[]): Promise<EmbeddedImage[]> {
  const { PDFName } = capability('pdf');
  const out: (EmbeddedImage|undefined)[] = [];
  const wanted: Map<string,{ hash: string; loaded: LoadedFacsimile; at: number[]; }[]> = new Map<any, any>();
  for (const [at, loaded] of pages.entries()) {
    const hash = await sha256(loaded.bytes, `facsimile|page=${loaded.pageIndex}`);
    const hit = context.byHash.get(hash);
    if (hit) { out[at] = hit; continue; }
    const group = wanted.get(loaded.url) ?? [];
    wanted.set(loaded.url, group);
    const same = group.find((entry) => entry.hash === hash);
    if (same) same.at.push(at); else group.push({ hash, loaded, at: [at] });
  }
  for (const group of wanted.values()) {
    const started = performance.now();
    const embedded = await pdfDoc.embedPages(group.map((entry) => entry.loaded.page), group.map((entry) => entry.loaded.box));
    for (const [n, entry] of group.entries()) {
      const { loaded } = entry;
      const result: EmbeddedImage = {
        ref: embedded[n].ref,
        hash: entry.hash,
        name: PDFName.of(`Fc${context.byHash.size}`),
        info: {
          format: 'application/pdf',
          path: 'form',
          filter: 'FlateDecode',
          bitsPerComponent: 0,
          colorSpace: 'n/a',
          hasSMask: false,
          width: loaded.widthPt,
          height: loaded.heightPt,
          interpolate: false,
          bytesIn: loaded.bytes.length,
          bytesOut: 0,
          decodeMs: (performance.now() - started) / group.length,
          encodeMs: 0,
          icc: 'none',
          gammaOnly: false,
          reason: `page ${loaded.pageIndex + 1} of ${loaded.url}, embedded as a Form XObject: vectors, text and fonts stay what they were`,
        },
      };
      context.byHash.set(entry.hash, result);
      for (const at of entry.at) out[at] = result;
    }
  }
  return (out as EmbeddedImage[]);
}

async function sha256(bytes: Uint8Array, parameters: string): Promise<string> {
  const tail = new TextEncoder().encode(parameters);
  const joined = new Uint8Array(bytes.length + tail.length);
  joined.set(bytes);
  joined.set(tail, bytes.length);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', joined))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
