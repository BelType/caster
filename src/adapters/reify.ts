/**
 * `adapters/reify.js` — reification: the text a pseudo-element paints, made a real element the walk can see.
 *
 * Caster's own; no harness source — PLAN.md D9 and *reification is one primitive with two moments* (DESIGN.md S49), *reification's second moment is real*, S52. Guide: `docs/guide/structure-tree.md` §"The engine contract".
 *
 * D9 of PLAN.md named this as one of the print preparation's three jobs; *reification is one primitive with two moments* (DESIGN.md S49) makes it a primitive of its own, because it has two moments. Before pagination it runs over the author's content — `h2::before { content: counter(h2) ". " }`, `li::marker` — so the pages an engine lays out contain what it made. After pagination it runs again over what the paginator made: Paged.js writes `.pagedjs_margin-content::after { content: counter(page) }`, a footnote call's `::after { content: counter(footnote) }` and a footnote body that is `display: list-item` with a `::marker` reading its own counter, and none of that exists until the pages do. One function, whole-document, idempotent, is what lets the same call serve both moments.
 *
 * Three rules, and the reason each is shaped as it is.
 *
 * 1. **`::before` and `::after` on every element.** `getComputedStyle` answers `content` in specified form — `counter(h2) ". "`, never `3. ` — so the counters are resolved by the walk itself. CSS counters are a property of the walk and not of an element: `counter-reset` on an element creates a counter in scope for that element, its descendants and its following siblings, which is why a scope is popped when the walk leaves the resetting element's parent rather than the element itself, and why the walk is one pass in document order over the whole tree — `counter(page)` on a margin cell must see every `.pagedjs_page { counter-increment: page }` before it. The pseudo is suppressed by one injected rule keyed on a class, because an element has no way to address its own pseudo from an inline style; and there is one class per pseudo, because a rule killing both took away a decorative `h2::after` the author also wrote, in silence.
 *
 * 2. **`::marker` on every element whose computed `display` is `list-item`, and not on the tag.** `docs/guide/structure-tree.md` §"The engine contract": `::marker` paints a glyph no marked-content sequence can claim, so a real `<span class="marker">` goes first in the item with the text the marker painted, and the native marker is taken away with `display: block` — without touching `list-style-type`, which `walk/structure.js`'s `LIST_NUMBERING` still reads `/ListNumbering` from. Keying on the display type rather than on `<li>` is what reaches a footnote body, and what leaves alone an `li` an author made `display: inline` for a horizontal nav — which paints no marker either. Where the computed `content` is `normal` — Chromium's answer for every ordinary counter marker — the text is derived from `list-style-type` and the item's ordinal among its list-item siblings (the list's `start`, `reversed` and each item's `value` honoured), which is the fallback D9 names. Where it is anything else it goes through the same resolver as rule 1, so `::marker { content: counter(footnote-marker) ". " }` reads the walk's counters.
 *
 * A shape marker — `disc`, `circle`, `square` — is no text at all, because Blink paints it as a shape: its span is an empty inline box whose margins and padding are Blink's own marker box (`vectors/listMarkers.js`, `markerBox`), and the shape is drawn inside it at print time.
 *
 * 3. **A pseudo that reads a value the engine has not delivered yet waits** (*a pseudo that reads a value the engine delivers is made real after the run*, DESIGN.md S79). Cicero rewrites `target-counter()`, `target-counters()` and `target-text()` into `var(--beltype-read-…, "")` and delivers the values while it runs, so before the run `getComputedStyle` answers the fallback: `"Figura " target-counter(…)` reads `"Figura "` and a lone `target-counter(…)` reads nothing, and a span frozen from either shows the screen's words with the screen's number missing. `reify(doc, { defer: true })` — the first moment's call — leaves such a pseudo native; the second moment, after the run, takes it with the values in. A pseudo is known to read one by asking the browser: every `--beltype-read-*` name the sheets mention is set to a sentinel on the element, and a pseudo whose computed `content` moves has no value of its own yet.
 *
 * 4. **Idempotent.** An element already carrying a reified span (a `.marker` or `.caster-generated` child) or the suppress class reifies nothing twice, and a reified list item is `display: block` and so no longer a list item; a second call over a prepared document answers with empty `markers` and `generated`. This is what a second moment costs: nothing.
 *
 * @packageDocumentation
 */

import { CasterError } from '../errors.ts';
import { ASCENT_ATTRIBUTE, SHAPE_ATTRIBUTE, SHAPE_MARKERS, markerBox } from '../vectors/listMarkers.ts';

/** The class the guide's engine contract names, and `walk/structure.js`'s `LI` and `FENote` branches look for. */
export const MARKER_CLASS = 'marker';

/** The class on a materialised `::before` / `::after`. */
export const GENERATED_CLASS = 'caster-generated';

/**
 * The two suppress classes, one per pseudo.
 *
 * @remarks
 * One class killing both was a real loss: materialising `h2::before` added a class whose rule read `::before, ::after { content: none !important }`, so a decorative `h2::after` the author also wrote vanished from the page with nothing to say so. A pseudo is suppressed only where it was replaced.
 */
export const SUPPRESS_CLASS = { before: 'caster-no-before', after: 'caster-no-after' };
/** The id of the one `<style>` that holds the two suppress rules. */
const SUPPRESS_ID = 'caster-generated-style';

/**
 * Properties never copied off a pseudo-element onto the span that replaces it.
 *
 * @remarks
 * `content` is what we are removing, and the four that would take the span out of the flow the pseudo was in.
 */
const NOT_COPIED = new Set(['content', 'position', 'top', 'right', 'bottom', 'left', 'float', 'counter-reset', 'counter-increment', 'counter-set']);

/** One counter in scope during the walk, and the depth of the element that created it. */
export type Scope = { name: string, value: number, ownerDepth: number };

/** One list item's marker, made a real span. */
export type ReifiedMarker = {
  /** The list item — an `<li>` or any element whose computed display was `list-item`; the key keeps its name so the shape is `Preparation.markers`'s. */
  li: HTMLElement;
  /** The marker's own text, which the walk's `Lbl` owns. */
  text: string;
  /** `::marker` when the computed content gave it, `counter` when it was derived. */
  source: string;
};

/** What one reification made, for the report. */
export type Reification = {
  markers: ReifiedMarker[];
  generated: { element: string, pseudo: string, text: string }[];
  warnings: string[];
  /** The pseudos left native because they read a value the engine has not delivered, as `element::pseudo`. */
  deferred: string[];
};

/**
 * Reify every pseudo-painted text in the document.
 *
 * @remarks
 * Whole-document, document order, idempotent.
 *
 * Every element is read before anything is written: the walk reads in document order and queues its writes, and the queue runs once the walk is done. Measured 2026-10-29 on the manual, every page built (65 207 elements, 400 pseudo-elements with content): with each write made where it was decided, every read after it made the browser restyle the document first, and reification took 1.49 s; read first, it takes 1.16 s, where the reads alone take 741 ms. So every read sees the page as the engine presented it, never a page some spans into this reification; the two differ only where a selector depends on structure the spans change (`:first-child`, a sibling combinator, `:empty`, `:has()`), and there the presented page is the oracle (Egildo's ruling, 2026-10-29). A shape marker's own probe is the one write left inside the walk, because it is what that reading reads.
 *
 * @param options - `defer`: leave a pseudo that reads an undelivered engine value native (the first moment, before the run); absent, everything is taken (the second moment, after it).
 * @throws {CasterError} The document has no window; a generated `content` or an `<li>`'s `list-style-type` this printer cannot express.
 */
export function reify(doc: Document, { defer = false }: { defer?: boolean; } = {}): Reification {
  const out: Reification = { markers: [], generated: [], warnings: [], deferred: [] };
  const view = doc.defaultView;
  if (!view) throw new CasterError('caster: the print frame has no window, so nothing about it can be reified or measured');

  if (!doc.getElementById(SUPPRESS_ID)) {
    const style = doc.createElement('style');
    style.id = SUPPRESS_ID;
    style.textContent = `.${SUPPRESS_CLASS.before}::before { content: none !important; }\n.${SUPPRESS_CLASS.after}::after { content: none !important; }`;
    doc.head.append(style);
  }

  const reads = defer ? readNamesOf(doc) : [];
  const writes: (() => void)[] = [];
  const scopes: Scope[] = [];
  const apply = ( style: CSSStyleDeclaration,  depth: number) => {
    for (const [name, value] of pairsOf(style.counterReset)) {
      // A new scope at the same depth replaces the one a previous sibling opened, and leaves every ancestor's alone. Pushing beside it made `counters(item, '.')` on the second of two sibling `<ol>`s resolve `3.1.` where Chromium renders `1.`, because the spent sibling's scope was still on the stack and still being joined. CSS Lists 3 §3: an element's counter-reset creates a new counter whose scope is that element and its descendants, so the previous sibling's is out of scope here by construction.
      const spent = scopes.findIndex((s) => s.name === name && s.ownerDepth === depth);
      if (spent >= 0) scopes.splice(spent, 1);
      scopes.push({ name, value, ownerDepth: depth });
    }
    for (const [name, value] of pairsOf(style.counterSet)) {
      const hit = innermost(scopes, name);
      if (hit) hit.value = value; else scopes.push({ name, value, ownerDepth: depth });
    }
    for (const [name, value] of pairsOf(style.counterIncrement, 1)) {
      const hit = innermost(scopes, name);
      if (hit) hit.value += value; else scopes.push({ name, value, ownerDepth: depth });
    }
  };

  // The list-item siblings of a parent, taken once, on the first demand. The walk alters each item as it passes (`display: block` takes it out of the list-item set), so a set read at the second item would no longer hold the first and every ordinal after it would slip by one. The first demand comes from the first list-item child, at which point no sibling has been altered yet: the earlier ones were never list items, the later ones have not been visited.
  const itemsByParent: WeakMap<Element,Element[]> = new WeakMap<any, any>();
  const itemsOf = ( parent: Element) => {
    let items = itemsByParent.get(parent);
    if (!items) {
      items = [...parent.children].filter((child) => view.getComputedStyle(child).display === 'list-item');
      itemsByParent.set(parent, items);
    }
    return items;
  };

  /** One element: its counters, its marker and `::before`, its children, its `::after`, then the scopes it closes. */
  const walk = (element: Element, depth: number) => {
    const style = view.getComputedStyle(element);
    // `display: none` generates no box, so it generates no pseudo-element and its counter operations do not happen (CSS Lists 3 §4.4) — and an element a paginator has emptied and hidden is one whose words the engine has already taken back, so a span written into it would be a word the block never held (*a pseudo that reads a value the engine delivers is made real after the run*, DESIGN.md S79).
    if (style.display === 'none') return;
    apply(style, depth);
    // `::marker` is the item's first box, so it goes first; then `::before`, then the children. The element's own counters have moved before any of the three reads them.
    const marker = style.display === 'list-item' ? markerSpan(view, (element as HTMLElement), style, scopes, itemsOf, out, writes) : null;
    const before = pseudoSpan(view, element, '::before', scopes, apply, depth + 1, out, reads, writes);
    if (before) writes.push(() => element.insertBefore(before, element.firstChild));
    if (marker) writes.push(() => element.insertBefore(marker, element.firstChild));
    for (const child of [...element.children]) {
      if (child.classList.contains(GENERATED_CLASS) || child.classList.contains(MARKER_CLASS)) continue;
      walk(child, depth + 1);
    }
    const after = pseudoSpan(view, element, '::after', scopes, apply, depth + 1, out, reads, writes);
    if (after) writes.push(() => element.append(after));
    // A counter created below this element stays in scope for this element's following siblings, and dies with this element's parent — which is where the walk is now.
    while (scopes.length && scopes[scopes.length - 1].ownerDepth > depth) scopes.pop();
  };
  walk(doc.documentElement, 0);
  for (const write of writes) write();

  return out;
}

/**
 * One list item's marker as a real span, or null where it paints nothing or was already made.
 *
 * @param style - The item's own computed style.
 * @param writes - Where the item's own write is queued.
 * @throws {CasterError} An `<li>`'s marker this printer cannot express; another list item's becomes a warning instead.
 */
function markerSpan(view: Window, item: HTMLElement, style: CSSStyleDeclaration, scopes: Scope[], itemsOf: (parent: Element) => Element[], out: Reification, writes: (() => void)[]): HTMLElement|null {
  if (item.querySelector(`:scope > .${MARKER_CLASS}`)) return null;
  const hangs = style.listStylePosition !== 'inside' && opensWithBlock(view, item);
  const parent = item.parentElement;
  // The list's items are taken before this item changes `display` on any path, so an item whose marker is hidden still counts, as Blink counts it (the seventh review of the Press round: `none, 2., 3.` printed `none, 1., 2.`).
  if (parent) itemsOf(parent);
  // An `<li>` in a `<ul>`/`<ol>` reads `list-style-type` off the list, as D9 wrote it; anything else reads its own.
  const list = item.tagName === 'LI' && parent && (parent.tagName === 'UL' || parent.tagName === 'OL') ? parent : null;
  const listStyle = list ? view.getComputedStyle(list).listStyleType : style.listStyleType;
  const content = view.getComputedStyle(item, '::marker').content;
  let text;
  let source;
  // `content: none` generates no marker box at all (css-lists-3), so Blink paints nothing and there is nothing to make: the item is reified like one whose text is empty (the sixth review of the Press round: a disc list with `::marker { content: none }` printed three bullets).
  if (content === 'none') {
    item.style.setProperty('display', 'block', 'important');
    return null;
  }
  if (!content || content === 'normal') {
    source = 'counter';
    if (SHAPE_MARKERS.includes(listStyle)) return shapeMarkerSpan(view, item, style, listStyle, hangs, out);
    try {
      text = counterText(listStyle, parent ? ordinalOf(item, itemsOf(parent)) : 1);
    } catch (error) {
      // An `<li>` refuses, as it always has. Another element made a list item is the paginator's own furniture more often than the author's, and a marker only the engine can draw is left to the engine, with a warning that says so.
      if (list || !(error instanceof CasterError)) throw error;
      out.warnings.push(`${domPathish(item)}: ${error.message}`);
      return null;
    }
  } else {
    source = '::marker';
    text = resolveGenerated(content, item, scopes, domPathish(item), '::marker');
  }
  // The native marker goes, and `list-style-type` stays: `/ListNumbering` is read from it.
  writes.push(() => item.style.setProperty('display', 'block', 'important'));
  // `list-style-type: none` paints no marker, so there is nothing to materialise and a `<span class="marker">` with no text would become a `Lbl` owning nothing — which is what the walk's `/ListNumbering /None` rule forbids beside it.
  if (text === '') return null;
  const span = item.ownerDocument.createElement('span');
  span.className = MARKER_CLASS;
  span.textContent = text;
  // An outside marker hangs before the text and advances nothing, so the span is a box of no width whose text is aligned to its end and overflows toward its start: the item's words stay where the native marker left them, and the marker ends where they begin (*preparation runs in no author preview, and must not change layout*, DESIGN.md S81). No width is measured, because the frame's faces may not have loaded when this runs. `white-space: pre` is the UA's own for `::marker`, and keeps the trailing space a line end would otherwise drop. An inside marker advances, as an ordinary inline span does. An outside marker before a block is also out of the flow ({@link opensWithBlock}).
  if (style.listStylePosition !== 'inside') span.style.cssText = `${hangs ? 'position: absolute; ' : ''}display: inline-flex; inline-size: 0; justify-content: flex-end; white-space: pre`;
  out.markers.push({ li: item, text, source });
  return span;
}

/**
 * A shape marker's empty inline box, sized and placed as the marker Blink paints in its place.
 *
 * @remarks
 * The native marker goes with `display: block` like every marker, and `list-style-type` stays for `/ListNumbering`. The ascent is measured by the browser, because Blink rounds it and a rounding this module would have to copy is a second reading of the font's metrics: a probe sits at the start of the item and the content area's top is the baseline less the ascent, whatever the line height. The box takes the marker's own font and colour, so the measurement is the marker's and not the item's. The span is left empty, so the walk gives the item a `Lbl` and no text, and the vector pass draws the shape.
 *
 * @param style - The item's own computed style.
 * @param listStyle - `disc`, `circle` or `square`.
 * @param hangs - The item opens with a block, so the box is taken out of the flow ({@link opensWithBlock}).
 */
function shapeMarkerSpan(view: Window, item: HTMLElement, style: CSSStyleDeclaration, listStyle: string, hangs: boolean, out: Reification): HTMLElement|null {
  const doc = item.ownerDocument;
  const markerStyle = view.getComputedStyle(item, '::marker');
  item.style.setProperty('display', 'block', 'important');
  const host = doc.createElement('span');
  copyMarkerPaint(host, markerStyle);
  const probe = doc.createElement('span');
  probe.style.cssText = 'display: inline-block; width: 0; height: 0; vertical-align: baseline';
  host.append(probe);
  item.insertBefore(host, item.firstChild);
  const ascent = Math.round(probe.getBoundingClientRect().top - host.getBoundingClientRect().top);
  // How far below its line's top the inline box would stand, which a box out of the flow has to be told: its static position is the line's top.
  const lead = host.getBoundingClientRect().top - item.getBoundingClientRect().top - Number.parseFloat(style.borderTopWidth) - Number.parseFloat(style.paddingTop);
  host.remove();
  if (ascent <= 0) return null;
  const { width, marginStart, marginEnd } = markerBox(ascent, style.listStylePosition === 'inside', Number.parseFloat(markerStyle.fontSize));
  const span = doc.createElement('span');
  span.className = MARKER_CLASS;
  copyMarkerPaint(span, markerStyle);
  span.setAttribute(SHAPE_ATTRIBUTE, listStyle);
  span.setAttribute(ASCENT_ATTRIBUTE, String(ascent));
  span.style.setProperty('margin-left', `${marginStart}px`);
  span.style.setProperty('margin-right', `${marginEnd}px`);
  span.style.setProperty('padding-right', `${width}px`);
  // The lead is an offset and not a margin: an absolutely positioned box's margin collapses with nothing, so it never adjoins a break. Cicero gives the box a page resumes at and its first child `margin-top: 0 !important` (`adjoin`, css-break-3 §5.2), and this span is that first child, so it rose by its lead at a page's top (1 px on the cast fixture's loose item that opens page 4, 2026-10-29). Written `!important` on the element, it outranks any sheet's important rule, a cascade layer's included.
  if (hangs) { span.style.setProperty('position', 'absolute'); span.style.setProperty('margin-top', `${lead}px`, 'important'); }
  out.markers.push({ li: item, text: '', source: 'counter' });
  return span;
}

/**
 * Does the item's first box stand in a block of its own, so that an outside marker hangs beside a line the item does not make?
 *
 * @remarks
 * A loose item (`li > p`, a Markdown list with blank lines between its items) opens with a block. Its native `::marker` hangs beside the block's first line and makes no line of its own, but an inline span before the block does: CSS wraps it in an anonymous block, and the item grows by a line (measured 2026-10-16 on the specimen under Paged.js: `alfa` 58.66 px to 80.66, and the cut moved). So the span of such an item is taken out of the flow, `position: absolute` with no offsets: its static position is the item's content box at the block's top, where nothing moves, and the end of its text stands at the item's content edge as the native marker's does (measured 2026-10-29 in standards mode against Blink's own marker: the same height for every item and the same x, for a first `p`, `pre`, nested list, `blockquote`, a padded or indented `p` and a figure). Its baseline is the item's own first line's, which is the block's where the block sets its first line in the item's face, as a `p` does; a first block in another face, with its own padding or opening with an image (a heading, a table, a figure) has Blink's marker on that line's baseline, 3 px lower for an `h3` and 13 px for a table cell padded 4 px or a 30 px image in that measurement, which this does not follow (none of the manual's 112 loose items, nor the cast fixture's 3, opens with anything but a `p`). An item whose `::before` paints opens with that inline box, and a tight item with its text: their marker stays in the line.
 */
function opensWithBlock(view: Window, item: Element): boolean {
  const before = view.getComputedStyle(item, '::before').content;
  if (before && before !== 'none' && before !== 'normal') return false;
  for (const node of item.childNodes) {
    if (node.nodeType === 3 && /\S/u.test((node as Text).data)) return false;
    if (node.nodeType !== 1) continue;
    const child = view.getComputedStyle((node as Element));
    if (child.display === 'none' || child.position === 'absolute' || child.position === 'fixed' || child.float !== 'none') continue;
    return child.display !== 'contents' && !child.display.startsWith('inline');
  }
  return false;
}

/**
 * The marker's own paint and face, written onto a box that measures or carries it.
 *
 * @param markerStyle - The `::marker` pseudo-element's computed style.
 */
function copyMarkerPaint(box: HTMLElement, markerStyle: CSSStyleDeclaration) {
  for (const property of ['color', 'font-family', 'font-size', 'font-weight', 'font-style']) box.style.setProperty(property, markerStyle.getPropertyValue(property));
}

/** The counter an item's marker shows, replayed from the list's start over the items before it: the list's `start` or `reversed`, then each item's own `value` in turn — the same sequence Chromium's `list-item` counter walks. */
function ordinalOf(item: Element, items: Element[]) {
  const parent = (item.parentElement as Element);
  const start = Number.parseInt(parent.getAttribute('start') ?? '', 10);
  const reversed = parent.hasAttribute('reversed');
  let counter = Number.isFinite(start) ? start : (reversed ? items.length : 1);
  for (const each of items) {
    const declared = Number.parseInt(each.getAttribute('value') ?? '', 10);
    if (Number.isFinite(declared)) counter = declared;
    if (each === item) break;
    counter += reversed ? -1 : 1;
  }
  return counter;
}

/**
 * One pseudo-element as a real span, or null where it paints nothing or was already replaced.
 *
 * @param reads - The engine's `--beltype-read-*` names, when the pseudo is to wait for them.
 * @param writes - Where the element's own write is queued.
 * @throws {CasterError} A generated `content` this printer cannot express.
 */
function pseudoSpan(view: Window, element: Element, which: '::before'|'::after', scopes: Scope[], apply: (style: CSSStyleDeclaration,depth: number) => void, depth: number, out: Reification, reads: string[], writes: (() => void)[]): HTMLElement|null {
  if (element.classList.contains(which === '::before' ? SUPPRESS_CLASS.before : SUPPRESS_CLASS.after)) return null;
  const style = view.getComputedStyle(element, which);
  const content = style.content;
  if (!content || content === 'none' || content === 'normal') return null;
  if (reads.length && waitsForReads(view, element, which, content, reads)) {
    out.deferred.push(`${domPathish(element)}${which}`);
    return null;
  }
  apply(style, depth);
  const text = resolveGenerated(content, element, scopes, domPathish(element), which);
  if (text === '') return null;
  const span = element.ownerDocument.createElement('span');
  span.className = GENERATED_CLASS;
  span.textContent = text;
  // The pseudo's own painting, carried onto the span: without it the number would take the heading's colour and face rather than the ones the author gave the marker.
  for (const property of style) {
    if (NOT_COPIED.has(property)) continue;
    span.style.setProperty(property, style.getPropertyValue(property));
  }
  writes.push(() => element.classList.add(which === '::before' ? SUPPRESS_CLASS.before : SUPPRESS_CLASS.after));
  out.generated.push({ element: domPathish(element), pseudo: which, text });
  return span;
}

/**
 * Every `--beltype-read-*` custom property the document's sheets mention: the names Cicero delivers a `target-counter()` or `target-text()` into (*a pseudo that reads a value the engine delivers is made real after the run*, DESIGN.md S79).
 *
 * @remarks
 * Text of the rules, not a parse: a name in a nested or grouped rule is in its parent's `cssText`. A sheet the page may not read (cross-origin) is skipped, which loses nothing here — Cicero's capture cannot read it either.
 */
function readNamesOf(doc: Document): string[] {
  const names = new Set<any>();
  for (const sheet of [...doc.styleSheets, ...doc.adoptedStyleSheets]) {
    let rules;
    try { rules = [...sheet.cssRules]; } catch { continue; }
    for (const rule of rules) for (const name of rule.cssText.match(/--beltype-read-[\w-]+/g) ?? []) names.add(name);
  }
  return [...names];
}

/**
 * Whether a pseudo's `content` reads a delivered value that is not delivered to it yet.
 *
 * @remarks
 * Asked of the browser, not of the selectors: an inherited custom property reaches a pseudo that has no value of its own, and one the engine already delivered to the pseudo itself (`::before, ::after { --beltype-read-… }`) wins over the inheritance, so after the run the sentinel changes nothing and the answer is no.
 *
 * @param content - The pseudo's computed `content` as it stands.
 */
function waitsForReads(view: Window, element: Element, which: '::before'|'::after', content: string, reads: string[]) {
  const style = (element as HTMLElement).style;
  for (const name of reads) style.setProperty(name, '"\u2060caster-probe"');
  const probed = view.getComputedStyle(element, which).content;
  for (const name of reads) style.removeProperty(name);
  return probed !== content;
}

/**
 * `counter-reset: a 0 b 3` → `[['a', 0], ['b', 3]]`; a name with no number takes `fallback`; `none` and the empty string are no pairs.
 *
 * @remarks
 * `getComputedStyle` hands over substituted values (a `var()` is already its value here — measured in `test/reify.test.js`), so the tokens are names and integers and nothing else.
 */
export function pairsOf( value: string,  fallback: number = 0) {
  const out: [string,number][] = [];
  if (!value || value === 'none') return out;
  const tokens = value.trim().split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const name = tokens[i];
    if (/^-?\d+$/.test(name)) continue;
    const next = tokens[i + 1];
    if (next !== undefined && /^-?\d+$/.test(next)) { out.push([name, Number(next)]); i += 1; }
    else out.push([name, fallback]);
  }
  return out;
}

/** The innermost counter of that name in scope, or undefined. */
function innermost(scopes: Scope[], name: string) {
  for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].name === name) return scopes[i];
  return null;
}

/** A short, human name for an element in a refusal. The walk's own `domPathOf` needs a container this module does not have. */
function domPathish( element: Element) {
  const id = element.id ? `#${element.id}` : '';
  const cls = element.classList.length ? `.${[...element.classList].filter((c) => c !== SUPPRESS_CLASS.before && c !== SUPPRESS_CLASS.after).join('.')}` : '';
  return `${element.tagName.toLowerCase()}${id}${cls}`;
}

/**
 * A computed `content` value, resolved to the text the box paints.
 *
 * @remarks
 * Strings, `counter()`, `counters()` and `attr()` are the four this printer can express. An image, a quote pair, `element()` or an unresolved `var()` refuses by name: a hole where the author put a marker is the one outcome worse than a refusal, because the page still looks deliberate.
 *
 * @throws {CasterError} An image, a quote pair, `element()`, an unresolved `var()`, or any other value that is not a string, `counter()`, `counters()` or `attr()`.
 */
export function resolveGenerated(content: string, element: Element, scopes: Scope[], domPath: string, which: string): string {
  // A computed `content` may carry an alt text after a `/`; the alt is the accessible name, and the painted text is what comes before it.
  const painted = content.split(/\s+\/\s+(?=("|counter|counters|attr|url|none))/)[0] ?? content;
  let out = '';
  const pattern = /"((?:[^"\\]|\\.)*)"|([a-zA-Z-]+)\(([^()]*)\)|(\S+)/g;
  for (const match of painted.matchAll(pattern)) {
    if (match[1] !== undefined) { out += match[1].replace(/\\(.)/g, '$1'); continue; }
    if (match[2] !== undefined) {
      const fn = match[2].toLowerCase();
      const args = match[3].split(',').map((a) => a.trim());
      if (fn === 'counter') {
        const hit = innermost(scopes, args[0]);
        out += counterValueText(hit ? hit.value : 0, args[1] ?? 'decimal');
        continue;
      }
      if (fn === 'counters') {
        const separator = literalOf(args[1] ?? '""') ?? '';
        const values = scopes.filter((scope) => scope.name === args[0]).map((scope) => counterValueText(scope.value, args[2] ?? 'decimal'));
        out += values.join(separator);
        continue;
      }
      if (fn === 'attr') { out += element.getAttribute(args[0]) ?? ''; continue; }
      throw new CasterError(`caster: content: ${fn}() on ${domPath}${which} is not one this printer can express. Strings, counter(), counters() and attr() are; an image or a quote pair is not, and a marker silently dropped leaves a page that still looks deliberate.`, { element: domPath });
    }
    const bare = match[4];
    if (bare === 'none' || bare === 'normal' || bare === '') continue;
    throw new CasterError(`caster: content: ${bare} on ${domPath}${which} is not one this printer can express. Strings, counter(), counters() and attr() are.`, { element: domPath });
  }
  return out;
}

/** A counter's value in a `list-style-type`-shaped style, without the marker suffix `counterText` adds — generated content carries its own punctuation in the author's own string. */
function counterValueText( value: number,  style: string) {
  switch (style) {
    case 'decimal': return String(value);
    case 'decimal-leading-zero': return String(value).padStart(2, '0');
    case 'lower-roman': return roman(value).toLowerCase();
    case 'upper-roman': return roman(value);
    case 'lower-alpha': case 'lower-latin': return alpha(value).toLowerCase();
    case 'upper-alpha': case 'upper-latin': return alpha(value);
    case 'none': return '';
    default: return String(value);
  }
}

/** A quoted string's own text, or null for anything else. */
function literalOf( content: string) {
  if (!content || content === 'normal' || content === 'none') return null;
  const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(content.trim());
  if (!quoted) return null;
  return quoted[1].replace(/\\(.)/g, '$1');
}

/**
 * The marker `list-style-type` and a counter would produce, for the fallback D9 names.
 *
 * @remarks
 * The numbering systems the walk's `LIST_NUMBERING` table already knows, and `none`. The three bullet shapes are not text and never reach here: `shapeMarkerSpan` draws them. An unnamed type refuses by name rather than painting nothing.
 *
 * @throws {CasterError} A `list-style-type` outside `MATERIALISABLE`.
 */
function counterText( listStyle: string,  value: number) {
  switch (listStyle) {
    case 'decimal': return `${value}. `;
    case 'decimal-leading-zero': return `${String(value).padStart(2, '0')}. `;
    case 'lower-roman': return `${roman(value).toLowerCase()}. `;
    case 'upper-roman': return `${roman(value)}. `;
    case 'lower-alpha': case 'lower-latin': return `${alpha(value).toLowerCase()}. `;
    case 'upper-alpha': case 'upper-latin': return `${alpha(value)}. `;
    case 'none': return '';
    // An unnamed type is a refusal and not an empty marker. The header promised a warning and none was ever written, so `list-style-type: lower-greek` or a `@counter-style` the author defined produced a silent `Lbl` with nothing in it — a list whose numbering the reader cannot see and the file does not admit to losing. The nine names above are the ones `/ListNumbering` also knows; anything else is a marker only the engine can render, and there is no honest guess.
    default: throw new CasterError(`prepare: \`list-style-type: ${listStyle}\` is outside the table this printer can materialise (${MATERIALISABLE.join(', ')}); the marker it produces is one only the engine can draw`);
  }
}

/** The `list-style-type` values `counterText` can draw, for the refusal's own message. */
const MATERIALISABLE = ['disc', 'circle', 'square', 'decimal', 'decimal-leading-zero', 'lower-roman', 'upper-roman', 'lower-alpha', 'lower-latin', 'upper-alpha', 'upper-latin', 'none'];

const ROMAN = ([[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']] as const);

/** Upper-case Roman numerals. */
export function roman(value: number) {
  if (!Number.isFinite(value) || value < 1 || value > 3999) return String(value);
  let n = Math.floor(value);
  let out = '';
  for (const [amount, numeral] of ROMAN) while (n >= amount) { out += numeral; n -= amount; }
  return out;
}

/** Bijective base-26: 1 → A, 26 → Z, 27 → AA. */
export function alpha(value: number) {
  if (!Number.isFinite(value) || value < 1) return String(value);
  let n = Math.floor(value);
  let out = '';
  while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
  return out;
}
