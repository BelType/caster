/**
 * `vectors/borderStyles.js` — E12b (`vector-painting.md`): the six border styles E9 painted solid and recorded, painted properly.
 *
 * Ported from `harness/src/export/borderStyles.ts` (E12B). Guide: `docs/guide/vector-painting.md` §"Non-solid border styles (E12B)".
 *
 * WHAT THE PORT CHANGED. The port records no change here beyond the language. The module runs only under the `styledBorders` flag (`options.js`), whose default `false` keeps every recorded stream as it was.
 *
 * The harness's own header follows.
 *
 * E12b (`vector-painting.md`): the six border styles E9 painted solid and recorded, painted properly.
 *
 * E9 (`vector-painting.md`) drew `solid`, `none` and `hidden` and pushed every other value onto the deferred list, because a border style is not a colour or a width that an exporter can read off a computed style and copy: it is a *drawing rule* that lives in the engine's source and nowhere else. CSS Backgrounds 3 says of `dashed` only that the border is "a series of short square-ended dashes", of `groove` that it "looks as though it were carved into the canvas", and of `inset`/`outset` that the box looks embedded or embossed — the lengths, the gaps, the corner fitting and the two shading factors are all left to the implementation. So this module is a transcription of one implementation, read at the version the harness runs, and every number in it is quoted below beside the function it came from.
 *
 * Chromium 141.0.7390.37, `core/paint/box_border_painter.cc` and `platform/graphics/styled_stroke_data.cc`:
 *
 * **Which style actually paints.** `BorderEdge::EffectiveStyle` turns `double` below 3 px and `groove`/`ridge` at 1 px or less into `solid` before anything is drawn, so a 2 px double border is a 2 px solid one and no reader ever sees three stripes in two pixels.
 *
 * **Dashes.** `DashLengthRatio(t)` is 2 for `t >= 3` and 3 below it, `DashGapRatio(t)` is 1 and 2 respectively, so a dashed border of width w is dashes of 2w with gaps of w when w ≥ 3 and dashes of 3w with gaps of 2w when it is thinner — thin lines get longer dashes so they do not read as dots. The dash length is then never touched again: the *gap* is what absorbs the fitting. `SelectBestDashGap` counts how many dashes fit (`n = floor(available / (dash + gap))`, with `available` the path length plus one gap on an open path and the bare length on a closed one), computes the gap that `n` and `n + 1` dashes would each need, and keeps whichever is nearer the nominal gap. That is the corner fitting: dashes land on both ends of every side because the gap, not the dash, was stretched.
 *
 * **Dots.** `StrokeIsDashed(w, style)` is true for `dashed` and for `dotted` *at 3 px or less*, and that split decides the shape. A thin dotted border goes through the dashed branch with no ratio applied, which is a dash of w and a gap of w under a butt cap: **square** dots. A dotted border thicker than 3 px goes through the dotted branch, which is `{0, gap + w - 0.01}` under a **round** cap: circles of diameter w, with the endpoints pulled in by w/2 so the caps do not overhang the corner. So the answer to "circles or squares" is both, and the threshold is 3 px.
 *
 * **Double.** `GetDoubleBorderStripeWidth` is `round(w/3)` for the outer stripe and `round(2w/3)` for where the inner stripe begins, per side; the flat path spells the same thing as `(w + 1) / 3` in integer arithmetic and the two agree at every integer width. The gap is whatever is left in the middle.
 *
 * **Groove, ridge, inset, outset.** `DarkenBoxSide(side, style)` is `(side is top or left) == (style is inset)`, so `inset` darkens the top and left and `outset` darkens the bottom and right. `CalculateInsetOutsetColor` darkens with `Color::Dark()` and otherwise leaves the colour alone unless it is dark enough that the two would not be told apart: below `r < 150/255` and `g < 92/255` it measures the WCAG contrast between the colour and its own dark, and lightens with `Color::Light()` when that is under 1.75. `Color::Dark()` is `v = max(r,g,b)`, `m = max(0, (v - 0.33)/v)`, every channel times m, quantised to 8 bits, with white special-cased to `rgb(171,171,171)`; `Color::Light()` is `m = min(1, v + 0.33)/v` with black special-cased to `rgb(84,84,84)`. `groove` paints its outer half as `inset` and its inner half as `outset`, `ridge` the other way round, split at the centre line.
 *
 * What this module does *not* transcribe is `EnforceDotsAtEndpoints`, which nudges a thin dotted line by single device pixels so a whole dot lands on each end, and the 2.2× overdraw-and-clip trick the rounded path strokes with. Both are device-pixel arrangements for an antialiased raster; a PDF is drawn at the reader's resolution and neither has anything to say about it. They are recorded in the notes rather than implemented.
 *
 * @packageDocumentation
 */
import { boundaryPieces, borderSidePath, insetBox } from './cssBoxes.ts';
import { PX_TO_PT } from '../coordinates/units.ts';
import { roundedRectPath, transformPath } from './pathData.ts';
import { emptyNodeCommon } from './vector.ts';

import type { Matrix } from '../images/imagePlace.ts';
import type { Box, Path, Radii } from './pathData.ts';
import type { ClipSpec, VectorNode } from './vector.ts';

/** The styles E9 (`vector-painting.md`) already drew exactly; this module is every other one. */
export const SOLID_STYLES: ReadonlySet<string> = new Set(['solid', 'none', 'hidden']);

/** The styles this module draws. Anything else is still solid plus a note. */
export const STYLED_BORDER_STYLES: ReadonlySet<string> = new Set(['dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset']);

/** A side of a box, clockwise from the top, as {@link SIDE_NAMES} names them. */
export type Side = 0 | 1 | 2 | 3;

/** The four sides' CSS names, indexed by {@link Side}. */
export const SIDE_NAMES = (['top', 'right', 'bottom', 'left'] as const);

/** A border colour with its alpha kept beside it. */
export type BorderColour = {
  rgb: [number, number, number];
  alpha: number;
};

/** What one side of one box declares, in CSS pixels and the engine's colours. */
export type BorderSideInput = {
  widthPx: number;
  style: string;
  colour: BorderColour;
};

/** One box's border, as {@link styledBorderNodes} is handed it. */
export type StyledBorderInput = {
  domPath: string;
  /** The border box, in the space `toPage` maps to points. */
  border: Box;
  radii: Radii;
  /** The padding box, which is the inner edge of the border. */
  padding: Box;
  paddingRadii: Radii;
  sides: [BorderSideInput, BorderSideInput, BorderSideInput, BorderSideInput];
  toPage: Matrix;
};

/** One side's answer, for the report and the node checker. */
export type StyledBorderRecord = {
  path: string;
  /** `top`, `right`, `bottom`, `left`, or `all` for a contour drawn once. */
  side: string;
  /** The declared style. */
  style: string;
  /** What Chromium's `EffectiveStyle` turned it into, when that differs. */
  effective?: string;
  widthPx: number;
  rgb: [number, number, number];
  /** Dashed and dotted: the pattern in points, as the `d` operator carries it. */
  dashPt?: number[];
  /** The same pattern in CSS pixels, which is where it was computed. */
  dashPx?: number[];
  /** 0 butt, 1 round. */
  cap?: 0 | 1;
  /** The length the fitting was computed over, in CSS px. */
  pathLengthPx?: number;
  /** How many whole dashes that length holds. */
  dashes?: number;
  closed?: boolean;
  /** Double: the two stripe widths in CSS px, outer first. */
  stripesPx?: [number, number];
  /** Groove, ridge, inset, outset: the colours the two halves were shaded to. */
  shaded?: { half: string, rgb: [number, number, number], darkened: boolean }[];
  /** How many painting nodes the side became. */
  nodes: number;
};

/** What {@link styledBorderNodes} answers for one box. */
export type StyledBorderResult = {
  nodes: VectorNode[];
  records: StyledBorderRecord[];
  /** Sides this module handled, so the caller leaves them alone. */
  handled: Set<Side>;
  /** Sides whose declared style the engine downgraded to `solid` before painting. The caller paints them solid as it always did, but it does *not* record them as deferred: a 2 px `double` painted solid is not an approximation, it is what Chromium paints, and a deferred entry there would be a note about a difference that does not exist. */
  downgraded: Set<Side>;
  /** What is still an approximation, in the deferred list's vocabulary. */
  deferred: { path: string, feature: string, paintedAs: string }[];
};

// --- Chromium's colour arithmetic -------------------------------------------

/** `QuantizeTo8Bit`: the float is scaled by just under 256 and truncated. */
const quantise8 = (v: number): number => Math.trunc(v * 255.99998474121094) / 255;

/** Whether a colour is exactly `rgb(r, g, b)` at 8 bits. */
const eq = (c: readonly number[], r: number, g: number, b: number): boolean => Math.round(c[0] * 255) === r && Math.round(c[1] * 255) === g && Math.round(c[2] * 255) === b;

/** `Color::Dark()`, with white's hard-coded answer. */
export function darkColour(rgb: [number,number,number]): [number,number,number] {
  if (eq(rgb, 255, 255, 255)) return [171 / 255, 171 / 255, 171 / 255];
  const v = Math.max(rgb[0], rgb[1], rgb[2]);
  const m = v === 0 ? 0 : Math.max(0, (v - 0.33) / v);
  return [quantise8(rgb[0] * m), quantise8(rgb[1] * m), quantise8(rgb[2] * m)];
}

/** `Color::Light()`, with black's hard-coded answer. */
export function lightColour(rgb: [number,number,number]): [number,number,number] {
  if (eq(rgb, 0, 0, 0)) return [84 / 255, 84 / 255, 84 / 255];
  const v = Math.max(rgb[0], rgb[1], rgb[2]);
  if (v === 0) return [84 / 255, 84 / 255, 84 / 255];
  const m = Math.min(1, v + 0.33) / v;
  return [quantise8(rgb[0] * m), quantise8(rgb[1] * m), quantise8(rgb[2] * m)];
}

/** `color_utils::Linearize`, the sRGB transfer function WCAG contrast uses. */
const linearise = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** WCAG's relative luminance of an sRGB colour. */
const relativeLuminance = (rgb: readonly number[]): number => 0.2126 * linearise(rgb[0]) + 0.7152 * linearise(rgb[1]) + 0.0722 * linearise(rgb[2]);

/** WCAG's contrast ratio between two colours, whichever is lighter. */
export function contrastRatio(a: readonly number[], b: readonly number[]): number {
  const la = relativeLuminance(a) + 0.05;
  const lb = relativeLuminance(b) + 0.05;
  return la > lb ? la / lb : lb / la;
}

/** The contrast below which the lighter edge is lightened rather than left alone. */
export const MINIMUM_BORDER_EDGE_CONTRAST_RATIO = 1.75;

/** `CalculateInsetOutsetColor`: the colour one shaded half of a groove, ridge, inset or outset border paints. */
export function insetOutsetColour(darken: boolean, rgb: [number,number,number]): [number,number,number] {
  if (darken) return darkColour(rgb);
  // The brute-force bound Chromium records: above either of these the answer is always the colour itself, so the contrast is never measured.
  if (rgb[0] >= 150 / 255 || rgb[1] >= 92 / 255) return rgb;
  return contrastRatio(rgb, darkColour(rgb)) < MINIMUM_BORDER_EDGE_CONTRAST_RATIO ? lightColour(rgb) : rgb;
}

/** `DarkenBoxSide`: inset darkens the top and left, outset the bottom and right. */
export const darkenBoxSide = (side: Side, style: 'inset'|'outset'): boolean => (side === 0 || side === 3) === (style === 'inset');

/** `BorderEdge::EffectiveStyle`: the style the painter actually sees. */
export function effectiveStyle(style: string, widthPx: number): string {
  const w = Math.round(widthPx);
  if (style === 'double' && w < 3) return 'solid';
  if ((style === 'groove' || style === 'ridge') && w <= 1) return 'solid';
  return style;
}

// --- Chromium's dash arithmetic ---------------------------------------------

/** `DashLengthRatio`: a dash's length as a multiple of the border's thickness. */
export const dashLengthRatio = (thickness: number): number => (thickness >= 3 ? 2 : 3);

/** `DashGapRatio`: a gap's nominal length as a multiple of the border's thickness. */
export const dashGapRatio = (thickness: number): number => (thickness >= 3 ? 1 : 2);

/** `StyledStrokeData::StrokeIsDashed`: dotted is dashed until it is thick. */
export const strokeIsDashed = (widthPx: number, style: string): boolean => style === 'dashed' || (style === 'dotted' && widthPx <= 3);

/** `SelectBestDashGap`: the gap, not the dash, is what absorbs the fitting. */
export function selectBestDashGap(strokeLength: number, dashLength: number, gapLength: number, closed: boolean): number {
  const available = closed ? strokeLength : strokeLength + gapLength;
  const minDashes = Math.floor(available / (dashLength + gapLength));
  const maxDashes = minDashes + 1;
  const minGaps = closed ? minDashes : minDashes - 1;
  const maxGaps = closed ? maxDashes : maxDashes - 1;
  const minGap = (strokeLength - minDashes * dashLength) / minGaps;
  const maxGap = (strokeLength - maxDashes * dashLength) / maxGaps;
  return maxGap <= 0 || Math.abs(minGap - gapLength) < Math.abs(maxGap - gapLength) ? minGap : maxGap;
}

/** The epsilon that keeps the last dot of a dotted line whole. */
export const DOT_EPSILON = 1.0e-2;

/** A dash pattern as Chromium resolves it for one line. */
export type DashPattern = {
  /** The `d` array in CSS px; empty means no dashes at all, i.e. a solid line. */
  intervals: number[];
  cap: 0 | 1;
  /** How many whole dashes the length holds, for the record. */
  dashes: number;
};

/**
 * `DashEffectFromStrokeStyle`, in CSS pixels.
 *
 * @returns `null` is Chromium's `std::nullopt`: the path is too short to carry dashes and the line is stroked solid.
 */
export function chromiumDash(style: string, widthPx: number, pathLengthPx: number, closed: boolean): DashPattern|null {
  const w = widthPx;
  if (strokeIsDashed(w, style)) {
    let dash = w;
    let gap = w;
    if (style === 'dashed') {
      dash *= dashLengthRatio(w);
      gap *= dashGapRatio(w);
    }
    if (pathLengthPx <= dash * 2) return null;
    let twoDashes = 2 * dash + gap;
    if (closed) twoDashes += gap;
    if (pathLengthPx <= twoDashes) {
      const multiplier = pathLengthPx / twoDashes;
      return { intervals: [dash * multiplier, gap * multiplier], cap: 0, dashes: 2 };
    }
    const fitted = style === 'dashed' ? selectBestDashGap(pathLengthPx, dash, gap, closed) : gap;
    return { intervals: [dash, fitted], cap: 0, dashes: Math.max(1, Math.round((pathLengthPx + fitted) / (dash + fitted))) };
  }
  if (style === 'dotted') {
    const perDot = w * 2;
    if (pathLengthPx < perDot) return { intervals: [0, perDot], cap: 1, dashes: 1 };
    const gap = selectBestDashGap(pathLengthPx, w, w, closed);
    const interval = gap + w - DOT_EPSILON;
    return { intervals: [0, interval], cap: 1, dashes: Math.max(1, Math.round(pathLengthPx / interval) + 1) };
  }
  return null;
}

// --- geometry ---------------------------------------------------------------

/**
 * A path's length, with cubics flattened finely enough for a dash count.
 *
 * @param steps - Straight pieces per cubic.
 */
export function pathLength(path: Path, steps: number = 24): number {
  let total = 0;
  let current: [number,number] = [0, 0];
  let start: [number,number] = [0, 0];
  const dist = (a: [number,number], b: [number,number]): number => Math.hypot(b[0] - a[0], b[1] - a[1]);
  for (const seg of path) {
    if (seg.op === 'm') {
      current = seg.to;
      start = seg.to;
      continue;
    }
    if (seg.op === 'l') {
      total += dist(current, seg.to);
      current = seg.to;
      continue;
    }
    if (seg.op === 'h') {
      total += dist(current, start);
      current = start;
      continue;
    }
    let previous = current;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      const point: [number,number] = [
        u * u * u * current[0] + 3 * u * u * t * seg.c1[0] + 3 * u * t * t * seg.c2[0] + t * t * t * seg.to[0],
        u * u * u * current[1] + 3 * u * u * t * seg.c1[1] + 3 * u * t * t * seg.c2[1] + t * t * t * seg.to[1],
      ];
      total += dist(previous, point);
      previous = point;
    }
    current = seg.to;
  }
  return total;
}

/** The four sides' widths, in CSS px. */
const sideWidths = (sides: StyledBorderInput['sides']): [number,number,number,number] => [sides[0].widthPx, sides[1].widthPx, sides[2].widthPx, sides[3].widthPx];

/** The line down the middle of one side, from outer corner to outer corner. */
function centreLine(border: Box, widths: [number,number,number,number], side: Side): { path: Path; length: number; } {
  const w = widths[side];
  if (side === 0) {
    const y = border.y + w / 2;
    return { path: [{ op: 'm', to: [border.x, y] }, { op: 'l', to: [border.x + border.w, y] }], length: border.w };
  }
  if (side === 2) {
    const y = border.y + border.h - w / 2;
    return { path: [{ op: 'm', to: [border.x, y] }, { op: 'l', to: [border.x + border.w, y] }], length: border.w };
  }
  if (side === 3) {
    const x = border.x + w / 2;
    return { path: [{ op: 'm', to: [x, border.y] }, { op: 'l', to: [x, border.y + border.h] }], length: border.h };
  }
  const x = border.x + border.w - w / 2;
  return { path: [{ op: 'm', to: [x, border.y] }, { op: 'l', to: [x, border.y + border.h] }], length: border.h };
}

/** A thick dotted line's endpoints pulled in by half a width, as Chromium pulls them. */
function shortenForRoundCaps(path: Path, widthPx: number, side: Side): Path {
  const half = widthPx / 2;
  const [a, b] = [path[0], path[1]];
  if (a.op !== 'm' || b.op !== 'l') return path;
  if (side === 0 || side === 2) {
    return [
      { op: 'm', to: [a.to[0] + half, a.to[1]] },
      { op: 'l', to: [b.to[0] - half, b.to[1]] },
    ];
  }
  return [
    { op: 'm', to: [a.to[0], a.to[1] + half] },
    { op: 'l', to: [b.to[0], b.to[1] - half] },
  ];
}

/** A filled region of a border — a stripe, a shaded half, a whole side — as a path node in page points. */
const fillNode = (domPath: string, label: string, path: Path, colour: BorderColour, toPage: Matrix): VectorNode => ({
  ...emptyNodeCommon(domPath, label),
  kind: 'path',
  path: transformPath(path, toPage),
  fill: { kind: 'rgb', rgb: colour.rgb },
  fillRule: 'nonzero',
  stroke: { kind: 'none' },
  strokeStyle: null,
  opacity: colour.alpha,
});

/** A dashed or dotted line as a stroked path node in page points, under its mitre clips. */
const strokeNode = (domPath: string, label: string, path: Path, colour: BorderColour, widthPx: number, dash: DashPattern|null, toPage: Matrix, clips: ClipSpec[]): VectorNode => ({
  ...emptyNodeCommon(domPath, label),
  kind: 'path',
  path: transformPath(path, toPage),
  fill: { kind: 'none' },
  fillRule: 'nonzero',
  stroke: { kind: 'rgb', rgb: colour.rgb },
  strokeStyle: {
    widthPt: widthPx * PX_TO_PT,
    cap: dash ? dash.cap : 0,
    join: 0,
    miterLimit: 10,
    dashPt: (dash?.intervals ?? []).map((v) => v * PX_TO_PT),
    dashPhasePt: 0,
    nonScaling: false,
  },
  strokeOpacity: colour.alpha,
  clips,
});

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * Every non-solid side of one box, as painting nodes in page points.
 *
 * @remarks
 * A side whose style is `solid`, `none` or `hidden` — or whose effective style became `solid` because it is too thin to carry its own detail — is left to the caller untouched, which is what keeps every fixture before E12 (`vector-painting.md`) byte for byte what it was: none of them declares a style this module handles, so `handled` comes back empty and `collectCssBoxes` runs exactly the code it ran.
 */
export function styledBorderNodes(input: StyledBorderInput): StyledBorderResult {
  const { domPath, border, radii, padding, paddingRadii, sides, toPage } = input;
  const out: StyledBorderResult = { nodes: [], records: [], handled: new Set<any>(), downgraded: new Set<any>(), deferred: [] };
  const widths = sideWidths(sides);
  const outerPieces = boundaryPieces(border, radii);
  const innerPieces = boundaryPieces(padding, paddingRadii);
  const rounded = radii.some((r) => r[0] > 0 || r[1] > 0);

  const uniform =
    sides.every((s) => s.style === sides[0].style && s.widthPx === sides[0].widthPx) &&
    sides.every((s) => s.colour.rgb.every((c, i) => c === sides[0].colour.rgb[i]) && s.colour.alpha === sides[0].colour.alpha);

  // The rounded contour case: Chromium strokes the whole centre-line contour once and clips it per side, so a box whose four sides agree is one closed path here rather than four straight ones, and the dash fitting is the closed-path fitting the engine performs.
  if (rounded && uniform && (sides[0].style === 'dashed' || sides[0].style === 'dotted')) {
    const w = sides[0].widthPx;
    const centre = insetBox(border, radii, w / 2, w / 2, w / 2, w / 2);
    const path = roundedRectPath(centre.box, centre.radii);
    const length = pathLength(path);
    const dash = chromiumDash(sides[0].style, w, length, true);
    out.nodes.push(strokeNode(domPath, 'border-contour', path, sides[0].colour, w, dash, toPage, []));
    out.records.push({
      path: domPath,
      side: 'all',
      style: sides[0].style,
      widthPx: round4(w),
      rgb: (sides[0].colour.rgb.map(round4) as [number, number, number]),
      dashPx: (dash?.intervals ?? []).map(round4),
      dashPt: (dash?.intervals ?? []).map((v) => round4(v * PX_TO_PT)),
      cap: dash ? dash.cap : 0,
      pathLengthPx: round4(length),
      dashes: dash?.dashes ?? 0,
      closed: true,
      nodes: 1,
    });
    for (const side of ([0, 1, 2, 3] as Side[])) out.handled.add(side);
    return out;
  }

  for (const side of ([0, 1, 2, 3] as Side[])) {
    const declared = sides[side].style;
    if (!STYLED_BORDER_STYLES.has(declared)) continue;
    const width = widths[side];
    if (width <= 0) continue;
    const colour = sides[side].colour;
    if (colour.alpha === 0) continue;
    const effective = effectiveStyle(declared, width);
    if (effective === 'solid') {
      out.downgraded.add(side);
      out.records.push({
        path: domPath,
        side: SIDE_NAMES[side],
        style: declared,
        effective: 'solid',
        widthPx: round4(width),
        rgb: (colour.rgb.map(round4) as [number, number, number]),
        nodes: 0,
      });
      continue;
    }
    out.handled.add(side);

    const name = `border-${SIDE_NAMES[side]}`;
    const record: StyledBorderRecord = {
      path: domPath,
      side: SIDE_NAMES[side],
      style: declared,
      widthPx: round4(width),
      rgb: (colour.rgb.map(round4) as [number, number, number]),
      nodes: 0,
    };
    if (effective !== declared) record.effective = effective;

    if (effective === 'dashed' || effective === 'dotted') {
      const line = centreLine(border, widths, side);
      const dash = chromiumDash(effective, width, line.length, false);
      const thickDots = effective === 'dotted' && !strokeIsDashed(width, 'dotted');
      const path = thickDots ? shortenForRoundCaps(line.path, width, side) : line.path;
      // The mitre clip: the side's own solid region, which is the trapezoid between the outer and inner contours that `ClipBorderSidePolygon` builds. Without it a stroke centred on the side runs the full width of the box and paints over both neighbours' corners.
      const clip: ClipSpec = {
        path: transformPath(borderSidePath(outerPieces, innerPieces, side), toPage),
        evenOdd: false,
        reason: `the ${effective} ${name} is a stroke, so its corner mitre is a clip`,
      };
      out.nodes.push(strokeNode(domPath, name, path, colour, width, dash, toPage, [clip]));
      record.dashPx = (dash?.intervals ?? []).map(round4);
      record.dashPt = (dash?.intervals ?? []).map((v) => round4(v * PX_TO_PT));
      record.cap = dash ? dash.cap : 0;
      record.pathLengthPx = round4(line.length);
      record.dashes = dash?.dashes ?? 0;
      record.closed = false;
      record.nodes = 1;
      if (rounded) {
        out.deferred.push({
          path: domPath,
          feature: `border-${SIDE_NAMES[side]}-style: ${declared} at a rounded corner with sides that differ`,
          paintedAs: 'a straight centre-line stroke clipped to the side, not the rounded contour Chromium strokes',
        });
      }
    } else if (effective === 'double') {
      const outerThird = (widths.map((w) => Math.round(w / 3)) as [number, number, number, number]);
      const innerStart = (widths.map((w) => Math.round((w * 2) / 3)) as [number, number, number, number]);
      const outerStripe = insetBox(border, radii, outerThird[0], outerThird[1], outerThird[2], outerThird[3]);
      const innerStripe = insetBox(border, radii, innerStart[0], innerStart[1], innerStart[2], innerStart[3]);
      const outerPath = borderSidePath(outerPieces, boundaryPieces(outerStripe.box, outerStripe.radii), side);
      const innerPath = borderSidePath(boundaryPieces(innerStripe.box, innerStripe.radii), innerPieces, side);
      out.nodes.push(fillNode(domPath, `${name}:outer-stripe`, outerPath, colour, toPage));
      out.nodes.push(fillNode(domPath, `${name}:inner-stripe`, innerPath, colour, toPage));
      record.stripesPx = [outerThird[side], round4(width - innerStart[side])];
      record.nodes = 2;
    } else if (effective === 'groove' || effective === 'ridge') {
      const halves = (widths.map((w) => w / 2) as [number, number, number, number]);
      const centre = insetBox(border, radii, halves[0], halves[1], halves[2], halves[3]);
      const centrePieces = boundaryPieces(centre.box, centre.radii);
      const s1 = effective === 'groove' ? 'inset' : 'outset';
      const s2 = effective === 'groove' ? 'outset' : 'inset';
      const darken1 = darkenBoxSide(side, s1);
      const darken2 = darkenBoxSide(side, s2);
      const rgb1 = insetOutsetColour(darken1, colour.rgb);
      const rgb2 = insetOutsetColour(darken2, colour.rgb);
      out.nodes.push(
        fillNode(domPath, `${name}:outer-half`, borderSidePath(outerPieces, centrePieces, side), { rgb: rgb1, alpha: colour.alpha }, toPage),
      );
      out.nodes.push(
        fillNode(domPath, `${name}:inner-half`, borderSidePath(centrePieces, innerPieces, side), { rgb: rgb2, alpha: colour.alpha }, toPage),
      );
      record.shaded = [
        { half: 'outer', rgb: (rgb1.map(round4) as [number, number, number]), darkened: darken1 },
        { half: 'inner', rgb: (rgb2.map(round4) as [number, number, number]), darkened: darken2 },
      ];
      record.nodes = 2;
    } else {
      const darken = darkenBoxSide(side, (effective as 'inset' | 'outset'));
      const rgb = insetOutsetColour(darken, colour.rgb);
      out.nodes.push(fillNode(domPath, name, borderSidePath(outerPieces, innerPieces, side), { rgb, alpha: colour.alpha }, toPage));
      record.shaded = [{ half: 'whole', rgb: (rgb.map(round4) as [number, number, number]), darkened: darken }];
      record.nodes = 1;
    }

    out.records.push(record);
  }

  return out;
}
