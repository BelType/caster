/**
 * `walk/paintOrder.js` — CSS painting order over the walked tree.
 *
 * Ported from `harness/src/export/paintOrder.ts` (E9). Guide: `docs/guide/vector-painting.md` §"Painting order".
 *
 * WHAT THE PORT CHANGED. One placement, and it is Caster's own finding rather than the harness's: an inline box's decoration goes down with the block backgrounds, in step 4, where Appendix E puts it in step 7.2.1 — the reason is at the line in `paintOrderOf` that does it. `'css'` is the default flag since 2026-09-08 (`options.js`'s `paintOrder`).
 *
 * The harness's own header follows.
 *
 * The painting order of `vector-painting.md` (E9): CSS 2.1 Appendix E, for the subset a page can build.
 *
 * Every experiment before this one painted in DOM order, and for a document with no positioning and no overlap that is the same order CSS asks for. It stops being the same order the moment anything overlaps: a block's background belongs before *every* line of text in the stacking context, not merely before its own, and a `z-index: 1` box that appears early in the DOM has to paint over a sibling that appears late. So the order is computed here, out of the computed styles, and the emitter is given a number per element rather than a rule to re-derive.
 *
 * Two numbers per element, not one. An element's *decoration* — its background, its borders, its outline — and its *content* — its text, its images, its inline SVG — are painted in different phases of the same stacking context, and an element that carried a single index could not be in both. That separation is the whole reason the switch changes any stream at all, and it is why the option exists: the experiments before E9 (`vector-painting.md`), E3 through E8, keep `'dom'` and stay byte for byte what they were, while E9 and anything after it get `'css'`.
 *
 * The structure tree is untouched by any of this. Reading order is DOM order, always (`structure-tree.md`, E5); this decides only which ink goes down first, and where the two disagree the tags carry the reading and the stream carries the painting.
 *
 * @packageDocumentation
 */
import { CasterError } from '../errors.ts';

/** Which of an element's two paint indexes an entry is. */
export type PaintPhaseKind = 'decoration'|'content';
/** The Appendix E phase an entry came out of, named as the specification names it. */
export type PaintPhase = 'root-background'|'negative-z'|'block-background'|'float'|'inline'|'positioned-z0'|'positive-z';

/**
 * The three buckets a child can be *hoisted* into.
 *
 * @remarks
 * Appendix E's step 4 and step 6 both say the same awkward thing: a float, and a positioned element with `z-index: auto`, are painted as if they created a stacking context, "except that positioned descendants and descendants which actually create a new stacking context should be considered part of the parent stacking context". So such an element gets its own six phases for everything ordinary, and hands its stacking-context and positioned children back up to whoever really is the stacking context. Without that, a `z-index: 1` box inside a `position: relative` wrapper would paint in tree order inside the wrapper rather than on top of the page, which is exactly the case the fixture's tenth box exists to catch.
 */
export type Hoist = {
  negative: Bucket[];
  positioned: Bucket[];
  positive: Bucket[];
};

/** One phase of one element, placed. */
export type PaintOrderEntry = {
  element: Element;
  /** The element's DOM path under the container; '' for the container itself. */
  path: string;
  kind: PaintPhaseKind;
  phase: PaintPhase;
  /** Position in the emitted order, which is the number the emitter sorts on. */
  index: number;
  /** The stacking context the entry was painted inside. */
  context: string;
};
/** One stacking context the walk found, and what made it one. */
export type StackingContextRecord = {
  path: string;
  /** The declaration that made it a stacking context, as {@link stackingReason} words it. */
  reason: string;
  zIndex: string;
  position: string;
};
/** A container's paint order: every entry, and each element's two indexes looked up by element. */
export type PaintOrder = {
  entries: PaintOrderEntry[];
  decoration: Map<Element, number>;
  content: Map<Element, number>;
  contexts: StackingContextRecord[];
  /** The emitted order as element paths, `<path>#<kind>`, for the report. */
  order: string[];
};
/** One stacking context's entries, with the two keys it is sorted into its parent's step by. */
export type Bucket = {
  z: number;
  /** Tree order among the parent's buckets, the tie-break for an equal `z`. */
  tree: number;
  entries: RawEntry[];
};
/** An entry before its index is known. */
export type RawEntry = {
  element: Element;
  kind: PaintPhaseKind;
  phase: PaintPhase;
  context: Element;
};

import { domPathOf } from '../measure/textMeasure.ts';
/** Whether the element takes part in block layout, as the engine computed it. */
function displayOf(style: CSSStyleDeclaration): string {
    return style.display;
}
/** Whether a computed `display` places the box in an inline formatting context. */
const isInlineLevel = (display: string): boolean => display.startsWith('inline') || display === 'ruby' || display === 'contents';
/**
 * Why this element is a stacking context, or the empty string.
 *
 * @remarks
 * The list is the subset a fixture can exercise and no more. `will-change`, `contain`, `backdrop-filter`, `perspective` and the grid/flex `z-index` special cases are all real and all absent, because an order walker that claimed to implement rules it was never run against would be a claim rather than a finding.
 */
function stackingReason(element: Element, style: CSSStyleDeclaration, isRoot: boolean): string {
    if (isRoot)
        return 'the container the exporter was handed';
    const position = style.position;
    const zIndex = style.zIndex;
    if (position !== 'static' && zIndex !== 'auto')
        return `position: ${position} with z-index: ${zIndex}`;
    if (position === 'fixed' || position === 'sticky')
        return `position: ${position}`;
    if (Number.parseFloat(style.opacity) < 1)
        return `opacity: ${style.opacity}`;
    if (style.transform !== 'none')
        return `transform: ${style.transform}`;
    if (style.mixBlendMode !== 'normal')
        return `mix-blend-mode: ${style.mixBlendMode}`;
    if (style.isolation === 'isolate')
        return 'isolation: isolate';
    if (style.filter !== 'none')
        return `filter: ${style.filter}`;
    return '';
}
/**
 * The paint order of one container.
 *
 * @remarks
 * The walk is a straight transcription of Appendix E's seven steps, run once per stacking context and spliced into its parent's step 2, 6 or 7 by `z-index`. Inside a step, entries stay in tree order, which is what makes the result stable and what makes a diff of two runs a diff of the fixture.
 */
export function paintOrderOf(container: HTMLElement): PaintOrder {
    const contexts: StackingContextRecord[] = [];
    let treeCounter = 0;
    /**
     * Appendix E's seven steps over one stacking context, or over one hoisted element inside one.
     *
     * @param hoist - The real stacking context's buckets, for a float or a `z-index: auto` positioned element; null when `root` is a stacking context itself.
     */
    const collect = (root: Element, isRoot: boolean, hoist: Hoist|null): RawEntry[] => {
        const style = getComputedStyle(root);
        if (hoist === null) {
            contexts.push({
                path: isRoot ? '' : domPathOf(root, container),
                reason: stackingReason(root, style, isRoot),
                zIndex: style.zIndex,
                position: style.position,
            });
        }
        // Appendix E's seven steps, in order.
        const ownPhase: PaintPhase = hoist ? 'positioned-z0' : 'root-background';
        const ownBackground: RawEntry[] = [{ element: root, kind: 'decoration', phase: ownPhase, context: root }];
        const own: Hoist = { negative: [], positioned: [], positive: [] };
        const target = hoist ?? own;
        const blockBackgrounds: RawEntry[] = [];
        const floats: RawEntry[] = [];
        const inlines: RawEntry[] = [{ element: root, kind: 'content', phase: hoist ? 'positioned-z0' : 'inline', context: root }];
        const descend = (parent: Element) => {
            for (const child of parent.children) {
                const childStyle = getComputedStyle(child);
                const display = displayOf(childStyle);
                if (display === 'none')
                    continue;
                const reason = stackingReason(child, childStyle, false);
                if (reason !== '') {
                    const z = Number.parseFloat(childStyle.zIndex);
                    const bucket: Bucket = { z: Number.isFinite(z) ? z : 0, tree: treeCounter++, entries: collect(child, false, null) };
                    if (Number.isFinite(z) && z < 0)
                        target.negative.push(bucket);
                    else if (Number.isFinite(z) && z > 0)
                        target.positive.push(bucket);
                    // A stacking context with `z-index: auto` or `0` paints in step 6, whether it was positioning, opacity or a transform that made it one: CSS Color 4 and CSS Transforms 1 both say "as if it were a positioned element with z-index: 0".
                    else
                        target.positioned.push(bucket);
                    continue;
                }
                if (childStyle.position !== 'static') {
                    target.positioned.push({ z: 0, tree: treeCounter++, entries: collect(child, false, target) });
                    continue;
                }
                if (childStyle.float !== 'none') {
                    floats.push(...collect(child, false, target).map((entry) => ({ ...entry, phase: 'float' } as RawEntry)));
                    continue;
                }
                if (isInlineLevel(display)) {
                    // An inline box's decoration goes down with the block backgrounds, not beside its own content, and the reason is a property of the measurement rather than a reading of Appendix E. A text run takes the paint index of the block it belongs to (`measure/textMeasure.js`, `paintIndexOf(p, 'content')` over `blocks`) — the exporter has no per-inline content index to give a glyph — so an inline entry pushed here, after its containing block's own content entry, is an index the text can never come before. Measured: a `<code>` with a background inside a table cell had its rounded rect emitted after the word it wraps and painted the word out, on a document with nothing overlapping and nothing positioned.
                    // Appendix E puts it in step 7.2.1, after the floats of step 5; this puts it in step 4 with the block backgrounds. The two orders differ only where an inline background overlaps a float, and that difference is a smaller error than a background that erases its own text.
                    blockBackgrounds.push({ element: child, kind: 'decoration', phase: 'inline', context: root });
                    inlines.push({ element: child, kind: 'content', phase: 'inline', context: root });
                    descend(child);
                    continue;
                }
                blockBackgrounds.push({ element: child, kind: 'decoration', phase: 'block-background', context: root });
                inlines.push({ element: child, kind: 'content', phase: 'inline', context: root });
                descend(child);
            }
        };
        descend(root);
        const flatten = (buckets: Bucket[], phase: PaintPhase): RawEntry[] => [...buckets]
            .sort((a, b) => a.z - b.z || a.tree - b.tree)
            .flatMap((bucket) => bucket.entries.map((entry) => ({ ...entry, phase: entry.context === root ? phase : entry.phase })));
        // A hoisted element keeps its own steps 1, 3, 4 and 5 and has no 2, 6 or 7 of its own: those children went to the real stacking context above it.
        return [
            ...ownBackground,
            ...(hoist ? [] : flatten(own.negative, 'negative-z')),
            ...blockBackgrounds,
            ...floats,
            ...inlines,
            ...(hoist ? [] : flatten(own.positioned, 'positioned-z0')),
            ...(hoist ? [] : flatten(own.positive, 'positive-z')),
        ];
    };
    const raw = collect(container, true, null);
    const decoration = new Map<any, any>();
    const content = new Map<any, any>();
    const entries: PaintOrderEntry[] = raw.map((entry, index) => {
        const path = entry.element === container ? '' : domPathOf(entry.element, container);
        if (entry.kind === 'decoration')
            decoration.set(entry.element, index);
        else
            content.set(entry.element, index);
        return {
            element: entry.element,
            path,
            kind: entry.kind,
            phase: entry.phase,
            index,
            context: entry.context === container ? '' : domPathOf(entry.context, container),
        };
    });
    return {
        entries,
        decoration,
        content,
        contexts,
        order: entries.map((entry) => `${entry.path}#${entry.kind}`),
    };
}
