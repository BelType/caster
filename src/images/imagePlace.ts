/**
 * `images/imagePlace.js` — where the browser put the image, expressed as one `cm` matrix.
 *
 * Ported from `harness/src/export/imagePlace.ts` (E7, E10, E12F). Guide: `docs/guide/images.md` §"Placement: four matrices, composed in PDF order".
 *
 * WHAT THE PORT CHANGED (P3). The four constants the harness imported from `e3-fixture.ts` come from `../coordinates/units.js` now; see that module for why the fallback geometry survives at all.
 *
 * The harness's own header follows.
 *
 * Where the browser put the image, expressed as one `cm` matrix.
 *
 * An image in a PDF is always drawn into the unit square: `w 0 0 h x y cm` followed by `/Im0 Do` paints the whole image into the rectangle that matrix maps [0,1]² onto, with the image's first row along the top edge. Everything CSS did to the picture — the content box, `object-fit`, `object-position`, a `transform`, and the EXIF orientation the engine already applied — therefore has to arrive as a single 3×2 matrix, and anything that cannot be folded into one has to arrive as a clip path beside it.
 *
 * Four matrices are composed, in this order, all in PDF's row-vector convention where `mul(A, B)` means "A, then B":
 *
 *   E    the EXIF orientation, a map of the unit square onto itself; the browser has already applied it to what it painted, so the PDF has to apply it too or the passed-through bytes come out sideways.
 *   M0   the unit square onto the untransformed painted rectangle, in CSS pixels measured from the top-left of the column.
 *   T    the computed CSS `transform`, about `transform-origin`, in the same pixel space.
 *   S    CSS pixels to PDF points, which is where the y axis turns over.
 *
 * The clip path is built in the same pixel space and pushed through `T · S`, so a rotated image clips along its own rotated edges rather than along a box the page never had.
 *
 * Nothing here resamples. The intrinsic pixels go in whatever they are, and the effective DPI is recorded so a later experiment can decide whether that was a good idea for a 6000-pixel photograph in a 200-point box.
 *
 * @packageDocumentation
 */
import { COLUMN_WIDTH_PX, MARGIN_PT, PAGE_HEIGHT_PT, PX_TO_PT } from '../coordinates/units.ts';
import { pageIndexAt } from '../coordinates/frame.ts';
import { pageGeometryFor } from '../coordinates/pageGeometry.ts';
import { pageRectOf } from '../measure/textMeasure.ts';
import { CasterError } from '../errors.ts';
import { IDENTITY, apply, mul } from '../coordinates/matrix.ts';

import type { Matrix } from '../coordinates/matrix.ts';
import type { PathSegment } from '../displayList.ts';
export type { PathSegment } from '../displayList.ts';

export type { Matrix } from '../coordinates/matrix.ts';


/**
 * The eight EXIF orientations as maps of the image's unit square onto the displayed unit square.
 *
 * @remarks
 * Derived rather than copied. For orientation 6 the displayed image is the stored one rotated ninety degrees clockwise, so `dest(r, c) = src(H−1−c, r)`; writing that in normalised coordinates and inverting gives displayed `a = t`, `b = 1 − s`, which is `[0 −1 1 0 0 1]`. The other seven follow the same way. Only 6 is exercised by the fixture; the rest are here because a table with holes in it is a trap.
 */
export const EXIF_MATRIX: Record<number,Matrix> = {
  1: [1, 0, 0, 1, 0, 0],
  2: [-1, 0, 0, 1, 1, 0],
  3: [-1, 0, 0, -1, 1, 1],
  4: [1, 0, 0, -1, 0, 1],
  5: [0, -1, -1, 0, 1, 1],
  6: [0, -1, 1, 0, 0, 1],
  7: [0, 1, 1, 0, 0, 0],
  8: [0, 1, -1, 0, 1, 0],
};

/** Whether an orientation swaps the two axes, i.e. whether stored w×h displays as h×w. */
export const exifSwapsAxes = (orientation: number): boolean => orientation >= 5 && orientation <= 8;

/** A rectangle in CSS pixels, measured from the top-left of the column it landed in. */
export type RectPx = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type PlacedImage = {
  /** The column the image landed in, which is the PDF page. */
  page: number;
  /** The content box, in CSS pixels relative to the column. */
  contentBoxPx: RectPx;
  /** Where the image itself is drawn, before any transform. May exceed the content box. */
  imageRectPx: RectPx;
  /** The painted rectangle in PDF points, `[x y w h]`, origin bottom-left. This is the `/BBox`. */
  paintedRectPt: [number, number, number, number];
  /** The clip rectangle in points when the image overflows its content box. */
  clipRectPt?: [number, number, number, number];
  /** The clip path, present when the image overflows or the element is rounded. */
  clipPath?: PathSegment[];
  /** Why there is a clip, for the record. */
  clipReason?: string;
  /** The one matrix a `cm` operator carries. */
  cm: Matrix;
  /** E10 (`coordinates-and-pages.md`): the ancestor chain folded into it, in page-local px; absent when identity. */
  chain?: Matrix;
  /** Intrinsic pixels as the browser reports them, i.e. after EXIF. */
  displayedIntrinsic: [number, number];
  /** Intrinsic pixels as the file stores them; differs when EXIF swaps the axes. */
  storedIntrinsic: [number, number];
  /** Intrinsic width over painted width, in pixels per inch. */
  effectiveDpi: number;
  exifOrientation: number;
  /** E12F (`images.md`): the computed `image-orientation`, present only when it is `none`. */
  imageOrientation?: string;
  /** E12F (`images.md`): the orientation the file's own EXIF tag carries, when it was ignored. */
  declaredExifOrientation?: number;
  objectFit: string;
  objectPosition: string;
  /** The computed `transform`, or `none`. */
  transform: string;
  /** True unless `image-rendering` asked for the pixels unsmoothed. */
  interpolate: boolean;
};

export type PlaceOptions = {
  /** The stored pixel size, from the file's own header. */
  storedIntrinsic: [number, number];
  /** EXIF orientation the browser already applied; 1 for everything else. */
  exifOrientation?: number;
  /** The box the image occupies, when the element is not an `<img>`. A background paints over the padding box, and a `<canvas>` fills its content box; both are handed in rather than guessed. */
  box?: 'content' | 'padding';
  /** E10 (`coordinates-and-pages.md`): the element's own computed `transform`, captured before the measurement pass neutralised it. Without it the transform is read here, which is right for every caller that did not neutralise anything. */
  transform?: string;
  /** E10 (`coordinates-and-pages.md`): the CTM chain the element's transformed ancestors contribute, in page-local px. Composed after the element's own transform and before the pixel-to-point map, so a scaled figure inside a rotated block lands where the browser painted it. */
  chain?: Matrix;
  /** DESIGN.md S80: a caller that knows the element is not a replaced element — a facsimile, whose canvas is contained in its box — names the fit, and the computed `object-fit` (which does not apply to it) is not read. */
  objectFit?: string;
  /** *a rectangle belongs to the page its node was assigned to* (DESIGN.md S27): the page the engine assigned the element to. Named, the box is expressed against that page; omitted, the box's own origin decides. */
  page?: number|null;
};

/** The kappa that makes four cubic Béziers a circle to within a thousandth of a radius. */
const KAPPA = 0.5523;

const px = (value: string): number => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * `matrix(a, b, c, d, e, f)` or `matrix3d(...)` as computed, or the identity.
 *
 * @throws {CasterError} A computed transform that is neither `none`, `matrix()` nor `matrix3d()`.
 */
function parseTransform(value: string): Matrix {
  if (!value || value === 'none') return IDENTITY;
  const numbers = value.match(/-?[\d.eE+]+/g)?.map(Number) ?? [];
  if (value.startsWith('matrix3d') && numbers.length === 16) {
    // The 2-D part of a 3-D matrix is the only part a flat page can carry.
    return [numbers[0], numbers[1], numbers[4], numbers[5], numbers[12], numbers[13]];
  }
  if (numbers.length >= 6) return [numbers[0], numbers[1], numbers[2], numbers[3], numbers[4], numbers[5]];
  throw new CasterError(`imagePlace: cannot read the transform ${JSON.stringify(value)}`);
}

/** `object-position` as two lengths inside a free box of size `free`. */
function positionOffset(value: string, freeX: number, freeY: number): [number,number] {
  // A `calc()` holds spaces of its own, so the split is a match rather than a `split(/\s+/)`: `calc(100% - 10px) 50%` is two tokens and not four.
  const parts = value.trim().match(/calc\([^)]*\)|\S+/g) ?? [];
  const one = (token: string, free: number): number => {
    // `object-position: right 10px bottom 20px` computes to `calc(100% - 10px)`, which is the form the browser hands back and the only form the two-value grammar's four-value spelling ever arrives in. Read as a plain length it gave NaN, which fell to 0 and pinned the image to the top-left corner.
    const calc = /^calc\(\s*([-\d.]+)%\s*([+-])\s*([-\d.]+)px\s*\)$/i.exec(token);
    if (calc) return (Number.parseFloat(calc[1]) / 100) * free + (calc[2] === '-' ? -1 : 1) * Number.parseFloat(calc[3]);
    if (token.endsWith('%')) return (Number.parseFloat(token) / 100) * free;
    if (token === 'left' || token === 'top') return 0;
    if (token === 'center') return free / 2;
    if (token === 'right' || token === 'bottom') return free;
    return px(token);
  };
  return [one(parts[0] ?? '50%', freeX), one(parts[1] ?? parts[0] ?? '50%', freeY)];
}

/**
 * The rectangle the image is drawn into, from `object-fit` and `object-position`.
 *
 * @throws {CasterError} An image with no intrinsic size, or an `object-fit` this printer does not know.
 */
export function fitRect(box: RectPx, intrinsicW: number, intrinsicH: number, objectFit: string, objectPosition: string): { rect: RectPx; overflows: boolean; } {
  if (intrinsicW <= 0 || intrinsicH <= 0) throw new CasterError('imagePlace: an image with no intrinsic size');
  const scaleContain = Math.min(box.w / intrinsicW, box.h / intrinsicH);
  const scaleCover = Math.max(box.w / intrinsicW, box.h / intrinsicH);

  let w;
  let h;
  if (objectFit === 'fill') {
    w = box.w;
    h = box.h;
  } else if (objectFit === 'contain') {
    w = intrinsicW * scaleContain;
    h = intrinsicH * scaleContain;
  } else if (objectFit === 'cover') {
    w = intrinsicW * scaleCover;
    h = intrinsicH * scaleCover;
  } else if (objectFit === 'none') {
    w = intrinsicW;
    h = intrinsicH;
  } else if (objectFit === 'scale-down') {
    const scale = Math.min(1, scaleContain);
    w = intrinsicW * scale;
    h = intrinsicH * scale;
  } else {
    throw new CasterError(`imagePlace: object-fit ${JSON.stringify(objectFit)} is not one this exporter knows`);
  }

  const [offsetX, offsetY] = positionOffset(objectPosition, box.w - w, box.h - h);
  const rect: RectPx = { x: box.x + offsetX, y: box.y + offsetY, w, h };
  // A hair of tolerance: `contain` on a box whose ratio matches the image is exactly flush, and a rounding error there must not invent a clip. All four edges are tested: an `object-position` past the right or the bottom of the box moves the image out on that side without changing its size, so the left and top tests alone said nothing had overflowed while the image hung off the page.
  const overflows =
    w > box.w + 0.01 ||
    h > box.h + 0.01 ||
    rect.x < box.x - 0.01 ||
    rect.y < box.y - 0.01 ||
    rect.x + w > box.x + box.w + 0.01 ||
    rect.y + h > box.y + box.h + 0.01;
  return { rect, overflows };
}

/**
 * The four radii the computed style gives, clamped so opposite pairs fit the box.
 *
 * @remarks
 * Two corrections to what this read before. A corner radius is two tokens — `border-radius: 20px / 10px` computes each corner to `20px 10px` — and only the first was read, so an elliptical corner was drawn circular at its horizontal radius and a percentage on the vertical half was resolved against the box's width. And the radius the computed style gives is the border box's, while the box an image is clipped to is the content box: the inner radius is the outer one less the border and the padding on each of the corner's two sides, floored at zero (CSS Backgrounds 3 §5.1), so a 6 px radius on a box with a 4 px border used to round the image by 6.
 *
 * @param inset - The border plus padding on each side, which is what separates the border box the radius is declared on from the box being clipped.
 */
export function borderRadii(style: CSSStyleDeclaration, box: RectPx, inset?: { top: number; right: number; bottom: number; left: number; }): [number,number,number,number] {
  const one = (value: string, insetX: number, insetY: number): number => {
    const tokens = value.trim().split(/\s+/);
    const horizontal = tokens[0] ?? '0px';
    const vertical = tokens[1] ?? tokens[0] ?? '0px';
    const rx = horizontal.endsWith('%') ? (Number.parseFloat(horizontal) / 100) * box.w : px(horizontal);
    const ry = vertical.endsWith('%') ? (Number.parseFloat(vertical) / 100) * box.h : px(vertical);
    // One number per corner is what `boxPath` draws, so an elliptical corner is drawn at the smaller of its two radii rather than at its horizontal one alone — a circle inside the ellipse, which never clips ink the browser painted.
    return Math.max(0, Math.min(rx - insetX, ry - insetY));
  };
  const pad = inset ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const radii: [number,number,number,number] = [
    one(style.borderTopLeftRadius, pad.left, pad.top),
    one(style.borderTopRightRadius, pad.right, pad.top),
    one(style.borderBottomRightRadius, pad.right, pad.bottom),
    one(style.borderBottomLeftRadius, pad.left, pad.bottom),
  ];
  const scale = Math.min(
    1,
    box.w / Math.max(radii[0] + radii[1], 1e-6),
    box.w / Math.max(radii[3] + radii[2], 1e-6),
    box.h / Math.max(radii[0] + radii[3], 1e-6),
    box.h / Math.max(radii[1] + radii[2], 1e-6),
  );
  return (radii.map((r) => r * scale) as [number, number, number, number]);
}

/** A rectangle, or a rounded one, as a path in CSS pixels; the caller maps it to points. */
function boxPath(box: RectPx, radii: [number,number,number,number]): { op: string; points: [number,number][]; }[] {
  const [tl, tr, br, bl] = radii;
  const { x, y, w, h } = box;
  if (tl === 0 && tr === 0 && br === 0 && bl === 0) {
    return [
      { op: 'm', points: [[x, y]] },
      { op: 'l', points: [[x + w, y]] },
      { op: 'l', points: [[x + w, y + h]] },
      { op: 'l', points: [[x, y + h]] },
      { op: 'h', points: [] },
    ];
  }
  const k = KAPPA;
  return [
    { op: 'm', points: [[x + tl, y]] },
    { op: 'l', points: [[x + w - tr, y]] },
    { op: 'c', points: [[x + w - tr + tr * k, y], [x + w, y + tr - tr * k], [x + w, y + tr]] },
    { op: 'l', points: [[x + w, y + h - br]] },
    { op: 'c', points: [[x + w, y + h - br + br * k], [x + w - br + br * k, y + h], [x + w - br, y + h]] },
    { op: 'l', points: [[x + bl, y + h]] },
    { op: 'c', points: [[x + bl - bl * k, y + h], [x, y + h - bl + bl * k], [x, y + h - bl]] },
    { op: 'l', points: [[x, y + tl]] },
    { op: 'c', points: [[x, y + tl - tl * k], [x + tl - tl * k, y], [x + tl, y]] },
    { op: 'h', points: [] },
  ];
}

/** CSS pixels relative to the column, to PDF points with y running up the page. */
export const PIXELS_TO_PAGE: Matrix = [PX_TO_PT, 0, 0, -PX_TO_PT, MARGIN_PT, PAGE_HEIGHT_PT - MARGIN_PT];

/**
 * The same map for one page of a document whose pages are not all one size.
 *
 * @remarks
 * E10 (`coordinates-and-pages.md`) installs a per-page geometry; without one this is `PIXELS_TO_PAGE` to the bit, which is what keeps every placement E7 (`images.md`) and E8 (`colour.md`) wrote unchanged.
 */
function pixelsToPageFor(page: number): Matrix {
  const geometry = pageGeometryFor(page);
  return [PX_TO_PT, 0, 0, -PX_TO_PT, geometry.marginPt, geometry.heightPt - geometry.marginPt];
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

const roundMatrix = (m: Matrix): Matrix => (m.map(round3) as Matrix);

/**
 * Measure one image element.
 *
 * @remarks
 * The layout box is read with the element's own `transform` forced to `none` for the length of one `getBoundingClientRect`, because a rotated element's bounding rectangle is the axis-aligned box *around* the rotation and carries neither the position nor the size the transform was applied to. The inline style is put back exactly as it was found, including having been absent.
 *
 * @throws {CasterError} A box laid out as more than one fragment — the engine broke it across a page; and whatever {@link fitRect} refuses.
 */
export function placeImage(element: HTMLElement, containerRect: DOMRect, options: PlaceOptions): PlacedImage {
  const style = getComputedStyle(element);
  const transform = options.transform ?? style.transform;

  const hadInlineTransform = element.style.transform !== '';
  const inlineTransform = element.style.transform;
  element.style.transform = 'none';
  const borderBox = element.getBoundingClientRect();
  if (hadInlineTransform) element.style.transform = inlineTransform;
  else element.style.removeProperty('transform');

  const wantsPaddingBox = options.box === 'padding';
  const left = px(style.borderLeftWidth) + (wantsPaddingBox ? 0 : px(style.paddingLeft));
  const top = px(style.borderTopWidth) + (wantsPaddingBox ? 0 : px(style.paddingTop));
  const right = px(style.borderRightWidth) + (wantsPaddingBox ? 0 : px(style.paddingRight));
  const bottom = px(style.borderBottomWidth) + (wantsPaddingBox ? 0 : px(style.paddingBottom));

  const boxRect = new DOMRect(
    borderBox.left + left,
    borderBox.top + top,
    borderBox.width - left - right,
    borderBox.height - top - bottom,
  );
  // A block can fragment at a column break, and `getBoundingClientRect` then answers with the union of its fragments — a rectangle the width of the gap between two columns, which is not a box anything was painted into. An image that straddles a break is a case v1 does not build, and it says so rather than placing a rectangle the size of the page.
  //
  // What asks the question changed, and it changed because reading the union's two corners answered it wrongly under Cicero. The harness inferred fragmentation from the two corners landing in different columns, which on a horizontal strip is a fair inference; on a vertical stack it is not, because a straddling block's tail is laid out below the cut and only clipped (*R5's clip boundary is `.flow`, not `.content-area`*, DESIGN.md S22; *a rectangle belongs to the page its node was assigned to*, S27), so an unfragmented image inside such a tail has a bottom edge inside the next page's band and was refused for a break it had not crossed. `getClientRects()` answers the question directly — a fragmented box has more than one — and the two page indices are kept for the message, which is the one thing they were ever right about.
  const fragments = element.getClientRects().length;
  if (fragments > 1) {
    const firstColumn = pageIndexAt(borderBox.left, borderBox.top) ?? Math.floor((borderBox.left - containerRect.left) / COLUMN_WIDTH_PX);
    const lastColumn = pageIndexAt(borderBox.right - 0.01, borderBox.bottom - 0.01) ?? Math.floor((borderBox.right - containerRect.left - 0.01) / COLUMN_WIDTH_PX);
    throw new CasterError(
      `imagePlace: the box of ${element.tagName.toLowerCase()} is laid out as ${fragments} fragments, pages ${firstColumn} to ${lastColumn}, so the engine broke it across a page break; give it break-inside: avoid`,
    );
  }

  const paged = pageRectOf(boxRect, containerRect, options.page ?? null);
  const box: RectPx = { x: paged.xPx, y: paged.yPx, w: paged.wPx, h: paged.hPx };

  // E12F (`images.md`): `image-orientation: none` tells the engine to ignore the EXIF tag, and an engine that ignored it displayed the stored pixels in the stored order — so the exporter has to ignore it too, or it would rotate an image the browser did not. The file's own tag is still what the caller handed in; this is the one place the *used* orientation and the *stored* one differ, and the record keeps both.
  const declaredOrientation = options.exifOrientation ?? 1;
  const imageOrientation = (style.imageOrientation || 'from-image').trim();
  const exifOrientation = imageOrientation === 'none' ? 1 : declaredOrientation;
  const [storedW, storedH] = options.storedIntrinsic;
  const displayed: [number,number] = exifSwapsAxes(exifOrientation) ? [storedH, storedW] : [storedW, storedH];

  const objectFit = options.objectFit ?? (style.objectFit || 'fill');
  const objectPosition = style.objectPosition || '50% 50%';
  const { rect: imageRect, overflows } = fitRect(box, displayed[0], displayed[1], objectFit, objectPosition);

  const radii = borderRadii(style, box, { top, right, bottom, left });
  const rounded = radii.some((r) => r > 0);

  // M0: the image's unit square, y up, onto the untransformed painted rect in CSS pixels with y down. The image's top row is t = 1, so d is negative.
  const m0: Matrix = [imageRect.w, 0, 0, -imageRect.h, imageRect.x, imageRect.y + imageRect.h];

  // T: the CSS transform about its origin, in the same pixel space.
  const cssMatrix = parseTransform(transform);
  const [originX, originY] = (style.transformOrigin || '0px 0px').trim().split(/\s+/).map(px);
  const originPx: [number,number] = [box.x + (originX - left), box.y + (originY - top)];
  const t: Matrix =
    cssMatrix === IDENTITY
      ? IDENTITY
      : mul(mul([1, 0, 0, 1, -originPx[0], -originPx[1]], cssMatrix), [1, 0, 0, 1, originPx[0], originPx[1]]);

  const exif = EXIF_MATRIX[exifOrientation] ?? IDENTITY;
  // E10 (`coordinates-and-pages.md`): whatever the element's transformed ancestors do sits between the element's own transform and the pixel-to-point map, because that is the order CSS applies them in.
  const chain = options.chain ?? IDENTITY;
  const pixelsToPage = pixelsToPageFor(paged.page);
  const cm = roundMatrix(mul(mul(mul(mul(exif, m0), t), chain), pixelsToPage));

  const toPage = mul(mul(t, chain), pixelsToPage);
  const clipBoxPx = box;
  let clipPath: PathSegment[]|undefined;
  let clipReason: string|undefined;
  if (overflows || rounded) {
    clipReason = [overflows ? `object-fit: ${objectFit} overflows the content box` : '', rounded ? 'border-radius' : '']
      .filter((r) => r !== '')
      .join(' and ');
    clipPath = boxPath(clipBoxPx, radii).map((segment) => {
      const mapped = segment.points.map(([x, y]) => (apply(toPage, x, y).map(round3) as [number, number]));
      if (segment.op === 'm') return ({ op: 'm', to: mapped[0] } as PathSegment);
      if (segment.op === 'l') return ({ op: 'l', to: mapped[0] } as PathSegment);
      if (segment.op === 'c') return ({ op: 'c', c1: mapped[0], c2: mapped[1], to: mapped[2] } as PathSegment);
      return ({ op: 'h' } as PathSegment);
    });
  }

  // The painted rect in points is the axis-aligned box around the four corners of the placed image, which is what a /BBox has to be even when the image is rotated.
  const corners: [number,number][] = [apply(cm, 0, 0), apply(cm, 1, 0), apply(cm, 1, 1), apply(cm, 0, 1)];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const paintedRectPt: [number,number,number,number] = [
    round3(Math.min(...xs)),
    round3(Math.min(...ys)),
    round3(Math.max(...xs) - Math.min(...xs)),
    round3(Math.max(...ys) - Math.min(...ys)),
  ];

  const clipCorners: [number,number][] = [
    apply(toPage, clipBoxPx.x, clipBoxPx.y),
    apply(toPage, clipBoxPx.x + clipBoxPx.w, clipBoxPx.y),
    apply(toPage, clipBoxPx.x + clipBoxPx.w, clipBoxPx.y + clipBoxPx.h),
    apply(toPage, clipBoxPx.x, clipBoxPx.y + clipBoxPx.h),
  ];
  const clipXs = clipCorners.map((c) => c[0]);
  const clipYs = clipCorners.map((c) => c[1]);

  const rendering = style.imageRendering;
  const interpolate = rendering !== 'pixelated' && rendering !== 'crisp-edges';

  return {
    page: paged.page,
    contentBoxPx: box,
    imageRectPx: imageRect,
    paintedRectPt,
    ...(clipPath
      ? {
          clipRectPt: ([
            round3(Math.min(...clipXs)),
            round3(Math.min(...clipYs)),
            round3(Math.max(...clipXs) - Math.min(...clipXs)),
            round3(Math.max(...clipYs) - Math.min(...clipYs)),
          ] as [number, number, number, number]),
          clipPath,
          clipReason,
        }
      : {}),
    cm,
    ...(options.chain ? { chain: options.chain } : {}),
    displayedIntrinsic: displayed,
    storedIntrinsic: [storedW, storedH],
    effectiveDpi: Math.round(((displayed[0] * 96) / Math.max(imageRect.w, 1e-6)) * 10) / 10,
    exifOrientation,
    ...(imageOrientation === 'none' ? { imageOrientation, declaredExifOrientation: declaredOrientation } : {}),
    objectFit,
    objectPosition,
    transform,
    interpolate,
  };
}
