/**
 * `coordinates/pageGeometry.js` — the size the page box actually is, per page.
 *
 * Ported from `harness/src/export/pageGeometry.ts` (E10, E12D). Guide: `docs/guide/coordinates-and-pages.md`.
 *
 * WHAT THE PORT CHANGED (R2, R7). The harness read the nominal size off `data-pdf-size` on the page element. A Cicero page carries no such attribute, so `geometryOfPage` takes the nominal size as an argument the adapter supplies — `adapters/cicero.js` reads it from `chase.js`'s own inline `style.width`/`style.height` and undoes the one-pixel print-safety inset. `data-pdf-size` is still read when a page happens to declare one, so a document from any other engine that honours the guide's container contract works unchanged, and `data-pdf-size` on the page host is the first item of DESIGN.md's "What Cicero should stamp". The trim-child convention (`.trim`) survives because the harness measured both and the exit notes never cut one.
 *
 * The harness's header, carried over. Every experiment up to E10 (`coordinates-and-pages.md`) had one page size and it was arithmetic — a column of Blink's, 794 CSS px wide, times 0.75, plus a 48 pt margin the exporter added on every side. That is a page box derived from a measurement, and a measurement of A4 in CSS pixels is 793.7007874… px which the engine stores on a 1/64 px grid as 793.703125. Converting that gives 595.27734375 pt, which is not A4: A4 is 595.276 pt, by definition, and a printer that is handed the other number trims a document that was laid out correctly.
 *
 * So the page box is nominal and the content is measured. The measured px width is recorded beside it so the quantisation is documented rather than inherited, and the content is still converted at exactly 0.75 pt/px from the page element's own top-left, with no margin at all: a page element carries its margins as padding, because a page that knows its own size can put its own margins inside it and the exporter has nothing left to add.
 *
 * `CropBox` and `ArtBox` are omitted, so a reader defaults `CropBox` to `MediaBox` and asks nothing about art.
 *
 * @packageDocumentation
 */

import { COLUMN_WIDTH_PX, MARGIN_PT, PAGE_HEIGHT_PT, PAGE_WIDTH_PT, PX_TO_PT, round3 } from './units.ts';
import { CasterError } from '../errors.ts';

import type { FramePage } from './frame.ts';
import type { BoxPt } from '../displayList.ts';
export type { BoxPt } from '../displayList.ts';

/** One page's box in points, and the trim and bleed it declared. */
export type PageGeometry = {
  widthPt: number;
  heightPt: number;
  /** Points the exporter adds around the measured content on every side. Zero for a page that carries its own margins. */
  marginPt: number;
  /** Width of one page's worth of x in CSS px; the column rule's page width. */
  columnWidthPx: number;
  /** The page size the page named, or '' for the default geometry. */
  nominal: string;
  /** The page element's measured border-box width in CSS px, for the record. */
  measuredWidthPx?: number;
  measuredHeightPx?: number;
  /** `TrimBox`, when the page declared one. */
  trimPt?: BoxPt;
  /** `BleedBox`, when the page declared one. */
  bleedPt?: BoxPt;
  /** The same two boxes as the other convention read them, for the comparison. */
  trimFromChildPt?: BoxPt;
  bleedFromChildPt?: BoxPt;
};

/**
 * The fallback geometry: the column plus the exporter's own margin.
 *
 * @remarks
 * Caster never takes it (the adapter installs one per page), and it is kept because every content stream from E3 (`text-emission.md`) through E9 (`vector-painting.md`) went through it.
 */
export const DEFAULT_GEOMETRY: PageGeometry = { widthPt: PAGE_WIDTH_PT, heightPt: PAGE_HEIGHT_PT, marginPt: MARGIN_PT, columnWidthPx: COLUMN_WIDTH_PX, nominal: '' };

/**
 * The nominal sizes a page may name, in points.
 *
 * @remarks
 * A4 is 210 × 297 mm, which is 595.2755905… × 841.8897637… pt; the ISO figures a PDF carries are those to three decimals. Landscape is the same page turned, and is a separate name rather than an orientation flag because the page box is the only place orientation exists in a PDF at all.
 */
export const NOMINAL_SIZES: Readonly<Record<string,readonly [number,number]>> = {
  a4: [595.276, 841.89],
  'a4-landscape': [841.89, 595.276],
  letter: [612, 792],
  'letter-landscape': [792, 612]
};

/** The geometries of the export that is running — module-scope state, kept where the harness has it (PLAN.md P4). */
let installed: PageGeometry[]|null = null;

/** Install one geometry per page for the export that is running. */
export function setPageGeometry(geometries: PageGeometry[]) { installed = geometries; }

/** Uninstall the geometries, so the next reader gets the fallback. */
export function clearPageGeometry() { installed = null; }

/**
 * The geometry of one page; without an installed set, the fallback.
 *
 * @param page - Clamped into the installed range.
 */
export function pageGeometryFor(page: number): PageGeometry {
  if (!installed) return DEFAULT_GEOMETRY;
  return installed[Math.min(Math.max(page, 0), installed.length - 1)];
}

/**
 * Pixels measured from the container's left edge, inside its column, to page x in points.
 *
 * @remarks
 * Rounded here rather than at the point of writing, so the number the writer aims its pen at and the number the report records are the same number and a checker is never comparing against a value the writer did not use. Called by the display list's builder and by `print()`, and by nothing that writes.
 */
export const xToPt = (xPx: number, page: number = 0): number => round3(pageGeometryFor(page).marginPt + xPx * PX_TO_PT);

/**
 * Pixels measured down from the page's top to PDF y measured up from the page bottom.
 *
 * @remarks
 * From E10 (`coordinates-and-pages.md`) the page index is an argument, because a document may mix page sizes and the height a y is flipped against is then the page's own. With no geometry installed every page answers the constants of `text-emission.md` (E3) and the default argument reproduces the one-line function this used to be, to the bit.
 */
export const yToPt = (yPx: number, page: number = 0): number => {
  const geometry = pageGeometryFor(page);
  return round3(geometry.heightPt - geometry.marginPt - yPx * PX_TO_PT);
};

/** Every installed geometry, or the fallback. */
export function pageGeometries(): PageGeometry[] { return installed ?? [DEFAULT_GEOMETRY]; }

/** The custom property a page declares its bleed through. */
export const BLEED_PROPERTY = '--pdf-bleed';
/** The custom property a page declares its trim inset through. */
export const TRIM_INSET_PROPERTY = '--pdf-trim-inset';

/** What registering one geometry property came to. */
export type GeometryPropertyRegistration = {
  property: string;
  registered: boolean;
  error?: string;
};

/**
 * Register the two length properties, non-inheriting, exactly as the colour hints are registered.
 *
 * @remarks
 * `syntax: '<length>'` rather than `'*'`, because unlike a colour hint these are consumed as numbers and a registered length is computed to px by the engine — which is the whole reason to register them: `3mm` arrives as `11.3386px` and the exporter never has to know what a millimetre is. `inherits: false` for the reason the colour hints need it: a trim declared on a container would otherwise claim every page inside it.
 */
export function registerGeometryProperties(): GeometryPropertyRegistration[] {
  return [BLEED_PROPERTY, TRIM_INSET_PROPERTY].map((property) => {
    try {
      CSS.registerProperty({ name: property, syntax: '<length>', inherits: false, initialValue: '0px' });
      return { property, registered: true };
    } catch (error) {
      // A second registration of the same name throws, and in a run that has already registered them that is success rather than failure.
      const message = String(error);
      return { property, registered: /already/i.test(message), error: message };
    }
  });
}

const px = ( value: string) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};


/**
 * The geometry of one page element, from the size it names and the boxes it declares.
 *
 * @remarks
 * `frame` supplies the page's untransformed border-box size in CSS px, which is what the trim child is measured against and what the record quotes beside the nominal size. Everything here is in the page's own untransformed pixels, so the container's scale has already been divided out by the time this runs.
 *
 * @param supplied - R2: what the adapter knows and the DOM does not. `widthPt`/`heightPt` name the page box directly (Cicero's route, where the size is the engine's own conclusion rather than an author's word); `style` names the computed style the `--pdf-*` properties are read off, which R7 may answer from the page host or from the `@page` rules.
 * @throws {CasterError} The page names a size `NOMINAL_SIZES` does not hold.
 */
export function geometryOfPage(page: FramePage, trimChild?: { xPx: number; yPx: number; wPx: number; hPx: number; }, supplied?: { nominal?: string; widthPt?: number; heightPt?: number; style?: CSSStyleDeclaration; }): PageGeometry {
  const nominal = supplied?.nominal ?? page.nominal;
  const named = NOMINAL_SIZES[nominal];
  if (nominal !== '' && !named) {
    throw new CasterError(`caster: ${JSON.stringify(nominal)} is not a page size this printer knows; it has ${Object.keys(NOMINAL_SIZES).join(', ')}`);
  }
  const widthPt = supplied?.widthPt ?? (named ? named[0] : page.widthPx * PX_TO_PT);
  const heightPt = supplied?.heightPt ?? (named ? named[1] : page.heightPx * PX_TO_PT);

  const style = supplied?.style ?? getComputedStyle(page.element);
  const bleedPx = px(style.getPropertyValue(BLEED_PROPERTY));
  const trimInsetPx = px(style.getPropertyValue(TRIM_INSET_PROPERTY));

  const geometry: PageGeometry = {
    widthPt,
    heightPt,
    marginPt: 0,
    columnWidthPx: page.widthPx,
    nominal,
    measuredWidthPx: page.widthPx,
    measuredHeightPx: page.heightPx
  };

  if (trimInsetPx > 0) {
    const t = round3(trimInsetPx * PX_TO_PT);
    geometry.trimPt = [t, t, round3(widthPt - t), round3(heightPt - t)];
    // The media is the finished page here, so there is no room outside it for a bleed to live in: a declared bleed eats into the trim margin instead, which is what `MediaBox ⊇ BleedBox ⊇ TrimBox` requires of a file whose media is nominal.
    const b = round3(Math.max(0, trimInsetPx - bleedPx) * PX_TO_PT);
    geometry.bleedPt = [b, b, round3(widthPt - b), round3(heightPt - b)];
  }

  if (trimChild) {
    const x0 = round3(trimChild.xPx * PX_TO_PT);
    const y1 = round3(heightPt - trimChild.yPx * PX_TO_PT);
    const x1 = round3((trimChild.xPx + trimChild.wPx) * PX_TO_PT);
    const y0 = round3(heightPt - (trimChild.yPx + trimChild.hPx) * PX_TO_PT);
    geometry.trimFromChildPt = [x0, y0, x1, y1];
    // The other half of that convention: with the trim marked by a box inside the page, the bleed has nothing left to say and is the media.
    geometry.bleedFromChildPt = [0, 0, round3(widthPt), round3(heightPt)];
  }

  return geometry;
}
