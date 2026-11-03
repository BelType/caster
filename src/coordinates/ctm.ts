/**
 * `coordinates/ctm.js` — the in-page CTM chain: the transforms between a page element and something measured inside it, as one matrix the PDF can carry.
 *
 * Ported from `harness/src/export/ctm.ts` (E9, E10). Guide: `docs/guide/coordinates-and-pages.md` §"The CTM chain".
 *
 * WHAT THE PORT CHANGED. (1) `PerspectiveError` is `src/errors.js`'s, so it is a `BelTypeError` and carries the DOM path as `element`. (2) `PX_TO_PT` comes from `coordinates/units.js` rather than from a fixture (P3). (3) The container Caster hands `beginChains` is the strip — under Cicero `<beltype-root>`, Cicero's light DOM, where every author element that carries a `transform` lives. A continuation clone is appended into that same light DOM beside the originals (*a clone introduces no structure node*, S23), so it walks the ordinary way and picks up whatever transforms its source's ancestors carry.
 *
 * The harness's own header follows.
 *
 * The in-page CTM chain of `coordinates-and-pages.md` (E10): the transforms between a page element and something measured inside it, as one matrix the PDF can carry.
 *
 * The container's own scale is not in here. That is recovered and divided out by `frame.ts` before any coordinate reaches this module, so a chain built at a preview scale of 0.5 is the same six numbers as the one built at scale 1 — which is the property the experiment set out to prove, expressed as an absence rather than as a factor. What is in here is everything an author put in the document: a rotated header cell, a scaled figure, a nested rotation with a translated span inside it.
 *
 * For every ancestor between the page element and the measured node whose computed `transform` is not `none`,
 *     M = T(−origin) · transform · T(+origin)
 * with `origin` from `transform-origin` resolved against that element's border box in page-local px, and the chain is the product from the innermost outwards — `p · M_inner · M_mid · M_outer` — because CSS applies an element's own transform first and then everything its ancestors do to it. Translation that came from layout rather than from a transform is already in the rects and is not part of the chain; that is the whole reason the rects have to be read with the transforms neutralised.
 *
 * Which is the other half of this module. A transform does not affect layout, so setting every transformed ancestor's `transform` to `none` for the length of one measurement pass gives the untransformed geometry the chain is expressed against, and restores to exactly what was there before — the same trick `imagePlace.ts` has used since E7 (`images.md`) for a single rotated image, applied to a whole subtree and held open for one frame instead of one rectangle.
 *
 * The alternative the plan proposes — take the Range rect as painted and map it back through `chain⁻¹` — is computed beside it and recorded, because it is only correct when the chain maps axis-aligned rectangles to axis-aligned rectangles. `Range.getClientRects` gives the *bounding box* of a rotated run, so at a quarter turn the inverse of the box is the box and the two agree, and at five degrees the box is bigger than the run in both axes and no inverse recovers it. The numbers are in the exit notes.
 *
 * @packageDocumentation
 */
import { IDENTITY, apply, mul } from './matrix.ts';
import { PX_TO_PT } from './units.ts';
import { pageRectOf } from '../measure/textMeasure.ts';
import { PerspectiveError, CasterError } from '../errors.ts';
import type { Matrix } from '../images/imagePlace.ts';
import type { PageGeometry } from './pageGeometry.ts';

/** One transformed ancestor on a chain, and the matrix it contributes. */
export type ChainLink = {
  /** A short identifier for the element, for the report and for a warning. */
  path: string;
  /** The computed `transform`, verbatim. */
  transform: string;
  /** `transform-origin` resolved to page-local px. */
  originPx: [number, number];
  /** `T(-origin) . transform . T(+origin)`, then the snap Blink gives the box's paint offset, in page-local px. */
  matrix: Matrix;
  /** The leftover fraction of the box's paint offset its own painting and its descendants keep, per axis (`subpixel_accumulation`); zero on an axis the transform cannot carry it through. */
  subpixel: [number, number];
};

/** A node's whole chain: the product, and the links it was folded from, outermost first. */
export type ChainResult = {
  matrix: Matrix;
  links: ChainLink[];
};

/** What one element's computed style said before anything was neutralised. */
export type CapturedStyle = {
  transform: string;
  transformOrigin: string;
  transformBox: string;
  transformStyle: string;
  perspective: string;
};

/** The chains of a whole container, built in one pass with the transforms neutralised. */
export type ChainContext = {
  /** The chain for a node's nearest transformed ancestors; null when identity. */
  chainOf: (element: Element) => ChainResult|null;
  /** The leftover fraction of a transformed element's snapped paint offset, which its own box is painted at (`snapBox`); null for an element with no transform. */
  subpixelOf: (element: Element) => [number, number]|null;
  /** The element's own computed `transform`, as captured before neutralisation. */
  transformOf: (element: Element) => string;
  /** The page element a node belongs to, as the caller named it. */
  pageElementOf: (element: Element) => HTMLElement|null;
  /** `transform-box` and `transform-style` values the MVP ignored. */
  warnings: string[];
  /** Restore every inline transform. Idempotent. */
  end: () => void;
  /** Take them off again. The measurement pass has to step outside the neutralised window once — to read the painted bounding box the inverse method starts from — and step back into it for the baseline probes, which have to read the same untransformed geometry everything else did. */
  reapply: () => void;
};

/** A 3-D transform or a perspective, which a flat page cannot carry. Re-exported under the harness's name so a port site reads the same (P5). */
export { PerspectiveError };
/** Whether a matrix is exactly the identity. */
export const isIdentityMatrix = ( m: Matrix): boolean => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
/** Round to three decimals, the precision of every operand in the file. */
const round3 = ( n: number): number => Math.round(n * 1000) / 1000;
/**
 * `matrix(a, b, c, d, e, f)` as computed; `matrix3d` is refused, not flattened.
 *
 * @throws {PerspectiveError} The value is a `matrix3d`.
 * @throws {CasterError} The value does not read as six numbers.
 */
function parseTransform(value: string, path: string): Matrix {
    if (!value || value === 'none')
        return IDENTITY;
    if (value.startsWith('matrix3d'))
        throw new PerspectiveError(`caster: ${path} carries ${JSON.stringify(value)}, which is a three-dimensional transform; a PDF content stream has a 2-D CTM and nothing that flattens a perspective is a measurement`, { element: path });
    const numbers = value.match(/-?[\d.eE+]+/g)?.map(Number) ?? [];
    if (numbers.length >= 6)
        return [numbers[0], numbers[1], numbers[2], numbers[3], numbers[4], numbers[5]];
    throw new CasterError(`caster: cannot read the transform ${JSON.stringify(value)} on ${path}`, { element: path });
}
/** A computed CSS length's px number; 0 where it does not parse. */
const px = ( value: string): number => {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : 0;
};
/** A short path for an element, for an error message and the report. */
function describe(element: Element) {
    const id = element.id ? `#${element.id}` : '';
    const cls = element.classList.length > 0 ? `.${[...element.classList].join('.')}` : '';
    return `${element.tagName.toLowerCase()}${id}${cls}`;
}
/**
 * The inverse of an affine `[a b c d e f]`.
 *
 * @throws {CasterError} The matrix is singular.
 */
export function invert(m: Matrix): Matrix {
    const det = m[0] * m[3] - m[1] * m[2];
    if (Math.abs(det) < 1e-12)
        throw new CasterError(`caster: the matrix [${m.join(' ')}] is singular and cannot be inverted`);
    return [
        m[3] / det,
        -m[1] / det,
        -m[2] / det,
        m[0] / det,
        (m[2] * m[5] - m[3] * m[4]) / det,
        (m[1] * m[4] - m[0] * m[5]) / det,
    ];
}
/**
 * CSS px relative to a page element's top-left, to PDF points on that page.
 *
 * @remarks
 * The same map `imagePlace.ts` calls `PIXELS_TO_PAGE`, taken per page rather than from the constants of `text-emission.md` (E3), because the pages of E10 (`coordinates-and-pages.md`) are not all the same size.
 */
export const pixelsToPage = ( geometry: PageGeometry): Matrix => ([
    PX_TO_PT,
    0,
    0,
    -PX_TO_PT,
    geometry.marginPt,
    geometry.heightPt - geometry.marginPt,
] as Matrix);
/**
 * A chain measured in page-local px, as the `cm` a PDF content stream carries.
 *
 * @remarks
 * The content inside the wrapper is written in the exporter's ordinary page points — the numbers the untransformed measurement produced — so the matrix has to be conjugated into that space: undo the pixel-to-point map, apply the chain, put the map back. Six numbers to three decimals, which is the same precision every other operand in the file carries.
 */
export function toPdfMatrix(chain: Matrix, geometry: PageGeometry): Matrix {
    const s = pixelsToPage(geometry);
    return (mul(mul(invert(s), chain), s).map(round3) as Matrix);
}
/**
 * Blink's `LayoutUnit::Round()` on a length in CSS px at a device pixel ratio: the length on the 1/64 grid of device pixels, rounded half toward plus infinity, back in CSS px.
 *
 * @remarks
 * `FixedPoint::Round()` (`platform/geometry/layout_unit.h`, Chromium 153). Blink lays out in device pixels (zoom for the device scale factor), so a print at one device pixel a CSS px snaps to whole CSS px and a screen at two to half ones (measured 2026-11-03 in Caster's Chromium 153 at device scale factors 1, 2 and 4: a rotated box's painted centre within 0.04 CSS px of this rule at each).
 */
export function snapLength(v: number, devicePixelRatio: number): number {
    return Math.floor(Math.round(v * devicePixelRatio * 64) / 64 + 0.5) / devicePixelRatio;
}

/**
 * `UpdateForPaintOffsetTranslation` (`core/paint/paint_property_tree_builder.cc`, Chromium 153) for a transformed box: its accumulated paint offset rounded to a device pixel, the shift that rounding moves the box by, and the fraction it keeps on the axes it may.
 *
 * @remarks
 * `paint_offset_translation = ToRoundedVector2d(paint_offset)`, and `subpixel_accumulation = paint_offset - rounded` is kept on an axis `CanPropagateSubpixelAccumulation` allows and zeroed on another. On a kept axis the box paints at the fraction inside the translated space, so it lands where it was laid out; on a zeroed one it lands on the rounded offset. The transform origin is not rounded.
 *
 * @param offset - The box's paint offset in its paint offset root's space, in CSS px.
 * @param keep - Per axis, whether the fraction passes through the transform.
 */
export function snapPaintOffset(offset: [number, number], keep: [boolean, boolean], devicePixelRatio: number): { shift: [number, number]; subpixel: [number, number] } {
    const rounded = offset.map((v) => snapLength(v, devicePixelRatio));
    const fraction = [offset[0] - rounded[0], offset[1] - rounded[1]];
    return {
        shift: [keep[0] ? 0 : -fraction[0], keep[1] ? 0 : -fraction[1]],
        subpixel: [keep[0] ? fraction[0] : 0, keep[1] ? fraction[1] : 0],
    };
}

/**
 * The box's own border box as Blink paints it, `ToPixelSnappedRect` at the fraction its paint offset kept: the corner rounded, each side `SnapSizeToPixel`.
 *
 * @remarks
 * `core/layout/geometry/physical_rect.h` and `layout_unit.h`, Chromium 153: a side is `(fraction + size).Round() - fraction.Round()`. In page-local px, where the box's laid-out corner is where the kept fraction sits.
 */
export function snapBox(box: { x: number; y: number; w: number; h: number }, subpixel: [number, number], devicePixelRatio: number): { x: number; y: number; w: number; h: number } {
    const side = (fraction: number, size: number) => snapLength(fraction + size, devicePixelRatio) - snapLength(fraction, devicePixelRatio);
    return {
        x: box.x - subpixel[0] + snapLength(subpixel[0], devicePixelRatio),
        y: box.y - subpixel[1] + snapLength(subpixel[1], devicePixelRatio),
        w: side(subpixel[0], box.w),
        h: side(subpixel[1], box.h),
    };
}

/** Paint containment, or style and layout containment together: `NeedsIsolationNodes`, which resets the paint offset and carries no fraction through. */
function isolates(style: CSSStyleDeclaration): boolean {
    const contain = style.contain.split(/\s+/);
    return contain.includes('paint') || contain.includes('strict') || contain.includes('content') || (contain.includes('style') && contain.includes('layout'));
}

/** `will-change: transform`, `scale` or `rotate`: `kPreventingSubpixelAccumulationReasons`. */
const preventsSubpixel = (style: CSSStyleDeclaration): boolean => /\b(transform|scale|rotate)\b/u.test(style.willChange);

/** `CanPropagateSubpixelAccumulation` for a box with a transform: identity or translation keeps both axes, scale and translation an axis whose scale is 1, anything else neither. */
function keepsSubpixel(element: Element, matrix: Matrix): [boolean, boolean] {
    const style = getComputedStyle(element);
    if (preventsSubpixel(style) || isolates(style))
        return [false, false];
    if (matrix[1] !== 0 || matrix[2] !== 0)
        return [false, false];
    return [matrix[0] === 1, matrix[3] === 1];
}

/**
 * The nearest ancestor, in the flat tree, that owns a paint offset translation, which a box's paint offset is measured from; null for the document.
 *
 * @remarks
 * `NeedsPaintOffsetTranslation`'s triggers that a page reaches: a transform, paint isolation (a Cicero page is `contain: layout size paint`) and `will-change` on a transform property.
 * ponytail: scrollers, sticky and fixed boxes, reference filters, backdrop filters and `backface-visibility: hidden` also own one in Blink and are not looked for; add them when a document puts a transformed box inside one.
 */
function paintOffsetRoot(element: Element, captured: Map<Element, CapturedStyle>): Element|null {
    for (let node = flatParent(element); node; node = flatParent(node)) {
        if (node === document.documentElement || node === document.body)
            return null;
        const transform = captured.get(node)?.transform ?? getComputedStyle(node).transform;
        if (transform !== 'none' && transform !== '')
            return node;
        const style = getComputedStyle(node);
        if (style.display !== 'contents' && (isolates(style) || preventsSubpixel(style)))
            return node;
    }
    return null;
}

/** An element's parent in the flat tree: its assigned slot, or its parent, crossing a shadow root to its host. */
export function flatParent(node: Element): Element|null {
    if (node.assignedSlot)
        return node.assignedSlot;
    const parent = node.parentNode;
    return parent instanceof ShadowRoot ? parent.host : parent instanceof Element ? parent : null;
}

/**
 * Capture every transform in the container, neutralise them, and build each transformed ancestor's link in one burst of reads.
 *
 * @remarks
 * The transforms stay neutralised until the returned context's `end()`; `index.js` opens one for the whole export, because a second would capture the `transform: none` the first wrote.
 *
 * @param pageElementOf - Where each node's chain stops.
 * @throws {PerspectiveError} An element carries a `perspective` or a `matrix3d`.
 * @throws {CasterError} A computed transform does not read as a matrix.
 */
export function beginChains(container: HTMLElement, pageElementOf: (element: Element) => HTMLElement|null): ChainContext {
    const captured: Map<Element,CapturedStyle> = new Map<any, any>();
    const warnings: string[] = [];
    const capture = ( element: Element) => {
        // Only HTML elements outside any `<svg>`. An SVG `transform` — on a `<g>`, on a `<use>`, on a nested `<svg>` — is part of the picture's own coordinate system, `getScreenCTM()` is what composes it, and `svgGeometry.ts` is what reads it; neutralising it here would replace a presentation attribute with an inline `transform: none` and flatten the drawing. This module is about the CSS transforms an HTML ancestor puts between a page element and whatever is painted inside it, and nothing else.
        if (!(element instanceof HTMLElement) || element.closest('svg') !== null)
            return;
        const style = getComputedStyle(element);
        captured.set(element, {
            transform: style.transform,
            transformOrigin: style.transformOrigin,
            transformBox: style.transformBox,
            transformStyle: style.transformStyle,
            perspective: style.perspective,
        });
    };
    capture(container);
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode())
        capture((node as Element));
    const transformed: HTMLElement[] = [];
    for (const [element, style] of captured) {
        if (style.perspective !== 'none' && style.perspective !== '') {
            throw new PerspectiveError(`caster: ${describe(element)} carries perspective: ${style.perspective}, which is a three-dimensional transform; a PDF content stream has a 2-D CTM and nothing that flattens a perspective is a measurement`, { element: describe(element) });
        }
        if (style.transform === 'none' || style.transform === '')
            continue;
        if (style.transform.startsWith('matrix3d'))
            throw new PerspectiveError(`caster: ${describe(element)} carries ${JSON.stringify(style.transform)}, which is a three-dimensional transform; a PDF content stream has a 2-D CTM and nothing that flattens a perspective is a measurement`, { element: describe(element) });
        // `transform-box` and `transform-style` are read and ignored in the MVP, which is a decision rather than an oversight, so a fixture that sets either of them says so in the record instead of silently measuring against a box this module did not use.
        if (style.transformBox !== 'view-box' && style.transformBox !== 'border-box') {
            warnings.push(`${describe(element)}: transform-box ${style.transformBox} ignored`);
        }
        if (style.transformStyle !== 'flat')
            warnings.push(`${describe(element)}: transform-style ${style.transformStyle} ignored`);
        transformed.push((element as HTMLElement));
    }
    const savedInline = transformed.map((element) => ({ element, had: element.style.transform !== '', value: element.style.transform }));
    for (const element of transformed)
        element.style.transform = 'none';
    // One burst of reads, with the whole subtree untransformed: every link's border box and therefore every link's origin comes from one layout.
    const linkByElement: Map<Element,ChainLink> = new Map<any, any>();
    const linkOf = (element: Element): ChainLink => {
        const done = linkByElement.get(element);
        if (done)
            return done;
        const style = (captured.get(element) as CapturedStyle);
        const path = describe(element);
        const pageElement = pageElementOf(element);
        const box = element.getBoundingClientRect();
        const local = pageRectOf(box, (pageElement ?? container).getBoundingClientRect());
        const [originX, originY] = style.transformOrigin.trim().split(/\s+/).map(px);
        const originPx: [number,number] = [local.xPx + originX, local.yPx + originY];
        const cssMatrix = parseTransform(style.transform, path);
        // The paint offset is snapped before the transform is applied, in the space of the nearest ancestor that owns a paint offset translation, and the snap moves everything the box paints: a translation after the link (Egildo's ruling 17 of the Rust writer).
        const scale = box.width > 0 ? local.wPx / box.width : 1;
        const root = paintOffsetRoot(element, captured);
        const rootRect = root?.getBoundingClientRect();
        const rootSubpixel: [number, number] = root && transformedSet.has(root) ? linkOf(root).subpixel : [0, 0];
        const offset: [number, number] = rootRect
            ? [(box.left - rootRect.left) * scale + rootSubpixel[0], (box.top - rootRect.top) * scale + rootSubpixel[1]]
            : [(box.left + window.scrollX) * scale, (box.top + window.scrollY) * scale];
        const snap = snapPaintOffset(offset, keepsSubpixel(element, cssMatrix), window.devicePixelRatio || 1);
        const matrix: Matrix = mul(mul(mul([1, 0, 0, 1, -originPx[0], -originPx[1]], cssMatrix), [1, 0, 0, 1, originPx[0], originPx[1]]), [1, 0, 0, 1, snap.shift[0], snap.shift[1]]);
        const link: ChainLink = { path, transform: style.transform, originPx, matrix, subpixel: snap.subpixel };
        linkByElement.set(element, link);
        return link;
    };
    const transformedSet = new Set<Element>(transformed);
    for (const element of transformed)
        linkOf(element);
    let ended = false;
    return {
        chainOf( element: Element) {
            const pageElement = pageElementOf(element);
            const links: ChainLink[] = [];
            let node: Element|null = element;
            for (; node && node !== pageElement && node !== container.parentElement; node = node.parentElement) {
                const link = linkByElement.get(node);
                if (link)
                    links.push(link);
            }
            if (links.length === 0)
                return null;
            // `links` runs innermost first, and `mul(a, b)` is "a then b", so folding it in that order is exactly `p · M_inner · … · M_outer`.
            let matrix: Matrix = IDENTITY;
            for (const link of links)
                matrix = mul(matrix, link.matrix);
            return { matrix, links: [...links].reverse() };
        },
        subpixelOf( element: Element) {
            return linkByElement.get(element)?.subpixel ?? null;
        },
        transformOf( element: Element) {
            return captured.get(element)?.transform ?? 'none';
        },
        pageElementOf,
        warnings,
        end() {
            if (ended)
                return;
            ended = true;
            for (const saved of savedInline) {
                if (saved.had)
                    saved.element.style.transform = saved.value;
                else
                    saved.element.style.removeProperty('transform');
            }
        },
        reapply() {
            if (!ended)
                return;
            ended = false;
            for (const element of transformed)
                element.style.transform = 'none';
        },
    };
}
/**
 * The rectangle the inverse method recovers: the four corners of the painted bounding box, mapped back through `chain⁻¹`, taken as an axis-aligned box.
 *
 * @throws {CasterError} The chain is singular.
 */
export function inverseRectOf(chain: Matrix, painted: { xPx: number; yPx: number; wPx: number; hPx: number; }): { xPx: number; yPx: number; wPx: number; hPx: number; } {
    const back = invert(chain);
    const corners: [number,number][] = [
        apply(back, painted.xPx, painted.yPx),
        apply(back, painted.xPx + painted.wPx, painted.yPx),
        apply(back, painted.xPx + painted.wPx, painted.yPx + painted.hPx),
        apply(back, painted.xPx, painted.yPx + painted.hPx),
    ];
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    return {
        xPx: Math.min(...xs),
        yPx: Math.min(...ys),
        wPx: Math.max(...xs) - Math.min(...xs),
        hPx: Math.max(...ys) - Math.min(...ys),
    };
}
