/**
 * `vectors/blendIsolation.js` — the isolation boundary of a blend: the box whose stacking context a blend mode mixes with, made a transparency group of its own around everything it paints (Egildo's ruling 15a of the Rust writer, 2026-11-03).
 *
 * @remarks
 * Chromium blends an element with its stacking context and nothing outside it. `NeedsEffectIgnoringClipPathAnd2DScale` (`core/paint/paint_property_tree_builder.cc`, Chromium 153) gives a box an effect node, an isolated group, when it `HasLayer() && IsStackingContext()` and its layer `HasNonIsolatedDescendantWithBlendMode()`; `LayoutObject::IsStackingContext` is `ComputedStyle::IsStackingContextWithoutContainment()` (`core/style/computed_style.cc`: a transform-related property, `ForcesStackingContext` for the document element and a z-index that applies, a stacking grouping property, a fixed or sticky position, `will-change` that would create one) or layout or paint containment. An inline `<svg>` root is none of these by itself: `LayoutSVGRoot::LayerTypeRequired` forces a layer only "so the parent layer will know if there are non-isolated descendants with blend mode", so a blend inside a plain `<svg>` mixes with the HTML stacking context around it (measured in Caster's Chromium 153: a `difference` circle in an `<svg>` over a red `<div>` shows 204, 153, 153, and 0, 153, 204 once the `<svg>` has `isolation: isolate`).
 *
 * In the list the boundary is one isolated group holding every vector request inside the box, in paint order; the writer gives such a group the document's sRGB profile as its `/CS` when it holds a blend. A blend whose boundary is the page (a Cicero page is `contain: layout size paint`) or the document is left on the page, and the writer gives that page a group in sRGB. So is a boundary this cannot wrap whole: one that holds text or a replaced element, which the list paints outside any group, one that crosses a page, or one whose requests belong to more than one structure element.
 *
 * @packageDocumentation
 */
import { flatParent } from '../coordinates/ctm.ts';
import { apply } from '../coordinates/matrix.ts';
import { bboxOf } from './cssBoxes.ts';
import { emptyNodeCommon, holdsOpenBlend } from './vector.ts';
import type { VectorNode, VectorRequest } from './vector.ts';

/** What the boundary search needs from the walk. */
export type BlendIsolationOptions = {
  /** The page element a node belongs to. */
  pageElementOf: (element: Element) => HTMLElement|null;
  /** The element's computed `transform` as captured before `beginChains` neutralised it. */
  transformOf: (element: Element) => string;
  /** The element's DOM path, as the collectors name it. */
  domPathOf: (element: Element) => string;
};

/** `LayoutObject::IsStackingContext` for an HTML box, from its computed style. */
export function isStackingContext(element: Element, transformOf: (element: Element) => string): boolean {
  if (element === document.documentElement) return true;
  const style = getComputedStyle(element);
  if (style.display === 'contents' || style.display === 'none') return false;
  const none = (value: string | undefined) => !value || value === 'none';
  const transform = transformOf(element);
  const parent = element.parentElement ? getComputedStyle(element.parentElement).display : '';
  const contain = style.contain.split(/\s+/u);
  return (
    !none(transform) || !none(style.translate) || !none(style.rotate) || !none(style.scale) || !none(style.perspective) || style.transformStyle === 'preserve-3d'
    || Number.parseFloat(style.opacity) < 1 || !none(style.filter) || !none(style.clipPath) || style.isolation === 'isolate' || !none(style.maskImage) || style.mixBlendMode !== 'normal' || !none(style.backdropFilter)
    || style.position === 'fixed' || style.position === 'sticky'
    || (style.zIndex !== 'auto' && (style.position !== 'static' || /\b(flex|grid)\b/u.test(parent)))
    || /\b(transform|translate|rotate|scale|perspective|opacity|filter|clip-path|mask|isolation|mix-blend-mode|backdrop-filter)\b/u.test(style.willChange)
    || contain.some((value) => value === 'layout' || value === 'paint' || value === 'strict' || value === 'content')
  );
  // ponytail: animations, the top layer and view transitions also make a stacking context in Blink and are not looked for; a print has none of them running.
}

/** Whether `ancestor` is `node` or holds it, in the flat tree. */
function holds(ancestor: Element, node: Element): boolean {
  for (let at: Element|null = node; at; at = flatParent(at)) if (at === ancestor) return true;
  return false;
}

/** Whether the box paints something the list draws outside any group: text, or a replaced element. */
function paintsOutsideVectors(box: Element): boolean {
  if (box instanceof SVGSVGElement) return box.querySelector('text') !== null;
  if (box.querySelector('img, svg, canvas, video, picture, iframe, object, embed, math') !== null) return true;
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) if ((text.textContent ?? '').trim() !== '') return true;
  return false;
}

/** A node's bounds in its parent's space: its own bounds under its chain. */
function boundsInParent(node: VectorNode): [number, number, number, number] {
  const [llx, lly, urx, ury] = bboxOf([node]);
  if (!node.cm) return [llx, lly, urx, ury];
  const corners = [apply(node.cm, llx, lly), apply(node.cm, urx, lly), apply(node.cm, urx, ury), apply(node.cm, llx, ury)];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * The vector requests with every blend's isolation boundary made one isolated group, where the boundary is a box inside the page that the list can wrap whole.
 *
 * @remarks
 * A request is left as it was when no blend in it reaches past it. The group takes the place, the paint index and the owner of the first request inside the box in paint order, or of the box's own decoration when it paints one.
 */
export function isolateBlends(requests: VectorRequest[], options: BlendIsolationOptions): VectorRequest[] {
  let out = requests;
  const wrapped = new Set<VectorRequest>();
  for (;;) {
    const open = out.find((request) => holdsOpenBlend(request.node) && !wrapped.has(request));
    if (!open) return out;
    wrapped.add(open);
    // A blend on the request's own node mixes with the box around its element; one inside it, with the element's own box when that isolates.
    let box: Element|null = open.node.blend !== 'Normal' ? flatParent(open.element) : open.element;
    while (box && !(box instanceof HTMLElement || box instanceof SVGSVGElement ? isStackingContext(box, options.transformOf) : false)) box = flatParent(box);
    const page = options.pageElementOf(open.element);
    if (!box || (page && holds(box, page))) continue;
    const boundary = box;
    const inside = out.filter((request) => holds(boundary, request.element));
    const owners = new Set(inside.map((request) => request.owner));
    if (inside.some((request) => request.page !== open.page) || paintsOutsideVectors(boundary) || (inside.length > 1 && [...owners].some((owner) => !owner.startsWith('artifact:')))) continue;
    const ordered = [...inside].sort((a, b) => a.paintIndex - b.paintIndex);
    const head = ordered.find((request) => request.element === boundary) ?? ordered[0];
    const domPath = options.domPathOf(boundary);
    const children = ordered.map((request) => request.node);
    const bounds = children.map(boundsInParent);
    const group: VectorRequest = {
      owner: head.owner,
      element: boundary,
      domPath,
      paintIndex: ordered[0].paintIndex,
      page: open.page,
      node: {
        ...emptyNodeCommon(domPath, 'isolation'),
        kind: 'group',
        children,
        bboxPt: [Math.min(...bounds.map((b) => b[0])), Math.min(...bounds.map((b) => b[1])), Math.max(...bounds.map((b) => b[2])), Math.max(...bounds.map((b) => b[3]))],
        forceForm: true,
        formReason: `the stacking context a blend mode mixes with, isolated at ${domPath}`,
      },
    };
    wrapped.add(group);
    const at = out.indexOf(ordered[0]);
    out = out.filter((request) => !inside.includes(request));
    out.splice(Math.min(at, out.length), 0, group);
  }
}
