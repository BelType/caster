/**
 * `vectors/pathData.js` — the geometry of `vector-painting.md` (E9): everything that has to become a PDF path before anything can be painted.
 *
 * Ported from `harness/src/export/pathData.ts` (E9, E12B, E12C). Guide: `docs/guide/vector-painting.md` — the kappa, the radius clamping algorithm, and the `d` grammar.
 *
 * WHAT THE PORT CHANGED. The port records no change here beyond the language.
 *
 * The harness's own header follows.
 *
 * The geometry of `vector-painting.md` (E9): everything that has to become a PDF path before anything can be painted.
 *
 * PDF has four path operators — `m`, `l`, `c` and `h` — and nothing else. SVG has twenty commands, CSS has four basic shapes and a radius algorithm, and every one of them has to arrive here as a list of those four. So this module is a converter and only a converter: it parses, it flattens relative commands to absolute ones, it turns quadratics into cubics and elliptical arcs into cubics, and it maps a path through a matrix. It reads no DOM, it holds no state, and it decides nothing about colour, order or tagging.
 *
 * Two conventions hold throughout. A `Point` is a pair in whatever space the caller is working in, and the caller says which by handing in the matrix that leaves it; nothing here knows whether y runs up or down. And a path is always a flat list, never a tree: a subpath boundary is an `m`, and a closed subpath ends in an `h`, which is exactly what a `W n` clip and an `f*` fill need in order to mean what the author wrote.
 *
 * @packageDocumentation
 */
import { apply } from '../coordinates/matrix.ts';
import { CasterError } from '../errors.ts';

import type { Matrix, PathSegment } from '../images/imagePlace.ts';

/** A pair in whatever space the caller is working in. */
export type Point = [number, number];

/** A path as a flat list of segments: a subpath begins at an `m` and a closed one ends in an `h`. */
export type Path = PathSegment[];

/**
 * The kappa that makes four cubic Béziers a circle to within a thousandth of a radius.
 *
 * @remarks
 * The same constant `imagePlace` rounds its image clips with, restated here rather than imported so a change to one is never silently a change to the other.
 */
export const KAPPA = 0.5523;

/** One corner's two radii, in the order CSS writes them. */
export type Radius = [number, number];

/** Four corners, clockwise from the top left, as PDF space walks a box. */
export type Radii = [Radius, Radius, Radius, Radius];

/** Four square corners. */
export const ZERO_RADII: Radii = [
  [0, 0],
  [0, 0],
  [0, 0],
  [0, 0],
];

/** A rectangle in whatever space the caller is working in, y increasing downward. */
export type Box = {
  x: number;
  y: number;
  w: number;
  h: number;
};

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * The CSS radius clamping algorithm, CSS Backgrounds 3 §5.5.
 *
 * @remarks
 * Every side gets a ratio of its length to the sum of the two radii that meet it; the smallest ratio below one scales *every* radius, both axes of it, so the corners stay the shape the author asked for and merely get smaller. That "one factor for all eight numbers" is the part an implementation gets wrong by clamping per side, and it is why `border-radius: 200px` on a 100×60 box comes out as 50×30 corners rather than as 50×50 ones.
 */
export function clampRadii(radii: Radii, w: number, h: number): Radii {
  const [tl, tr, br, bl] = radii;
  const ratios = [w / (tl[0] + tr[0]), w / (bl[0] + br[0]), h / (tl[1] + bl[1]), h / (tr[1] + br[1])].filter((r) =>
    Number.isFinite(r),
  );
  const f = Math.min(1, ...ratios);
  if (f >= 1) return radii;
  return (radii.map((r) => ([r[0] * f, r[1] * f] as Radius)) as Radii);
}

/**
 * A rectangle, or a rounded one, as a path.
 *
 * @remarks
 * The corners are elliptical: each is one cubic whose control points are the corner's own two radii pulled in by kappa, so an `rx` that differs from its `ry` comes out as the quarter-ellipse CSS and SVG both specify rather than as a circle scaled after the fact.
 */
export function roundedRectPath(box: Box, radii: Radii = ZERO_RADII): Path {
  const { x, y, w, h } = box;
  const [tl, tr, br, bl] = radii;
  if (radii.every((r) => r[0] <= 0 && r[1] <= 0)) {
    return [
      { op: 'm', to: [x, y] },
      { op: 'l', to: [x + w, y] },
      { op: 'l', to: [x + w, y + h] },
      { op: 'l', to: [x, y + h] },
      { op: 'h' },
    ];
  }
  const k = KAPPA;
  return [
    { op: 'm', to: [x + tl[0], y] },
    { op: 'l', to: [x + w - tr[0], y] },
    { op: 'c', c1: [x + w - tr[0] + tr[0] * k, y], c2: [x + w, y + tr[1] - tr[1] * k], to: [x + w, y + tr[1]] },
    { op: 'l', to: [x + w, y + h - br[1]] },
    { op: 'c', c1: [x + w, y + h - br[1] + br[1] * k], c2: [x + w - br[0] + br[0] * k, y + h], to: [x + w - br[0], y + h] },
    { op: 'l', to: [x + bl[0], y + h] },
    { op: 'c', c1: [x + bl[0] - bl[0] * k, y + h], c2: [x, y + h - bl[1] + bl[1] * k], to: [x, y + h - bl[1]] },
    { op: 'l', to: [x, y + tl[1]] },
    { op: 'c', c1: [x, y + tl[1] - tl[1] * k], c2: [x + tl[0] - tl[0] * k, y], to: [x + tl[0], y] },
    { op: 'h' },
  ];
}

/** An ellipse as four cubics, which is the only circle a PDF has. */
export function ellipsePath(cx: number, cy: number, rx: number, ry: number): Path {
  const k = KAPPA;
  return [
    { op: 'm', to: [cx + rx, cy] },
    { op: 'c', c1: [cx + rx, cy + ry * k], c2: [cx + rx * k, cy + ry], to: [cx, cy + ry] },
    { op: 'c', c1: [cx - rx * k, cy + ry], c2: [cx - rx, cy + ry * k], to: [cx - rx, cy] },
    { op: 'c', c1: [cx - rx, cy - ry * k], c2: [cx - rx * k, cy - ry], to: [cx, cy - ry] },
    { op: 'c', c1: [cx + rx * k, cy - ry], c2: [cx + rx, cy - ry * k], to: [cx + rx, cy] },
    { op: 'h' },
  ];
}

/** Map every point of a path through a matrix, control points included, which is what makes it exact. */
export function transformPath(path: Path, m: Matrix): Path {
  const at = (p: Point): Point => (apply(m, p[0], p[1]).map(round4) as Point);
  return path.map((segment) => {
    if (segment.op === 'm') return ({ op: 'm', to: at(segment.to) } as PathSegment);
    if (segment.op === 'l') return ({ op: 'l', to: at(segment.to) } as PathSegment);
    if (segment.op === 'c') return ({ op: 'c', c1: at(segment.c1), c2: at(segment.c2), to: at(segment.to) } as PathSegment);
    return ({ op: 'h' } as PathSegment);
  });
}

/**
 * The axis-aligned box around a path's anchor and control points.
 *
 * @remarks
 * Control points, not the curve: the hull is what a clip, a raster canvas and a `/BBox` all have to contain, and a hull that is a hair too large costs a hair of canvas while a tight box that is wrong loses ink.
 */
export function pathBounds(path: Path): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const see = (p: Point) => {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  };
  for (const segment of path) {
    if (segment.op === 'm' || segment.op === 'l') see(segment.to);
    else if (segment.op === 'c') {
      see(segment.c1);
      see(segment.c2);
      see(segment.to);
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// --- the `d` attribute ------------------------------------------------------

/**
 * Numbers and command letters of a `d` attribute, in order.
 *
 * @remarks
 * The arc command's two flags are the one place the grammar is not "a number is a number". SVG 1.1's `flag` production is a single character, `0` or `1`, and it may be written with no separator after it — so `A10 10 0 0110 10` is a legal arc with `large-arc-flag 0`, `sweep-flag 1`, and an endpoint at `(10, 10)`. A tokenizer that read the longest number saw `0110` and produced an arc with the wrong flags and one argument too few, which is a shape minified icon sets emit constantly. The split is done here because only the tokenizer knows it is looking at argument three or four of an `A`.
 */
function tokenize(d: string): (string|number)[] {
  const tokens: (string|number)[] = [];
  const pattern = /([MmZzLlHhVvCcSsQqTtAa])|([+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?)/g;
  let command = '';
  let argument = 0;
  for (const match of d.matchAll(pattern)) {
    if (match[1]) { command = match[1]; argument = 0; tokens.push(command); continue; }
    let text = (match[2] as string);
    while (command.toUpperCase() === 'A' && (argument % 7 === 3 || argument % 7 === 4) && text.length > 1 && (text[0] === '0' || text[0] === '1')) {
      tokens.push(Number(text[0]));
      argument += 1;
      text = text.slice(1);
    }
    if (text === '') continue;
    tokens.push(Number(text));
    argument += 1;
  }
  return tokens;
}

/**
 * One elliptical arc as up to four cubic Béziers.
 *
 * @remarks
 * The implementation is the endpoint-to-centre conversion of SVG 1.1 Appendix F.6 followed by the usual quarter-at-a-time Bézier approximation. Two of its clauses are corrections rather than conveniences and are the reason an arc cannot be waved through: a radius pair too small to span the endpoints is scaled up until it can (F.6.6), and an arc whose endpoints coincide is not an arc at all and contributes nothing.
 */
function arcToCubics(from: Point, rx: number, ry: number, rotationDeg: number, largeArc: boolean, sweep: boolean, to: Point): PathSegment[] {
  if (from[0] === to[0] && from[1] === to[1]) return [];
  if (rx === 0 || ry === 0) return [{ op: 'l', to }];

  let absRx = Math.abs(rx);
  let absRy = Math.abs(ry);
  const phi = (rotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx2 = (from[0] - to[0]) / 2;
  const dy2 = (from[1] - to[1]) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  // F.6.6: an out-of-range radius pair is scaled until the arc exists.
  const lambda = (x1p * x1p) / (absRx * absRx) + (y1p * y1p) / (absRy * absRy);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    absRx *= scale;
    absRy *= scale;
  }

  const sign = largeArc === sweep ? -1 : 1;
  const numerator = absRx * absRx * absRy * absRy - absRx * absRx * y1p * y1p - absRy * absRy * x1p * x1p;
  const denominator = absRx * absRx * y1p * y1p + absRy * absRy * x1p * x1p;
  const coefficient = sign * Math.sqrt(Math.max(0, numerator) / denominator);
  const cxp = (coefficient * absRx * y1p) / absRy;
  const cyp = (-coefficient * absRy * x1p) / absRx;
  const cx = cosPhi * cxp - sinPhi * cyp + (from[0] + to[0]) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (from[1] + to[1]) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const length = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
    const value = Math.acos(Math.min(1, Math.max(-1, dot / length)));
    return ux * vy - uy * vx < 0 ? -value : value;
  };
  const startAngle = angle(1, 0, (x1p - cxp) / absRx, (y1p - cyp) / absRy);
  let sweepAngle = angle((x1p - cxp) / absRx, (y1p - cyp) / absRy, (-x1p - cxp) / absRx, (-y1p - cyp) / absRy);
  if (!sweep && sweepAngle > 0) sweepAngle -= 2 * Math.PI;
  if (sweep && sweepAngle < 0) sweepAngle += 2 * Math.PI;

  const pieces = Math.max(1, Math.ceil(Math.abs(sweepAngle) / (Math.PI / 2)));
  const delta = sweepAngle / pieces;
  const alpha = (4 / 3) * Math.tan(delta / 4);

  const onArc = (theta: number): Point => [
    cx + absRx * Math.cos(theta) * cosPhi - absRy * Math.sin(theta) * sinPhi,
    cy + absRx * Math.cos(theta) * sinPhi + absRy * Math.sin(theta) * cosPhi,
  ];
  const tangent = (theta: number): Point => [
    -absRx * Math.sin(theta) * cosPhi - absRy * Math.cos(theta) * sinPhi,
    -absRx * Math.sin(theta) * sinPhi + absRy * Math.cos(theta) * cosPhi,
  ];

  const out: PathSegment[] = [];
  for (let i = 0; i < pieces; i++) {
    const t0 = startAngle + i * delta;
    const t1 = t0 + delta;
    const p0 = onArc(t0);
    const p1 = onArc(t1);
    const d0 = tangent(t0);
    const d1 = tangent(t1);
    out.push({
      op: 'c',
      c1: [p0[0] + alpha * d0[0], p0[1] + alpha * d0[1]],
      c2: [p1[0] - alpha * d1[0], p1[1] - alpha * d1[1]],
      to: i === pieces - 1 ? to : p1,
    });
  }
  return out;
}

/**
 * An SVG `d` attribute as absolute moves, lines, cubics and closes.
 *
 * @remarks
 * Everything else is expanded here rather than carried: `H`/`V` become lines, `Q`/`T` become cubics through the degree-elevation formula, `S`/`T` reflect the previous control point, and `A` goes through the arc conversion above. A command letter this grammar has never met is an error naming the letter, because a path that silently lost a segment is a shape the page never had.
 *
 * @throws {CasterError} The path starts with a number, ends inside a command, or names a command letter SVG does not have.
 */
export function parsePath(d: string): Path {
  const tokens = tokenize(d);
  const out: PathSegment[] = [];
  let index = 0;
  let current: Point = [0, 0];
  let start: Point = [0, 0];
  let lastCubicControl: Point|null = null;
  let lastQuadControl: Point|null = null;
  let command = '';

  const number = (): number => {
    const value = tokens[index++];
    if (typeof value !== 'number') throw new CasterError(`pathData: ${JSON.stringify(d)} ends in the middle of a ${command} command`);
    return value;
  };

  while (index < tokens.length) {
    const token = tokens[index];
    if (typeof token === 'string') {
      command = token;
      index += 1;
    } else if (command === 'M') command = 'L';
    else if (command === 'm') command = 'l';
    else if (command === '') throw new CasterError(`pathData: ${JSON.stringify(d)} starts with a number rather than a command`);

    const relative = command === command.toLowerCase();
    const base: Point = relative ? current : [0, 0];
    const upper = command.toUpperCase();

    if (upper === 'Z') {
      out.push({ op: 'h' });
      current = start;
      lastCubicControl = null;
      lastQuadControl = null;
      continue;
    }

    if (upper === 'M') {
      const to: Point = [base[0] + number(), base[1] + number()];
      out.push({ op: 'm', to });
      current = to;
      start = to;
      lastCubicControl = null;
      lastQuadControl = null;
      continue;
    }

    if (upper === 'L') {
      const to: Point = [base[0] + number(), base[1] + number()];
      out.push({ op: 'l', to });
      current = to;
      lastCubicControl = null;
      lastQuadControl = null;
      continue;
    }

    if (upper === 'H') {
      const to: Point = [base[0] + number(), current[1]];
      out.push({ op: 'l', to });
      current = to;
      lastCubicControl = null;
      lastQuadControl = null;
      continue;
    }

    if (upper === 'V') {
      const to: Point = [current[0], base[1] + number()];
      out.push({ op: 'l', to });
      current = to;
      lastCubicControl = null;
      lastQuadControl = null;
      continue;
    }

    if (upper === 'C' || upper === 'S') {
      const c1: Point =
        upper === 'C'
          ? [base[0] + number(), base[1] + number()]
          : lastCubicControl
            ? [2 * current[0] - lastCubicControl[0], 2 * current[1] - lastCubicControl[1]]
            : current;
      const c2: Point = [base[0] + number(), base[1] + number()];
      const to: Point = [base[0] + number(), base[1] + number()];
      out.push({ op: 'c', c1, c2, to });
      current = to;
      lastCubicControl = c2;
      lastQuadControl = null;
      continue;
    }

    if (upper === 'Q' || upper === 'T') {
      const q: Point =
        upper === 'Q'
          ? [base[0] + number(), base[1] + number()]
          : lastQuadControl
            ? [2 * current[0] - lastQuadControl[0], 2 * current[1] - lastQuadControl[1]]
            : current;
      const to: Point = [base[0] + number(), base[1] + number()];
      // Degree elevation: a quadratic is the cubic whose controls sit two thirds of the way from each endpoint towards the quadratic's control.
      out.push({
        op: 'c',
        c1: [current[0] + (2 / 3) * (q[0] - current[0]), current[1] + (2 / 3) * (q[1] - current[1])],
        c2: [to[0] + (2 / 3) * (q[0] - to[0]), to[1] + (2 / 3) * (q[1] - to[1])],
        to,
      });
      current = to;
      lastQuadControl = q;
      lastCubicControl = null;
      continue;
    }

    if (upper === 'A') {
      const rx = number();
      const ry = number();
      const rotation = number();
      const largeArc = number() !== 0;
      const sweep = number() !== 0;
      const to: Point = [base[0] + number(), base[1] + number()];
      out.push(...arcToCubics(current, rx, ry, rotation, largeArc, sweep, to));
      current = to;
      lastCubicControl = null;
      lastQuadControl = null;
      continue;
    }

    throw new CasterError(`pathData: ${JSON.stringify(command)} is not an SVG path command`);
  }

  return out;
}

// --- SVG shapes -------------------------------------------------------------

/** A numeric attribute, or `fallback` where it is absent, blank or not a number. */
const attrNumber = (element: Element, name: string, fallback: number = 0): number => {
  const raw = element.getAttribute(name);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
};

/**
 * The basic shapes as paths, in the element's own user space.
 *
 * @remarks
 * `rect` with `rx`/`ry` follows SVG 2's auto rule — a missing radius takes the other one — and then the same clamping a CSS box gets, because SVG says a radius larger than half the side is reduced to half the side, which is what clamping with one factor produces on a rectangle whose four corners are equal.
 *
 * @returns `null` for an element that is not a basic shape; an empty path for a shape that draws nothing.
 * @throws {CasterError} From {@link parsePath}, for a `<path>` whose `d` it refuses.
 */
export function shapePath(element: Element): Path|null {
  switch (element.tagName.toLowerCase()) {
    case 'rect': {
      const x = attrNumber(element, 'x');
      const y = attrNumber(element, 'y');
      const w = attrNumber(element, 'width');
      const h = attrNumber(element, 'height');
      if (w <= 0 || h <= 0) return [];
      const rxRaw = element.getAttribute('rx');
      const ryRaw = element.getAttribute('ry');
      const rx = rxRaw !== null ? attrNumber(element, 'rx') : ryRaw !== null ? attrNumber(element, 'ry') : 0;
      const ry = ryRaw !== null ? attrNumber(element, 'ry') : rx;
      const radius: Radius = [Math.min(rx, w / 2), Math.min(ry, h / 2)];
      return roundedRectPath({ x, y, w, h }, [radius, radius, radius, radius]);
    }
    case 'circle': {
      const r = attrNumber(element, 'r');
      if (r <= 0) return [];
      return ellipsePath(attrNumber(element, 'cx'), attrNumber(element, 'cy'), r, r);
    }
    case 'ellipse': {
      const rx = attrNumber(element, 'rx');
      const ry = attrNumber(element, 'ry');
      if (rx <= 0 || ry <= 0) return [];
      return ellipsePath(attrNumber(element, 'cx'), attrNumber(element, 'cy'), rx, ry);
    }
    case 'line':
      return [
        { op: 'm', to: [attrNumber(element, 'x1'), attrNumber(element, 'y1')] },
        { op: 'l', to: [attrNumber(element, 'x2'), attrNumber(element, 'y2')] },
      ];
    case 'polyline':
    case 'polygon': {
      const numbers = (element.getAttribute('points') ?? '').match(/[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g)?.map(Number) ?? [];
      if (numbers.length < 4) return [];
      const path: PathSegment[] = [{ op: 'm', to: [numbers[0], numbers[1]] }];
      for (let i = 2; i + 1 < numbers.length; i += 2) path.push({ op: 'l', to: [numbers[i], numbers[i + 1]] });
      if (element.tagName.toLowerCase() === 'polygon') path.push({ op: 'h' });
      return path;
    }
    case 'path': {
      const d = element.getAttribute('d');
      return d && d.trim() !== '' ? parsePath(d) : [];
    }
    default:
      return null;
  }
}

// --- CSS basic shapes -------------------------------------------------------

/** One `<length-percentage>` against a reference length. */
function lengthPercentage(token: string, reference: number): number {
  const text = token.trim();
  if (text.endsWith('%')) return (Number.parseFloat(text) / 100) * reference;
  const value = Number.parseFloat(text);
  return Number.isFinite(value) ? value : 0;
}

/** `closest-side` and friends, resolved against a box and a centre. */
function shapeRadius(token: string, cx: number, cy: number, box: Box, axis: 'x'|'y'|'both'): number {
  const text = token.trim();
  const dx = [Math.abs(cx - box.x), Math.abs(box.x + box.w - cx)];
  const dy = [Math.abs(cy - box.y), Math.abs(box.y + box.h - cy)];
  if (text === 'closest-side') {
    if (axis === 'x') return Math.min(...dx);
    if (axis === 'y') return Math.min(...dy);
    return Math.min(...dx, ...dy);
  }
  if (text === 'farthest-side') {
    if (axis === 'x') return Math.max(...dx);
    if (axis === 'y') return Math.max(...dy);
    return Math.max(...dx, ...dy);
  }
  // A percentage on a circle resolves against the diagonal, per CSS Shapes 1.
  if (text.endsWith('%') && axis === 'both') {
    return ((Number.parseFloat(text) / 100) * Math.sqrt(box.w * box.w + box.h * box.h)) / Math.SQRT2;
  }
  return lengthPercentage(text, axis === 'y' ? box.h : box.w);
}

/** The `at <position>` tail of `circle()`/`ellipse()`, as a point in the box. */
function shapePosition(text: string, box: Box): Point {
  const parts = text.trim().split(/\s+/).filter((p) => p !== '');
  const keyword = (token: string, size: number, start: number): number|null => {
    if (token === 'left' || token === 'top') return start;
    if (token === 'center') return start + size / 2;
    if (token === 'right' || token === 'bottom') return start + size;
    return null;
  };
  const one = (token: string, size: number, start: number): number => keyword(token, size, start) ?? start + lengthPercentage(token, size);
  if (parts.length === 0) return [box.x + box.w / 2, box.y + box.h / 2];
  if (parts.length === 1) return [one(parts[0], box.w, box.x), box.y + box.h / 2];
  return [one(parts[0], box.w, box.x), one(parts[1], box.h, box.y)];
}

/**
 * A CSS basic shape as a path in the reference box's space.
 *
 * @remarks
 * `inset()` carries its own `round` clause and goes through the same clamping a border radius does; `polygon()` keeps its fill rule for the caller, which is why the result says which one it wants rather than assuming non-zero.
 *
 * @returns `null` for `none` and for anything that is not a shape this reads.
 * @throws {CasterError} From {@link parsePath}, for a `path()` whose string it refuses.
 */
export function cssShapePath(value: string, box: Box): { path: Path; evenOdd: boolean; }|null {
  const text = value.trim();
  if (text === '' || text === 'none') return null;

  const call = /^([a-z-]+)\((.*)\)$/is.exec(text);
  if (!call) return null;
  const name = call[1].toLowerCase();
  const body = call[2].trim();

  if (name === 'inset') {
    const [insetPart, roundPart] = body.split(/\bround\b/i);
    const edges = insetPart.trim().split(/\s+/).filter((p) => p !== '');
    const at = (i: number, fallback: number, reference: number): number => (edges[i] !== undefined ? lengthPercentage(edges[i], reference) : fallback);
    const top = at(0, 0, box.h);
    const right = at(1, top, box.w);
    const bottom = at(2, top, box.h);
    const left = at(3, right, box.w);
    const inner: Box = { x: box.x + left, y: box.y + top, w: box.w - left - right, h: box.h - top - bottom };
    let radii = ZERO_RADII;
    if (roundPart) {
      const tokens = roundPart.trim().split('/');
      const xs = tokens[0].trim().split(/\s+/).filter((p) => p !== '');
      const ys = (tokens[1] ?? tokens[0]).trim().split(/\s+/).filter((p) => p !== '');
      const pick = (list: string[], i: number, reference: number): number => {
        const fallback = [0, 0, 0, 1][i];
        const token = list[i] ?? list[fallback] ?? list[0];
        return lengthPercentage(token, reference);
      };
      radii = clampRadii(
        ([0, 1, 2, 3].map((i) => ([pick(xs, i, inner.w), pick(ys, i, inner.h)] as Radius)) as Radii),
        inner.w,
        inner.h,
      );
    }
    return { path: roundedRectPath(inner, radii), evenOdd: false };
  }

  if (name === 'circle' || name === 'ellipse') {
    const [radiusPart, positionPart] = body.split(/\bat\b/i);
    const radiusTokens = (radiusPart ?? '').trim().split(/\s+/).filter((p) => p !== '');
    const [cx, cy] = shapePosition(positionPart ?? '', box);
    if (name === 'circle') {
      const r = shapeRadius(radiusTokens[0] ?? 'closest-side', cx, cy, box, 'both');
      return { path: ellipsePath(cx, cy, r, r), evenOdd: false };
    }
    const rx = shapeRadius(radiusTokens[0] ?? 'closest-side', cx, cy, box, 'x');
    const ry = shapeRadius(radiusTokens[1] ?? radiusTokens[0] ?? 'closest-side', cx, cy, box, 'y');
    return { path: ellipsePath(cx, cy, rx, ry), evenOdd: false };
  }

  if (name === 'polygon') {
    const args = body.split(',').map((a) => a.trim()).filter((a) => a !== '');
    let evenOdd = false;
    if (/^(nonzero|evenodd)$/i.test(args[0] ?? '')) {
      evenOdd = args[0].toLowerCase() === 'evenodd';
      args.shift();
    }
    const points = args.map((arg) => {
      const pair = arg.split(/\s+/);
      return ([box.x + lengthPercentage(pair[0], box.w), box.y + lengthPercentage(pair[1] ?? pair[0], box.h)] as Point);
    });
    if (points.length < 3) return null;
    const path: PathSegment[] = [{ op: 'm', to: points[0] }];
    for (const point of points.slice(1)) path.push({ op: 'l', to: point });
    path.push({ op: 'h' });
    return { path, evenOdd };
  }

  if (name === 'path') {
    const quoted = /^(?:(nonzero|evenodd)\s*,\s*)?["'](.*)["']$/is.exec(body);
    if (!quoted) return null;
    return { path: parsePath(quoted[2]), evenOdd: (quoted[1] ?? '').toLowerCase() === 'evenodd' };
  }

  return null;
}

/**
 * `matrix(a, b, c, d, e, f)` and `matrix3d(…)` as computed, or the identity.
 *
 * @throws {CasterError} The value is neither `none` nor a matrix with enough numbers to read.
 */
export function parseMatrix(value: string): Matrix {
  if (!value || value === 'none') return [1, 0, 0, 1, 0, 0];
  const numbers = value.match(/-?[\d.eE+]+/g)?.map(Number) ?? [];
  if (value.startsWith('matrix3d') && numbers.length === 16) {
    return [numbers[0], numbers[1], numbers[4], numbers[5], numbers[12], numbers[13]];
  }
  if (numbers.length >= 6) return [numbers[0], numbers[1], numbers[2], numbers[3], numbers[4], numbers[5]];
  throw new CasterError(`pathData: cannot read the transform ${JSON.stringify(value)}`);
}

/** An `SVGMatrix`/`DOMMatrix` as the six numbers a `cm` carries. */
export function domMatrix(m: DOMMatrixReadOnly): Matrix {
  return [m.a, m.b, m.c, m.d, m.e, m.f];
}
