/**
 * `vectors/listMarkers.js` — the `disc`, `circle` and `square` list markers, drawn as the vectors Blink draws them.
 *
 * Blink paints these three symbol markers as shapes and not as glyphs: the marker's text (`■ `, `◦ `, `• `, from the UA counter-style table) is laid out so that its advance and its font are real, and then the painter draws a rectangle or an ellipse in place of it. Caster cannot ask a font for a glyph Blink never drew, so `adapters/reify.js` makes each marker an empty inline box with Blink's own margins and padding, and this module draws the shape inside that box.
 *
 * The geometry is Blink's, read from `third_party/blink/renderer/core/layout/list/list_marker.cc` (Chromium 153.0.8010.12). `ListMarker::RelativeSymbolMarkerRect` places the bullet at x = 1 and y = 3·(ascent − offset)/2 inside the marker box, with offset = ascent·2/3 and size = (offset + 1)/2, all integer division. The marker box is `WidthOfSymbol` = size + 2 wide; outside it starts `offset + kCMarkerPaddingPx + 1` (kCMarkerPaddingPx = 7) before the item's text and advances nothing; inside it starts 1 px before the text and advances `size + 2 + 1em`. `InlineMarginsForOutside` and `InlineMarginsForInside` answer those margins; `markerBox` is the same arithmetic, and Chromium 153's own print of `fixtures/list-markers` agrees with it to the pixel (measured 2026-10-14: ascent 12 at 12 px, bullets 4 × 4 px at y = baseline − 6).
 *
 * What is painted was also measured on Chromium's own print of the fixture (2026-10-14): a `square` is a filled rectangle of the bullet's size; a `disc` is a filled ellipse inscribed in it; a `circle` is an ellipse on the bullet's rectangle stroked at one CSS pixel, centred on the rectangle's edge.
 *
 * @packageDocumentation
 */

import { CasterError } from '../errors.ts';
import { PX_TO_PT } from '../coordinates/units.ts';
import { pageGeometryFor } from '../coordinates/pageGeometry.ts';
import { toPdfMatrix } from '../coordinates/ctm.ts';
import { roundedRectPath, transformPath } from './pathData.ts';
import { emptyNodeCommon, pageOfElement, parseCssColor, placeBox } from './vector.ts';
import type { VectorPathNode } from './vector.ts';

import type { ChainContext } from '../coordinates/ctm.ts';
import type { VectorRequest } from './vector.ts';
import type { PaintOrder } from '../walk/paintOrder.ts';

/** The attribute `adapters/reify.js` puts on a shape marker, naming the `list-style-type` it draws. */
export const SHAPE_ATTRIBUTE = 'data-caster-marker';

/** The attribute `adapters/reify.js` puts beside it: the font's ascent as Blink rounds it, which the geometry is a function of. */
export const ASCENT_ATTRIBUTE = 'data-caster-ascent';

/** The `list-style-type` values Blink paints as shapes. */
export const SHAPE_MARKERS = (['disc', 'circle', 'square'] as readonly string[]);

/** `kCMarkerPaddingPx` in Blink's `list_marker.cc`. */
const MARKER_PADDING_PX = 7;

/** One shape marker the walk made a `Lbl` for, with the element that carries it. */
export type ShapeMarker = {
  /** The reified marker span, or a twin of it when the engine rendered the original nowhere. */
  element: HTMLElement;
  /** The `Lbl` the marker belongs to, by structure path. */
  owner: string;
  domPath: string;
};

/**
 * The bullet's position and size inside the marker box, as Blink's `RelativeSymbolMarkerRect` computes them.
 *
 * @param ascent - The font's ascent in whole CSS pixels, Blink's rounded value.
 * @returns `offset` is the marker's own offset, `size` the bullet's side and `top` the bullet's distance below the marker box's top.
 */
export function bulletOf(ascent: number): { offset: number; size: number; top: number; } {
  const offset = Math.floor((ascent * 2) / 3);
  const size = Math.floor((offset + 1) / 2);
  return { offset, size, top: Math.floor((3 * (ascent - offset)) / 2) };
}

/**
 * The margins and padding that make an empty inline box exactly Blink's marker box.
 *
 * @remarks
 * The box's border box is what `getBoundingClientRect` answers for an inline element, so the padding is the box's width and the margins are the two sides `InlineMarginsForOutside` and `InlineMarginsForInside` give. An outside marker advances nothing, which is why the item's text does not move; an inside one advances `width + 1em - 1`, which is why it does.
 *
 * @param ascent - Blink's rounded ascent.
 * @param inside - `list-style-position: inside`.
 * @param fontPx - The marker's computed font size in CSS pixels.
 */
export function markerBox(ascent: number, inside: boolean, fontPx: number): { width: number; marginStart: number; marginEnd: number; } {
  const { offset, size } = bulletOf(ascent);
  const width = size + 2;
  return inside
    ? { width, marginStart: -1, marginEnd: fontPx }
    : { width, marginStart: -(offset + MARKER_PADDING_PX + 1), marginEnd: offset + MARKER_PADDING_PX + 1 - width };
}

/**
 * One shape marker's request for the measurement, drawn on the page its element is on.
 *
 * @remarks
 * The rectangle is read inside the chain builder's neutralised window, like every decoration, so the chain becomes the node's `cm` and the bullet is expressed in the untransformed space it was measured in. The bullet's rectangle is the marker box's left edge plus one pixel and the box's top plus `bulletOf(ascent).top`: an inline box's rectangle is its content area, whose top is the baseline less the ascent whatever the line height (measured 2026-10-14 at four line heights and five font sizes).
 *
 * @throws {CasterError} A marker whose ascent attribute is not a number; the reifier writes it, so that is a corrupted document.
 */
export function collectListMarkers(markers: ShapeMarker[], { order, chains, container }: { order: PaintOrder; chains: ChainContext; container: Element; }): { requests: VectorRequest[]; } {
  const requests: VectorRequest[] = [];
  const containerRect = container.getBoundingClientRect();
  for (const marker of markers) {
    const { element } = marker;
    const ascent = Number(element.getAttribute(ASCENT_ATTRIBUTE));
    const shape = element.getAttribute(SHAPE_ATTRIBUTE);
    if (!Number.isFinite(ascent) || !shape) throw new CasterError(`caster: the list marker at ${marker.domPath} carries no ${ASCENT_ATTRIBUTE}, so Blink's bullet cannot be placed`);
    const { size, top } = bulletOf(ascent);
    if (size <= 0) continue;
    const style = getComputedStyle(element);
    // `visibility` inherits into the span as it does into the native `::marker`, so a hidden list whose paragraphs are shown paints no bullet, and the span keeps the box the hidden marker keeps.
    if (style.visibility !== 'visible') continue;
    const box = element.getBoundingClientRect();
    const bullet: DOMRectReadOnly = ({ left: box.left + 1, top: box.top + top, width: size, height: size } as any);
    const page = pageOfElement(element, chains);
    const placement = placeBox(bullet, containerRect, page);
    // A disc and a circle are the ellipse inscribed in the bullet; a square is its own rectangle.
    const radius = shape === 'square' ? 0 : size / 2;
    const radii = ([[radius, radius], [radius, radius], [radius, radius], [radius, radius]] as [[number, number], [number, number], [number, number], [number, number]]);
    const path = transformPath(roundedRectPath(placement.box, radii), placement.toPage);
    const colour = parseCssColor(style.color);
    const chain = chains.chainOf(element);
    const cm = chain ? toPdfMatrix(chain.matrix, pageGeometryFor(placement.page)) : null;
    const common = { ...emptyNodeCommon(marker.domPath, shape), ...(cm ? { cm } : {}) };
    const node: VectorPathNode = shape === 'circle'
      ? { ...common, kind: 'path', path, fill: { kind: 'none' }, fillRule: 'nonzero', stroke: { kind: 'rgb', rgb: colour.rgb }, strokeStyle: { widthPt: PX_TO_PT, cap: 0, join: 0, miterLimit: 10, dashPt: [], dashPhasePt: 0, nonScaling: false }, opacity: 1, strokeOpacity: colour.alpha }
      : { ...common, kind: 'path', path, fill: { kind: 'rgb', rgb: colour.rgb }, fillRule: 'nonzero', stroke: { kind: 'none' }, strokeStyle: null, opacity: colour.alpha, strokeOpacity: 1, blend: 'Normal' };
    const paintIndex = order.content.get(element) ?? (element.parentElement ? order.content.get(element.parentElement) : undefined) ?? Number.MAX_SAFE_INTEGER;
    requests.push({ owner: marker.owner, element, domPath: marker.domPath, paintIndex, page: placement.page, node });
  }
  return { requests };
}
