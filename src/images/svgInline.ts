/**
 * `images/svgInline.js` — an SVG served as an `<img>` takes the vector road.
 *
 * Caster's own; no harness source — the experiments never met an `<img>` whose file was an SVG, so the decoder tiers of `images.md` (E7) were the only thing waiting for one and the last of them is `decodeThroughCanvas`. M9 is what that costs. `docs/assets/route.svg` carries a `viewBox` and no `width`/`height`, and a browser will not decode a bitmap from a document with no intrinsic size — `createImageBitmap` refuses with `InvalidStateError`, which escaped as a bare exception naming no element (*an SVG that arrives through an `<img>` is a drawing*, DESIGN.md S44).
 *
 * The refusal was the smaller half of the defect. The larger one is that the printer already paints an inline `<svg>` as vectors (`vectors/svgGeometry.js`), so rasterising the same drawing because it arrived through an `<img>` is the one thing the README says this printer never does in silence: a raster of a vector drawing, at whatever `rasterDpi` happens to be. So the bytes the gateway already fetched are parsed, the document is seated where the `<img>` stood, and the walk's image record becomes an `SvgRoot` under the same structure owner — the `Figure` the `<img>`'s `alt` already made, or the artifact its `alt=""` already made. Nothing about the structure tree changes; only which collector paints it.
 *
 * The seating is measured, not assumed. The `<svg>` replaces the `<img>` carrying the img's own used box — its computed `display`, `float`, `vertical-align`, `box-sizing`, margins, padding and border widths, with `width`/`height` pinned to the used content box and the min/max constraints neutralised because a used value has already honoured them. Layout must not move: every text rectangle in the document is measured after this runs. So the seated element's border box is compared against the one the `<img>` had, and a disagreement past a twentieth of a pixel is an export error naming the element rather than a page that is quietly somewhere else.
 *
 * What it refuses, each naming the element: bytes that do not parse as SVG, a root that is not `<svg>`, an `object-fit` other than `fill` or `contain`, a non-default `object-position`, and a seating that moved the box. What it does not do: `object-fit: fill` stretches a raster and the SVG default `preserveAspectRatio` (`xMidYMid meet`) does not, so a viewBox whose ratio differs from the box's is letterboxed where the browser would have stretched it — taken deliberately, because `meet` is what the file itself asks for and a stretched drawing is the guess this package does not make. A relative `href` or `url()` inside the fetched file resolves against the print document rather than against the file, since the document is grafted rather than framed; `vectors/svgGeometry.js` paints shapes, gradients, markers and text, so only a file reaching outside itself for a resource is affected, and it loses that resource the way an inline `<svg>` with a broken reference does.
 *
 * @packageDocumentation
 */

import { CasterError } from '../errors.ts';

import type { WalkImage, WalkResult } from '../walk/structure.ts';

/** The properties that decide where the `<img>`'s box is and how big it is. Paint properties are deliberately absent: `fill` copied off an `<img>`'s computed style is the initial black, and as an inline style on an `<svg>` root it would inherit into every child that declares none. */
const BOX_PROPERTIES = [
  'display', 'float', 'clear', 'vertical-align', 'box-sizing', 'position',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'
];

/** How far the seated `<svg>`'s border box may sit from the `<img>`'s before the seating is a refusal, in CSS px. A twentieth of a pixel is three orders of magnitude finer than the quarter-point the acceptance test asserts geometry at. */
const SEAT_TOLERANCE_PX = 0.05;

/**
 * Take every `<img>` whose file is an SVG off the raster road and put it on the vector one.
 *
 * @remarks
 * Called between the walk and `paintOrderOf`, which is the one window where it can be: the walk is what says which elements are images and what owns them, the bytes are already fetched (fetching reads no layout, so it sits outside the neutralised window of `coordinates-and-pages.md` (E10) in both directions), and `paintOrderOf` and `beginChains` must both see the element the collector will ask about.
 *
 * @param walk - Mutated: `images` loses the entries that moved, `svgs` gains them, `decorated` loses any element that left the document.
 * @returns What moved, for the report.
 * @throws {CasterError} Whatever {@link seat} refuses, naming the element.
 */
export function inlineSvgImages(walk: WalkResult, bytesBySrc: ReadonlyMap<string,{ bytes: Uint8Array; mimeType: string; }>): { domPath: string; src: string; }[] {
  const kept: WalkImage[] = [];
  const moved: { domPath: string; src: string; }[] = [];
  const left: Set<Element> = new Set<any>();
  for (const image of walk.images) {
    const source = bytesBySrc.get(image.src);
    const element = image.element;
    if (!source || source.mimeType !== 'image/svg+xml' || !isImageElement(element)) {
      kept.push(image);
      continue;
    }
    const svg = seat(element, source.bytes, image.domPath);
    left.add(element);
    walk.svgs.push({
      element: svg,
      owner: image.path,
      tag: image.tag,
      ...(image.alt === undefined ? {} : { alt: image.alt }),
      domPath: image.domPath
    });
    moved.push({ domPath: image.domPath, src: image.src });
  }
  if (moved.length === 0) return moved;
  walk.images = kept;
  // A detached element in `decorated` is a rectangle of zero width and zero height, which is the shape `vectors/cssBoxes.js` answers with three boundary pieces where every other box gives eight (*`boundaryPieces` answers three pieces for a zero-height box*, DESIGN.md S21). Nothing paints the `<img>`'s own border or background now — an inline `<svg>` has never had either painted here, because `decoratedElements` excludes anything inside an `<svg>` and an `<svg>` root is inside itself — so the two roads agree, and this keeps the list from holding a node the document no longer has.
  walk.decorated = walk.decorated.filter(( candidate: HTMLElement) => !left.has(candidate));
  return moved;
}

/**
 * Parse one file and put it where the `<img>` was.
 *
 * @throws {CasterError} An `<img>` in a document with no window; an `object-fit` other than `fill` or `contain`; a non-default `object-position`; bytes that do not parse as SVG; a seating that moved the box by more than {@link SEAT_TOLERANCE_PX}.
 */
function seat(img: HTMLImageElement, bytes: Uint8Array, domPath: string): SVGSVGElement {
  const doc = img.ownerDocument;
  const view = doc.defaultView;
  if (!view) throw new CasterError(`caster: the <img> at ${domPath} is in a document with no window, so nothing about it can be measured`, { element: domPath });
  const style = view.getComputedStyle(img);
  const fit = style.objectFit || 'fill';
  if (fit !== 'fill' && fit !== 'contain') {
    throw new CasterError(`caster: the SVG image at ${domPath} is laid out with object-fit: ${fit}, and this printer seats an SVG <img> as a drawing rather than as pixels — a drawing is fitted by the file's own preserveAspectRatio, which has no ${fit}. Use object-fit: contain, or give the file a width and a height of its own.`, { element: domPath });
  }
  const position = (style.objectPosition || '50% 50%').trim();
  if (position !== '50% 50%' && position !== 'center' && position !== 'center center') {
    throw new CasterError(`caster: the SVG image at ${domPath} declares object-position: ${position}, and a drawing seated from its viewBox is centred by preserveAspectRatio; there is nothing here that offsets it.`, { element: domPath });
  }

  const text = new TextDecoder().decode(bytes);
  const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = parsed.documentElement;
  if (parsed.getElementsByTagName('parsererror').length > 0 || !root || root.localName !== 'svg') {
    throw new CasterError(`caster: the file behind the <img> at ${domPath} (${img.currentSrc || img.src}) is served as image/svg+xml and does not parse as an SVG document; its root is <${root ? root.localName : 'nothing'}>`, { element: domPath });
  }
  const svg = ((doc.importNode(root, true) as unknown) as SVGSVGElement);
  // An `<img>` scales a file with no `viewBox` to its box, as if the viewBox were the file's own width and height (SVG 2, the synthesized viewBox of an image), where an inline `<svg>` crops it; so the seated drawing is given that viewBox, as long as both lengths are absolute (issue 3).
  const [w, h] = [svg.width.baseVal, svg.height.baseVal];
  if (!svg.hasAttribute('viewBox') && svg.hasAttribute('width') && svg.hasAttribute('height') && w.unitType !== w.SVG_LENGTHTYPE_PERCENTAGE && h.unitType !== h.SVG_LENGTHTYPE_PERCENTAGE)
    svg.setAttribute('viewBox', `0 0 ${w.value} ${h.value}`);

  const before = img.getBoundingClientRect();
  for (const property of BOX_PROPERTIES) svg.style.setProperty(property, style.getPropertyValue(property));
  // The used width and height, which have already honoured every min and max the cascade put on the `<img>`; the constraints are then taken off so they cannot apply a second time to a box that is now stated outright.
  svg.style.setProperty('width', style.width);
  svg.style.setProperty('height', style.height);
  svg.style.setProperty('max-width', 'none');
  svg.style.setProperty('max-height', 'none');
  svg.style.setProperty('min-width', '0');
  svg.style.setProperty('min-height', '0');
  // An engine that presents by slots (Cicero's `<beltype-root>`) shows a top-level node on its page only while a slot holds it, and a slot assigned by hand does not take the node that replaces one it held: the seated `<svg>` was connected, unstyled and 0 × 0 (issue 3). So the drawing takes the `<img>`'s place in that slot too.
  const slot = img.assignedSlot;
  const held = (slot?.assignedNodes() ?? []) as (Element | Text)[];
  img.replaceWith(svg);
  if (slot && (slot.getRootNode() as ShadowRoot).slotAssignment === 'manual') slot.assign(...held.map((node) => (node === img ? svg : node)));

  const after = svg.getBoundingClientRect();
  const off = Math.max(Math.abs(after.left - before.left), Math.abs(after.top - before.top), Math.abs(after.width - before.width), Math.abs(after.height - before.height));
  if (off > SEAT_TOLERANCE_PX) {
    throw new CasterError(`caster: seating the SVG image at ${domPath} as a drawing moved its box by ${off.toFixed(3)} px — the <img> occupied ${rectText(before)} and the <svg> occupies ${rectText(after)}. Every rectangle in this document is measured after the seating, so a box that moved is a page the printer would describe wrongly; give the image an explicit width and height in the venue's own stylesheet.`, { element: domPath });
  }
  return svg;
}

/**
 * Ask the browser for the faces the text of every SVG `<img>` is set in, so they are loaded before the pages are cut.
 *
 * @remarks
 * The browser draws an SVG image in a context of its own, with none of the document's faces, so a face only the drawing names is one the document never loads, and the font table reads only the faces the browser loaded (*the table reads the faces the browser loaded*, DESIGN.md S88). The drawing is seated at print time and needs the face then; but a face that loads during the print is news Cicero answers by cutting the document again, under the printer's feet (codeberg.org/BelType/caster issue 11). So the faces are asked for here, before the cut: each file is fetched (the image already brought it into the cache), parsed, and set for a moment in a hidden, empty box beside its `<img>`, where its text inherits what the seated drawing will inherit, so each `<text>`'s computed font names the face the drawing will ask for; the box is gone before anything awaits. A file that cannot be fetched or parsed is left to the print, which refuses it by name.
 *
 * @returns The `FontFaceSet.load()` requests, once every one has settled.
 */
export async function loadImageFaces(doc: Document): Promise<string[]> {
  const view = doc.defaultView;
  if (!view) return [];
  const requests: { font: string; text: string; }[] = [];
  for (const img of [...doc.querySelectorAll('img')]) {
    const src = isImageElement(img) ? img.currentSrc || img.src : '';
    if (!src) continue;
    let text;
    try {
      const response = await view.fetch(src);
      if (!response.ok || !/svg/i.test(response.headers.get('content-type') ?? '')) continue;
      text = await response.text();
    } catch {
      continue;
    }
    const root = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
    if (!img.isConnected || root?.localName !== 'svg' || !root.querySelector('text')) continue;
    const box = doc.createElement('span');
    box.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden';
    box.append(doc.importNode(root, true));
    img.before(box);
    for (const element of box.querySelectorAll('text, tspan')) {
      const style = view.getComputedStyle(element);
      requests.push({ font: `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`, text: element.textContent ?? '' });
    }
    box.remove();
  }
  await Promise.all(requests.map(({ font, text }) => doc.fonts.load(font, text).catch(() => [])));
  return requests.map(({ font }) => font);
}

/** A rectangle as `w×h at (x, y)`, for a refusal's message. */
function rectText(rect: DOMRect) {
  return `${rect.width.toFixed(2)}×${rect.height.toFixed(2)} at (${rect.left.toFixed(2)}, ${rect.top.toFixed(2)})`;
}

/** `instanceof HTMLImageElement` against the element's own realm: the print frame is a different realm from the app's, and a cross-realm `instanceof` is false for an element that is one. */
function isImageElement(element: Element): element is HTMLImageElement {
  return element.localName === 'img' && 'currentSrc' in element;
}
