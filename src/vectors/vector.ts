/**
 * `vectors/vector.js` — the shape of a painted vector, between the browser that measured it and the emitter that writes it.
 *
 * Ported from `harness/src/export/vector.ts` (E9, E10, E12C). Guide: `docs/guide/vector-painting.md` §"The emitter rule table", which writes the shapes this file declares.
 *
 * WHAT THE PORT CHANGED. The port records no change here beyond the language. *a rectangle belongs to the page its node was assigned to* (DESIGN.md S27) added one thing after it: `placeBox` takes the page a caller assigns a node to, and `pageOfElement` answers it.
 *
 * The harness's own header follows.
 *
 * The shape of a painted vector, between the browser that measured it and the emitter that writes it.
 *
 * Everything in this file is data. `cssBoxes.js` and `svgGeometry.js` fill it in from the DOM; `vectorEmit.js`, `shading.js` and `transparency.js` read it and write operators and objects. Neither side imports the other, which is what keeps a geometry question ("where is this circle?") separate from an emission question ("does this fill need a soft mask?") — and it is what makes the report possible at all, because the report is this structure with the unserialisable parts left out.
 *
 * One convention holds everywhere: every coordinate is in **PDF points on the page the item landed on**, y running up from the bottom-left corner. The conversion happens once, at the point where a DOM rectangle is read, and nothing downstream has to know that CSS measures downwards. The one exception is a shading's `/Coords`, which stays in the space its `matrix` maps to the page, because that is what lets a rotated gradient keep circular ends.
 *
 * @packageDocumentation
 */
import { COLUMN_WIDTH_PX, PX_TO_PT } from '../coordinates/units.ts';
import { activeFrame, quantisePx, toLocal, toLocalOn } from '../coordinates/frame.ts';
import { IDENTITY, mul, PIXELS_TO_PAGE } from '../images/imagePlace.ts';
import { pageGeometryFor } from '../coordinates/pageGeometry.ts';
import { CasterError } from '../errors.ts';

import type { Matrix } from '../images/imagePlace.ts';
import type { Cmyk } from '../colour/colorHints.ts';
import type { DecodedSamples } from '../images/canvasDecode.ts';
import type { Box, Path } from './pathData.ts';

export type FillRule = 'nonzero' | 'evenodd';

/** Everything `w J j M d` carries, in points. */
export type StrokeStyle = {
  widthPt: number;
  /** 0 butt, 1 round, 2 projecting square, as the `J` operator numbers them. */
  cap: 0 | 1 | 2;
  /** 0 miter, 1 round, 2 bevel, as `j` numbers them. */
  join: 0 | 1 | 2;
  miterLimit: number;
  dashPt: number[];
  dashPhasePt: number;
  /** `vector-effect: non-scaling-stroke`; the points are pre-transformed instead. */
  nonScaling: boolean;
};

/** One stop of a gradient, with the alpha kept beside the colour rather than folded in. */
export type GradientStop = {
  offset: number;
  rgb: [number, number, number];
  /** Present when the hint of `colour.md` (E8) declared the stop in CMYK. */
  cmyk?: Cmyk;
  alpha: number;
};

/** A shading, in the terms the PDF dictionary uses. */
export type ShadingSpec = {
  /** 2 for axial, 3 for radial; nothing else is built. */
  type: 2 | 3;
  /** `/Coords`, in the space `matrix` maps onto the page. */
  coords: number[];
  extend: [boolean, boolean];
  stops: GradientStop[];
  colorSpace: 'DeviceRGB' | 'DeviceCMYK';
  /** The `cm` concatenated before `sh`, or folded into a pattern's `/Matrix`. */
  matrix: Matrix;
  /** The same coordinates mapped onto the page, for a human reading the report. */
  coordsPt: number[];
  /** `pad`, or the spread the stops were unrolled for. */
  spread: 'pad' | 'reflect' | 'repeat';
  /** How many periods the unrolling covers; 1 when the spread is `pad`. */
  periods: number;
  /** True when any stop is not fully opaque, which is what asks for a soft mask. */
  hasAlpha: boolean;
  /** What the gradient was written as, for the record. */
  source: string;
  /** Set when PDF has no shading that draws what the engine drew, with the reason. The caller rasterises instead of emitting the shading. */
  degenerate?: string;
};

/** What a fill or a stroke paints with: nothing, a flat DeviceRGB or DeviceCMYK colour, or a shading. */
export type PaintSpec = { kind: 'none' } | { kind: 'rgb', rgb: [number, number, number] } | { kind: 'cmyk', values: Cmyk } | { kind: 'shading', shading: ShadingSpec };

/** A clip in force around a node, already intersected by nesting. */
export type ClipSpec = {
  path: Path;
  evenOdd: boolean;
  /** What asked for the clip, for the report. */
  reason: string;
};

/** A luminosity or alpha soft mask, as a transparency group of its own. */
export type SoftMaskSpec = {
  type: 'Luminosity' | 'Alpha';
  content: VectorNode[];
  bboxPt: [number, number, number, number];
  /** `/BC`, the backdrop the group is composited against. */
  backdrop?: number[];
  reason: string;
};

/** Everything a raster fallback needs, before and after the canvas has run. */
export type RasterSpec = {
  /** The trigger, in the vocabulary the raster policy is written in. */
  feature: string;
  /** The whole sentence, for the report. */
  reason: string;
  /** The isolated SVG document the canvas is drawn from. */
  svg: string;
  /** The painted rectangle, in page points, `[x y w h]`. */
  rectPt: [number, number, number, number];
  dpi: number;
  /** The `cm` that puts the unit square on `rectPt`. */
  cm: Matrix;
  /** Pixels, filled in asynchronously by the raster pass. */
  samples?: DecodedSamples;
};

/** What every vector node carries whatever its kind: where it came from, and the clips, alpha, blend and transform it is painted under. */
export type NodeCommon = {
  /** DOM path of the element the node came from. */
  domPath: string;
  /** A short name for the report, e.g. `background`, `border-top`, `circle`. */
  label: string;
  clips: ClipSpec[];
  /** `/ca`. */
  opacity: number;
  /** `/CA`. */
  strokeOpacity: number;
  /** `/BM`; `Normal` when nothing asked otherwise. */
  blend: string;
  softMask?: SoftMaskSpec;
  /** E10 (`coordinates-and-pages.md`): the in-page CTM chain of every transformed HTML ancestor between the page element and this node, as the `cm` a content stream carries. Present only when `ctm.js` found a chain. The emitter concatenates it immediately after the node's own `q`, *before* the node's clips, so everything under the node — its clips, its paths, its children, the `/BBox` of any form it becomes — is expressed in the untransformed page space the geometry was measured in and the transform lives entirely in these six numbers, exactly as it does for a line of text under `lineWrap`. */
  cm?: Matrix;
};

/**
 * A path, filled and stroked.
 *
 * @remarks
 * `strokeFirst` is SVG's `paint-order: stroke`. PDF has one operator that fills and strokes, and it fills first; a path that wants the other order is written twice, `S` and then `f`, which is what the emitter does when this is set. It is set only where the fill is a flat colour — a shading fill is `sh` inside a clip and reordering it is a different emission, deferred by name instead.
 */
export type VectorPathNode = NodeCommon & { kind: 'path', path: Path, fill: PaintSpec, fillRule: FillRule, stroke: PaintSpec, strokeStyle: StrokeStyle | null, strokeFirst?: boolean };

/** A raster fallback, painted as an image where PDF has no vector that draws what the engine drew. */
export type VectorRasterNode = NodeCommon & { kind: 'raster', raster: RasterSpec };

/** Children painted together; a form XObject when `forceForm` says why one is needed. */
export type VectorGroupNode = NodeCommon & { kind: 'group', children: VectorNode[], bboxPt: [number, number, number, number], forceForm: boolean, formReason: string };

/**
 * E12c (`vector-painting.md`): content painted once into a form XObject and placed many times.
 *
 * @remarks
 * The distinction from `VectorGroupNode` with `forceForm` is reuse. A group becomes a form because its opacity or its blend mode needs one, and it becomes a *different* form every time; a marker is one definition placed on eleven vertices, so the content is written once, keyed, and every placement is six numbers and a `Do`. The content is expressed in the form's own space and `matrix` is what puts that space where the node belongs.
 */
export type VectorFormNode = NodeCommon & { kind: 'form', formKey: string, content: VectorNode[], bboxPt: [number, number, number, number], matrix: Matrix, reason: string };

/** One node of a painted vector tree, discriminated by `kind`. */
export type VectorNode = VectorPathNode | VectorRasterNode | VectorGroupNode | VectorFormNode;

/** One thing the emitter paints, named by the structure element that owns it. */
export type VectorRequest = {
  /** Owner key: a `Figure` element's path, or an artifact's path. */
  owner: string;
  element: Element;
  domPath: string;
  /** Position in CSS painting order, from `paintOrderOf`. */
  paintIndex: number;
  /** The column the item landed in, which is the PDF page. */
  page: number;
  node: VectorNode;
};

/** A vector request with the DOM index the emitter interleaves it on. */
export type MeasuredVector = VectorRequest & { domIndex: number };

/** A node's common half with nothing in force: no clips, fully opaque, `Normal` blend, no transform. */
export function emptyNodeCommon(domPath: string, label: string): NodeCommon {
  return { domPath, label, clips: [], opacity: 1, strokeOpacity: 1, blend: 'Normal' };
}

/**
 * CSS pixels measured from the container's top-left, to PDF points on the page the column belongs to.
 *
 * @remarks
 * The column offset is subtracted first, so a box in the third column lands on the third page at the same x as a box in the first lands on the first — which is the whole of what "the browser paginated it" means here.
 */
export function pageMatrix(page: number): Matrix {
  return mul([1, 0, 0, 1, -page * COLUMN_WIDTH_PX, 0], PIXELS_TO_PAGE);
}

/** Which column a point in container pixels landed in. */
export function pageOfX(xPx: number): number {
  return Math.max(0, Math.floor(xPx / COLUMN_WIDTH_PX));
}

/** A painted rectangle, the page it landed on, and the map from its space to points. */
export type PagePlacement = {
  page: number;
  /** The rectangle in the coordinates `toPage` maps from. */
  box: Box;
  toPage: Matrix;
};

/**
 * The one hub every vector coordinate goes through, matching `pageRectOf`.
 *
 * @remarks
 * With the container frame of `coordinates-and-pages.md` (E10) installed the page is the page element the rect falls in, the box is its offset from that page's own top-left with the container scale divided out, and the map is that page's own pixel-to-point matrix — a landscape page flips y against 595.276 pt rather than against 841.89. With no frame it is the column rule of `text-emission.md` (E3) against the container's origin and the column-subtracting matrix, unchanged to the bit, which is what keeps every earlier fixture's stream identical.
 *
 * *a rectangle belongs to the page its node was assigned to* (DESIGN.md S27): a caller that knows the page — because it knows which page the node was assigned to — names it, and the rectangle is expressed against that page whatever band it happens to fall in. A section that begins on page 3 and runs to page 5 has one border box whose top is on page 3 and whose bottom is two pages down; read by its own origin it lands on page 3 and is right, but read as an ancestor of something on page 5 it would hand page 5's clip a box measured from page 3's corner.
 *
 * @param page - The page the caller assigns the rectangle to. Omitted, the rectangle's own origin decides, which is `coordinates-and-pages.md` (E10) unchanged.
 */
export function placeBox(rect: DOMRect, containerRect: DOMRect, page: number|null = null): PagePlacement {
  const local = page === null ? toLocal(rect) : toLocalOn(rect, page);
  if (local) {
    const geometry = pageGeometryFor(local.page);
    return {
      page: local.page,
      box: { x: local.xPx, y: local.yPx, w: local.wPx, h: local.hPx },
      toPage: [PX_TO_PT, 0, 0, -PX_TO_PT, geometry.marginPt, geometry.heightPt - geometry.marginPt],
    };
  }
  const column = pageOfX(rect.left - containerRect.left);
  return {
    page: column,
    box: { x: rect.left - containerRect.left, y: rect.top - containerRect.top, w: rect.width, h: rect.height },
    toPage: pageMatrix(column),
  };
}

/**
 * Which page a node was assigned to, as an index into the frame's pages, or null when nothing answers.
 *
 * @remarks
 * The other half of *a rectangle belongs to the page its node was assigned to* (DESIGN.md S27): `chains.pageElementOf` walks a node's assigned-slot chain up to its `<beltype-page>`, which is the page the engine put it on, and the frame lists those same elements in order. A collector that has an element in hand asks this rather than letting the rectangle's own top decide, because a straddling block's rectangle reaches down through the bands of pages it does not belong to.
 */
export function pageOfElement(element: Element, chains?: { pageElementOf: (element: Element) => HTMLElement|null; }): number|null {
  const frame = activeFrame();
  const pageElement = chains?.pageElementOf(element) ?? null;
  if (!frame || !pageElement) return null;
  const index = frame.pages.findIndex((p) => p.element === pageElement);
  return index < 0 ? null : index;
}

/**
 * Viewport (client) coordinates to the same page-local px `placeBox` answers in.
 *
 * @remarks
 * `getScreenCTM()` speaks client coordinates, so an inline `<svg>` reaches the page through a matrix rather than through a rectangle and needs the same conversion `toLocal` performs on one. The six numbers are quantised for the reason `frame.js` quantises a recovered coordinate: dividing by the container scale is where the float noise between two container states comes from, and a nanometre of a pixel is six orders of magnitude finer than the emitter's own quantum.
 */
export function clientToLocalMatrix(page: number, containerRect: DOMRect): Matrix {
  const frame = activeFrame();
  if (!frame) return [1, 0, 0, 1, -containerRect.left, -containerRect.top];
  const p = frame.pages[Math.min(Math.max(page, 0), frame.pages.length - 1)];
  const s = frame.scale;
  return ([1 / s, 0, 0, 1 / s, -p.left / s, -p.top / s].map(quantisePx) as Matrix);
}

/** The same quantisation applied to a composed matrix, when a frame is in force. */
export function quantiseIfFramed(m: Matrix): Matrix {
  if (!activeFrame()) return m;
  return (m.map(quantisePx) as Matrix);
}

/** `IDENTITY`, re-exported so the geometry modules need one matrix import. */
export { IDENTITY };

/**
 * `rgb(a, b, c)` and `rgba(a, b, c, d)` as PDF operands plus an alpha.
 *
 * @throws {CasterError} The value is not empty, `none` or `transparent` and carries fewer than three numbers.
 */
export function parseCssColor(color: string): { rgb: [number,number,number]; alpha: number; } {
  const text = color.trim();
  if (text === '' || text === 'none' || text === 'transparent') return { rgb: [0, 0, 0], alpha: 0 };
  const numbers = text.match(/[\d.]+(?:%)?/g);
  if (!numbers || numbers.length < 3) throw new CasterError(`vector: cannot parse colour ${JSON.stringify(color)}`);
  const channel = (token: string): number => (token.endsWith('%') ? Number.parseFloat(token) / 100 : Number(token) / 255);
  const alphaToken = numbers[3];
  const alpha = alphaToken === undefined ? 1 : alphaToken.endsWith('%') ? Number.parseFloat(alphaToken) / 100 : Number(alphaToken);
  return { rgb: [channel(numbers[0]), channel(numbers[1]), channel(numbers[2])], alpha };
}

/** The three blend modes CSS and PDF spell the same way, plus every other one. */
export function blendName(value: string): string {
  const text = (value || 'normal').trim().toLowerCase();
  if (text === 'normal') return 'Normal';
  return text
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}
