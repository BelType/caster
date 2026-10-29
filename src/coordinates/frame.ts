/**
 * `coordinates/frame.js` — the container frame: what the printer has to know about the box the pages are being viewed in before a single rectangle it reads means anything.
 *
 * Ported from `harness/src/export/frame.ts` (E10, E12D). Guide: `docs/guide/coordinates-and-pages.md`.
 *
 * WHAT THE PORT CHANGED (R1). The harness's fixtures laid pages in a horizontal strip and `pageIndexAt(viewportX)` read x alone. Cicero stacks its pages vertically inside `<beltype-root>`'s shadow root (`@media screen { beltype-page { margin: 0 auto 16px } }`), so the lookup is generalised to the page whose rectangle contains the point — the last page starting at or before it in y, then in x, with the same 0.01 px tolerance. The one-argument call the harness made is gone: it answered by x alone, which on a vertical stack is the last page of the file for every point on every page, and its only two callers were `imagePlace`'s fragmentation check. Under Cicero the strip is `<beltype-root>`, and the probes are appended into its shadow root, where the pages are laid out, because a probe appended to its light DOM would be assigned to no slot and never laid out at all; an engine whose pages are light DOM hands the strip itself (*the strip is static and the pages are light DOM*, DESIGN.md S51).
 *
 * The harness's header, carried over. Every measurement before E10 (`coordinates-and-pages.md`) was taken from a container at scale 1 with its top-left at the top-left of an unscrolled viewport, and every coordinate was `rect − containerRect.origin` in viewport CSS pixels. An editor does not show pages that way. It shows them scaled to fit, scrolled, inside a panel at a fractional offset, on a screen whose device pixel ratio is 2. All four of those change what `getBoundingClientRect` returns and none of them changes where the engine actually put the text, so the exporter has to be able to undo them exactly — and has to refuse, loudly, the ones it cannot undo.
 *
 * The contract, stated once and enforced here. Between the document root and a page element, an ancestor may translate, may scroll, and may apply a uniform `transform: scale(s)` with any `transform-origin`. It may not rotate, skew, scale non-uniformly, use CSS `zoom`, or apply a perspective. A violation is an export error naming the element that caused it, never a page that is quietly a few points wrong.
 *
 * The recovery is one linear map, measured rather than assumed. Three zero-size absolutely positioned probes are put into the strip at `(0, 0)`, `(K, 0)` and `(0, K)` for an integer `K`, and their painted positions give the two column vectors of the 2×2 part of whatever the ancestors compose to: `[a b] = (probe(K,0) − probe(0,0)) / K` and `[c d] = (probe(0,K) − probe(0,0)) / K`. `b` and `c` are zero exactly when the chain is axis-aligned; `a` and `d` are equal exactly when it is uniform; `a` is then the scale. The probe offsets are integers the module chooses, so the baseline the ratio is taken against is exact — which the alternatives are not: `offsetWidth` is the border box rounded to a whole pixel and an A4 page is 793.7 px wide, and `getComputedStyle(page).width` is that same box serialised to six significant figures. Both are recorded beside the probe answer.
 *
 * The checks run in a fixed order — `zoom`, then axis-alignment, then uniformity — because a rotation makes the width and height ratios disagree too, and an error that named the wrong cause would send a reader looking for the wrong thing.
 *
 * @packageDocumentation
 */

import { ZoomError, RotationError, NonUniformScaleError, CasterError } from '../errors.ts';

/** One page element as the frame read it: where it was painted, and its untransformed size. */
export type FramePage = {
  element: HTMLElement;
  /** Viewport x of the page's border box, as painted. */
  left: number;
  /** Viewport y of the same. */
  top: number;
  /** Painted width in viewport px, i.e. the untransformed width times the scale. */
  paintedWidthPx: number;
  paintedHeightPx: number;
  /** Untransformed border-box width, from `getComputedStyle`. */
  widthPx: number;
  heightPx: number;
  /** `offsetWidth`, recorded beside it: the same box rounded to a whole pixel. */
  offsetWidthPx: number;
  offsetHeightPx: number;
  /** The `data-pdf-size` the page declares, verbatim; '' when it declares none — which is every Cicero page (R2, and DESIGN.md's wish list). */
  nominal: string;
};

/** The container frame one measurement pass runs against — the recovered scale, the evidence for it, and the pages. */
export type Frame = {
  strip: HTMLElement|ShadowRoot;
  /** The factor every page-relative coordinate is divided by. From the probes. */
  scale: number;
  /** The same factor read off the y axis. */
  scaleFromHeight: number;
  /** `pageRect.width / untransformedWidth`, the ratio method, for the record. */
  scaleFromWidthRatio: number;
  scaleFromHeightRatio: number;
  /** The 2×2 part the probes measured: `[a, b, c, d]`. */
  linear: [number, number, number, number];
  /** How far the probes put the strip's corners off a rectangle, in px. */
  offAxisPx: number;
  cornersAxisAligned: boolean;
  widthSource: 'computed'|'offsetWidth';
  /** `zoom` values found on the ancestor chain; empty in every state that exports. */
  zoomSeen: string[];
  pages: FramePage[];
};

/** A rectangle expressed in the page it landed in, in untransformed page-local CSS px. */
export type PagedRect = {
  page: number;
  xPx: number;
  yPx: number;
  wPx: number;
  hPx: number;
};

/**
 * The offset the scale probes are read over, in CSS px.
 *
 * @remarks
 * An integer, and a large one: the probes are placed by `left`/`top` so the engine puts them at exactly this many pixels apart in the strip's own coordinates, which makes the denominator of the ratio exact and the numerator the only thing being measured. 1024 px is wide enough that a rotation of a hundredth of a degree still moves a corner by 0.17 px.
 */
const PROBE_SPAN_PX = 1024;

/** Off-axis tolerance, in px, over the probe span. */
const AXIS_TOLERANCE_PX = 0.01;

/** How far the two axis scales may differ before the chain is called non-uniform. */
const UNIFORM_TOLERANCE = 1e-4;

/**
 * Quantum the recovered page-local coordinates are rounded to, in CSS px.
 *
 * @remarks
 * Dividing by the scale and subtracting a page origin that is itself the product of a transform introduces float noise in the last few digits, and two container states that agree to twelve decimal places would still round to different thousandths of a point if the true value sat on a rounding boundary. A nanometre of a pixel is six orders of magnitude finer than the 0.00133 px the emitter's three-decimal points quantise to, so this cannot move an emitted number, and it makes the states agree bit for bit rather than nearly.
 */
const LOCAL_QUANTUM_PX = 1e-9;

/** Round a page-local coordinate to {@link LOCAL_QUANTUM_PX}. */
const quantise = ( value: number): number => Math.round(value / LOCAL_QUANTUM_PX) * LOCAL_QUANTUM_PX;

/**
 * The same quantum, for a coordinate that reaches page-local px through a matrix rather than through `toLocal`.
 *
 * @remarks
 * The vector geometry of `vector-painting.md` (E9) maps an SVG element's `getScreenCTM()` into the page rather than reading a rectangle, so it never passes through `toLocal` and would otherwise be the one family of numbers in the printer that carries the float noise of the division by the container scale.
 */
export const quantisePx = ( value: number): number => quantise(value);

/** The frame in force — module-scope state, kept where the harness has it (PLAN.md P4). */
let current: Frame|null = null;

/**
 * The frame in force, or null when the coordinate hub should use the column rule.
 *
 * @remarks
 * P4: the module-scope state stays where the harness has it, and `precheck.js`'s lock is what makes it safe.
 */
export function activeFrame(): Frame|null { return current; }

/** A computed CSS length's px number; 0 where it does not parse. */
const px = ( value: string): number => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The untransformed border-box size of an element, from the computed style.
 *
 * @remarks
 * `getComputedStyle().width` is the used width of the box `box-sizing` names, so a border-box element already answers with the border box and a content-box one has to have its padding and borders added back.
 */
function computedBorderBox( style: CSSStyleDeclaration) {
  const width = px(style.width);
  const height = px(style.height);
  if (style.boxSizing === 'border-box') return { width, height };
  const extraX = px(style.paddingLeft) + px(style.paddingRight) + px(style.borderLeftWidth) + px(style.borderRightWidth);
  const extraY = px(style.paddingTop) + px(style.paddingBottom) + px(style.borderTopWidth) + px(style.borderBottomWidth);
  return { width: width + extraX, height: height + extraY };
}

/** A short path for an element, for an error message. */
function describe( element: Element): string {
  const id = element.id ? `#${element.id}` : '';
  const cls = element.classList.length > 0 ? `.${[...element.classList].join('.')}` : '';
  return `${element.tagName.toLowerCase()}${id}${cls}`;
}

/**
 * Every `zoom` on the chain from `element` to the document root that is not 1.
 *
 * @remarks
 * The walk crosses a shadow boundary through `host`, because Cicero's pages live in one and the chain a printer must not be fooled by runs through it.
 */
function zoomsOn( element: Element) {
const paths: string[] = [];
const values: string[] = [];
  let node: Element|null = element;
  while (node) {
    const zoom = getComputedStyle(node).zoom;
    if (zoom !== '' && zoom !== '1' && zoom !== 'normal') { paths.push(describe(node)); values.push(zoom); }
    const parent: Element|null = node.parentElement;
    if (parent) { node = parent; continue; }
    const root = node.getRootNode();
    node = root instanceof ShadowRoot ? root.host : null;
  }
  return { paths, values };
}

/** A zero-size, out-of-flow probe at `(x, y)` in the strip's own coordinates. */
function probeAt( x: number,  y: number): HTMLElement {
  const probe = document.createElement('div');
  probe.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:0;height:0;margin:0;padding:0;border:0;visibility:hidden;pointer-events:none;contain:strict`;
  return probe;
}

/**
 * Install the frame for one measurement pass.
 *
 * @remarks
 * The strip must establish a containing block, because the probes are placed by `left`/`top` against it. They are out of flow, so they change no layout, and they are removed before anything else is read. Every rectangle the frame stores is read after the probes are gone, in one burst with no write between any two of them: the whole point of the exercise is that the numbers describe one layout rather than several.
 *
 * @param strip - Cicero's is `<beltype-root>`'s shadow root — probes appended to its light DOM would be assigned to no slot and never laid out.
 * @throws {CasterError} No page elements were given.
 * @throws {ZoomError} CSS `zoom` is set on an ancestor of the strip.
 * @throws {RotationError} The container chain is not axis-aligned.
 * @throws {NonUniformScaleError} The container chain scales x and y differently.
 */
export function beginFrame(strip: HTMLElement|ShadowRoot, pageElements: HTMLElement[]): Frame {
  if (pageElements.length === 0) throw new CasterError('caster: beginFrame was given no page elements — the engine presented no pages, so there is nothing to print');

  const zoomHost = strip instanceof ShadowRoot ? strip.host : strip;
  const zoom = zoomsOn(zoomHost);
  if (zoom.paths.length > 0) {
    throw new ZoomError(`caster: CSS zoom is set on ${zoom.paths.length} ancestor${zoom.paths.length === 1 ? '' : 's'} of the page strip (${zoom.paths.map((path, i) => `${path}: zoom ${zoom.values[i]}`).join('; ')}); zoom is not a transform, it re-runs layout in its own pixel unit, so the page it measures is not the page the document describes`, { element: zoom.paths[0] });
  }

  const origin = probeAt(0, 0);
  const alongX = probeAt(PROBE_SPAN_PX, 0);
  const alongY = probeAt(0, PROBE_SPAN_PX);
  strip.append(origin, alongX, alongY);
  const o = origin.getBoundingClientRect();
  const x = alongX.getBoundingClientRect();
  const y = alongY.getBoundingClientRect();
  origin.remove();
  alongX.remove();
  alongY.remove();

  const linear: [number,number,number,number] = [
    (x.left - o.left) / PROBE_SPAN_PX,
    (x.top - o.top) / PROBE_SPAN_PX,
    (y.left - o.left) / PROBE_SPAN_PX,
    (y.top - o.top) / PROBE_SPAN_PX
  ];
  const offAxisPx = Math.max(Math.abs(linear[1]), Math.abs(linear[2])) * PROBE_SPAN_PX;
  const cornersAxisAligned = offAxisPx <= AXIS_TOLERANCE_PX;
  if (!cornersAxisAligned) throw new RotationError(`caster: the container chain is not axis-aligned — it maps the unit axes to [${linear[0]}, ${linear[1]}] and [${linear[2]}, ${linear[3]}], which puts the strip's corners ${offAxisPx.toFixed(4)} px off a rectangle; a rotated or skewed view container cannot be undone into page-local pixels`);
  if (Math.abs(linear[0] - linear[3]) > UNIFORM_TOLERANCE) throw new NonUniformScaleError(`caster: the container chain scales x by ${linear[0]} and y by ${linear[3]}; a view container may scale uniformly or not at all, because a non-uniform scale changes the shape of every glyph and there is no one factor to divide the measurements by`);

  const pages: FramePage[] = pageElements.map((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const box = computedBorderBox(style);
    return {
      element,
      left: rect.left,
      top: rect.top,
      paintedWidthPx: rect.width,
      paintedHeightPx: rect.height,
      widthPx: box.width,
      heightPx: box.height,
      offsetWidthPx: element.offsetWidth,
      offsetHeightPx: element.offsetHeight,
      nominal: element.dataset.pdfSize ?? ''
    };
  });

  return installFrame({
    strip,
    scale: linear[0],
    scaleFromHeight: linear[3],
    scaleFromWidthRatio: pages[0].paintedWidthPx / pages[0].widthPx,
    scaleFromHeightRatio: pages[0].paintedHeightPx / pages[0].heightPx,
    linear,
    offAxisPx,
    cornersAxisAligned,
    widthSource: 'computed',
    zoomSeen: [],
    pages
  });
}

/**
 * Make a frame the active one.
 *
 * @remarks
 * `beginFrame` measures a real strip and ends here; this is the door it ends at, and it is exported because the lookups over a frame — which page a point falls in, what a rectangle is in that page's coordinates — are arithmetic that a node suite can put a frame in front of and check, where measuring one needs a browser. Nothing in the printer calls it: the composition installs a frame by measuring one.
 */
export function installFrame(frame: Frame): Frame {
  current = frame;
  return frame;
}

/** Uninstall the frame at the end of a measurement pass. */
export function endFrame() { current = null; }

/**
 * Which page a viewport point falls in.
 *
 * @remarks
 * R1's generalisation. The harness's pages were laid out left to right and never overlapped, so the page a rectangle belonged to was the last one that started at or before it in x. Cicero's stack vertically, so the answer is the page whose rectangle contains the point: the last page starting at or before it in y, and among those, the last starting at or before it in x. A hair of tolerance absorbs a rect flush against a page's edge whose transformed position lands a nanometre short of it.
 *
 * The x-only form the harness called is gone. It survived the port as a compatibility branch and had exactly two callers, both in `imagePlace`'s fragmentation check, where a document whose pages stack vertically made it answer with the last page in the file for every image on every page — so the check that refuses a fragmented box was comparing two numbers that were both simply wrong, and would have refused nothing and everything at once. Both callers pass the point now.
 */
export function pageIndexAt(viewportX: number, viewportY: number): number|null {
  if (!current) return null;
  const pages = current.pages;
  // The containing page, when there is one: y inside the page's painted band and x inside its painted width.
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    if (viewportY >= p.top - 0.01 && viewportY <= p.top + p.paintedHeightPx + 0.01 && viewportX >= p.left - 0.01 && viewportX <= p.left + p.paintedWidthPx + 0.01) return i;
  }
  // Outside every page's box — a trim mark, a margin box hanging past an edge, a rect in the gutter between two pages. Take the last page that starts at or before the point in y, then in x among the pages that share that band.
  let best = 0;
  for (let i = pages.length - 1; i >= 0; i--) {
    if (viewportY >= pages[i].top - 0.01) { best = i; break; }
  }
  const band = pages[best].top;
  for (let i = pages.length - 1; i > best; i--) {
    if (Math.abs(pages[i].top - band) <= 0.01 && viewportX >= pages[i].left - 0.01) return i;
  }
  return best;
}

/** A viewport rectangle in untransformed page-local px, or null with no frame. */
export function toLocal(rect: DOMRect): PagedRect|null {
  if (!current) return null;
  const page = (pageIndexAt(rect.left, rect.top) as number);
  const p = current.pages[page];
  const s = current.scale;
  return { page, xPx: quantise((rect.left - p.left) / s), yPx: quantise((rect.top - p.top) / s), wPx: quantise(rect.width / s), hPx: quantise(rect.height / s) };
}

/**
 * One viewport y in untransformed page-local px, against a page named by index, or null with no frame.
 *
 * @remarks
 * The baseline probes read a single `bottom` rather than a rectangle, and they already know which page their segment landed in, so they convert through this rather than through `toLocal`.
 *
 * @param page - Clamped into the frame's pages.
 */
export function toLocalY(viewportY: number, page: number) {
  if (!current) return null;
  const p = current.pages[Math.min(Math.max(page, 0), current.pages.length - 1)];
  return quantise((viewportY - p.top) / current.scale);
}

/**
 * A viewport rectangle in the coordinates of a page the caller names, or null with no frame.
 *
 * @remarks
 * `toLocal` finds the page from the rectangle's own origin, which is right for content but wrong for a box that is deliberately outside its page — a trim box drawn 6 mm in from the media edge sits outside a page element that carries its margins as padding, and would otherwise be attributed to a neighbour.
 *
 * @param page - Clamped into the frame's pages.
 */
export function toLocalOn(rect: DOMRect, page: number): PagedRect|null {
  if (!current) return null;
  const index = Math.min(Math.max(page, 0), current.pages.length - 1);
  const p = current.pages[index];
  const s = current.scale;
  return { page: index, xPx: quantise((rect.left - p.left) / s), yPx: quantise((rect.top - p.top) / s), wPx: quantise(rect.width / s), hPx: quantise(rect.height / s) };
}

/**
 * One viewport x in untransformed page-local px, against a page named by index, or null with no frame.
 *
 * @param page - Clamped into the frame's pages.
 */
export function toLocalX( viewportX: number,  page: number): number|null {
  if (!current) return null;
  const p = current.pages[Math.min(Math.max(page, 0), current.pages.length - 1)];
  return quantise((viewportX - p.left) / current.scale);
}
