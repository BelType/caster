/**
 * `vectors/svgGeometry.js` — the SVG half of `vector-painting.md` (E9): an inline `<svg>` read back out of the engine that laid it out.
 *
 * Ported from `harness/src/export/svgGeometry.ts` (E9, E10, E12C). Guide: `docs/guide/vector-painting.md` — the browser-side procedure's step 5, the raster fallback list, and §"SVG markers (E12C)".
 *
 * WHAT THE PORT CHANGED. The port records no change here beyond the language. *a drawing inside a continuation was painted on no page* (DESIGN.md S40) added one thing after it: `collectSvg` takes R5's `clipToPage`, so a drawing inside a continuation is painted by the clone that carries it.
 *
 * The harness's own header follows.
 *
 * The SVG half of `vector-painting.md` (E9): an inline `<svg>` read back out of the engine that laid it out.
 *
 * Nothing here re-implements SVG. Every geometric question that the browser has already answered is asked of the browser — `getScreenCTM()` for the transform chain, `getBBox()` for object bounding boxes, `getComputedStyle()` for every presentation attribute, `getStartPositionOfChar()` for where a glyph went — and only the things a DOM cannot answer are computed: the `d` attribute (`pathData.js`), the shape-to-path conversions, and the mapping of a paint server onto a PDF shading.
 *
 * `getScreenCTM()` rather than `getCTM()` on purpose. `getCTM()` stops at the nearest viewport, so an element inside a nested `<svg>` reports a matrix that is missing the outer viewBox entirely, and an element reached through `<use>` reports one that has nothing to do with where it was painted. `getScreenCTM()` goes all the way to the client coordinate system — the same one `getBoundingClientRect()` speaks — so subtracting the container's own origin from it lands directly in the pixel grid every other part of the exporter measures in. Both are read and both are recorded, because which one is right is one of the things this experiment was told not to assume.
 *
 * A note on stroke widths. Paths arrive at the emitter already in page points, so a stroke has to carry a width in page points too, which means multiplying the user-space width by the uniform scale of the element's CTM. That is exactly what `vector-effect: non-scaling-stroke` asks *not* to happen, so the two cases differ by one factor and the property costs nothing to support. A CTM with a non-uniform scale has no single factor and is recorded as deferred rather than approximated.
 *
 * @packageDocumentation
 */
import { apply, mul, IDENTITY } from '../coordinates/matrix.ts';
import { RASTER_DPI, bboxOf, periodsFor, unrollGradient } from './cssBoxes.ts';
import { toPdfMatrix } from '../coordinates/ctm.ts';
import { PX_TO_PT } from '../coordinates/units.ts';
import { pageGeometryFor } from '../coordinates/pageGeometry.ts';
import { cssShapePath, domMatrix, roundedRectPath, shapePath, transformPath } from './pathData.ts';
import { markerAttributes, markerPlacements, viewBoxMatrix } from './svgMarkers.ts';
import { domPathOf } from '../measure/textMeasure.ts';
import { blendName, clientToLocalMatrix, emptyNodeCommon, pageOfElement, placeBox, quantiseIfFramed, parseCssColor } from './vector.ts';
import { CasterError } from '../errors.ts';

import type { Matrix } from '../images/imagePlace.ts';
import type { DeferredRecord } from './cssBoxes.ts';
import type { ChainContext } from '../coordinates/ctm.ts';
import type { PaintOrder } from '../walk/paintOrder.ts';
import type { Box, Path, Point } from './pathData.ts';
import type { MarkerAttributes, MarkerPlacement } from './svgMarkers.ts';
import type { ArtifactDescriptor } from '../walk/structure.ts';
import type { ClipSpec, GradientStop, PaintSpec, RasterSpec, ShadingSpec, SoftMaskSpec, StrokeStyle, VectorNode, VectorRequest } from './vector.ts';

/** One inline `<svg>` the walker found, with the structure element that owns it. */
export type SvgRoot = {
  element: SVGSVGElement;
  /** Owner key: a `Figure` element's path, or an artifact's path. */
  owner: string;
  tag: 'Figure' | 'Artifact';
  alt?: string;
  domPath: string;
};

/** One `<text>` the figure owns, for the run emitter to measure and place. */
export type SvgTextRequest = {
  element: SVGTextElement;
  owner: string;
  domPath: string;
  page: number;
  /** User space to container pixels; the caller turns positions into page points. */
  toContainer: Matrix;
  /** The uniform scale of that matrix, which the font size is multiplied by. */
  scale: number;
  paintIndex: number;
};

/** What `getCTM` and `getScreenCTM` answered for one element, recorded rather than assumed. */
export type CtmReading = {
  path: string;
  case: string;
  ctm: number[] | null;
  screenCtm: number[] | null;
  /** `getBBox()` in the element's own user space. */
  bbox: [number, number, number, number] | null;
  /** The same element's client rect, for comparison with the bounding box. */
  clientRect: [number, number, number, number] | null;
  note: string;
};

/** E12c (`vector-painting.md`): one `<marker>` definition, as it became a form XObject. */
export type MarkerDefinitionRecord = {
  id: string;
  formKey: string;
  units: string;
  refX: number;
  refY: number;
  markerWidth: number;
  markerHeight: number;
  orient: string;
  overflow: string;
  viewBox: [number, number, number, number] | null;
  viewBoxMatrix: number[];
  bboxPt: [number, number, number, number];
  clipped: boolean;
  uses: number;
};

/** E12c (`vector-painting.md`): one placement of one marker on one vertex. */
export type MarkerPlacementRecord = {
  path: string;
  marker: string;
  position: string;
  vertex: number;
  pointPt: [number, number];
  inDeg: number | null;
  outDeg: number | null;
  angleDeg: number;
  reversed: boolean;
  scale: number;
  /** The `cm` the content stream carries, in page points. */
  matrix: [number, number, number, number, number, number];
};

/** What {@link collectSvg} answers for every inline `<svg>` the walker found. */
export type SvgResult = {
  requests: VectorRequest[];
  artifacts: ArtifactDescriptor[];
  rasters: RasterSpec[];
  deferred: DeferredRecord[];
  texts: SvgTextRequest[];
  readings: CtmReading[];
  /** E12c (`vector-painting.md`): the marker definitions, one per `<marker>` element actually used. */
  markerDefinitions: MarkerDefinitionRecord[];
  /** E12c (`vector-painting.md`): every placement, in emission order. */
  markerPlacements: MarkerPlacementRecord[];
};

/** Elements that define rather than paint. */
const NON_PAINTING = new Set([
  'defs',
  'title',
  'desc',
  'metadata',
  'style',
  'lineargradient',
  'radialgradient',
  'pattern',
  'clippath',
  'mask',
  'filter',
  'symbol',
  'marker',
  'script',
]);

const SHAPES = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path']);

/** The four elements markers are rendered on, and no others. */
const MARKER_ELEMENTS = new Set(['path', 'line', 'polyline', 'polygon']);

/** A computed value's number, or `fallback` where it does not parse. */
const numberOf = (value: string, fallback: number = 0): number => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
};

/** The uniform scale of a matrix, and whether it has one at all. */
function scaleOf(m: Matrix): { scale: number; uniform: boolean; } {
  const sx = Math.hypot(m[0], m[1]);
  const sy = Math.hypot(m[2], m[3]);
  return { scale: Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || sx, uniform: Math.abs(sx - sy) < 1e-6 };
}

/** `url(#id)` in any of the spellings a computed style uses. */
function referenceId(value: string): string|null {
  const match = /url\(\s*["']?#([^"')\s]+)["']?\s*\)/i.exec(value ?? '');
  return match ? match[1] : null;
}

/** A `transform` attribute's own matrix, as the DOM consolidated it. */
function localMatrix(element: Element): Matrix {
  const graphics = (element as SVGGraphicsElement);
  const list = graphics.transform?.baseVal;
  if (!list || list.numberOfItems === 0) return IDENTITY;
  const consolidated = list.consolidate();
  return consolidated ? domMatrix(consolidated.matrix) : IDENTITY;
}

/**
 * Everything one inline `<svg>` paints.
 *
 * @remarks
 * The root's page is the column its own rectangle landed in and every element under it inherits that page, because an `<svg>` that straddled a column break would be a figure with no single rectangle to be placed in — the same restriction E7 (`images.md`) puts on an image box, for the same reason.
 *
 * @param options - `clipToPage` is R5's clip, the same one `measureText` takes: a drawing the engine laid out and then clipped belongs to the continuation clone that carries it, and the clone is what paints it (*a drawing inside a continuation was painted on no page*, DESIGN.md S40). `chains` is the chain builder of `coordinates-and-pages.md` (E10). The transforms of every HTML ancestor between the page element and the `<svg>` are neutralised inside it, so `getScreenCTM()` answers with the SVG's own transform chain and the element's untransformed position and nothing else; the HTML chain becomes the `cm` the whole figure is painted under. SVG-internal transforms stay here, where the browser already composed them.
 * @throws {CasterError} The drawing names a marker, paint server, clip path or mask that is not in the `<svg>` or is not the element it should be, a gradient has no stops, or a raster fallback would have to set text.
 */
export function collectSvg(options: { container: HTMLElement; order: PaintOrder; roots: SvgRoot[]; chains: ChainContext; clipToPage?: (page: number,element: Element) => { topPx: number; bottomPx: number; }|null; }): SvgResult {
  const { container, order, roots, chains } = options;
  const containerRect = container.getBoundingClientRect();
  const out: SvgResult = {
    requests: [],
    artifacts: [],
    rasters: [],
    deferred: [],
    texts: [],
    readings: [],
    markerDefinitions: [],
    markerPlacements: [],
  };

  for (const root of roots) {
    const svg = root.element;
    const rect = svg.getBoundingClientRect();
    const placement = placeBox(rect, containerRect, pageOfElement(svg, chains));
    const page = placement.page;
    // R5's clip, applied to a whole drawing rather than to a line (*a drawing inside a continuation was painted on no page*, DESIGN.md S40). A straddling block's original carries its tail laid out below the cut and only clipped, so a drawing in that tail is expressed against the page the block was assigned to and lands far below it — off the media box, painted nowhere anybody can see. The copy the reader sees is inside the continuation clone, which the walk now collects; this is the other half of that, and without it the same drawing would be painted twice.
    const area = options.clipToPage?.(page, root.element) ?? null;
    if (area && (placement.box.y >= area.bottomPx - 0.01 || placement.box.y + placement.box.h <= area.topPx + 0.01)) continue;
    const toPage = placement.toPage;
    const clientToLocal = clientToLocalMatrix(page, containerRect);

    /** One element's user space, all the way to page points. */
    const toPageOf = (element: Element): Matrix => mul(toContainerOf(element), toPage);
    /** One element's user space to the page-local px `toPage` maps from, through `getScreenCTM()`. */
    const toContainerOf = (element: Element): Matrix => {
      const screen = (element as SVGGraphicsElement).getScreenCTM?.();
      const base = screen ? domMatrix(screen) : IDENTITY;
      return quantiseIfFramed(mul(base, clientToLocal));
    };

    const context: SvgContext = {
      container,
      svg,
      page,
      toPage,
      clientToLocal,
      toPageOf,
      toContainerOf,
      owner: root.owner,
      order,
      out,
      markers: new Map<any, any>(),
      markerScope: root.domPath,
    };

    // The verify items: what the two CTM calls answer for the root, for a nested `<svg>`, and for an element reached through `<use>`.
    record(context, svg, 'the outer <svg> itself');
    const nested = svg.querySelector('svg');
    if (nested) record(context, nested, 'an element inside a nested <svg>');
    const inSymbol = svg.querySelector('symbol > *');
    if (inSymbol) record(context, inSymbol, 'an element inside a <symbol>, which is never painted directly');
    const strokeProbe = svg.querySelector('[data-stroke-probe]');
    if (strokeProbe) record(context, strokeProbe, 'a stroked shape, to see whether getBBox() carries the stroke');

    // An `<svg>` clips to its own viewport: the UA stylesheet sets `overflow: hidden` on it, and a shape that runs past the viewBox is cut off on the screen. Without this the exporter would paint the whole shape and the PDF would carry ink the page never showed.
    const viewport = viewportClip(context, svg, root.domPath);

    const children: VectorNode[] = [];
    for (const child of svg.children) {
      const node = paintElement(context, child, []);
      if (node) children.push(node);
    }
    if (children.length === 0) continue;

    const chain = chains.chainOf(svg);
    const node: VectorNode = {
      ...emptyNodeCommon(root.domPath, 'svg'),
      kind: 'group',
      children,
      clips: viewport,
      bboxPt: bboxOf(children),
      forceForm: false,
      formReason: '',
      // The viewport clip and every path under it were measured with the HTML ancestors neutralised, so both sit inside this matrix — which is the same one the text in the same wrapper is emitted under.
      ...(chain ? { cm: toPdfMatrix(chain.matrix, pageGeometryFor(page)) } : {}),
    };

    out.requests.push({
      owner: root.owner,
      element: svg,
      domPath: root.domPath,
      paintIndex: order.content.get(svg) ?? Number.MAX_SAFE_INTEGER,
      page,
      node,
    });
  }

  return out;
}

/** Everything the painting functions share about the one `<svg>` being read. */
export type SvgContext = {
  container: HTMLElement;
  svg: SVGSVGElement;
  page: number;
  toPage: Matrix;
  /** Client coordinates to the page-local px `toPage` maps from. */
  clientToLocal: Matrix;
  toPageOf: (element: Element) => Matrix;
  toContainerOf: (element: Element) => Matrix;
  owner: string;
  order: PaintOrder;
  out: SvgResult;
  /** E12c (`vector-painting.md`): one built definition per `<marker>` element, shared by every use. */
  markers: Map<Element, MarkerDefinition>;
  /** A stable prefix for the form keys of this `<svg>`, so two figures never collide. */
  markerScope: string;
};

/** Record what `getCTM()`, `getScreenCTM()`, `getBBox()` and the client rectangle answer for one element, into `context.out.readings`. */
function record(context: SvgContext, element: Element, description: string) {
  const graphics = (element as SVGGraphicsElement);
  let ctm: number[]|null = null;
  let screen: number[]|null = null;
  let bbox: [number,number,number,number]|null = null;
  let clientRect: [number,number,number,number]|null = null;
  let note = '';
  try {
    const value = graphics.getCTM?.();
    ctm = value ? domMatrix(value) : null;
  } catch (error) {
    note += `getCTM threw: ${String(error)}; `;
  }
  try {
    const value = graphics.getScreenCTM?.();
    screen = value ? domMatrix(value) : null;
  } catch (error) {
    note += `getScreenCTM threw: ${String(error)}; `;
  }
  try {
    const value = graphics.getBBox?.();
    bbox = value ? [value.x, value.y, value.width, value.height] : null;
  } catch (error) {
    note += `getBBox threw: ${String(error)}; `;
  }
  const client = graphics.getBoundingClientRect?.();
  if (client) clientRect = [client.x, client.y, client.width, client.height];
  context.out.readings.push({
    path: domPathOf(element, context.container),
    case: description,
    ctm,
    screenCtm: screen,
    bbox,
    clientRect,
    note: note.trim(),
  });
}

/** One SVG element as a vector node, or null when it paints nothing. */
function paintElement(context: SvgContext, element: Element, clips: ClipSpec[]): VectorNode|null {
  const tag = element.tagName.toLowerCase();
  if (NON_PAINTING.has(tag)) return null;
  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return null;

  const domPath = domPathOf(element, context.container);
  const toPage = context.toPageOf(element);
  const own = [...clips, ...elementClips(context, element, style, toPage, domPath)];

  if (style.filter !== 'none') {
    const raster = rasterOf(context, element, style, 'filter', `filter: ${style.filter} on ${domPath}: PDF has no filter primitives`);
    context.out.deferred.push({ path: domPath, feature: `filter: ${style.filter}`, paintedAs: `raster at ${RASTER_DPI} dpi` });
    return { ...emptyNodeCommon(domPath, tag), kind: 'raster', raster, clips: own };
  }

  if (tag === 'text' || tag === 'tspan') {
    const scale = scaleOf(context.toContainerOf(element));
    if (!scale.uniform) {
      context.out.deferred.push({ path: domPath, feature: 'non-uniform CTM on <text>', paintedAs: 'the uniform part of the scale' });
    }
    // A glyph is painted as a filled run in one flat colour, so a `fill` naming a gradient or a pattern has nowhere to go: `measureSvgText` takes the computed `fill` only when it parses as an `rgb()` and falls back to `color` otherwise, which is a guess unless it is said out loud. Deferred at the request rather than at the measurement, because this is where the `<text>` is minted and where its computed style is already in hand.
    if (style.fill.startsWith('url(')) {
      context.out.deferred.push({ path: domPath, feature: `fill: ${style.fill} on <text>`, paintedAs: 'the current colour, flat' });
    }
    context.out.texts.push({
      element: (element as SVGTextElement),
      owner: context.owner,
      domPath,
      page: context.page,
      toContainer: context.toContainerOf(element),
      scale: scale.scale,
      paintIndex: context.order.content.get(element) ?? Number.MAX_SAFE_INTEGER,
    });
    return null;
  }

  if (tag === 'image' || tag === 'foreignobject') {
    context.out.deferred.push({
      path: domPath,
      feature: `<${tag}>`,
      paintedAs: 'nothing; E7 owns raster images and foreignObject is out of scope',
    });
    return null;
  }

  if (tag === 'use') {
    return paintUse(context, (element as SVGUseElement), style, own, domPath);
  }

  if (tag === 'g' || tag === 'a' || tag === 'svg') {
    const children: VectorNode[] = [];
    for (const child of element.children) {
      const node = paintElement(context, child, []);
      if (node) children.push(node);
    }
    if (children.length === 0) return null;
    // A nested `<svg>` establishes a viewport of its own and clips to it, exactly as the outer one does.
    const clips = tag === 'svg' ? [...own, ...viewportClip(context, element, domPath)] : own;
    return groupNode(context, element, style, children, clips, domPath, tag);
  }

  if (SHAPES.has(tag)) {
    const local = shapePath(element);
    if (!local || local.length === 0) return null;
    const node = shapeNode(context, element, style, local, toPage, own, domPath, tag);
    if (!node) return null;
    const opacity = Number.parseFloat(style.opacity);
    if (Number.isFinite(opacity) && opacity < 1) {
      const bothPaints = node.kind === 'path' && node.fill.kind !== 'none' && node.stroke.kind !== 'none';
      if (bothPaints) {
        // A stroke and a fill that overlap have to be composited together before the opacity is applied, or the overlap goes darker than either. That is a transparency group, even for one element.
        return {
          ...emptyNodeCommon(domPath, tag),
          kind: 'group',
          children: [{ ...node, clips: [] }],
          clips: own,
          bboxPt: bboxOf([node]),
          opacity,
          forceForm: true,
          formReason: `opacity ${style.opacity} over a fill and a stroke that overlap`,
        };
      }
      // A shape with markers is a group, and `opacity` fades the shape and its markers together, once.
      if (node.kind === 'group') return { ...node, opacity, forceForm: true, formReason: node.formReason || `opacity ${style.opacity} on ${domPath}, its markers included` };
      return { ...node, opacity: node.opacity * opacity, strokeOpacity: node.strokeOpacity * opacity };
    }
    return node;
  }

  context.out.deferred.push({ path: domPath, feature: `<${tag}>`, paintedAs: 'nothing; the element is not in E9’s SVG subset' });
  return null;
}

/**
 * A client rectangle in the page-local px `context.toPage` maps from.
 *
 * @remarks
 * With no container frame this is the container-relative box every version of this module has read; with one it is the page-relative box with the container's scale divided out, which is the same conversion `placeBox` performs on a rectangle read for a CSS box.
 */
function localBoxOf(context: SvgContext, rect: DOMRect): Box {
  const [x, y] = apply(context.clientToLocal, rect.left, rect.top);
  return { x, y, w: rect.width * context.clientToLocal[0], h: rect.height * context.clientToLocal[3] };
}

/** The rectangle an `<svg>` element clips its content to, in page points. */
function viewportClip(context: SvgContext, element: Element, domPath: string): ClipSpec[] {
  if (getComputedStyle(element).overflow === 'visible') return [];
  // A nested `<svg>`'s viewport is its `x`, `y`, `width` and `height` in its parent's user space; its client rectangle is the box around what it draws, which is no clip at all.
  if (element !== context.svg && element.parentElement) {
    const nested = element as SVGSVGElement;
    const box: Box = { x: nested.x.baseVal.value, y: nested.y.baseVal.value, w: nested.width.baseVal.value, h: nested.height.baseVal.value };
    if (box.w <= 0 || box.h <= 0) return [];
    return [{ path: transformPath(roundedRectPath(box), context.toPageOf(element.parentElement)), evenOdd: false, reason: `the <svg> viewport at ${domPath}` }];
  }
  const box = localBoxOf(context, element.getBoundingClientRect());
  if (box.w <= 0 || box.h <= 0) return [];
  return [{ path: transformPath(roundedRectPath(box), context.toPage), evenOdd: false, reason: `the <svg> viewport at ${domPath}` }];
}

/** A `<g>`, with its opacity, blend mode and mask decided. */
function groupNode(context: SvgContext, element: Element, style: CSSStyleDeclaration, children: VectorNode[], clips: ClipSpec[], domPath: string, label: string): VectorNode {
  const opacity = Number.parseFloat(style.opacity);
  const blend = blendName(style.mixBlendMode);
  const mask = maskOf(context, element, style, domPath);
  const painting = children.length;
  // Whenever the group is not fully opaque. `/ca` alone is the non-stroking alpha, so a group opacity never reached a stroke however few children it had, and it replaced a child's own alpha instead of multiplying it. A transparency group composites the whole result once, which is what `opacity` means on a `<g>`.
  const wantsForm = (Number.isFinite(opacity) && opacity < 1) || blend !== 'Normal' || mask !== undefined;
  return {
    ...emptyNodeCommon(domPath, label),
    kind: 'group',
    children,
    clips,
    bboxPt: bboxOf(children),
    opacity: Number.isFinite(opacity) ? opacity : 1,
    blend,
    ...(mask ? { softMask: mask } : {}),
    forceForm: wantsForm,
    formReason: !wantsForm
      ? ''
      : mask
        ? `mask on ${domPath}`
        : blend !== 'Normal'
          ? `mix-blend-mode: ${style.mixBlendMode}`
          : `group opacity ${style.opacity} over ${painting} painting ${painting === 1 ? 'child' : 'children'}`,
  };
}

/**
 * One shape, with its fill, its stroke and whatever paint server either names.
 *
 * @param paints - The paint values to use instead of the element's own computed ones, which is how a `<use>` instance's inherited fill and its `currentColor` reach a shape sitting in `<defs>` (see `referencedPaint`).
 */
function shapeNode(context: SvgContext, element: Element, style: CSSStyleDeclaration, local: Path, toPage: Matrix, clips: ClipSpec[], domPath: string, label: string, paints?: { fill: string; stroke: string; }): VectorNode|null {
  const path = transformPath(local, toPage);
  const fill = paintOf(context, element, style, paints?.fill ?? style.fill, toPage, domPath, 'fill');
  const stroke = paintOf(context, element, style, paints?.stroke ?? style.stroke, toPage, domPath, 'stroke');
  if (fill.kind === 'none' && stroke.kind === 'none') return null;

  const degenerate =
    (fill.kind === 'shading' && fill.shading.degenerate) || (stroke.kind === 'shading' && stroke.shading.degenerate) || '';
  if (degenerate) {
    const raster = rasterOf(context, element, style, 'radial-focal-outside', `${domPath}: ${degenerate}`);
    return { ...emptyNodeCommon(domPath, label), kind: 'raster', raster, clips };
  }

  const scale = scaleOf(toPage);
  if (!scale.uniform) {
    context.out.deferred.push({ path: domPath, feature: 'non-uniform CTM under a stroke', paintedAs: 'the uniform part of the scale' });
  }
  const nonScaling = style.vectorEffect === 'non-scaling-stroke';
  const widthUser = numberOf(style.strokeWidth, 1);
  const factor = nonScaling ? PX_TO_PT : scale.scale;
  const dashes = (style.strokeDasharray === 'none' ? '' : style.strokeDasharray)
    .split(/[\s,]+/)
    .filter((token) => token !== '')
    .map((token) => numberOf(token) * factor);
  // SVG 2 §13.5.6: a dash array whose values sum to zero is `none` — a solid stroke. Written to a PDF as `[0] 0 d` it is a line of zero-length dashes, which paints nothing: every Mermaid edge computes `stroke-dasharray: 0px`, and its diagrams printed as arrowheads with no shafts (measured on the manual, 2026-09-21).
  const dash = dashes.reduce((sum, value) => sum + value, 0) > 0 ? dashes : [];

  const strokeStyle: StrokeStyle|null =
    stroke.kind === 'none'
      ? null
      : {
          widthPt: widthUser * factor,
          cap: style.strokeLinecap === 'round' ? 1 : style.strokeLinecap === 'square' ? 2 : 0,
          join: style.strokeLinejoin === 'round' ? 1 : style.strokeLinejoin === 'bevel' ? 2 : 0,
          miterLimit: numberOf(style.strokeMiterlimit, 4),
          dashPt: dash,
          dashPhasePt: numberOf(style.strokeDashoffset) * factor,
          nonScaling,
        };

  const fillOpacity = numberOf(style.fillOpacity, 1);
  const strokeOpacity = numberOf(style.strokeOpacity, 1);
  const blend = blendName(style.mixBlendMode);
  const mask = maskOf(context, element, style, domPath);

  // SVG 2 `paint-order`: `normal` is fill, stroke, markers, and a value beginning with `stroke` swaps the first two. PDF's `B` fills first and has no counterpart, so a flat fill is written as two operations; a shading fill is `sh` inside a clip, emitted before the stroke block reaches it at all, and reordering that is a different emission than this one — deferred by name rather than half done.
  const strokeFirst = (style.getPropertyValue('paint-order').trim().split(/\s+/)[0] ?? '') === 'stroke' && stroke.kind !== 'none' && fill.kind !== 'none';
  if (strokeFirst && fill.kind === 'shading') {
    context.out.deferred.push({ path: domPath, feature: 'paint-order: stroke over a gradient fill', paintedAs: 'fill then stroke; a shading fill is painted inside its own clip, which this order would have to be built around' });
  }
  const shape: VectorNode = {
    ...emptyNodeCommon(domPath, label),
    kind: 'path',
    path,
    fill,
    fillRule: style.fillRule === 'evenodd' ? 'evenodd' : 'nonzero',
    stroke,
    strokeStyle,
    ...(strokeFirst && fill.kind !== 'shading' ? { strokeFirst: true } : {}),
    clips,
    opacity: fillOpacity,
    strokeOpacity,
    blend,
    ...(mask ? { softMask: mask } : {}),
  };

  // E12c (`vector-painting.md`): markers are painted after the shape they belong to, which is SVG's own order — an arrowhead sits on top of the line it ends.
  const markerNodes = markerNodesFor(context, element, style, local, toPage, widthUser, domPath);
  if (markerNodes.length === 0) return shape;
  // A marker is part of its element's rendering (SVG 2 §11.6.2), so the element's mask and blend mode apply to the shape and its markers together, composited once: they go on the group, which becomes a form, and the shape inside keeps its fill and stroke alpha alone. On the shape they masked and blended the line and left the arrowheads as they were.
  const { softMask: _mask, ...bare } = shape;
  const composite = mask !== undefined || blend !== 'Normal';
  return {
    ...emptyNodeCommon(domPath, `${label}:with-markers`),
    kind: 'group',
    children: [{ ...bare, clips: [], blend: 'Normal' }, ...markerNodes],
    clips,
    bboxPt: bboxOf([shape, ...markerNodes]),
    blend,
    ...(mask ? { softMask: mask } : {}),
    forceForm: composite,
    formReason: !composite ? '' : mask ? `mask on ${domPath}, its markers included` : `mix-blend-mode: ${style.mixBlendMode} on ${domPath}, its markers included`,
  };
}

/**
 * The `<marker>` element three properties can name, resolved once.
 *
 * @remarks
 * A marker property is inherited and resolves against the document, so the lookup is by id inside this `<svg>`; a reference that names nothing is an export error rather than a silent omission, for the reason every other dangling reference in this module is one.
 *
 * @throws {CasterError} The reference names no element in the `<svg>`, or one that is not a `<marker>`.
 */
function markerElement(context: SvgContext, value: string, domPath: string, which: string): Element|null {
  const id = referenceId(value ?? '');
  if (id === null) return null;
  const element = context.svg.querySelector(`#${CSS.escape(id)}`);
  if (!element) throw new CasterError(`svgGeometry: ${domPath} names a ${which} #${id} that is not in the <svg>`, { element: domPath });
  if (element.tagName.toLowerCase() !== 'marker') {
    throw new CasterError(
      `svgGeometry: ${domPath} names ${which} #${id}, which is a <${element.tagName.toLowerCase()}> rather than a <marker>`,
      { element: domPath },
    );
  }
  return element;
}

/** One `<marker>` built into form-space content, ready to be placed. */
export type MarkerDefinition = {
  attributes: MarkerAttributes;
  formKey: string;
  content: VectorNode[];
  bbox: [number, number, number, number];
  clipped: boolean;
  record: MarkerDefinitionRecord;
};

/**
 * The transform chain from one element up to (but not including) an ancestor.
 *
 * @remarks
 * `getScreenCTM()` cannot answer for marker content: a `<marker>` is never rendered, so its children have no screen CTM at all and the DOM returns null. The chain is therefore composed from the elements' own `transform` attributes, which is the whole of what an SVG transform chain is once the viewport matrices have been taken out — and inside a marker they have been, because the marker's own viewBox matrix is applied separately.
 */
function chainWithin(element: Element, ancestor: Element): Matrix {
  let matrix = IDENTITY;
  let node: Element|null = element;
  while (node && node !== ancestor) {
    matrix = mul(matrix, localMatrix(node));
    node = node.parentElement;
  }
  return matrix;
}

/**
 * A `<marker>` as content in its own viewport space, built once per element.
 *
 * @remarks
 * The form's space is the marker *viewport* — the `markerWidth × markerHeight` box — so the viewBox matrix is applied inside the form and every placement outside it is the same six numbers whatever the marker's own coordinates are.
 */
function markerDefinition(context: SvgContext, element: Element): MarkerDefinition {
  const existing = context.markers.get(element);
  if (existing) return existing;

  const attributes = markerAttributes(element);
  const viewBox = viewBoxMatrix(attributes);
  const inner: SvgContext = {
    ...context,
    toPage: viewBox,
    toPageOf: (child) => mul(chainWithin(child, element), viewBox),
    toContainerOf: (child) => mul(chainWithin(child, element), viewBox),
  };

  const content: VectorNode[] = [];
  for (const child of element.children) {
    const node = paintElement(inner, child, []);
    if (node) content.push(node);
  }

  const viewport: [number,number,number,number] = [0, 0, attributes.markerWidth, attributes.markerHeight];
  const clipped = attributes.overflow !== 'visible';
  const bbox = clipped ? viewport : bboxOf(content);
  if (clipped && content.length > 0) {
    // The marker viewport clips its content, which is the UA stylesheet's `overflow: hidden` on `marker` and is the only reason `markerWidth` and `markerHeight` mean anything at all.
    const clip: ClipSpec = {
      path: roundedRectPath({ x: 0, y: 0, w: attributes.markerWidth, h: attributes.markerHeight }),
      evenOdd: false,
      reason: `the marker viewport of #${attributes.id}`,
    };
    for (const node of content) node.clips = [clip, ...node.clips];
  }

  const definitionRecord: MarkerDefinitionRecord = {
    id: attributes.id,
    formKey: `${context.markerScope}#${attributes.id}`,
    units: attributes.units,
    refX: attributes.refX,
    refY: attributes.refY,
    markerWidth: attributes.markerWidth,
    markerHeight: attributes.markerHeight,
    orient: attributes.orient,
    overflow: attributes.overflow,
    viewBox: attributes.viewBox,
    viewBoxMatrix: viewBox.map(round4),
    bboxPt: (bbox.map(round4) as [number, number, number, number]),
    clipped,
    uses: 0,
  };
  const definition: MarkerDefinition = { attributes, formKey: definitionRecord.formKey, content, bbox, clipped, record: definitionRecord };
  context.markers.set(element, definition);
  context.out.markerDefinitions.push(definitionRecord);
  return definition;
}

/** Every marker placement on one shape, as form nodes in page points. */
function markerNodesFor(context: SvgContext, element: Element, style: CSSStyleDeclaration, local: Path, toPage: Matrix, strokeWidth: number, domPath: string): VectorNode[] {
  // SVG 2 §Markers: markers are rendered on `path`, `line`, `polyline` and `polygon` and on nothing else, so a `marker-end` inherited onto a `<rect>` draws nothing — which is what Chromium does and is easy to get wrong, because the property computes to the same value on both.
  if (!MARKER_ELEMENTS.has(element.tagName.toLowerCase())) return [];
  const start = markerElement(context, (style.markerStart as string), domPath, 'marker-start');
  const mid = markerElement(context, (style.markerMid as string), domPath, 'marker-mid');
  const end = markerElement(context, (style.markerEnd as string), domPath, 'marker-end');
  if (!start && !mid && !end) return [];

  const placements = markerPlacements({
    path: local,
    markers: { ...(start ? { start } : {}), ...(mid ? { mid } : {}), ...(end ? { end } : {}) },
    strokeWidth,
    attributesOf: (marker) => markerDefinition(context, marker).attributes,
  });

  const byId: Map<string,MarkerDefinition> = new Map<any, any>();
  for (const marker of [start, mid, end]) {
    if (marker) {
      const definition = markerDefinition(context, marker);
      byId.set(definition.attributes.id, definition);
    }
  }

  const nodes: VectorNode[] = [];
  for (const placement of placements) {
    const definition = (byId.get(placement.markerId) as MarkerDefinition);
    if (definition.content.length === 0) continue;
    const matrix = mul(placement.matrix, toPage);
    definition.record.uses += 1;
    nodes.push({
      ...emptyNodeCommon(domPath, `marker-${placement.position}`),
      kind: 'form',
      formKey: definition.formKey,
      content: definition.content,
      bboxPt: definition.bbox,
      matrix,
      reason: `<marker id="${definition.attributes.id}"> on the ${placement.position} vertex of ${domPath}`,
    });
    context.out.markerPlacements.push({
      path: domPath,
      marker: placement.markerId,
      position: placement.position,
      vertex: placement.vertexIndex,
      pointPt: apply(toPage, placement.vertex.point[0], placement.vertex.point[1]),
      inDeg: placement.vertex.inDir === null ? null : round4((placement.vertex.inDir * 180) / Math.PI),
      outDeg: placement.vertex.outDir === null ? null : round4((placement.vertex.outDir * 180) / Math.PI),
      angleDeg: round4((placement.angle * 180) / Math.PI),
      reversed: placement.reversed,
      scale: round4(placement.scale),
      matrix: (matrix.map(round4) as [number, number, number, number, number, number]),
    });
  }
  return nodes;
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * A `fill` or `stroke` value: a colour, a paint server, or nothing at all.
 *
 * @throws {CasterError} The value names a paint server that is not in the `<svg>`.
 */
function paintOf(context: SvgContext, element: Element, style: CSSStyleDeclaration, value: string, toPage: Matrix, domPath: string, which: 'fill'|'stroke'): PaintSpec {
  const text = (value ?? '').trim();
  if (text === '' || text === 'none') return { kind: 'none' };
  const id = referenceId(text);
  if (id !== null) {
    const server = context.svg.querySelector(`#${CSS.escape(id)}`);
    if (!server) {
      throw new CasterError(`svgGeometry: ${domPath} names a ${which} server #${id} that is not in the <svg>`, { element: domPath });
    }
    const tag = server.tagName.toLowerCase();
    if (tag === 'lineargradient' || tag === 'radialgradient') {
      return { kind: 'shading', shading: gradientSpec(context, element, server, toPage, domPath) };
    }
    context.out.deferred.push({
      path: domPath,
      feature: `<${tag}> paint server`,
      paintedAs: 'nothing; SVG patterns are a PDF tiling pattern and are out of scope',
    });
    return { kind: 'none' };
  }
  const colour = parseCssColor(text);
  if (colour.alpha === 0) return { kind: 'none' };
  return { kind: 'rgb', rgb: colour.rgb };
}

/** The stops of one gradient element, `href` inheritance included. */
function gradientStops(server: Element, svg: SVGSVGElement): GradientStop[] {
  let source: Element|null = server;
  let stops: Element[] = [];
  const seen: Set<Element> = new Set<any>();
  while (source && !seen.has(source)) {
    seen.add(source);
    stops = [...source.querySelectorAll('stop')];
    if (stops.length > 0) break;
    const href: string = source.getAttribute('href') ?? source.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? '';
    const id: string|null = href.startsWith('#') ? href.slice(1) : null;
    source = id === null ? null : svg.querySelector(`#${CSS.escape(id)}`);
  }
  // SVG 1.1 §13.2.4: each stop's offset is clamped to be at least the one before it. Clamped, not sorted — an out-of-order stop takes its predecessor's position and keeps its place in the list, where sorting would move its colour too and turn a hard-edged gradient into a different gradient. `shading.js` sorts what it is given, which is right for a list that is already monotonic and wrong as a way of making one.
  let previous = 0;
  return stops.map((stop, index) => {
    const style = getComputedStyle(stop);
    const raw = stop.getAttribute('offset') ?? String(index / Math.max(1, stops.length - 1));
    const offset = raw.trim().endsWith('%') ? Number.parseFloat(raw) / 100 : numberOf(raw);
    const clamped = Math.max(previous, Math.min(1, Math.max(0, offset)));
    previous = clamped;
    const colour = parseCssColor(style.stopColor);
    const stopOpacity = numberOf(style.stopOpacity, 1);
    return { offset: clamped, rgb: colour.rgb, alpha: colour.alpha * stopOpacity };
  });
}

/** An inherited gradient attribute, following `href` until one is set. */
function gradientAttribute(server: Element, svg: SVGSVGElement, name: string): string|null {
  let source: Element|null = server;
  const seen: Set<Element> = new Set<any>();
  while (source && !seen.has(source)) {
    seen.add(source);
    const value = source.getAttribute(name);
    if (value !== null) return value;
    const href: string = source.getAttribute('href') ?? source.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? '';
    const id: string|null = href.startsWith('#') ? href.slice(1) : null;
    source = id === null ? null : svg.querySelector(`#${CSS.escape(id)}`);
  }
  return null;
}

/**
 * One `<linearGradient>` or `<radialGradient>` as a PDF shading.
 *
 * @remarks
 * `/Coords` stays in the gradient's own coordinate space and the matrix that reaches the page carries `gradientTransform`, the units mapping and the element's CTM. That is what lets an `objectBoundingBox` gradient on a non-square box stay the ellipse SVG says it is: a Type 3 shading has one radius, and the other axis is in the matrix.
 *
 * `fr` maps onto the inner circle's radius directly. SVG clamps a focal point that falls outside the outer circle onto its edge; PDF does not, and extends the cone instead, so the clamping is done here and recorded.
 *
 * @throws {CasterError} The gradient, `href` inheritance included, has no stops.
 */
function gradientSpec(context: SvgContext, element: Element, server: Element, toPage: Matrix, domPath: string): ShadingSpec {
  const svg = context.svg;
  const tag = server.tagName.toLowerCase();
  const units = gradientAttribute(server, svg, 'gradientUnits') ?? 'objectBoundingBox';
  const spreadAttribute = ((gradientAttribute(server, svg, 'spreadMethod') ?? 'pad') as 'pad' | 'reflect' | 'repeat');
  const transformValue = gradientAttribute(server, svg, 'gradientTransform');
  const gradientTransform = transformValue ? parseTransformList(transformValue) : IDENTITY;

  const bbox = (element as SVGGraphicsElement).getBBox();
  const unitsMatrix: Matrix = units === 'userSpaceOnUse' ? IDENTITY : [bbox.width, 0, 0, bbox.height, bbox.x, bbox.y];
  const matrix = mul(mul(gradientTransform, unitsMatrix), toPage);

  const fraction = (value: string|null, fallback: number): number => {
    if (value === null) return fallback;
    const text = value.trim();
    if (text.endsWith('%')) return Number.parseFloat(text) / 100;
    return numberOf(text, fallback);
  };

  let stops = gradientStops(server, svg);
  if (stops.length === 0) {
    throw new CasterError(`svgGeometry: the gradient #${server.id} named by ${domPath} has no stops`, { element: domPath });
  }
  if (stops.length === 1) stops = [stops[0], { ...stops[0], offset: 1 }];

  const spread: 'pad'|'reflect'|'repeat' = spreadAttribute;
  const diagonal = Math.hypot(bbox.width, bbox.height) || 1;

  if (tag === 'lineargradient') {
    let x1 = fraction(gradientAttribute(server, svg, 'x1'), 0);
    let y1 = fraction(gradientAttribute(server, svg, 'y1'), 0);
    let x2 = fraction(gradientAttribute(server, svg, 'x2'), 1);
    let y2 = fraction(gradientAttribute(server, svg, 'y2'), 0);
    let periods = 1;
    if (spread !== 'pad') {
      // The gradient vector's length and the shape's extent are both measured in the gradient's own space, so their ratio is how much of the line's parameter the shape covers — and that, over the stops' span, is how many periods have to be written out.
      const vectorLength = Math.hypot(x2 - x1, y2 - y1);
      const extent = (units === 'userSpaceOnUse' ? diagonal : Math.SQRT2) / Math.max(vectorLength, 1e-6);
      const span = stops[stops.length - 1].offset - stops[0].offset;
      const count = periodsFor(extent, span);
      const unrolled = unrollGradient(stops, spread, count);
      const vx = x2 - x1;
      const vy = y2 - y1;
      const ox = x1;
      const oy = y1;
      x1 = ox + vx * unrolled.fromT;
      y1 = oy + vy * unrolled.fromT;
      x2 = ox + vx * unrolled.toT;
      y2 = oy + vy * unrolled.toT;
      stops = unrolled.stops;
      periods = 2 * count + 1;
    }
    const [ax, ay] = apply(matrix, x1, y1);
    const [bx, by] = apply(matrix, x2, y2);
    return {
      type: 2,
      coords: [x1, y1, x2, y2],
      extend: [true, true],
      stops,
      colorSpace: 'DeviceRGB',
      matrix,
      coordsPt: [ax, ay, bx, by],
      spread,
      periods,
      hasAlpha: stops.some((s) => s.alpha < 1),
      source: `<${tag} id="${server.id}"> ${units}`,
    };
  }

  const cx = fraction(gradientAttribute(server, svg, 'cx'), 0.5);
  const cy = fraction(gradientAttribute(server, svg, 'cy'), 0.5);
  const r = fraction(gradientAttribute(server, svg, 'r'), 0.5);
  let fx = fraction(gradientAttribute(server, svg, 'fx'), cx);
  let fy = fraction(gradientAttribute(server, svg, 'fy'), cy);
  const fr = fraction(gradientAttribute(server, svg, 'fr'), 0);

  // SVG 2 §13.2.3: a focal point outside the end circle is moved onto it.
  const distance = Math.hypot(fx - cx, fy - cy);
  let clamped = false;
  if (distance > r * 0.999 && distance > 0) {
    const factor = (r * 0.999) / distance;
    fx = cx + (fx - cx) * factor;
    fy = cy + (fy - cy) * factor;
    clamped = true;
    context.out.deferred.push({
      path: domPath,
      feature: 'radial focal point outside the end circle',
      paintedAs: `raster at ${RASTER_DPI} dpi; SVG clamps the point onto the circle and paints a cone, and no PDF Type 3 shading draws that`,
    });
  }

  let innerRadius = fr;
  let outerRadius = r;
  let periods = 1;
  if (spread !== 'pad') {
    const extent = (units === 'userSpaceOnUse' ? diagonal : Math.SQRT2) / Math.max(r - fr, 1e-6);
    const span = stops[stops.length - 1].offset - stops[0].offset;
    const count = periodsFor(extent, span);
    // The radius axis runs from the focal circle to the end circle; unrolling stretches it the same way an axial gradient's line is stretched, cut where the radius reaches zero, because a circle has no negative radius.
    const unrolled = unrollGradient(stops, spread, count, -fr / Math.max(r - fr, 1e-6));
    stops = unrolled.stops;
    innerRadius = Math.max(0, fr + unrolled.fromT * (r - fr));
    outerRadius = fr + unrolled.toT * (r - fr);
    periods = 2 * count + 1;
  }

  const [cxPt, cyPt] = apply(matrix, cx, cy);
  const [edgePt] = [apply(matrix, cx + outerRadius, cy)];
  return {
    type: 3,
    coords: [fx, fy, innerRadius, cx, cy, outerRadius],
    // A focal point on the end circle degenerates the family of circles into a cone, and PDF's `/Extend` would carry that cone outwards over ground the browser leaves unpainted. The extension is switched off for exactly that case, which is measured against the browser rather than assumed.
    extend: [true, true],
    stops,
    colorSpace: 'DeviceRGB',
    matrix,
    coordsPt: [cxPt, cyPt, 0, cxPt, cyPt, Math.hypot(edgePt[0] - cxPt, edgePt[1] - cyPt)],
    spread,
    periods,
    hasAlpha: stops.some((s) => s.alpha < 1),
    source: `<${tag} id="${server.id}"> ${units}${clamped ? ', focal point clamped' : ''}`,
    // A focal point on the end circle turns the family of circles into a cone, and the ground beyond the tangent at that point has no parameter at all: SVG leaves it unpainted, and PDF's `/Extend` fills the complement of a wedge instead. Both were rendered and measured before this was written.
    ...(clamped
      ? {
          degenerate:
            'the focal point falls outside the end circle; SVG clamps it onto the circle and paints a cone that no PDF Type 3 shading draws',
        }
      : {}),
  };
}

/** An SVG `transform` attribute, through the DOM's own parser. */
function parseTransformList(value: string): Matrix {
  const svgNs = 'http://www.w3.org/2000/svg';
  const holder = document.createElementNS(svgNs, 'svg');
  const g = document.createElementNS(svgNs, 'g');
  g.setAttribute('transform', value);
  holder.append(g);
  const consolidated = g.transform.baseVal.consolidate();
  return consolidated ? domMatrix(consolidated.matrix) : IDENTITY;
}

/**
 * `clip-path` on an SVG element: a `<clipPath>` reference or a CSS basic shape.
 *
 * @throws {CasterError} The value names a clip path that is not in the `<svg>`.
 */
function elementClips(context: SvgContext, element: Element, style: CSSStyleDeclaration, toPage: Matrix, domPath: string): ClipSpec[] {
  const value = style.clipPath;
  if (!value || value === 'none') return [];
  const id = referenceId(value);
  if (id === null) {
    const bbox = (element as SVGGraphicsElement).getBBox();
    const shape = cssShapePath(value, { x: bbox.x, y: bbox.y, w: bbox.width, h: bbox.height });
    if (!shape) return [];
    return [{ path: transformPath(shape.path, toPage), evenOdd: shape.evenOdd, reason: `clip-path: ${value} on ${domPath}` }];
  }
  const clipPath = context.svg.querySelector(`#${CSS.escape(id)}`);
  if (!clipPath) throw new CasterError(`svgGeometry: ${domPath} names a clip path #${id} that is not in the <svg>`, { element: domPath });
  const units = clipPath.getAttribute('clipPathUnits') ?? 'userSpaceOnUse';
  const bbox = (element as SVGGraphicsElement).getBBox();
  const unitsMatrix: Matrix = units === 'objectBoundingBox' ? [bbox.width, 0, 0, bbox.height, bbox.x, bbox.y] : IDENTITY;

  // `clip-rule` is each child's own (SVG 2 §14.3.5); it inherits, so one set on the `<clipPath>` reaches every child. The children are one path under one rule, so a rule they do not share is said out loud and the clip takes nonzero.
  const path: Path = [];
  const rules = new Set<string>();
  for (const child of clipPath.children) {
    const local = shapePath(child);
    if (!local || local.length === 0) continue;
    rules.add(getComputedStyle(child).clipRule);
    path.push(...transformPath(local, mul(mul(localMatrix(child), unitsMatrix), toPage)));
  }
  if (path.length === 0) return [];
  if (rules.size > 1) context.out.deferred.push({ path: domPath, feature: `clip-rule differing between the children of <clipPath id="${id}">`, paintedAs: 'one path clipped by nonzero' });
  const evenOdd = rules.size === 1 && rules.has('evenodd');
  return [{ path, evenOdd, reason: `clip-path url(#${id}) on ${domPath}, ${units}` }];
}

/**
 * A `<mask>` reference as a soft mask, with its content painted into a group.
 *
 * @throws {CasterError} The value names a mask that is not in the `<svg>`.
 */
function maskOf(context: SvgContext, element: Element, style: CSSStyleDeclaration, domPath: string): SoftMaskSpec|undefined {
  const value = style.mask && style.mask !== 'none' ? style.mask : element.getAttribute('mask') ?? '';
  const id = referenceId(value);
  if (id === null) return undefined;
  const mask = context.svg.querySelector(`#${CSS.escape(id)}`);
  if (!mask) throw new CasterError(`svgGeometry: ${domPath} names a mask #${id} that is not in the <svg>`, { element: domPath });

  const contentUnits = mask.getAttribute('maskContentUnits') ?? 'userSpaceOnUse';
  const bbox = (element as SVGGraphicsElement).getBBox();
  const toPage = context.toPageOf(element);
  const unitsMatrix: Matrix = contentUnits === 'objectBoundingBox' ? [bbox.width, 0, 0, bbox.height, bbox.x, bbox.y] : IDENTITY;
  const contentToPage = mul(unitsMatrix, toPage);

  const children: VectorNode[] = [];
  for (const child of mask.children) {
    const node = maskChild(context, child, contentToPage);
    if (node) children.push(node);
  }
  const type =
    (getComputedStyle(mask).getPropertyValue('mask-type').trim() || mask.getAttribute('mask-type') || 'luminance') === 'alpha'
      ? 'Alpha'
      : 'Luminosity';
  return {
    type,
    content: children,
    bboxPt: bboxOf(children),
    // A luminosity mask composites over black, so anything the mask does not paint is fully masked out — which is what makes a mask's own extent the shape it cuts.
    ...(type === 'Luminosity' ? { backdrop: [0] } : {}),
    reason: `mask url(#${id}) on ${domPath}, ${contentUnits}, ${type.toLowerCase()}`,
  };
}

/** One child of a `<mask>`, painted into the mask's own space. */
function maskChild(context: SvgContext, element: Element, toPage: Matrix): VectorNode|null {
  const tag = element.tagName.toLowerCase();
  if (NON_PAINTING.has(tag)) return null;
  const style = getComputedStyle(element);
  const domPath = domPathOf(element, context.container);
  const own = mul(localMatrix(element), toPage);

  if (tag === 'g') {
    const children: VectorNode[] = [];
    for (const child of element.children) {
      const node = maskChild(context, child, own);
      if (node) children.push(node);
    }
    if (children.length === 0) return null;
    return { ...emptyNodeCommon(domPath, 'mask-g'), kind: 'group', children, bboxPt: bboxOf(children), forceForm: false, formReason: '' };
  }

  const local = shapePath(element);
  if (!local || local.length === 0) return null;
  const fill = paintOf(context, element, style, style.fill, own, domPath, 'fill');
  if (fill.kind === 'none') return null;
  return {
    ...emptyNodeCommon(domPath, `mask-${tag}`),
    kind: 'path',
    path: transformPath(local, own),
    fill,
    fillRule: style.fillRule === 'evenodd' ? 'evenodd' : 'nonzero',
    stroke: { kind: 'none' },
    strokeStyle: null,
    opacity: numberOf(style.fillOpacity, 1),
  };
}

/**
 * A `<use>`, resolved by reference.
 *
 * @remarks
 * The referenced element is painted under the `<use>` element's own transform chain plus its `x`/`y`, with a `<symbol>`'s `viewBox` mapping folded in. Everything inside the reference keeps its own local transforms, composed by hand rather than read from `getScreenCTM()` — an element sitting in `<defs>` has never been painted and answers with a matrix that means nothing.
 */
function paintUse(context: SvgContext, use: SVGUseElement, style: CSSStyleDeclaration, clips: ClipSpec[], domPath: string): VectorNode|null {
  const href = use.getAttribute('href') ?? use.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? '';
  const id = href.startsWith('#') ? href.slice(1) : '';
  const target = id ? context.svg.querySelector(`#${CSS.escape(id)}`) : null;
  if (!target) {
    const raster = rasterOf(context, use, style, 'use', `<use href="${href}"> could not be resolved`);
    context.out.deferred.push({ path: domPath, feature: '<use> the resolver cannot handle', paintedAs: `raster at ${RASTER_DPI} dpi` });
    return { ...emptyNodeCommon(domPath, 'use'), kind: 'raster', raster, clips };
  }

  const x = numberOf(use.getAttribute('x') ?? '0');
  const y = numberOf(use.getAttribute('y') ?? '0');
  let base = mul([1, 0, 0, 1, x, y], context.toPageOf(use));

  const targetTag = target.tagName.toLowerCase();
  if (targetTag === 'symbol' || targetTag === 'svg') {
    const width = numberOf(use.getAttribute('width') ?? target.getAttribute('width') ?? '0');
    const height = numberOf(use.getAttribute('height') ?? target.getAttribute('height') ?? '0');
    const viewBox = (target.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
    if (viewBox.length === 4 && width > 0 && height > 0) {
      // preserveAspectRatio defaults to xMidYMid meet, which is a uniform scale plus the centring translation.
      const scale = Math.min(width / viewBox[2], height / viewBox[3]);
      const tx = (width - viewBox[2] * scale) / 2 - viewBox[0] * scale;
      const ty = (height - viewBox[3] * scale) / 2 - viewBox[1] * scale;
      base = mul([scale, 0, 0, scale, tx, ty], base);
    }
    const children: VectorNode[] = [];
    for (const child of target.children) {
      const node = referencedNode(context, child, base, style);
      if (node) children.push(node);
    }
    if (children.length === 0) return null;
    return groupNode(context, use, style, children, clips, domPath, 'use');
  }

  const node = referencedNode(context, target, base, style);
  if (!node) return null;
  return { ...node, clips: [...clips, ...node.clips] };
}

/**
 * The paint one referenced element is actually painted with.
 *
 * @remarks
 * SVG 2 instantiates a `<use>` as a shadow tree, so an inherited property that the referenced subtree never declares comes from the `<use>` element's own cascade, and `currentColor` inside it resolves against the `<use>`'s `color`. `getComputedStyle` on the original element in `<defs>` answers with the `<defs>`' context instead — usually the initial value, always the wrong one — so an icon written once as `<path fill="currentColor">` and placed with `<use fill="red">` or `<use style="color: red">` came out black.
 *
 * Only `fill` and `stroke` are answered here, which is the narrow half of the rule and the half the case is about; a `stroke-width` or a `fill-opacity` declared on the `<use>` alone is still read off the referenced element. What is checked is declaration, walking the referenced subtree upwards: a presentation attribute or an inline style anywhere between the element and its root declares the property, and anything else means nothing in the referenced tree said so.
 */
function referencedPaint(element: Element, style: CSSStyleDeclaration, useStyle: CSSStyleDeclaration|null, property: 'fill'|'stroke'): string {
  if (!useStyle) return style.getPropertyValue(property);
  let declared: string = '';
  for (let node = (element as Element | null); node; node = node.parentElement) {
    const own = ((node as unknown) as HTMLElement).style?.getPropertyValue(property) || node.getAttribute(property) || '';
    if (own !== '') { declared = own.trim(); break; }
    if (node.tagName.toLowerCase() === 'svg') break;
  }
  if (declared === '') return useStyle.getPropertyValue(property);
  if (declared.toLowerCase() === 'currentcolor') return useStyle.getPropertyValue('color');
  return style.getPropertyValue(property);
}

/**
 * One element inside a `<defs>` or `<symbol>`, painted under a matrix given from outside.
 *
 * @param useStyle - The `<use>` element's own computed style, which is where an undeclared inherited paint and `currentColor` come from.
 */
function referencedNode(context: SvgContext, element: Element, toPage: Matrix, useStyle?: CSSStyleDeclaration): VectorNode|null {
  const tag = element.tagName.toLowerCase();
  if (NON_PAINTING.has(tag)) return null;
  const style = getComputedStyle(element);
  const domPath = domPathOf(element, context.container);
  const own = mul(localMatrix(element), toPage);

  if (tag === 'g') {
    const children: VectorNode[] = [];
    for (const child of element.children) {
      const node = referencedNode(context, child, own, useStyle);
      if (node) children.push(node);
    }
    if (children.length === 0) return null;
    return { ...emptyNodeCommon(domPath, 'use-g'), kind: 'group', children, bboxPt: bboxOf(children), forceForm: false, formReason: '' };
  }

  const local = shapePath(element);
  if (!local || local.length === 0) return null;
  return shapeNode(context, element, style, local, own, [], domPath, `use-${tag}`, useStyle
    ? { fill: referencedPaint(element, style, useStyle, 'fill'), stroke: referencedPaint(element, style, useStyle, 'stroke') }
    : undefined);
}

/**
 * Serialise one element into its own SVG document and hand it to the raster pass.
 *
 * @throws {CasterError} The element contains text, which a serialised fragment would set in a system font; or its copy is missing from the clone.
 */
function rasterOf(context: SvgContext, element: Element, style: CSSStyleDeclaration, feature: string, reason: string): RasterSpec {
  if ((element.textContent ?? '').trim() !== '') {
    throw new CasterError(
      `svgGeometry: ${domPathOf(element, context.container)} would be rasterised for ${feature}, but it contains text; ` +
        'a serialised fragment cannot reach the page’s fonts, so the raster would be set in a system font and the words would be wrong',
      { element: domPathOf(element, context.container) },
    );
  }
  const painted = localBoxOf(context, element.getBoundingClientRect());
  // A filter paints outside the element's own box; the region is grown by the filter's default 10% margin on each side, which is what SVG specifies.
  const pad = Math.max(painted.w, painted.h) * 0.15 + 8;
  const box: Box = { x: painted.x - pad, y: painted.y - pad, w: painted.w + 2 * pad, h: painted.h + 2 * pad };
  const svgBox = localBoxOf(context, context.svg.getBoundingClientRect());
  const offsetX = svgBox.x;
  const offsetY = svgBox.y;

  // The clone keeps three things: every definition, the chain of ancestors down to the element, and the element's own subtree. Everything else is removed, so the raster carries the fallback alone and nothing that has already been painted as vector is painted twice.
  const clone = (context.svg.cloneNode(true) as SVGSVGElement);
  const target = atIndexPath(clone, indexPath(element, context.svg));
  if (!target) {
    throw new CasterError(`svgGeometry: the raster fallback for ${domPathOf(element, context.container)} lost its element in the clone`);
  }
  const chain: Set<Element> = new Set<any>();
  for (let node = (target as Element | null); node && node !== clone; node = node.parentElement) chain.add(node);
  for (const candidate of [...clone.querySelectorAll('*')]) {
    if (candidate.closest('defs') !== null) continue;
    if (chain.has(candidate)) continue;
    if (target.contains(candidate)) continue;
    candidate.remove();
  }
  // The ancestors' opacity, mask, filter and blend mode are painted by the vector group the raster sits in (`groupNode`), so they are neutralised here, or a `<g mask>` or `<g opacity>` would be applied twice, once in the pixels and once around them. The element's own stay: nothing outside the raster paints them.
  for (let node: Element | null = target.parentElement; node && node !== clone; node = node.parentElement) {
    const own = (node as Element & ElementCSSInlineStyle).style;
    own.setProperty('opacity', '1');
    own.setProperty('mask', 'none');
    own.setProperty('filter', 'none');
    own.setProperty('mix-blend-mode', 'normal');
  }
  clone.setAttribute('x', '0');
  clone.setAttribute('y', '0');
  clone.setAttribute('width', String(svgBox.w));
  clone.setAttribute('height', String(svgBox.h));

  // The clone goes in whole, its `viewBox` with it: its content is in the drawing's user units, and only the `<svg>` maps them to the px the box is measured in. Its children alone were drawn one user unit a px, small and in the corner.
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${box.w}" height="${box.h}" viewBox="0 0 ${box.w} ${box.h}">`,
    `<g transform="translate(${offsetX - box.x} ${offsetY - box.y})">`,
    new XMLSerializer().serializeToString(clone),
    '</g></svg>',
  ].join('');

  const toPage = context.toPage;
  const corners: Point[] = [
    apply(toPage, box.x, box.y),
    apply(toPage, box.x + box.w, box.y),
    apply(toPage, box.x + box.w, box.y + box.h),
    apply(toPage, box.x, box.y + box.h),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const rectPt: [number,number,number,number] = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
  const spec: RasterSpec = {
    feature,
    reason,
    svg,
    rectPt,
    dpi: RASTER_DPI,
    cm: [rectPt[2], 0, 0, rectPt[3], rectPt[0], rectPt[1]],
  };
  context.out.rasters.push(spec);
  return spec;
}

/** Where an element sits under a root, as child indices. */
function indexPath(element: Element, root: Element): number[] {
  const path: number[] = [];
  for (let node = (element as Element | null); node && node !== root; node = node.parentElement) {
    const parent = node.parentElement;
    if (!parent) break;
    path.unshift([...parent.children].indexOf(node));
  }
  return path;
}

/** The element the same indices reach in a clone of that root. */
function atIndexPath(root: Element, path: number[]): Element|null {
  let node: Element|null = root;
  for (const index of path) {
    if (!node) return null;
    node = node.children[index] ?? null;
  }
  return node;
}
