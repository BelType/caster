/**
 * `coordinates/printMarks.js` — crop and registration marks, in the one colour that is on every plate.
 *
 * Ported from `harness/src/export/printMarks.ts` (E12D). Guide: `docs/guide/coordinates-and-pages.md` §"Print marks (E12D)"; the experiments are `browser-to-pdf-experiments`.
 *
 * WHAT THE PORT CHANGED. (P1) `PX_TO_PT` comes from `./units.js` rather than from the fixture module the harness kept it in. (P11) the harness's `throw new Error('printMarks: …')` becomes a `CasterError` carrying the same message, per the house rule that every thrown thing is a `BelTypeError` subclass; nothing else about the refusal changes. Nothing here touches the DOM except `registerMarksProperty`, so the geometry is testable in node exactly as it stands.
 *
 * The harness's header, carried over. A print mark is not decoration and it is not content. It is an instruction to a finishing machine — this is where the guillotine goes, these four plates are in register — and it lives outside the page a reader ever sees. That gives it three properties nothing else in this harness has, and all three are decisions rather than transcription.
 *
 * **Where the marks live.** They are outside the trim box and outside the bleed, so the media has to be bigger than the finished page. `MediaBox` grows by `bleed + 3 mm offset + 5 mm length` on every side, and it grows as a *negative-origin* box: `[-m -m w+m h+m]` rather than `[0 0 w+2m h+2m]`. That is the smaller change of the two, and it is the whole reason for the choice: every content coordinate in the file, every `TrimBox`, every `BleedBox` and every structure-tree `/BBox` is expressed against the page element's own top-left, and shifting the origin would move all of them. With a negative origin the page's coordinates are exactly what they were with no marks at all, and the marks are the only thing in the file that ever uses a negative number. The alternative — keep `MediaBox` at `[0 0 …]`, translate the whole page content by `+m` and add `m` to both boxes — produces the same picture and is what a page-imposition step would do, because an imposed page is a new page rather than the same one with more room; it is named here and not taken, because this exporter is emitting the page the browser laid out.
 *
 * **What colour they are.** `/All` at full tint, which is the one colourant PDF predefines to mean "every plate": a registration mark that printed on three plates out of four would be worse than no mark at all. E8 (`colour.md`) already resolves `spot(All)` and allocates the `/Separation`; what E12d (`coordinates-and-pages.md`) adds is the *stroking* path through it, which E8 implemented and never exercised because a box decoration is four filled rectangles and nothing in that fixture strokes.
 *
 * **What they are in the structure tree.** Nothing: `/Artifact <</Type /Page>>`, which is ISO 32000-2's own artifact type for "printer's marks and other content not part of the document" and is the third `/Type` beside the `Pagination` and `Layout` this harness already emits.
 *
 * The geometry is a transcription of nobody's implementation, because no browser has one: `@page { marks: crop cross }` is in CSS Paged Media 3 and Chromium ignores it entirely, so the value arrives through the custom-property channel of `colour.md` (E8) the way `--pdf-bleed` and `--pdf-trim-inset` do, and the mark shapes are the ones the graphic-arts trade uses — a pair of hairlines at each corner aligned with the two trim edges, and a circle with a cross through it centred on each side.
 *
 * @packageDocumentation
 */

import { CasterError } from '../errors.ts';
import { KAPPA } from '../vectors/pathData.ts';
import { PX_TO_PT } from './units.ts';

import type { BoxPt, PageGeometry } from './pageGeometry.ts';

/** The custom property a page element declares its marks through. */
export const MARKS_PROPERTY = '--pdf-marks';

/** Millimetres to PDF points: 72 points to the inch, 25.4 mm to the inch. */
export const MM_TO_PT = 72 / 25.4;

/** How far outside the bleed a mark starts. */
export const MARK_OFFSET_MM = 3;

/** How long a crop mark is. */
export const MARK_LENGTH_MM = 5;

/** The hairline every mark is stroked at. */
export const MARK_STROKE_PT = 0.25;

/** The radius of a registration target's circle. */
export const REGISTRATION_RADIUS_MM = 1.6;

/** How far a registration target's crosshairs reach past its own circle. */
export const REGISTRATION_ARM_MM = 2.4;

/** What a page's `--pdf-marks` asked for. */
export type MarksDeclaration = {
  /** The property's computed value, verbatim. */
  declared: string;
  crop: boolean;
  cross: boolean;
};

/**
 * `--pdf-marks: crop cross`, in the grammar CSS Paged Media 3 gives `marks`.
 *
 * @remarks
 * `none` and the empty string are both "no marks", because a registered property with `syntax: '*'` and no declaration computes to the empty string and a page that says nothing is a page that wants nothing.
 *
 * @throws {CasterError} A word other than `crop`, `cross` or `none`.
 */
export function parseMarks(value: string): MarksDeclaration {
  const text = value.trim().toLowerCase();
  const words = text.split(/\s+/).filter((w) => w !== '');
  if (words.length === 0 || (words.length === 1 && words[0] === 'none')) {
    return { declared: text === '' ? 'none' : text, crop: false, cross: false };
  }
  for (const word of words) {
    if (word !== 'crop' && word !== 'cross') {
      throw new CasterError(`printMarks: ${JSON.stringify(value)} is not a marks value; it takes crop, cross, both or none`);
    }
  }
  return { declared: words.join(' '), crop: words.includes('crop'), cross: words.includes('cross') };
}

/** What registering `--pdf-marks` came to. */
export type MarksRegistration = {
  property: string;
  registered: boolean;
  error?: string;
};

/**
 * Register `--pdf-marks`, exactly as E10 (`coordinates-and-pages.md`) registers its two length properties.
 *
 * @remarks
 * `syntax: '*'` rather than a keyword list, because a registered property with a restricted syntax rejects an invalid value silently at computed-value time and the exporter would then see the initial value where the author wrote a typo. E8 (`colour.md`) made the same choice for the same reason: the exporter parses the hint and reports what it could not read, and a property that quietly repairs itself takes that report away. `inherits: false`, because a marks value on a container would otherwise claim every page inside it.
 */
export function registerMarksProperty(): MarksRegistration {
  try {
    CSS.registerProperty({ name: MARKS_PROPERTY, syntax: '*', inherits: false, initialValue: 'none' });
    return { property: MARKS_PROPERTY, registered: true };
  } catch (error) {
    const message = String(error);
    return { property: MARKS_PROPERTY, registered: /already/i.test(message), error: message };
  }
}

/** One stroked shape of one mark, as a list of subpaths in page points. */
export type MarkShape = {
  kind: 'crop' | 'cross';
  /** Which corner or side the shape belongs to. */
  at: string;
  /** Straight segments, `[x0, y0, x1, y1]`. */
  segments: [number, number, number, number][];
  /** A circle, `[cx, cy, r]`, present on a registration target. */
  circle?: [number, number, number];
};

/** Every mark one page carries, and the media box before and after it grew to hold them. */
export type PageMarks = {
  page: number;
  declaration: MarksDeclaration;
  /** The bleed the page declared, in points. */
  bleedPt: number;
  offsetPt: number;
  lengthPt: number;
  /** How far the media grew on every side. Zero when the page has no marks. */
  growthPt: number;
  mediaBefore: BoxPt;
  mediaAfter: BoxPt;
  trimPt?: BoxPt;
  bleedBoxPt?: BoxPt;
  shapes: MarkShape[];
};

/** Round to three decimals. */
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Every mark one page carries, and the media box that holds them.
 *
 * @remarks
 * The marks are placed against the **trim** box, because that is the only box whose edges a guillotine cares about; a page that declared no trim inset is its own trim and the marks sit against the media edge. The bleed is a *clearance*, not a datum: a mark inside the bleed would be printed over by the artwork that bleeds off the page, so the offset is measured from the bleed edge outwards and the growth carries the bleed as well.
 *
 * @param bleedPx - The page's declared `--pdf-bleed`, computed to px.
 */
export function pageMarksOf(page: number, geometry: PageGeometry, declaration: MarksDeclaration, bleedPx: number): PageMarks {
  const mediaBefore: BoxPt = [0, 0, round3(geometry.widthPt), round3(geometry.heightPt)];
  const bleedPt = round3(bleedPx * PX_TO_PT);
  const offsetPt = round3(MARK_OFFSET_MM * MM_TO_PT);
  const lengthPt = round3(MARK_LENGTH_MM * MM_TO_PT);
  const wants = declaration.crop || declaration.cross;
  const growthPt = wants ? round3(bleedPt + offsetPt + lengthPt) : 0;

  const marks: PageMarks = {
    page,
    declaration,
    bleedPt,
    offsetPt,
    lengthPt,
    growthPt,
    mediaBefore,
    mediaAfter: wants
      ? [-growthPt, -growthPt, round3(geometry.widthPt + growthPt), round3(geometry.heightPt + growthPt)]
      : mediaBefore,
    ...(geometry.trimPt ? { trimPt: geometry.trimPt } : {}),
    ...(geometry.bleedPt ? { bleedBoxPt: geometry.bleedPt } : {}),
    shapes: [],
  };
  if (!wants) return marks;

  const trim: BoxPt = geometry.trimPt ?? mediaBefore;
  const [x0, y0, x1, y1] = trim;
  // Where a mark starts and ends, measured outwards from the trim edge.
  const near = round3(bleedPt + offsetPt);
  const far = round3(near + lengthPt);

  if (declaration.crop) {
    const corner = (at: string, cx: number, cy: number, sx: number, sy: number): MarkShape => ({
      kind: 'crop',
      at,
      segments: [
        // Along x, aligned with the horizontal trim edge through this corner.
        [round3(cx + sx * near), round3(cy), round3(cx + sx * far), round3(cy)],
        // Along y, aligned with the vertical trim edge through this corner.
        [round3(cx), round3(cy + sy * near), round3(cx), round3(cy + sy * far)],
      ],
    });
    marks.shapes.push(
      corner('bottom-left', x0, y0, -1, -1),
      corner('bottom-right', x1, y0, 1, -1),
      corner('top-right', x1, y1, 1, 1),
      corner('top-left', x0, y1, -1, 1),
    );
  }

  if (declaration.cross) {
    const radius = round3(REGISTRATION_RADIUS_MM * MM_TO_PT);
    const arm = round3(REGISTRATION_ARM_MM * MM_TO_PT);
    // Centred in the mark band, which is where a crop mark's own middle is.
    const band = round3(near + lengthPt / 2);
    const target = (at: string, cx: number, cy: number): MarkShape => ({
      kind: 'cross',
      at,
      segments: [
        [round3(cx - arm), round3(cy), round3(cx + arm), round3(cy)],
        [round3(cx), round3(cy - arm), round3(cx), round3(cy + arm)],
      ],
      circle: [round3(cx), round3(cy), radius],
    });
    const midX = round3((x0 + x1) / 2);
    const midY = round3((y0 + y1) / 2);
    marks.shapes.push(
      target('bottom', midX, round3(y0 - band)),
      target('right', round3(x1 + band), midY),
      target('top', midX, round3(y1 + band)),
      target('left', round3(x0 - band), midY),
    );
  }

  return marks;
}

/**
 * A registration target's circle as four cubics.
 *
 * @remarks
 * The same kappa `pathData` rounds every other corner with, restated through the same constant rather than a second one, so a change to the circle approximation is one change.
 *
 * @returns The start point, then four cubics' control and end points.
 */
export function circleSegments(cx: number, cy: number, r: number): number[][] {
  const k = KAPPA * r;
  return [
    [cx + r, cy],
    [cx + r, cy + k, cx + k, cy + r, cx, cy + r],
    [cx - k, cy + r, cx - r, cy + k, cx - r, cy],
    [cx - r, cy - k, cx - k, cy - r, cx, cy - r],
    [cx + k, cy - r, cx + r, cy - k, cx + r, cy],
  ];
}
