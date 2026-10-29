/**
 * `vectors/svgMarkers.js` — SVG markers (`vector-painting.md`, E12c), from the path data the browser can no longer answer for.
 *
 * Ported from `harness/src/export/svgMarkers.ts` (E12C). Guide: `docs/guide/vector-painting.md` §"SVG markers (E12C)".
 *
 * WHAT THE PORT CHANGED. The port records no change here beyond the language.
 *
 * The harness's own header follows.
 *
 * E12c (`vector-painting.md`): SVG markers, from the path data the browser can no longer answer for.
 *
 * A marker is the one part of SVG painting that a DOM will not hand over. `getScreenCTM()` answers for a rendered element and a `<marker>` inside `<defs>` is never rendered; `getBBox()` answers for the shape and says nothing about the arrowheads on it; there is no `getMarkerPositions()`. So markers have to be derived, and everything they need is in the two things this exporter already has: the `PathSegment[]` E9 (`vector-painting.md`) parses out of `d`, and the `<marker>` element's own attributes.
 *
 * The derivation is three rules, and each is a decision worth stating.
 *
 * **Where the vertices are.** Every drawing command contributes one vertex at its endpoint, and the subpath's `moveto` contributes one at its start; a `closepath` contributes a vertex too, at the point it closes onto, which is why a closed triangle carries four markers and not three. That is SVG 1.1 §11.6.2's list and SVG 2 keeps it.
 *
 * **Which way they point.** A vertex has an incoming direction and an outgoing one, taken from the *tangent* of the segment rather than from the chord: a cubic leaves its start point towards its first control point and arrives at its end point from its second, and a control point that coincides with the anchor falls through to the next one, which is what makes a cubic with a doubled control point still have a direction. `orient="auto"` then takes the outgoing direction at the first vertex, the incoming direction at the last, and the *bisector* at every vertex that has both — computed as the angle of the sum of the two unit vectors, which is the bisector that stays finite when the two directions are nearly opposite. `auto-start-reverse` is `auto` with the start marker turned through 180°, and a number is that number of degrees whatever the path does.
 *
 * A closed subpath is where the rules meet: its first vertex and its closing vertex are the same point, and both are given the closing segment as their incoming direction and the first segment as their outgoing one, so the two markers that land there point the same way and a closed shape has no seam.
 *
 * **How big and where about the vertex.** The placement is `T(vertex) · R(angle) · S(strokeWidth) · T(−refX, −refY)`, composed in the referencing element's user space and then mapped to the page by the element's own CTM. `markerUnits: strokeWidth` — which is the default — makes the scale the referencing element's stroke width, so an arrowhead on a thick line is a thick arrowhead; `userSpaceOnUse` makes it 1. A `viewBox` adds one more matrix inside all of that, mapping the marker's own content coordinates onto the `markerWidth × markerHeight` viewport, and `refX`/`refY` are in the content coordinates rather than the viewport's, so the reference point goes through that matrix before it is subtracted.
 *
 * The marker's content is painted once, into a form XObject in *viewport* space, and every placement is that form under its own `cm`. That is the whole reason a marker is worth doing properly rather than rasterising: a polyline with eleven mid markers is one stream and eleven six-number matrices.
 *
 * @packageDocumentation
 */
import { IDENTITY, mul } from '../images/imagePlace.ts';

import type { Matrix, PathSegment } from '../images/imagePlace.ts';
import type { Path, Point } from './pathData.ts';

/** One vertex of a path, with the directions of the segments that meet there. */
export type MarkerVertex = {
  point: Point;
  /** Direction of the segment arriving, in radians, or null at a path start. */
  inDir: number | null;
  /** Direction of the segment leaving, in radians, or null at a path end. */
  outDir: number | null;
  /** Which subpath the vertex belongs to. */
  subpath: number;
  /** True for the vertex a `closepath` produced. */
  fromClose: boolean;
};

/** Below this a length is zero and a direction does not exist. */
const EPSILON = 1e-9;

/** The angle of the chord from one point to another, in radians, or null where the two coincide. */
const direction = (from: Point, to: Point): number|null => {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  return Math.abs(dx) < EPSILON && Math.abs(dy) < EPSILON ? null : Math.atan2(dy, dx);
};

/** The direction towards the first of a list of candidate points that is not the anchor. */
const firstDistinct = (anchor: Point, candidates: Point[]): number|null => {
  for (const candidate of candidates) {
    const angle = direction(anchor, candidate);
    if (angle !== null) return angle;
  }
  return null;
};

/**
 * Every vertex of a path, in order, with its two tangent directions.
 *
 * @remarks
 * The path is the `PathSegment[]` `pathData.parsePath` produces, so every curve is already a cubic and every subpath boundary is an `m`.
 */
export function markerVertices(path: Path): MarkerVertex[] {
  const vertices: MarkerVertex[] = [];
  let current: Point = [0, 0];
  let start: Point = [0, 0];
  let subpath = -1;
  let firstIndexOfSubpath = -1;

  const push = (point: Point, fromClose: boolean): number => {
    vertices.push({ point, inDir: null, outDir: null, subpath, fromClose });
    return vertices.length - 1;
  };

  for (const segment of (path as PathSegment[])) {
    if (segment.op === 'm') {
      subpath += 1;
      current = segment.to;
      start = segment.to;
      firstIndexOfSubpath = push(segment.to, false);
      continue;
    }
    if (vertices.length === 0) continue;
    const previous = vertices[vertices.length - 1];

    if (segment.op === 'h') {
      const out = direction(current, start);
      const closeIndex = push(start, true);
      previous.outDir = previous.outDir ?? out;
      vertices[closeIndex].inDir = out;
      // The first vertex of the subpath and the closing vertex are the same point; both take the closing direction as their incoming one, so a closed shape's two coincident markers point the same way.
      if (firstIndexOfSubpath >= 0) {
        vertices[firstIndexOfSubpath].inDir = out;
        vertices[closeIndex].outDir = vertices[firstIndexOfSubpath].outDir;
      }
      current = start;
      continue;
    }

    if (segment.op === 'l') {
      const angle = direction(current, segment.to);
      previous.outDir = angle;
      const index = push(segment.to, false);
      vertices[index].inDir = angle;
      current = segment.to;
      continue;
    }

    // A cubic: out along the first control point that is not the anchor, in along the last control point that is not the endpoint.
    previous.outDir = firstDistinct(current, [segment.c1, segment.c2, segment.to]);
    const inAngle = firstDistinct(segment.to, [segment.c2, segment.c1, current]);
    const index = push(segment.to, false);
    vertices[index].inDir = inAngle === null ? null : inAngle + Math.PI;
    current = segment.to;
  }

  return vertices;
}

/** Which marker property applies at a vertex. */
export type MarkerPosition = 'start' | 'mid' | 'end';

/** Which marker property applies at the vertex `index` of `total`. */
export function positionOf(index: number, total: number): MarkerPosition {
  if (index === 0) return 'start';
  if (index === total - 1) return 'end';
  return 'mid';
}

/**
 * The angle a marker is drawn at, in radians.
 *
 * @remarks
 * `orient` is a number of degrees, `auto`, or `auto-start-reverse`; the computed style spells the first as a bare number and the other two as themselves.
 */
export function markerAngle(vertex: MarkerVertex, position: MarkerPosition, orient: string): { angle: number; reversed: boolean; } {
  const text = (orient || '0').trim().toLowerCase();
  if (text !== 'auto' && text !== 'auto-start-reverse') {
    const degrees = Number.parseFloat(text);
    return { angle: Number.isFinite(degrees) ? (degrees * Math.PI) / 180 : 0, reversed: false };
  }
  let angle: number;
  if (vertex.inDir === null && vertex.outDir === null) angle = 0;
  else if (vertex.inDir === null) angle = (vertex.outDir as number);
  else if (vertex.outDir === null) angle = vertex.inDir;
  else {
    // The bisector, as the angle of the sum of the two unit vectors. Adding the vectors rather than averaging the angles is what keeps the answer right across the ±π wrap, and it degenerates to zero only when the two directions are exactly opposite — a path that doubles back on itself, where no bisector exists and the incoming direction is as good an answer as any.
    const x = Math.cos(vertex.inDir) + Math.cos(vertex.outDir);
    const y = Math.sin(vertex.inDir) + Math.sin(vertex.outDir);
    angle = Math.abs(x) < EPSILON && Math.abs(y) < EPSILON ? vertex.inDir : Math.atan2(y, x);
  }
  const reversed = text === 'auto-start-reverse' && position === 'start';
  return { angle: reversed ? angle + Math.PI : angle, reversed };
}

/** Everything a `<marker>` element declares. */
export type MarkerAttributes = {
  id: string;
  refX: number;
  refY: number;
  markerWidth: number;
  markerHeight: number;
  units: 'strokeWidth' | 'userSpaceOnUse';
  orient: string;
  overflow: string;
  viewBox: [number, number, number, number] | null;
  preserveAspectRatio: string;
};

/** An attribute's number, or `fallback` where it is absent or not a number. */
const numberOf = (value: string|null, fallback: number): number => {
  const n = Number.parseFloat(value ?? '');
  return Number.isFinite(n) ? n : fallback;
};

/** A `<marker>` element's attributes, with SVG's defaults where it declares none. */
export function markerAttributes(element: Element): MarkerAttributes {
  const viewBoxText = element.getAttribute('viewBox');
  const parts = (viewBoxText ?? '').trim().split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
  const style = getComputedStyle(element);
  return {
    id: element.id,
    refX: numberOf(element.getAttribute('refX'), 0),
    refY: numberOf(element.getAttribute('refY'), 0),
    markerWidth: numberOf(element.getAttribute('markerWidth'), 3),
    markerHeight: numberOf(element.getAttribute('markerHeight'), 3),
    units: element.getAttribute('markerUnits') === 'userSpaceOnUse' ? 'userSpaceOnUse' : 'strokeWidth',
    orient: element.getAttribute('orient') ?? '0',
    overflow: style.overflow || 'hidden',
    viewBox: parts.length === 4 ? [parts[0], parts[1], parts[2], parts[3]] : null,
    preserveAspectRatio: element.getAttribute('preserveAspectRatio') ?? 'xMidYMid meet',
  };
}

/**
 * The `viewBox` → viewport matrix, SVG 1.1 §7.8's algorithm.
 *
 * @remarks
 * Without a `viewBox` the marker's content coordinates *are* the viewport's and the matrix is the identity, which is the common case and the one the fixture exercises both ways.
 */
export function viewBoxMatrix(attributes: MarkerAttributes): Matrix {
  const { viewBox, markerWidth, markerHeight, preserveAspectRatio } = attributes;
  if (!viewBox) return IDENTITY;
  const [minX, minY, width, height] = viewBox;
  if (width <= 0 || height <= 0) return IDENTITY;
  const tokens = preserveAspectRatio.trim().split(/\s+/);
  const align = tokens[0] === 'defer' ? tokens[1] ?? 'xMidYMid' : tokens[0] || 'xMidYMid';
  const meetOrSlice = tokens[tokens.length - 1] === 'slice' ? 'slice' : 'meet';

  let scaleX = markerWidth / width;
  let scaleY = markerHeight / height;
  if (align !== 'none') {
    const uniform = meetOrSlice === 'slice' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
    scaleX = uniform;
    scaleY = uniform;
  }
  let translateX = -minX * scaleX;
  let translateY = -minY * scaleY;
  if (align.includes('xMid')) translateX += (markerWidth - width * scaleX) / 2;
  if (align.includes('xMax')) translateX += markerWidth - width * scaleX;
  if (align.includes('YMid')) translateY += (markerHeight - height * scaleY) / 2;
  if (align.includes('YMax')) translateY += markerHeight - height * scaleY;
  return [scaleX, 0, 0, scaleY, translateX, translateY];
}

const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
const scaleMatrix = (s: number): Matrix => [s, 0, 0, s, 0, 0];
const rotate = (angle: number): Matrix => [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0];

/**
 * `T(vertex) · R(angle) · S(strokeWidth) · T(−refX, −refY)`, in the referencing element's user space.
 *
 * @remarks
 * Written here as a composition in application order — the reference point is subtracted first and the vertex added last — because that is the order a reader can check against the specification's sentence, and `mul(a, b)` in this codebase is "a then b".
 *
 * @param viewBox - The marker's `viewBox` matrix, which `refX`/`refY` go through before they are subtracted.
 */
export function placementMatrix(vertex: Point, angle: number, scale: number, refX: number, refY: number, viewBox: Matrix): Matrix {
  const [rx, ry] = [viewBox[0] * refX + viewBox[2] * refY + viewBox[4], viewBox[1] * refX + viewBox[3] * refY + viewBox[5]];
  return mul(mul(mul(translate(-rx, -ry), scaleMatrix(scale)), rotate(angle)), translate(vertex[0], vertex[1]));
}

/** One marker, placed on one vertex. */
export type MarkerPlacement = {
  markerId: string;
  position: MarkerPosition;
  vertexIndex: number;
  vertex: MarkerVertex;
  angle: number;
  reversed: boolean;
  scale: number;
  /** The placement in the referencing element's user space. */
  matrix: Matrix;
};

/** What {@link markerPlacements} is handed about one referencing shape. */
export type MarkerPlacementOptions = {
  /** The referencing element's path, in its own user space. */
  path: Path;
  /** `marker-start`, `marker-mid`, `marker-end` as resolved marker elements. */
  markers: { start?: Element, mid?: Element, end?: Element };
  /** The referencing element's `stroke-width` in user units. */
  strokeWidth: number;
  /** Attributes and viewBox matrix per marker element, keyed by id. */
  attributesOf: (element: Element) => MarkerAttributes;
};

/** Every placement of every marker on one shape, in path order. */
export function markerPlacements(options: MarkerPlacementOptions): MarkerPlacement[] {
  const vertices = markerVertices(options.path);
  const out: MarkerPlacement[] = [];
  vertices.forEach((vertex, index) => {
    const position = positionOf(index, vertices.length);
    const element = options.markers[position];
    if (!element) return;
    const attributes = options.attributesOf(element);
    const { angle, reversed } = markerAngle(vertex, position, attributes.orient);
    const scale = attributes.units === 'strokeWidth' ? options.strokeWidth : 1;
    out.push({
      markerId: attributes.id,
      position,
      vertexIndex: index,
      vertex,
      angle,
      reversed,
      scale,
      matrix: placementMatrix(vertex.point, angle, scale, attributes.refX, attributes.refY, viewBoxMatrix(attributes)),
    });
  });
  return out;
}
