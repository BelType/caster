/**
 * `vectors/cssBoxes.js` — the CSS half of `vector-painting.md` (E9): what a box paints, read off the computed style.
 *
 * Ported from `harness/src/export/cssBoxes.ts` (E9, E10, E11, E12B). Guide: `docs/guide/vector-painting.md` — the browser-side procedure, the raster fallback list and the radius clamping.
 *
 * WHAT THE PORT CHANGED (DESIGN.md P18). One departure: `boundaryPieces` closes a square-cornered box's fourth edge on the piece count rather than on its length, so a box of zero height answers eight pieces like every other (*`boundaryPieces` answers three pieces for a zero-height box*, DESIGN.md S21, and the function's own comment). The rest is the language.
 *
 * The harness's own header follows.
 *
 * The CSS half of `vector-painting.md` (E9): what a box paints, read off the computed style.
 *
 * A decorated box is not one shape. It is a shadow behind it, a background colour, a background image, four border sides that may differ in colour and width and that meet inside rounded corners, an outline outside all of it, and whatever clip its ancestors imposed — painted in that order, into a box that the engine may have split across a page break. Every one of those is read here and turned into the vector nodes `vectorEmit` writes, in page points, with nothing left for the emitter to re-derive from a DOM it no longer holds.
 *
 * Three rules are worth stating because they are decisions rather than transcription. Fragments are the engine's: `getClientRects()` answers with one rectangle per fragment and each is painted whole, which is `box-decoration-break: slice` and is the only thing an exporter that does not lay out text can honestly do. Rounded corners are split between two sides at the middle of the corner's arc, which is exact when the two border widths are equal and is within a fraction of a point of Chromium when they are not. And a border style this exporter cannot draw is painted solid and recorded, never dropped: a missing border is a page the reader cannot check, while a solid one is a page that is visibly a little wrong in a way the notes name.
 *
 * @packageDocumentation
 */
import { styledBorderNodes } from './borderStyles.ts';
import { parseCmykGradientHint, readHint } from '../colour/colorHints.ts';
import { invert, toPdfMatrix } from '../coordinates/ctm.ts';
import { apply, mul } from '../coordinates/matrix.ts';
import { PX_TO_PT } from '../coordinates/units.ts';
import { pageGeometryFor } from '../coordinates/pageGeometry.ts';
import { clampRadii, cssShapePath, pathBounds, roundedRectPath, transformPath } from './pathData.ts';
import { domPathOf } from '../measure/textMeasure.ts';
import { IDENTITY, blendName, emptyNodeCommon, pageOfElement, placeBox, parseCssColor } from './vector.ts';

import type { StyledBorderRecord } from './borderStyles.ts';
import type { Cmyk } from '../colour/colorHints.ts';
import type { ChainContext } from '../coordinates/ctm.ts';
import type { Matrix, PathSegment } from '../images/imagePlace.ts';
import type { Box, Path, Point, Radii, Radius } from './pathData.ts';
import type { PaintOrder } from '../walk/paintOrder.ts';
import type { ArtifactDescriptor } from '../walk/structure.ts';
import type { ClipSpec, GradientStop, PaintSpec, RasterSpec, ShadingSpec, VectorNode, VectorRequest } from './vector.ts';

/** The DPI every raster fallback is drawn at. */
export const RASTER_DPI = 300;

/** How many periods of a repeating gradient are ever unrolled. */
const MAX_PERIODS = 64;

/** One thing this exporter cannot paint the way the engine did. */
export type DeferredRecord = {
  path: string;
  feature: string;
  paintedAs: string;
};

/** What {@link collectCssBoxes} answers: the requests to paint, the artifacts that own them, and what could not be painted as a vector. */
export type CssBoxResult = {
  requests: VectorRequest[];
  artifacts: ArtifactDescriptor[];
  rasters: RasterSpec[];
  deferred: DeferredRecord[];
  /** E12b (`vector-painting.md`): one entry per side a non-solid style was actually drawn for. */
  borderStyles: StyledBorderRecord[];
};

/** A computed length in px as a number, or 0 where it does not parse. */
const px = (value: string): number => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};

/** One corner's radius pair, as the computed style spells it (`10px` or `10px 20px`). */
function cornerRadius(value: string, w: number, h: number): Radius {
  const parts = value.trim().split(/\s+/).filter((p) => p !== '');
  const one = (token: string, reference: number): number => (token.endsWith('%') ? (Number.parseFloat(token) / 100) * reference : px(token));
  const rx = one(parts[0] ?? '0px', w);
  const ry = parts[1] !== undefined ? one(parts[1], h) : one(parts[0] ?? '0px', h);
  return [rx, ry];
}

/** The four corners, clamped by the CSS algorithm so opposite pairs fit the box. */
export function radiiOf(style: CSSStyleDeclaration, w: number, h: number): Radii {
  return clampRadii(
    [
      cornerRadius(style.borderTopLeftRadius, w, h),
      cornerRadius(style.borderTopRightRadius, w, h),
      cornerRadius(style.borderBottomRightRadius, w, h),
      cornerRadius(style.borderBottomLeftRadius, w, h),
    ],
    w,
    h,
  );
}

/** Border widths in CSS-property order: top, right, bottom, left. */
function borderWidths(style: CSSStyleDeclaration): [number,number,number,number] {
  return [px(style.borderTopWidth), px(style.borderRightWidth), px(style.borderBottomWidth), px(style.borderLeftWidth)];
}

/** A box inset on each side, with the radii reduced by the same amounts. */
export function insetBox(box: Box, radii: Radii, top: number, right: number, bottom: number, left: number): { box: Box; radii: Radii; } {
  const inner: Box = { x: box.x + left, y: box.y + top, w: Math.max(0, box.w - left - right), h: Math.max(0, box.h - top - bottom) };
  const shrink = (r: Radius, dx: number, dy: number): Radius => [Math.max(0, r[0] - dx), Math.max(0, r[1] - dy)];
  return {
    box: inner,
    radii: [shrink(radii[0], left, top), shrink(radii[1], right, top), shrink(radii[2], right, bottom), shrink(radii[3], left, bottom)],
  };
}

// --- border sides -----------------------------------------------------------

/** One boundary piece of a rounded rectangle, with its own start point. */
export type Piece = {
  start: Point;
  segs: PathSegment[];
};

/** de Casteljau: one cubic split at t into the two cubics that make it up. */
function splitCubic(p0: Point, c1: Point, c2: Point, p3: Point, t: number): { first: Piece; second: Piece; } {
  const lerp = (a: Point, b: Point): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const a = lerp(p0, c1);
  const b = lerp(c1, c2);
  const c = lerp(c2, p3);
  const d = lerp(a, b);
  const e = lerp(b, c);
  const m = lerp(d, e);
  return {
    first: { start: p0, segs: [{ op: 'c', c1: a, c2: d, to: m }] },
    second: { start: m, segs: [{ op: 'c', c1: e, c2: c, to: p3 }] },
  };
}

/**
 * The eight boundary pieces of a rounded rectangle, in the order a path walks them: top edge, top-right corner, right edge, bottom-right corner, bottom edge, bottom-left corner, left edge, top-left corner.
 *
 * @remarks
 * A departure from the port (DESIGN.md P18, closing *`boundaryPieces` answers three pieces for a zero-height box*, DESIGN.md S21). The harness's `boundaryPieces` drops the closing edge whenever the walk has already returned to the start point, which is right for a rounded path — its last cubic lands exactly on the start and a ninth piece would break every index below — and wrong for a square-cornered box of zero height, whose fourth edge is degenerate for the same reason: `{w:100,h:0}` answered three pieces where `{w:0,h:20}`, a rounded `{w:100,h:0}` and every ordinary box answer eight, and `borderSidePath` then indexed `outer[7]` and threw. A square-cornered box always walks three explicit edges before it closes, so the fourth is pushed on that count rather than on its length, and the eight-piece contract holds for every box whatever its dimensions.
 */
export function boundaryPieces(box: Box, radii: Radii): Piece[] {
  const path = roundedRectPath(box, radii);
  const pieces: Piece[] = [];
  let current: Point = [0, 0];
  let first: Point = [0, 0];
  for (const segment of path) {
    if (segment.op === 'm') {
      current = segment.to;
      first = segment.to;
      continue;
    }
    if (segment.op === 'h') {
      // The closing edge, pushed when the cursor has not come back to the start — or when only three pieces have been walked, which is a square-cornered box whose fourth edge happens to have zero length. A rounded path arrives here with its eight pieces already walked and its cursor on the start, and pushes nothing.
      const open = current[0] !== first[0] || current[1] !== first[1];
      if (open || pieces.length === 3) pieces.push({ start: current, segs: [{ op: 'l', to: first }] });
      continue;
    }
    pieces.push({ start: current, segs: [segment] });
    current = segment.op === 'l' ? segment.to : segment.to;
  }
  // A square-cornered box produces four line pieces and no corners; the corners are inserted as zero-length pieces so the indices below hold whatever the radii are.
  if (pieces.length === 4) {
    const out: Piece[] = [];
    for (const piece of pieces) {
      out.push(piece);
      const end = endOf(piece);
      out.push({ start: end, segs: [] });
    }
    return out;
  }
  return pieces;
}

/** Where a piece ends: its last segment's endpoint, or its start when it has no segment or closes on one. */
function endOf(piece: Piece): Point {
  const last = piece.segs[piece.segs.length - 1];
  if (!last) return piece.start;
  return last.op === 'h' ? piece.start : last.to;
}

/** A piece walked backwards, which is what closes a side's outline. */
function reversePiece(piece: Piece): Piece {
  const points: PathSegment[] = [];
  let cursor = piece.start;
  const stack: { from: Point; seg: PathSegment; }[] = [];
  for (const seg of piece.segs) {
    stack.push({ from: cursor, seg });
    cursor = seg.op === 'h' ? cursor : seg.to;
  }
  const start = cursor;
  for (const { from, seg } of stack.reverse()) {
    if (seg.op === 'c') points.push({ op: 'c', c1: seg.c2, c2: seg.c1, to: from });
    else if (seg.op === 'l' || seg.op === 'm') points.push({ op: 'l', to: from });
  }
  return { start, segs: points };
}

/** Half a corner, so the two sides that meet in it each get one. */
function halfCorner(piece: Piece, which: 'first'|'second'): Piece {
  const seg = piece.segs[0];
  if (!seg || seg.op !== 'c') return { start: which === 'first' ? piece.start : endOf(piece), segs: [] };
  const split = splitCubic(piece.start, seg.c1, seg.c2, seg.to, 0.5);
  return which === 'first' ? split.first : split.second;
}

/**
 * One border side as a closed region.
 *
 * @remarks
 * Outer boundary: the second half of the corner before the side, the side itself, the first half of the corner after it. Inner boundary: the same three pieces of the inner box, walked backwards. The two are joined by straight lines, which is what makes the join between two sides of different colours a straight mitre rather than a gap.
 */
export function borderSidePath(outer: Piece[], inner: Piece[], side: 0|1|2|3): Path {
  const edge = side * 2;
  const before = (edge + 7) % 8;
  const after = (edge + 1) % 8;

  const outerRun = [halfCorner(outer[before], 'second'), outer[edge], halfCorner(outer[after], 'first')];
  const innerRun = [halfCorner(inner[before], 'second'), inner[edge], halfCorner(inner[after], 'first')];

  const path: PathSegment[] = [{ op: 'm', to: outerRun[0].start }];
  for (const piece of outerRun) for (const seg of piece.segs) path.push(seg);
  const innerReversed = innerRun.map(reversePiece).reverse();
  path.push({ op: 'l', to: innerReversed[0].start });
  for (const piece of innerReversed) for (const seg of piece.segs) path.push(seg);
  path.push({ op: 'h' });
  return path;
}

// --- CSS gradients ----------------------------------------------------------

/** Split a comma-separated list, ignoring commas inside parentheses. */
function splitTopLevel(text: string, separator: string = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === separator && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current.trim());
  return out;
}

/** The name and body of the outermost `name(...)`, or null. */
function functionCall(text: string): { name: string; body: string; }|null {
  const match = /^([a-z-]+)\((.*)\)$/is.exec(text.trim());
  return match ? { name: match[1].toLowerCase(), body: match[2] } : null;
}

/** One raw stop: whatever colour syntax was written, plus its optional position. */
export type RawStop = {
  color: string;
  position: string | null;
};

/** A gradient's stop arguments, each split into its colour and its optional position; a stop written with two positions becomes two stops. */
function parseStops(args: string[]): RawStop[] {
  const stops: RawStop[] = [];
  for (const arg of args) {
    // A colour may itself contain spaces (`rgb(1 2 3)`), so the position is taken off the end rather than the colour off the front.
    const match = /^(.*?)\s+((?:-?[\d.]+(?:px|%|em|rem|pt)?)(?:\s+-?[\d.]+(?:px|%|em|rem|pt)?)?)$/is.exec(arg.trim());
    if (match) {
      for (const position of match[2].trim().split(/\s+/)) stops.push({ color: match[1].trim(), position });
      continue;
    }
    stops.push({ color: arg.trim(), position: null });
  }
  return stops;
}

/** A position token as a fraction of the gradient line's length. */
function stopOffset(position: string|null, lineLengthPx: number): number|null {
  if (position === null) return null;
  const text = position.trim();
  if (text.endsWith('%')) return Number.parseFloat(text) / 100;
  const value = px(text);
  return lineLengthPx > 0 ? value / lineLengthPx : 0;
}

/**
 * Raw stops to resolved ones: every offset a number, non-decreasing, first at zero and last at one unless the author said otherwise.
 *
 * @remarks
 * CSS Images 3 §3.4.3 in three steps: the ends default to 0 and 1, a run of missing positions is spread evenly between the two that surround it, and a position smaller than the one before it is raised to it.
 */
function resolveStops(raw: RawStop[], lineLengthPx: number, colorOf: StopColorReader): GradientStop[] {
  const offsets: (number|null)[] = raw.map((stop) => stopOffset(stop.position, lineLengthPx));
  if (offsets[0] === null) offsets[0] = 0;
  if (offsets[offsets.length - 1] === null) offsets[offsets.length - 1] = 1;
  for (let i = 0; i < offsets.length; i++) {
    if (offsets[i] !== null) continue;
    let end = i;
    while (offsets[end] === null) end += 1;
    const from = (offsets[i - 1] as number);
    const to = (offsets[end] as number);
    for (let j = i; j < end; j++) offsets[j] = from + ((to - from) * (j - i + 1)) / (end - i + 1);
    i = end - 1;
  }
  let previous = -Infinity;
  return raw.map((stop, index) => {
    const offset = Math.max(previous, (offsets[index] as number));
    previous = offset;
    const colour = colorOf(stop.color);
    return { offset, rgb: colour.rgb, alpha: colour.alpha, ...(colour.cmyk ? { cmyk: colour.cmyk } : {}) };
  });
}

/** `45deg`, `0.25turn`, `100grad`, `1rad` as degrees clockwise from "to top". */
function angleDegrees(token: string): number|null {
  const match = /^(-?[\d.]+)(deg|grad|rad|turn)$/i.exec(token.trim());
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  switch (match[2].toLowerCase()) {
    case 'grad':
      return (value * 360) / 400;
    case 'rad':
      return (value * 180) / Math.PI;
    case 'turn':
      return value * 360;
    default:
      return value;
  }
}

/** `to top right` and friends as the angle CSS Images 3 §3.1 defines for a box. */
function cornerAngle(keywords: string[], w: number, h: number): number {
  const has = (word: string): boolean => keywords.includes(word);
  const vertical = has('top') ? 'top' : has('bottom') ? 'bottom' : '';
  const horizontal = has('left') ? 'left' : has('right') ? 'right' : '';
  if (vertical && horizontal) {
    // The gradient line of a corner keyword is perpendicular to the diagonal between the two *other* corners, which is what makes the corner's two neighbours land on the same stop.
    const base = (Math.atan2(w, h) * 180) / Math.PI;
    if (vertical === 'top' && horizontal === 'right') return base;
    if (vertical === 'bottom' && horizontal === 'right') return 180 - base;
    if (vertical === 'bottom' && horizontal === 'left') return 180 + base;
    return 360 - base;
  }
  if (horizontal === 'right') return 90;
  if (horizontal === 'left') return 270;
  if (vertical === 'top') return 0;
  return 180;
}

/** A radial gradient's radii, from its size keyword or explicit lengths. */
function radialRadii(tokens: string[], shape: string, centre: Point, box: Box): [number,number] {
  const dx = [Math.abs(centre[0] - box.x), Math.abs(box.x + box.w - centre[0])];
  const dy = [Math.abs(centre[1] - box.y), Math.abs(box.y + box.h - centre[1])];
  const keyword = tokens.find((t) => /^(closest|farthest)-(side|corner)$/i.test(t));
  if (keyword) {
    const [which, what] = keyword.toLowerCase().split('-');
    const pick = which === 'closest' ? Math.min : Math.max;
    if (what === 'side') {
      if (shape === 'circle') return [pick(...dx, ...dy), pick(...dx, ...dy)];
      return [pick(...dx), pick(...dy)];
    }
    const sideX = pick(...dx);
    const sideY = pick(...dy);
    if (shape === 'circle') {
      const corners = dx.flatMap((x) => dy.map((y) => Math.hypot(x, y)));
      const r = pick(...corners);
      return [r, r];
    }
    // An ellipse's corner size keeps the closest/farthest-side aspect ratio and scales it until it touches the corner, per CSS Images 3 §3.2.
    const scale = Math.SQRT2;
    return [sideX * scale, sideY * scale];
  }
  const lengths = tokens.filter((t) => /^-?[\d.]+(px|%|em|rem|pt)$/i.test(t));
  if (lengths.length === 0) {
    const corners = dx.flatMap((x) => dy.map((y) => Math.hypot(x, y)));
    const r = Math.max(...corners);
    return shape === 'circle' ? [r, r] : [Math.max(...dx) * Math.SQRT2, Math.max(...dy) * Math.SQRT2];
  }
  const one = (token: string, reference: number): number => (token.endsWith('%') ? (Number.parseFloat(token) / 100) * reference : px(token));
  const rx = one(lengths[0], box.w);
  const ry = lengths[1] !== undefined ? one(lengths[1], box.h) : rx;
  return [rx, ry];
}

/** `at 30% 70%` as a point in the box. */
function radialCentre(body: string, box: Box): Point {
  const at = /\bat\b(.*)$/is.exec(body);
  if (!at) return [box.x + box.w / 2, box.y + box.h / 2];
  const parts = at[1].trim().split(/\s+/).filter((p) => p !== '');
  const one = (token: string, size: number, start: number): number => {
    if (token === 'left' || token === 'top') return start;
    if (token === 'center') return start + size / 2;
    if (token === 'right' || token === 'bottom') return start + size;
    if (token.endsWith('%')) return start + (Number.parseFloat(token) / 100) * size;
    return start + px(token);
  };
  return [one(parts[0] ?? 'center', box.w, box.x), one(parts[1] ?? 'center', box.h, box.y)];
}

/**
 * Unroll a repeating or reflecting gradient over as many periods as the shape needs.
 *
 * @remarks
 * PDF's `/Extend` pads with the end colours and has no notion of repetition, so the only way to say "and again" is to say it: the axis is stretched to cover `2k+1` periods and the stop list is written out that many times, reversed on alternate copies when the spread is `reflect`. The result is one Type 2 or Type 3 shading with a longer stitching function and no repetition at all.
 *
 * The period is the stops' own range, not the gradient line. A `repeating-linear-gradient` whose stops end at 16 px of a 120 px line repeats every 16 px, so the axis grows by whole 16-pixel steps and the returned `fromT`/`toT` are in units of the *original* line — which is what the caller multiplies its direction vector by, and what a radial caller multiplies its radius by.
 *
 * Two stops at the same offset are a hard edge and are kept as two stops. That is the whole of what a striped repeating gradient is, and dropping the duplicate — which is the obvious way to keep a stitching function's bounds strictly increasing — turns every stripe into a ramp.
 */
export function unrollGradient(stops: GradientStop[], spread: 'reflect'|'repeat', periods: number): { stops: GradientStop[]; fromT: number; toT: number; } {
  const first = stops[0].offset;
  const last = stops[stops.length - 1].offset;
  const span = last - first || 1e-6;
  const fromT = first - periods * span;
  const toT = last + periods * span;
  const total = toT - fromT;
  const out: GradientStop[] = [];
  for (let period = -periods; period <= periods; period++) {
    const flip = spread === 'reflect' && Math.abs(period) % 2 === 1;
    const source = flip ? [...stops].reverse().map((stop) => ({ ...stop, offset: first + last - stop.offset })) : stops;
    for (const stop of source) out.push({ ...stop, offset: (stop.offset + period * span - fromT) / total });
  }
  return { stops: out, fromT, toT };
}

/**
 * How many periods a repeating gradient needs on each side to cover the shape.
 *
 * @remarks
 * `extent` and `span` are both in units of the gradient line's own parameter, so the answer is "how many stop-ranges fit across the shape", plus one so the edges are covered whatever the phase.
 */
export function periodsFor(extent: number, span: number): number {
  if (!(span > 1e-9)) return 0;
  return Math.min(MAX_PERIODS, Math.ceil(extent / span) + 1);
}

/** A CSS colour, or a `device-cmyk()` from a `--pdf-background` hint. */
export type StopColorReader = (text: string) => { rgb: [number, number, number], alpha: number, cmyk?: Cmyk };

const cssStopColor: StopColorReader = (text) => parseCssColor(text);

/** What {@link cssGradient} answers: a shading, or the reason it must be a raster. */
export type GradientResult = {
  shading?: ShadingSpec;
  /** Set when the gradient is one PDF has no shading for. */
  raster?: { feature: string, reason: string };
};

/**
 * One CSS gradient, in the box it paints, as a PDF shading.
 *
 * @remarks
 * The gradient's own space is the container's pixel grid, so `/Coords` are pixel coordinates and the matrix that reaches the page is the same one every other box decoration uses — except for a radial gradient, whose space is the unit circle, because a Type 3 shading has one radius per circle and an ellipse has two.
 *
 * @throws {CasterError} From the stop colour reader, for a stop colour it cannot read.
 */
export function cssGradient(value: string, box: Box, toPage: Matrix, colorOf: StopColorReader = cssStopColor, colorSpace: 'DeviceRGB'|'DeviceCMYK' = 'DeviceRGB'): GradientResult {
  const call = functionCall(value);
  if (!call) return {};
  const name = call.name;
  if (name === 'conic-gradient' || name === 'repeating-conic-gradient') {
    return { raster: { feature: 'conic-gradient', reason: `${name}() has no PDF shading type; the box is rasterised` } };
  }
  if (!/^(repeating-)?(linear|radial)-gradient$/.test(name)) return {};

  const repeating = name.startsWith('repeating-');
  const radial = name.includes('radial');
  const args = splitTopLevel(call.body);
  const diagonal = Math.hypot(box.w, box.h);

  if (!radial) {
    const first = args[0] ?? '';
    let degrees = 180;
    let stopArgs = args;
    const angle = angleDegrees(first);
    if (angle !== null) {
      degrees = angle;
      stopArgs = args.slice(1);
    } else if (/^to\s+/i.test(first)) {
      degrees = cornerAngle(first.toLowerCase().split(/\s+/).slice(1), box.w, box.h);
      stopArgs = args.slice(1);
    }
    const radians = (degrees * Math.PI) / 180;
    // CSS measures clockwise from "to top"; the pixel grid has y downwards, so the direction vector is (sin θ, −cos θ).
    const dir: Point = [Math.sin(radians), -Math.cos(radians)];
    const lineLength = Math.abs(box.w * Math.sin(radians)) + Math.abs(box.h * Math.cos(radians));
    const centre: Point = [box.x + box.w / 2, box.y + box.h / 2];
    let start: Point = [centre[0] - (dir[0] * lineLength) / 2, centre[1] - (dir[1] * lineLength) / 2];
    let end: Point = [centre[0] + (dir[0] * lineLength) / 2, centre[1] + (dir[1] * lineLength) / 2];

    let stops = resolveStops(parseStops(stopArgs), lineLength, colorOf);
    let spread: 'pad'|'repeat' = 'pad';
    let periods = 1;
    if (repeating && stops.length > 1) {
      const span = stops[stops.length - 1].offset - stops[0].offset;
      // The gradient line already spans the box by construction, so one line's worth of parameter is the whole extent that has to be covered.
      const count = periodsFor(1, span);
      const unrolled = unrollGradient(stops, 'repeat', count);
      const vx = end[0] - start[0];
      const vy = end[1] - start[1];
      const origin: Point = [start[0], start[1]];
      start = [origin[0] + vx * unrolled.fromT, origin[1] + vy * unrolled.fromT];
      end = [origin[0] + vx * unrolled.toT, origin[1] + vy * unrolled.toT];
      stops = unrolled.stops;
      spread = 'repeat';
      periods = 2 * count + 1;
    }

    const coords = [start[0], start[1], end[0], end[1]];
    const [px0, py0] = apply(toPage, start[0], start[1]);
    const [px1, py1] = apply(toPage, end[0], end[1]);
    return {
      shading: {
        type: 2,
        coords,
        extend: [true, true],
        stops,
        colorSpace,
        matrix: toPage,
        coordsPt: [px0, py0, px1, py1],
        spread,
        periods,
        hasAlpha: stops.some((s) => s.alpha < 1),
        source: value,
      },
    };
  }

  // radial
  const head = args[0] ?? '';
  const looksLikeStop =
    parseCssColor.length >= 0 && /^(rgb|rgba|hsl|hsla|#|[a-z]+\s*$)/i.test(head) && !/\b(circle|ellipse|at|closest|farthest)\b/i.test(head);
  const stopArgs = looksLikeStop ? args : args.slice(1);
  const headTokens = looksLikeStop ? [] : head.split(/\s+/).filter((t) => t !== '' && !/^at$/i.test(t));
  const shape = headTokens.some((t) => /^circle$/i.test(t)) ? 'circle' : 'ellipse';
  const centre = radialCentre(head, box);
  const beforeAt = head.split(/\bat\b/i)[0] ?? '';
  const [rx, ry] = radialRadii(beforeAt.split(/\s+/).filter((t) => t !== ''), shape, centre, box);

  let stops = resolveStops(parseStops(stopArgs), Math.max(rx, ry), colorOf);
  let innerRadius = 0;
  let outerRadius = 1;
  let spread: 'pad'|'repeat' = 'pad';
  let periods = 1;
  if (repeating && stops.length > 1) {
    const span = stops[stops.length - 1].offset - stops[0].offset;
    const count = periodsFor(diagonal / Math.max(Math.max(rx, ry), 1e-6), span);
    const unrolled = unrollGradient(stops, 'repeat', count);
    stops = unrolled.stops;
    // A circle has no negative radius, so the inner end is clamped at zero and the periods that would have fallen inside it are simply not drawn.
    innerRadius = Math.max(0, unrolled.fromT);
    outerRadius = unrolled.toT;
    spread = 'repeat';
    periods = 2 * count + 1;
  }

  // The gradient's space is the unit circle; the ellipse is in the matrix.
  const space: Matrix = mul([rx, 0, 0, ry, centre[0], centre[1]], toPage);
  const [cxPt, cyPt] = apply(toPage, centre[0], centre[1]);
  return {
    shading: {
      type: 3,
      coords: [0, 0, innerRadius, 0, 0, outerRadius],
      extend: [true, true],
      stops,
      colorSpace,
      matrix: space,
      coordsPt: [cxPt, cyPt, 0, cxPt, cyPt, Math.max(rx, ry) * 0.75 * outerRadius],
      spread,
      periods,
      hasAlpha: stops.some((s) => s.alpha < 1),
      source: value,
    },
  };
}

// --- the collector ----------------------------------------------------------

/**
 * Whether the computed style puts any vector ink on the element's own box.
 *
 * @throws {CasterError} From `parseCssColor`, for a `background-color` it cannot read.
 */
export function paintsDecoration(style: CSSStyleDeclaration): boolean {
  if (parseCssColor(style.backgroundColor).alpha > 0) return true;
  if (style.backgroundImage !== 'none') return true;
  if (style.boxShadow !== 'none') return true;
  if (style.outlineStyle !== 'none' && px(style.outlineWidth) > 0) return true;
  const widths = borderWidths(style);
  const styles = [style.borderTopStyle, style.borderRightStyle, style.borderBottomStyle, style.borderLeftStyle];
  return widths.some((w, i) => w > 0 && styles[i] !== 'none' && styles[i] !== 'hidden');
}

/** The border styles this exporter draws exactly; everything else is solid plus a note. */
const SOLID_STYLES = new Set(['solid', 'none', 'hidden']);

/** What {@link collectCssBoxes} is handed: the decorated elements, and the paint order and CTM chains they are painted under. */
export type CssBoxOptions = {
  container: HTMLElement;
  order: PaintOrder;
  /** Every element whose decorations are to be painted, from the walker. */
  decorated: HTMLElement[];
  /** The chain builder of `coordinates-and-pages.md` (E10), open over the whole measurement pass. Every transformed HTML ancestor between the page element and a decorated box is neutralised inside it, so the rectangles read here are the untransformed ones the chain is expressed against, and the chain itself becomes the `cm` the box is painted under — the same `cm` `lineWrap` puts around the text in the same wrapper. */
  chains: ChainContext;
  /** E11 (`tables.md`): elements whose borders belong to a grid rather than to a box. Under `border-collapse: collapse` the border between two cells is one border resolved from up to six declarations and painted on the grid line, so every part of such a table — the table, its row groups, its rows and its cells — keeps its background and loses its four sides here; `tableBorders` paints what is actually there. Absent, nothing changes and every fixture before E11 is byte for byte what it was. */
  suppressBorders?: (element: HTMLElement) => boolean;
  /** E11 (`tables.md`): the box to paint an element's decoration on, when its own client rectangle is not it. A `<table>` generates two boxes — an anonymous wrapper holding the caption and the grid box holding the rows — and `getClientRects()` answers with the wrapper, so a table with a `<caption>` painted from its own rectangle gets its border drawn around the caption as well as around the table. That is visible in a side-by-side render and it is wrong: `caption-side` moves the caption, not the table's border. Absent, every element is painted on its own rectangles, which is every fixture before E11 unchanged. */
  rectsOf?: (element: HTMLElement) => DOMRect[] | null;
  /** E12b (`vector-painting.md`): draw `dashed`, `dotted`, `double`, `groove`, `ridge`, `inset` and `outset` the way Chromium draws them, instead of painting them solid and recording the difference. Off by default, and that is a decision rather than caution. E11's `border-collapse: separate` case declares `1px dotted` cell borders and its content stream is a recorded result; turning the emitter on for every fixture would repaint those cells and change a stream E11 signed off. So the styles are drawn where a fixture asks for them, and E11's dotted cells stay on the deferred list with a note saying why. */
  styledBorders?: boolean;
};

/**
 * Every decorated CSS box in the container, as vector requests.
 *
 * @remarks
 * One request per element per fragment. The owner is a Layout artifact of the element's own — a box decoration is never part of the reading order, and the structure walker has no element for something it never saw as content.
 *
 * @throws {CasterError} From `parseCssColor`, for a computed colour it cannot read, or from `cssShapePath`, for a `clip-path: path()` whose string `parsePath` refuses.
 */
export function collectCssBoxes(options: CssBoxOptions): CssBoxResult {
  const { container, order, decorated, chains } = options;
  const containerRect = container.getBoundingClientRect();
  const requests: VectorRequest[] = [];
  const artifacts: ArtifactDescriptor[] = [];
  const rasters: RasterSpec[] = [];
  const deferred: DeferredRecord[] = [];
  const borderStyles: StyledBorderRecord[] = [];

  for (const element of decorated) {
    const style = getComputedStyle(element);
    if (!paintsDecoration(style)) continue;
    const domPath = domPathOf(element, container);

    // The layout box is read inside the chain builder's neutralised window, so the rectangle is the box the transform was applied *to* rather than the axis-aligned box around the result — which is what E7 (`images.md`) arranges one rectangle at a time and what `beginChains` arranges for a whole subtree.
    const rects = (options.rectsOf?.(element) ?? [...element.getClientRects()]).filter((r) => r.width > 0 && r.height > 0);

    if (rects.length === 0) continue;

    rects.forEach((rect, fragment) => {
      const placement = placeBox(rect, containerRect, pageOfElement(element, chains));
      const page = placement.page;
      const border: Box = placement.box;
      const toPage = placement.toPage;
      // The element's own transform is the innermost link of its chain, so it is no longer folded into the path coordinates here: the whole chain becomes one `cm` and every path under it stays in the untransformed space the rectangles were read in.
      const chain = chains.chainOf(element);
      const chainCm = chain ? toPdfMatrix(chain.matrix, pageGeometryFor(page)) : null;
      const radii = radiiOf(style, border.w, border.h);
      const widths = borderWidths(style);
      const { box: padding, radii: paddingRadii } = insetBox(border, radii, widths[0], widths[1], widths[2], widths[3]);
      const { box: content, radii: contentRadii } = insetBox(
        padding,
        paddingRadii,
        px(style.paddingTop),
        px(style.paddingRight),
        px(style.paddingBottom),
        px(style.paddingLeft),
      );

      const children: VectorNode[] = [];
      // An ancestor's clip lives in the ancestor's own space, which is the element's space only as far as the chain they share. Mapping it through `chain(ancestor) · chain(element)⁻¹` puts it where emitting it under the element's `cm` reproduces the rectangle the engine clipped to; with no chain anywhere both matrices are the identity and the path is the one `vector-painting.md` (E9) always wrote.
      const clips = ancestorClips(element, container, containerRect, page, domPath, chains, chainCm);
      const own = ownClip(element, style, border, radii, toPage, domPath);
      if (own) clips.push(own);

      // 1. the shadow, which is behind everything the box paints
      if (style.boxShadow !== 'none') {
        const raster = shadowRaster(style, border, radii, toPage, domPath);
        if (raster) {
          rasters.push(raster);
          children.push({ ...emptyNodeCommon(domPath, 'box-shadow'), kind: 'raster', raster });
          deferred.push({ path: domPath, feature: 'box-shadow', paintedAs: `raster at ${RASTER_DPI} dpi` });
        } else if (parseBoxShadow(style.boxShadow)?.inset) {
          deferred.push({ path: domPath, feature: 'box-shadow: inset', paintedAs: 'nothing: an inner shadow is painted inside the padding box with the shape inverted, which is a drawing this exporter does not build' });
        }
      }

      // 2. and 3. the background colour and image, inside the background clip
      const clipName = style.backgroundClip;
      const backgroundBox = clipName === 'content-box' ? content : clipName === 'padding-box' ? padding : border;
      const backgroundRadii = clipName === 'content-box' ? contentRadii : clipName === 'padding-box' ? paddingRadii : radii;
      const backgroundPath = transformPath(roundedRectPath(backgroundBox, backgroundRadii), toPage);

      const backgroundColour = parseCssColor(style.backgroundColor);
      if (backgroundColour.alpha > 0) {
        children.push({
          ...emptyNodeCommon(domPath, 'background'),
          kind: 'path',
          path: backgroundPath,
          fill: { kind: 'rgb', rgb: backgroundColour.rgb },
          fillRule: 'nonzero',
          stroke: { kind: 'none' },
          strokeStyle: null,
          opacity: backgroundColour.alpha,
          strokeOpacity: 1,
          blend: 'Normal',
          clips: [],
        });
      }

      // The positioning area is the background-origin box; nothing here honours background-size, -position or -repeat, which the deferred list names.
      const originName = style.backgroundOrigin;
      const originBox = originName === 'border-box' ? border : originName === 'content-box' ? content : padding;
      const hint = readHint(element, '--pdf-background');
      const hinted = parseCmykGradientHint(hint, domPath);
      const gradientSource = hinted ? hinted.normalized : style.backgroundImage;
      if (gradientSource !== 'none' && gradientSource !== '') {
        // `background-image` is a list, and the list is split before anything looks for a function call: `functionCall`'s pattern anchors on the first `(` and the last `)`, so `linear-gradient(a, b), linear-gradient(c, d)` came back as one call whose body ran from `a` to `d` and whose stops parsed with whatever alpha the garbage produced — silently, because a stop this reader cannot parse is transparent rather than an error. Layers paint last to first (CSS Backgrounds 3 §3.10): the first layer is the one nearest the reader.
        const layers = splitTopLevel(gradientSource);
        const results = layers.map((layer) => (hinted ? cssGradient(layer, originBox, toPage, hinted.colorOf, 'DeviceCMYK') : cssGradient(layer, originBox, toPage)));
        const rasterised = results.find((result) => result.raster);
        if (rasterised && rasterised.raster) {
          // One raster for the element, not one per layer: the isolated document draws the whole background, every layer of it, in the browser's own order.
          const raster = elementRaster(element, style, border, toPage, rasterised.raster.feature, rasterised.raster.reason);
          rasters.push(raster);
          children.push({ ...emptyNodeCommon(domPath, 'background-image'), kind: 'raster', raster });
          deferred.push({ path: domPath, feature: rasterised.raster.feature, paintedAs: `raster at ${RASTER_DPI} dpi` });
        } else {
          for (let index = layers.length - 1; index >= 0; index--) {
            const result = results[index];
            if (result.shading) {
              children.push({
                ...emptyNodeCommon(domPath, layers.length > 1 ? `background-image[${index}]` : 'background-image'),
                kind: 'path',
                path: backgroundPath,
                fill: { kind: 'shading', shading: result.shading },
                fillRule: 'nonzero',
                stroke: { kind: 'none' },
                strokeStyle: null,
              });
              continue;
            }
            const name = functionCall(layers[index])?.name ?? layers[index];
            deferred.push({ path: domPath, feature: `background-image: ${name}`, paintedAs: 'nothing: only a gradient layer is painted as a vector' });
          }
        }
      }
      if (hint !== '' && !hinted) {
        deferred.push({ path: domPath, feature: '--pdf-background', paintedAs: 'ignored; the hint is not a device-cmyk() gradient' });
      }

      // 4. the four border sides
      // A `border-image` replaces all four of them with a picture, and nothing in this module's border model has room for one: `BorderSideInput.colour` is a single flat `{ rgb, alpha }` per side. So the sides fall through to `border-*-color`, which for the ordinary `border: 3px solid; border-image: linear-gradient(…) 1` is `currentColor` — the surrounding text colour, painted as a flat frame where the author wrote a gradient. Deferred by name, the same way an unpaintable `background-image` layer is a few lines above; painting one is a different drawing and a round of its own.
      if (style.borderImageSource !== 'none' && style.borderImageSource !== '') {
        deferred.push({ path: domPath, feature: `border-image: ${functionCall(style.borderImageSource)?.name ?? style.borderImageSource}`, paintedAs: 'the flat border-color' });
      }
      const gridBorders = options.suppressBorders?.(element) ?? false;
      const outerPieces = boundaryPieces(border, radii);
      const innerPieces = boundaryPieces(padding, paddingRadii);
      const sideStyles = [style.borderTopStyle, style.borderRightStyle, style.borderBottomStyle, style.borderLeftStyle];
      const sideColours = [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor];
      const sideNames = ['border-top', 'border-right', 'border-bottom', 'border-left'];
      // E12b (`vector-painting.md`): the non-solid sides, drawn rather than approximated. The module answers with the sides it took, and the loop below skips exactly those, so a box with one dashed side and three solid ones keeps E9's emission for the three.
      const styled =
        options.styledBorders && !gridBorders
          ? styledBorderNodes({
              domPath,
              border,
              radii,
              padding,
              paddingRadii,
              sides: (
                [0, 1, 2, 3].map((side) => ({
                  widthPx: widths[side],
                  style: sideStyles[side],
                  colour: parseCssColor(sideColours[side]),
                })) as Parameters<typeof styledBorderNodes>[0]['sides']
              ),
              toPage,
            })
          : null;
      if (styled) {
        children.push(...styled.nodes);
        borderStyles.push(...styled.records);
        deferred.push(...styled.deferred);
      }

      widths.forEach((width, side) => {
        if (gridBorders) return;
        if (styled?.handled.has((side as 0 | 1 | 2 | 3))) return;
        if (width <= 0 || sideStyles[side] === 'none' || sideStyles[side] === 'hidden') return;
        if (!SOLID_STYLES.has(sideStyles[side]) && !styled?.downgraded.has((side as 0 | 1 | 2 | 3))) {
          deferred.push({ path: domPath, feature: `border-${sideNames[side].slice(7)}-style: ${sideStyles[side]}`, paintedAs: 'solid' });
        }
        const colour = parseCssColor(sideColours[side]);
        if (colour.alpha === 0) return;
        children.push({
          ...emptyNodeCommon(domPath, sideNames[side]),
          kind: 'path',
          path: transformPath(borderSidePath(outerPieces, innerPieces, (side as 0 | 1 | 2 | 3)), toPage),
          fill: { kind: 'rgb', rgb: colour.rgb },
          fillRule: 'nonzero',
          stroke: { kind: 'none' },
          strokeStyle: null,
          opacity: colour.alpha,
        });
      });

      // 5. the outline, outside everything, offset by its own property
      const outlineWidth = px(style.outlineWidth);
      if (style.outlineStyle !== 'none' && outlineWidth > 0) {
        const offset = px(style.outlineOffset);
        const grow = offset + outlineWidth / 2;
        const outlineBox: Box = { x: border.x - grow, y: border.y - grow, w: border.w + 2 * grow, h: border.h + 2 * grow };
        const outlineRadii = (
          radii.map((r) => ([r[0] > 0 ? r[0] + grow : 0, r[1] > 0 ? r[1] + grow : 0] as Radius)) as Radii
        );
        const colour = parseCssColor(style.outlineColor);
        if (!SOLID_STYLES.has(style.outlineStyle)) {
          deferred.push({ path: domPath, feature: `outline-style: ${style.outlineStyle}`, paintedAs: 'solid' });
        }
        children.push({
          ...emptyNodeCommon(domPath, 'outline'),
          kind: 'path',
          path: transformPath(roundedRectPath(outlineBox, outlineRadii), toPage),
          fill: { kind: 'none' },
          fillRule: 'nonzero',
          stroke: { kind: 'rgb', rgb: colour.rgb },
          strokeStyle: {
            widthPt: outlineWidth * 0.75,
            cap: 0,
            join: 0,
            miterLimit: 10,
            dashPt: [],
            dashPhasePt: 0,
            nonScaling: false,
          },
          strokeOpacity: colour.alpha,
        });
      }

      if (children.length === 0) return;

      const opacity = Number.parseFloat(style.opacity);
      const blend = blendName(style.mixBlendMode);
      const bbox = bboxOf(children);
      const node: VectorNode =
        children.length === 1 && opacity >= 1 && blend === 'Normal'
          ? { ...children[0], clips: [...clips, ...children[0].clips], ...(chainCm ? { cm: chainCm } : {}) }
          : {
              ...emptyNodeCommon(domPath, 'box'),
              kind: 'group',
              children,
              clips,
              bboxPt: bbox,
              opacity: Number.isFinite(opacity) ? opacity : 1,
              blend,
              // Whenever the group is not fully opaque, and not only when it has more than one child. A `/ca` on a single child sets the non-stroking alpha alone, so `opacity: .5` on a box with an outline drew the outline opaque; and it replaces the child's own alpha rather than multiplying it, so `rgba(0,0,0,.5)` under `opacity: .5` painted at a half instead of a quarter. A transparency group composites once, which is what the property means.
              forceForm: (Number.isFinite(opacity) && opacity < 1) || blend !== 'Normal',
              formReason:
                blend !== 'Normal'
                  ? `mix-blend-mode: ${style.mixBlendMode} makes the box a transparency group`
                  : `opacity ${style.opacity} over ${children.length} painting children`,
              ...(chainCm ? { cm: chainCm } : {}),
            };

      const artifactPath = `artifact:paint:${domPath}${rects.length > 1 ? `#${fragment}` : ''}`;
      artifacts.push({ path: artifactPath, kind: 'layout', type: 'Layout' });
      requests.push({
        owner: artifactPath,
        element,
        domPath,
        paintIndex: order.decoration.get(element) ?? Number.MAX_SAFE_INTEGER,
        page,
        node,
      });
    });
  }

  return { requests, artifacts, rasters, deferred, borderStyles };
}

/** The union of every child's bounds, which is what a form XObject's `/BBox` has to be. */
export function bboxOf(children: VectorNode[]): [number,number,number,number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const see = (box: Box) => {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.w);
    maxY = Math.max(maxY, box.y + box.h);
  };
  const visit = (node: VectorNode) => {
    if (node.kind === 'path') {
      const bounds = pathBounds(node.path);
      const grow = node.strokeStyle ? node.strokeStyle.widthPt : 0;
      see({ x: bounds.x - grow, y: bounds.y - grow, w: bounds.w + 2 * grow, h: bounds.h + 2 * grow });
    } else if (node.kind === 'raster') {
      const [x, y, w, h] = node.raster.rectPt;
      see({ x, y, w, h });
    } else if (node.kind === 'form') {
      // A form's content is in the form's own space, so its bounds outside it are the four corners of its /BBox under its placement matrix.
      const [llx, lly, urx, ury] = node.bboxPt;
      const corners = [
        apply(node.matrix, llx, lly),
        apply(node.matrix, urx, lly),
        apply(node.matrix, urx, ury),
        apply(node.matrix, llx, ury),
      ];
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      see({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
    } else for (const child of node.children) visit(child);
  };
  for (const child of children) visit(child);
  if (!Number.isFinite(minX)) return [0, 0, 0, 0];
  return [minX, minY, maxX, maxY];
}

/** The element's own `clip-path` and, when it hides its overflow, its padding box. */
function ownClip(element: Element, style: CSSStyleDeclaration, border: Box, radii: Radii, toPage: Matrix, domPath: string): ClipSpec|null {
  const shape = cssShapePath(style.clipPath, border);
  if (shape) {
    return { path: transformPath(shape.path, toPage), evenOdd: shape.evenOdd, reason: `clip-path: ${style.clipPath} on ${domPath}` };
  }
  return null;
}

/**
 * Every clip an ancestor imposes on the element, outermost first.
 *
 * @remarks
 * `overflow: hidden` clips to the padding box, rounded when the ancestor has radii, which is the rule CSS Overflow 3 states and is what makes a child inside a rounded card stop at the curve rather than at the corner.
 */
function ancestorClips(element: Element, container: HTMLElement, containerRect: DOMRect, page: number, domPath: string, chains: ChainContext, chainCm: Matrix|null): ClipSpec[] {
  const clips: ClipSpec[] = [];
  const intoElementSpace = chainCm ? invert(chainCm) : IDENTITY;
  for (let node = element.parentElement; node && node !== container.parentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    const placement = placeBox(rect, containerRect, page);
    const box: Box = placement.box;
    const ancestorChain = chains.chainOf(node);
    const ancestorCm = ancestorChain ? toPdfMatrix(ancestorChain.matrix, pageGeometryFor(page)) : null;
    const toPage = ancestorCm || chainCm ? mul(mul(placement.toPage, ancestorCm ?? IDENTITY), intoElementSpace) : placement.toPage;
    const radii = radiiOf(style, box.w, box.h);
    const widths = borderWidths(style);
    const shape = cssShapePath(style.clipPath, box);
    if (shape) {
      clips.unshift({
        path: transformPath(shape.path, toPage),
        evenOdd: shape.evenOdd,
        reason: `clip-path on ${domPathOf(node, container)}, inherited by ${domPath}`,
      });
    }
    if (style.overflow === 'hidden' || style.overflowX === 'hidden' || style.overflowY === 'hidden') {
      const inner = insetBox(box, radii, widths[0], widths[1], widths[2], widths[3]);
      clips.unshift({
        path: transformPath(roundedRectPath(inner.box, inner.radii), toPage),
        evenOdd: false,
        reason: `overflow: hidden on ${domPathOf(node, container)}`,
      });
    }
    if (node === container) break;
  }
  return clips;
}

/** `<rect>` for the shadow, blurred and offset, as an isolated SVG document. */
function shadowRaster(style: CSSStyleDeclaration, border: Box, radii: Radii, toPage: Matrix, domPath: string): RasterSpec|null {
  const shadow = parseBoxShadow(style.boxShadow);
  if (!shadow) return null;
  // An inner shadow is a different drawing, not this one offset, and the caller says so by name rather than pretending a raster was drawn.
  if (shadow.inset) return null;
  const pad = shadow.blur + shadow.spread + Math.max(Math.abs(shadow.dx), Math.abs(shadow.dy)) + 4;
  const area: Box = { x: border.x - pad, y: border.y - pad, w: border.w + 2 * pad, h: border.h + 2 * pad };
  const local: Box = { x: pad + shadow.dx - shadow.spread, y: pad + shadow.dy - shadow.spread, w: border.w + 2 * shadow.spread, h: border.h + 2 * shadow.spread };
  // A spread grows every corner radius by the same amount, floored at zero (CSS Backgrounds 3 §7.1.1).
  const grown = (radii.map((r) => ([Math.max(0, r[0] + shadow.spread), Math.max(0, r[1] + shadow.spread)] as Radius)) as Radii);
  const d = pathToSvg(roundedRectPath(local, grown));
  // A CSS blur radius is twice the Gaussian standard deviation, which is the one number that has to be right for a shadow to be the same shadow.
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${area.w}" height="${area.h}" viewBox="0 0 ${area.w} ${area.h}">`,
    `<filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${shadow.blur / 2}"/></filter>`,
    `<path d="${d}" fill="${shadow.color}" filter="url(#b)"/>`,
    '</svg>',
  ].join('');
  const corners: Point[] = [
    apply(toPage, area.x, area.y),
    apply(toPage, area.x + area.w, area.y),
    apply(toPage, area.x + area.w, area.y + area.h),
    apply(toPage, area.x, area.y + area.h),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const rectPt: [number,number,number,number] = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
  return {
    feature: 'box-shadow',
    reason: `box-shadow ${style.boxShadow} on ${domPath}: a blur PDF has no operator for`,
    svg,
    rectPt,
    dpi: RASTER_DPI,
    cm: [rectPt[2], 0, 0, rectPt[3], rectPt[0], rectPt[1]],
  };
}

/** Whatever cannot be painted as vector, drawn from the element's own markup. */
function elementRaster(element: Element, style: CSSStyleDeclaration, border: Box, toPage: Matrix, feature: string, reason: string): RasterSpec {
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${border.w}" height="${border.h}" viewBox="0 0 ${border.w} ${border.h}">`,
    `<foreignObject width="${border.w}" height="${border.h}">`,
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${border.w}px;height:${border.h}px;background-image:${style.backgroundImage}"></div>`,
    '</foreignObject></svg>',
  ].join('');
  const corners: Point[] = [
    apply(toPage, border.x, border.y),
    apply(toPage, border.x + border.w, border.y),
    apply(toPage, border.x + border.w, border.y + border.h),
    apply(toPage, border.x, border.y + border.h),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const rectPt: [number,number,number,number] = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
  return {
    feature,
    reason,
    svg,
    rectPt,
    dpi: RASTER_DPI,
    cm: [rectPt[2], 0, 0, rectPt[3], rectPt[0], rectPt[1]],
  };
}

/**
 * The first `box-shadow` layer, which is the only one the MVP paints.
 *
 * @remarks
 * `inset` is read rather than drawn. An inner shadow is not the outer one moved: it is painted inside the padding box, clipped to it, with the shape inverted, and an isolated SVG that drew it would be a second implementation of the geometry rather than the same one offset. So the keyword comes back on the record and the caller defers by name, which is the difference between a deferral that says what is missing and one that claims a raster nobody drew.
 *
 * `spread` grows the shadow's own shape on every side before the blur, and every radius with it (CSS Backgrounds 3 §7.1.1: a spread grows a corner radius by the same amount, floored at zero). It was parsed and then used only to pad the raster's canvas, so a `0 0 8px 4px` shadow was drawn four pixels too small in each direction.
 */
export function parseBoxShadow(value: string): { color: string; dx: number; dy: number; blur: number; spread: number; inset: boolean; }|null {
  if (value === 'none') return null;
  const layer = splitTopLevel(value)[0];
  const colourMatch = /(rgba?\([^)]*\)|#[0-9a-f]{3,8})/i.exec(layer);
  const color = colourMatch ? colourMatch[1] : 'rgba(0, 0, 0, 0.4)';
  const rest = layer.replace(colourMatch?.[1] ?? '', '');
  const inset = /(^|\s)inset(\s|$)/i.test(rest);
  const lengths = rest.match(/-?[\d.]+px/g)?.map(px) ?? [];
  if (lengths.length < 2) return null;
  return { color, dx: lengths[0], dy: lengths[1], blur: lengths[2] ?? 0, spread: lengths[3] ?? 0, inset };
}

/** A path as an SVG `d` attribute, for the isolated documents the raster path draws. */
export function pathToSvg(path: Path): string {
  const out: string[] = [];
  for (const segment of path) {
    if (segment.op === 'm') out.push(`M${segment.to[0]} ${segment.to[1]}`);
    else if (segment.op === 'l') out.push(`L${segment.to[0]} ${segment.to[1]}`);
    else if (segment.op === 'c') {
      out.push(`C${segment.c1[0]} ${segment.c1[1]} ${segment.c2[0]} ${segment.c2[1]} ${segment.to[0]} ${segment.to[1]}`);
    } else out.push('Z');
  }
  return out.join(' ');
}

// --- text decorations -------------------------------------------------------

/** What one element's `text-decoration-*` shorthand resolved to. */
export type TextDecoration = {
  lines: ('underline' | 'overline' | 'line-through')[];
  /** `text-decoration-color`, as PDF `rg` operands. */
  rgb: [number, number, number];
  /** The computed colour the components came from. */
  css: string;
  /** `text-decoration-thickness`, in px; null means `auto`, i.e. the font's. */
  thicknessPx: number | null;
  /** `text-underline-offset`, in px; null means `auto`. */
  offsetPx: number | null;
  /** `text-decoration-skip-ink` is on. This function paints the line continuous and says so; `vectors/skipInk.js` is what cuts it, in a second pass the composition runs over the finished records when the `skipInk` flag is on. */
  skipInk: boolean;
  /** A key runs split on: two runs with different decorations are two runs. */
  key: string;
};

/**
 * The decoration one element's text is painted with, propagation included.
 *
 * @remarks
 * `text-decoration` does not inherit, it *propagates*: the line is drawn across every descendant of the box that declared it, and `getComputedStyle` on the descendant says `none` while the line is plainly there. So the answer is assembled by walking up rather than read off one element, and the nearest ancestor that declared a line owns the colour, the thickness and the offset.
 *
 * @throws {CasterError} From `parseCssColor`, for a `text-decoration-color` it cannot read.
 */
export function decorationOf(element: Element, container: Element): TextDecoration|null {
  const lines: Set<'underline'|'overline'|'line-through'> = new Set<any>();
  let source: CSSStyleDeclaration|null = null;
  for (let node = (element as Element | null); node && node !== container.parentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    const declared = style.textDecorationLine;
    if (declared && declared !== 'none') {
      for (const word of declared.split(/\s+/)) {
        if (word === 'underline' || word === 'overline' || word === 'line-through') lines.add(word);
      }
      if (!source) source = style;
    }
    if (node === container) break;
  }
  if (lines.size === 0 || !source) return null;
  const order: ('underline'|'overline'|'line-through')[] = ['underline', 'overline', 'line-through'];
  const colour = parseCssColor(source.textDecorationColor);
  const thickness = source.textDecorationThickness;
  const offset = source.textUnderlineOffset;
  const decoration: TextDecoration = {
    lines: order.filter((line) => lines.has(line)),
    rgb: colour.rgb,
    css: source.textDecorationColor,
    thicknessPx: thickness === 'auto' || thickness === '' ? null : px(thickness),
    offsetPx: offset === 'auto' || offset === '' ? null : px(offset),
    skipInk: (source.getPropertyValue('text-decoration-skip-ink') || 'auto') !== 'none',
    key: '',
  };
  decoration.key = [decoration.lines.join('+'), decoration.css, decoration.thicknessPx, decoration.offsetPx].join('|');
  return decoration;
}

/** The face metrics a decoration is positioned from, in font units. */
export type DecorationMetrics = {
  upem: number;
  /** `post.underlinePosition`: the top of the underline below the baseline, so negative. */
  underlinePosition: number;
  underlineThickness: number;
  ascent: number;
  xHeight: number;
};

/** One decoration rectangle, with the numbers the node checker reads back. */
export type DecorationRecord = {
  path: string;
  line: 'underline' | 'overline' | 'line-through';
  page: number;
  /** The rectangle in page points, `[x y w h]`. */
  rectPt: [number, number, number, number];
  thicknessPt: number;
  /** The face's own numbers, before any CSS override. */
  fontUnits: { position: number, thickness: number, upem: number };
  /** Whether CSS overrode the position, the thickness, or neither. */
  source: string;
  rgb: [number, number, number];
  skipInkIgnored: boolean;
};

/** What {@link textDecorationVectors} answers. */
export type DecorationResult = {
  requests: VectorRequest[];
  artifacts: ArtifactDescriptor[];
  records: DecorationRecord[];
  deferred: DeferredRecord[];
};

/**
 * Underlines, overlines and strike-throughs as filled rectangles.
 *
 * @remarks
 * The underline's position and thickness come from the face's `post` table scaled to the run's size, and a line-through's centre sits a third of the face's ascent above the baseline, which is what Chromium does for both positions. `text-underline-offset` and `text-decoration-thickness` override them where the author set them; the `auto` thickness stays the face's own, where Chromium's is a tenth of the font size (E9's rule, kept; `vectors/skipInk.js` names the gap). The line is painted continuous here and the request for `text-decoration-skip-ink` is recorded rather than answered, because skipping ink needs the glyph outlines and E9 (`vector-painting.md`) had the advances. E12F (`structure-tree.md`) has the outlines: `vectors/skipInk.js` takes these records back, cuts the underlines against the intercepts, and the composition replaces the path of every request it recognises — so a caller that runs that pass clears the deferral this one wrote, and a caller that does not keeps E9's file exactly.
 */
export function textDecorationVectors(lines: readonly { page: number; baselinePx: number; paragraph: number; chain?: Matrix; runs: readonly TextRunForDecoration[]; }[], paragraphs: readonly { domIndex: number; element: string; }[], paintIndexOfParagraph: (paragraph: number) => number, metricsOf: (instanceKey: string) => DecorationMetrics): DecorationResult {
  const out: DecorationResult = { requests: [], artifacts: [], records: [], deferred: [] };
  let counter = 0;

  for (const line of lines) {
    for (const run of line.runs) {
      const decoration = run.decoration;
      if (!decoration || !run.element) continue;
      const metrics = metricsOf(run.instanceKey);
      const scale = run.sizePx / metrics.upem;
      const left = Math.min(...run.segments.map((s) => s.xPx));
      const right = Math.max(...run.segments.map((s) => s.rightPx));
      // A measured segment's `xPx` is already relative to its own page, so the matrix here is the page's own pixel-to-point map and never the column-subtracting one: that would take the column offset off a second time and put every underline off the page. Per page rather than the constant of `text-emission.md` (E3), because a document may mix page sizes and a decoration on a landscape page flips y against that page's height.
      const geometry = pageGeometryFor(line.page);
      const toPage: Matrix = [PX_TO_PT, 0, 0, -PX_TO_PT, geometry.marginPt, geometry.heightPt - geometry.marginPt];

      for (const kind of decoration.lines) {
        const autoThickness = metrics.underlineThickness * scale;
        const thicknessPx = decoration.thicknessPx ?? autoThickness;
        let topPx: number;
        let source: string;
        if (kind === 'underline') {
          const autoTop = line.baselinePx - metrics.underlinePosition * scale;
          topPx = decoration.offsetPx === null ? autoTop : line.baselinePx + decoration.offsetPx;
          source = decoration.offsetPx === null ? 'post.underlinePosition' : 'text-underline-offset';
        } else if (kind === 'overline') {
          topPx = line.baselinePx - metrics.ascent * scale;
          source = 'hhea.ascent';
        } else {
          // Blink's rule (`ComputeLineThroughLineData` in `core/paint/text_decoration_info.cc`): the line's top is two thirds of the ascent below the text's top, less half the thickness, so its centre sits a third of the ascent above the baseline. Measured in the pinned Chromium at 100 px: 32, 34 and 30 px for Crimson Text, JetBrains Mono and Crimson Pro, a third of each face's ascent to the pixel (*the pixel reader*, DESIGN.md S95).
          // ponytail: Blink takes the ascent from the decorating box's font and the text top from the run's own; one face for both here, which is every specimen case.
          topPx = line.baselinePx - (metrics.ascent * scale) / 3 - thicknessPx / 2;
          source = 'a third of hhea.ascent';
        }
        if (decoration.thicknessPx !== null) source += ' with text-decoration-thickness';

        const box: Box = { x: left, y: topPx, w: right - left, h: thicknessPx };
        const path = transformPath(roundedRectPath(box), toPage);
        const bounds = pathBounds(path);
        const domPath = paragraphs[line.paragraph]?.element ?? '';
        const artifactPath = `artifact:decoration:${domPath}#${counter++}`;
        out.artifacts.push({ path: artifactPath, kind: 'layout', type: 'Layout' });
        out.requests.push({
          owner: artifactPath,
          element: (run.element as Element),
          domPath,
          // Half a step after the text it decorates, so the line goes on top.
          paintIndex: paintIndexOfParagraph(line.paragraph) + 0.5,
          page: line.page,
          node: {
            ...emptyNodeCommon(domPath, `decoration:${kind}`),
            kind: 'path',
            path,
            fill: { kind: 'rgb', rgb: decoration.rgb },
            fillRule: 'nonzero',
            stroke: { kind: 'none' },
            strokeStyle: null,
            // A decoration is measured in the same neutralised space its run is, so it carries the same chain the run's line carries.
            ...(line.chain ? { cm: toPdfMatrix(line.chain, geometry) } : {}),
          },
        });
        out.records.push({
          path: artifactPath,
          line: kind,
          page: line.page,
          rectPt: [bounds.x, bounds.y, bounds.w, bounds.h],
          thicknessPt: bounds.h,
          fontUnits: { position: metrics.underlinePosition, thickness: metrics.underlineThickness, upem: metrics.upem },
          source,
          rgb: decoration.rgb,
          skipInkIgnored: decoration.skipInk,
        });
        if (decoration.skipInk) {
          out.deferred.push({
            path: domPath,
            feature: 'text-decoration-skip-ink',
            paintedAs: 'a continuous line; skipping needs the glyph outlines, which is `skipInk.js`\'s pass rather than this one',
          });
        }
      }
    }
  }
  return out;
}

/** The half of a measured run a decoration needs; `textMeasure` satisfies it. */
export type TextRunForDecoration = {
  instanceKey: string;
  sizePx: number;
  /** Absent only for a run whose caller never asked for decorations. */
  element?: Element;
  decoration?: TextDecoration;
  segments: readonly { xPx: number, rightPx: number }[];
};
