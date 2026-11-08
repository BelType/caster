/**
 * `adapters/cicero.js` — the first of the two modules that know an engine's DOM; `adapters/pagedjs.js` is the second.
 *
 * Caster's own; no harness source — the harness's fixtures laid their pages in one horizontal strip themselves (E10), so there was no engine to ask. PLAN.md §5, with every rule carrying the measurement it rests on (DESIGN.md, from *Cicero's pages stack vertically* (S9) to *the page host's shadow adopts no sheet*, S16). Guide: `docs/guide/coordinates-and-pages.md`.
 *
 * It reads `packages/engine-cicero/src/root.js`, `chase.js`, `fragments.js`, `compose-dom.js` and `seam/client.js`, and it edits none of them: Cicero's `src/` and `seam/` were out of scope for the round that wrote it, absolutely, and what the adapter cannot read is a wish in DESIGN.md's *What Cicero should stamp* rather than a patch.
 *
 * The adapter's whole output is a `PageStrip`: the strip element, the page elements in order, the per-page flow nodes in order, the nominal sizes, the content areas, the margins and the continuation pairs. Nothing downstream of it knows the engine's name — which is the property the experiments proved and the reason Caster is its own package rather than a room inside the engine.
 *
 * @packageDocumentation
 */

import { addWordTo, hasWordOn, posOf } from '@beltype/common/data-beltype';
import { CasterError } from '../errors.ts';
import { PX_TO_PT } from '../coordinates/units.ts';
import { domPathOf } from '../measure/textMeasure.ts';
import { ARTIFACT_ATTRIBUTE } from '../walk/structure.ts';
import { backgroundTile, functionCall, gradientTile, splitTopLevel } from '../vectors/cssBoxes.ts';
import { lengthPercentage, shapeTokens } from '../vectors/pathData.ts';
import { TABLE_REPEAT_ATTRIBUTE } from '../walk/tableModel.ts';
import { deriveIntervals } from './intervals.ts';
import { GENERATED_CLASS, pairsOf, reify, resolveGenerated } from './reify.ts';

import type { PageStrip, StripPage } from './strip.ts';
import type { DerivationNote } from './intervals.ts';
import type { Gateway } from '../host/gateway.ts';

/**
 * `<beltype-root>` as the adapter asks it: the element, and the one verb of the engine's it reads.
 *
 * @remarks
 * `sourceOf` is optional because not every root answers it: an engine older than *the engine names the source* (2026-09-21) has no such method, and neither has a detached fixture. Where it is absent the pairing falls back to its own rules — the belt's stamp, then the only original of a tag — which is why those rules stay until stage 3a of the interval round retires them (`docs/round-plan-an-interval-is-a-marked-content-sequence.md`).
 */
export type CiceroRoot = HTMLElement & { sourceOf?: (element: Element) => Element|null };

/**
 * The piece words (the round *the piece words*, 2026-10-11; the registry's `split`, `start`, `end`). A box the engine divides across pages wears `split` on every piece; `start` says the piece is dressed as the box's beginning and `end` that it holds the box's end. So a continuation is a piece that is `split` and not `start` (the old `__beltype-cont`), and a constructed first fragment is `split` and `start` (the old `__beltype-first`). A `position: fixed` box's per-page copy wears `fixed`, the painted shell's wrapper `shell`, and the Compositor's own `<br>` and filler `<span>` `break` and `fill`.
 *
 * The first half of a divided block is a clone since *the first fragment is constructed* (2026-09-15) and was the original before it.
 */
/** The word every clone Cicero appends to the light DOM carries, among the words of `data-beltype` (`root.js`'s `FRAGMENT`). */
export const FRAGMENT_WORD = 'fragment';
/** The selector that finds it. */
export const FRAGMENT_SELECTOR = '[data-beltype~="fragment"]';
/** PDF's own name for pagination furniture, written by the engine on every running-element copy a margin cell receives and on a fixed box's per-page copy after the first (`engine-cicero/src/data-beltype.js`'s `ARTIFACT`). The Paged.js adapter writes the same word on its copies, so both engines end with one marker (*the margins are lifted into the light DOM*, DESIGN.md S57 and *a running element's original is the element the engine hid*, S60; the artifact word). */
export const ARTIFACT_WORD = 'artifact';

/** The `data-beltype` words (the round *the piece words*, 2026-10-11; *the engine's marks are words of one attribute*, DESIGN.md S72; *one grammar in common*, 2026-10-11). Cicero marks its copies with the words of one attribute, and the belt's line stamp is the word `pos:<line>` of the same attribute, so nothing here compares or sets the whole attribute: a copy carries the stamp it inherited and the engine's words besides. The grammar is `common/src/data-beltype.js`, which Caster reaches as it reaches the error types (the print frame's import map maps `@egildo/beltype-common/`); the engine's words (`fragment`, `split`, …) are named here, Caster importing no engine, and `test/data-beltype.test.js` pins them against the engine's registry. */
/** Is this element a clone the engine appended to the light DOM — a fragment, a fixed box's per-page copy, a running element's, a span lifted out of a margin cell? */
export const isFragment = (el: Element) => hasWordOn(el, FRAGMENT_WORD);

/**
 * The page-level `--pdf-*` properties, read where *Chromium's `@page` parser discards a custom property* (S11) and *the page-level `--pdf-*` properties are read from the document root* (S12) measured them readable: the document root.
 *
 * @remarks
 * R7 proposed two roads and one measurement closed both — Chromium's `@page` parser discards a custom property before the CSSOM ever sees it, registered or not — so `@page { --pdf-bleed: 3mm }` is not a channel that exists. `:root { --pdf-bleed: 3mm }` is, it computes to px because the property is registered as a `<length>`, and `inherits: false` keeps it off every descendant, which is the semantics the guide asks for. Named pages, `:first` and parity are not honoured this round and the reason is the parser.
 */
export function pageHintsOf(doc: Document): CSSStyleDeclaration {
  return doc.defaultView ? doc.defaultView.getComputedStyle(doc.documentElement) : getComputedStyle(doc.documentElement);
}

/**
 * Read the strip Cicero presented.
 *
 * @param doc - The print frame's document, after `__beltypeCicero.run()` resolved.
 * @param options - `note` is handed to `deriveIntervals`, for a caller that reports what the derivation met (the census).
 * @throws {CasterError} Whatever says this is not a document Cicero presented — no `<beltype-root>`, no open shadow, zero pages, a page with no root slot, no inline size, no shadow or no `.content-area` — and every refusal the pairing and the verification make.
 */
export function adaptCicero(doc: Document, { note }: { note?: (note: DerivationNote) => void; } = {}): PageStrip {
  // THE SECOND MOMENT OF REIFICATION (*a pseudo that reads a value the engine delivers is made real after the run*, DESIGN.md S79). A pseudo that read a value Cicero delivers while it runs — a page number, a figure's number — was left native by `prepare()` and is complete now.
  reify(doc);
  const strip = (doc.querySelector('beltype-root') as CiceroRoot|null);
  if (!strip) throw new CasterError('caster: the document holds no <beltype-root>; the Cicero adapter is looking at a document the engine never presented. Was `run()` awaited?');
  const shadow = strip.shadowRoot;
  if (!shadow) throw new CasterError('caster: <beltype-root> has no open shadow root, so its pages cannot be read. Cicero attaches one with `mode: open` — a document where it is closed is not a document this printer can measure.');

  // R1: one `<beltype-page>` per page, in order, in the root's shadow.
  const pageElements = ([...shadow.querySelectorAll('beltype-page')] as HTMLElement[]);
  if (pageElements.length === 0) throw new CasterError('caster: <beltype-root> presented no pages. The engine paginated to zero, which is a document error rather than a print error — read the page console before concluding the printer is at fault.');

  const pages: StripPage[] = [];
  const pageOfNode: Map<Element,number> = new Map<any, any>();
  const twins: Map<Element,Element> = new Map<any, any>();
  /** Every light-DOM element that is margin content, by its top (*the margins are lifted into the light DOM*, S57). */
  const marginRoots: Set<Element> = new Set<any>();
  /** Every running element's clone, with the artifact kind its cell gave it (*the margins are lifted into the light DOM*, S57). */
  const running: Map<Element,'header'|'footer'> = new Map<any, any>();

  // Every margin cell's generated text, read on every page before any page is lifted: a lift writes to the document, and a read after a write makes the browser restyle it first (see `marginTextsOf`).
  const marginTexts = pageElements.map((element, index) => marginTextsOf(element, index));

  pageElements.forEach((element, index) => {
    // R3: the elements on page N, in flow order, are the root slot's assigned nodes. Never `<beltype-root>`'s light DOM directly — unassigned originals live there (a composed block's source, a fixed box's source) and are not rendered.
    //
    // **Two slots since 2026-09-18** (`engine-cicero`'s *the page rendering clips at the bleed area*). The engine used to assign a page's flow and its repeated fixed boxes to one slot, because one clip served both; it now clips the flow on the block axis alone and keeps §9.6.1's page-area clip for the fixed boxes, which means two boxes and therefore two slots, named `iv-N` and `fx-N`. Read in that order the concatenation is byte-for-byte the list this walk always had — flow first, fixed clones last — so everything downstream is unchanged. A page with no fixed box has no `fx-N` slot at all, which is why the second is optional and the first is not.
    const flowSlot =(element.querySelector(':scope > slot[name^="iv-"]') as HTMLSlotElement|null);
    if (!flowSlot) throw new CasterError(`caster: page ${index + 1} carries no root slot, so its flow cannot be read; \`root.js\`'s \`present()\` gives every page one through \`chase.js\`'s \`adopt\``);
    const furnitureSlot = (element.querySelector(':scope > slot[name^="fx-"]') as HTMLSlotElement|null);
    const flowNodes = ([flowSlot, ...(furnitureSlot ? [furnitureSlot] : [])].flatMap((s) => s.assignedNodes()).filter((n) => n.nodeType === 1) as Element[]);
    for (const node of flowNodes) pageOfNode.set(node, index);

    // R2 (*the one-pixel inset is real*, S10): the nominal size is the engine's own literal, with `chase.js`'s one-pixel print-safety inset put back.
    const widthPx = Number.parseFloat(element.style.width);
    const heightPx = Number.parseFloat(element.style.height);
    if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx)) {
      throw new CasterError(`caster: page ${index + 1} declares no inline width and height, so its page box is unknown. Cicero writes both in \`applyConditions\`; a page without them came from something else.`);
    }
    const nominal = { widthPt: round3(widthPx * PX_TO_PT), heightPt: round3((heightPx + 1) * PX_TO_PT) };

    const pageShadow = element.shadowRoot;
    if (!pageShadow) throw new CasterError(`caster: page ${index + 1} has no open shadow root, so its content area and margin boxes cannot be read`);
    const contentArea = (pageShadow.querySelector('.content-area') as HTMLElement|null);
    if (!contentArea) throw new CasterError(`caster: page ${index + 1} holds no .content-area`);
    // R5's foot is `.flow`'s bottom rather than `.content-area`'s, and `chase.js`'s own note is why: `setFlow` clips at "the CUT's own extent — a cut line box can overflow contentH while its ink starts above it, and the print text layer keeps ink, so the clip boundary is the Ledger's y, not the content edge". Measured on the specimen (*R5's clip boundary is `.flow`, not `.content-area`*, DESIGN.md S22): a line at 1026.42..1045.42 against a content-area bottom of 1031.78 is a line Cicero kept, and a printer that refused it would refuse the ordinary case. Its head is not read: since *the page clips at its bleed area on the block axis too* (2026-10-02) `.flow`'s clip edge at the head stands a page's height above the page box, and R5's head is the page host's own clip, the page box (*R5's head is the page box and its foot is the cut*, DESIGN.md S69).
    const flow = (contentArea.querySelector('.flow') as HTMLElement|null) ?? contentArea;

    // R6: the margin cells, brought into the light DOM the walk runs over (*the margins are lifted into the light DOM*, S57).
    liftMargins(element, strip, marginRoots, running, index, marginTexts[index]);

    const trimBox = (contentArea.querySelector('.trim') as HTMLElement|null);
    pages.push({ element, index, flow: flowNodes, flowBox: flow, trimBox, nominal, declaredPx: { widthPx, heightPx: heightPx + 1 }, contentArea, continuations: [] });
  });

  const pathOf = ( el: Element) => domPathOf((el as HTMLElement), strip);
  const originals = [...strip.children].filter((el) => !isFragment(el));

  // A running element's original is unassigned and unrendered, exactly as a divided block's is, and it is margin content too (*the margins are lifted into the light DOM*, S57) — so it joins its clones outside the structure tree rather than standing in it as a node with no ink. The pairing is `originalOf`'s own, the belt's stamp first.
  for (const [clone, kind] of running) {
    const original = originalOf(clone, originals, strip);
    if (original && !original.hasAttribute(ARTIFACT_ATTRIBUTE)) {
      original.setAttribute(ARTIFACT_ATTRIBUTE, kind);
      marginRoots.add(original);
    }
  }

  // A repeated table group (`data-pdf-repeat` is the word for a header or footer the engine draws again; *a table Paged.js cut across pages is one table in several fragments*, DESIGN.md S63). Every `thead` or `tfoot` the engine repeated wears the `artifact` word and is a copy of a group the table already holds once, so it is stamped for the walk, which paints it as a pagination artifact and keeps it out of the tree.
  for (const copy of strip.querySelectorAll(`thead[data-beltype~="${ARTIFACT_WORD}"], tfoot[data-beltype~="${ARTIFACT_WORD}"]`)) {
    copy.setAttribute(TABLE_REPEAT_ATTRIBUTE, 'true');
  }

  // A fixed box's copy after the first page wears the `artifact` word, and the word means PDF's artifact (DESIGN.md S82, *an artifact is never read*): the copy is pagination, drawn as such with no subtype, and the box's words are in the structure tree once, from the copy on the page it first stands on, which wears no word. The stamp is what the walk reads; the margin roots keep the copy's text out of the tree, and the copy is no longer transparent as an engine mark (the `fixed` word), or the walk would look through it at its words and tag them as content.
  for (const copy of strip.querySelectorAll(`[data-beltype~="fixed"][data-beltype~="${ARTIFACT_WORD}"]`)) {
    copy.setAttribute(ARTIFACT_ATTRIBUTE, 'pagination');
    marginRoots.add(copy);
  }

  // A first fragment is a clone too, and it pairs with the original the same way (*the engine stopped showing the original*, S47). It introduces no structure node — the original in the light DOM is the one element the author wrote — and it is where that original's own ink comes from, since the original is now on no page. A head and a continuation differ in one thing the pairing can see: a head stands at the block's own beginning, so its children align with the original's first; a continuation drops what the earlier page consumed, so its children align with the original's last.
  for (const page of pages) {
    for (const node of page.flow) {
      // A composed block's clone, and a clone a nested fixed box has left, stand where their original stood exactly as a first fragment does, so they are heads by the same rule (*two merges, one arrangement*, S48): the composed mode of *M4 was three defects* (S43) and the first fragment of *the engine stopped showing the original* (S47) are one arrangement — the original on no page, a clone on the page it begins.
      if (!isFragment(node) || isContinuation(node) || isFixedClone(node)) continue;
      const original = originalOf(node, originals, strip);
      if (!original) {
        throw new CasterError(`caster: the first fragment on page ${page.index + 1} names no original in <beltype-root>'s light DOM — ${strip.sourceOf ? 'the engine was asked (`sourceOf`) and answered that it is a copy of nothing the author wrote' : 'the engine answers no `sourceOf`, and neither the belt\'s stamp nor the only original of its tag names one'}; a fragment is a fragment OF something, and without the original the tree has no element the author wrote to hang its words on`, { element: node.tagName.toLowerCase() });
      }
      pairTrees(node, original, twins, pathOf, true);
    }
  }

  // R4: pair every continuation clone with the fragment it resumes. Cicero stores no link on the clone (*a continuation clone carries no link back to its source*, S14), so the pairing is by rule, and the whole set is verified afterwards — the partition is a fact about a block's every fragment together, which no single pairing can see (*the engine stopped showing the original*, S47). Then (*a continuation mirrors its source element by element*, S29) every element under the clone is paired with its twin, positionally, so the walk can adopt element by element.
  //
  // **The pair and the twin are two different questions and the answers parted here.** The pair is which fragment this one resumes, which is what says a continuation has a beginning somewhere and is a first fragment where one was constructed. The twin is which element the author wrote, which is always the original — pairing a continuation's tree against a first fragment's would ask it to match a tree the cut has already taken the tail out of.
  for (const page of pages) {
    for (const node of page.flow) {
      if (!isContinuation(node)) continue;
      const paired = pairContinuation(node, page, pages, strip);
      page.continuations.push({ clone: node, source: paired.source, sourcePage: paired.sourcePage });
      pairTrees(node, originalOf(paired.source, originals, strip) ?? paired.source, twins, pathOf, false);
    }
  }
  verifyPartitions(pages, strip);

  const lang = doc.documentElement.getAttribute('lang')?.trim() ?? '';

  const climbToPage = (element: Element) => {
    let node: Node|null = element;
    while (node) {
      if (node instanceof Element && node.tagName === 'BELTYPE-PAGE') return (node as HTMLElement);
      const assigned: HTMLSlotElement|null = node instanceof Element ? node.assignedSlot : null;
      if (assigned) { node = assigned; continue; }
      const parent: Node|null = node.parentNode;
      node = parent instanceof ShadowRoot ? parent.host : parent;
    }
    // An assigned original lives in the light DOM and its parent chain never crosses into a page: answer from the map the flow walk built.
    let up: Element|null = element;
    while (up) {
      const index = pageOfNode.get(up);
      if (index !== undefined) return pages[index].element;
      up = up.parentElement;
    }
    return null;
  };

  // The lift above was the adapter's last write that moves an element between pages, and a later element is a new key, so each element climbs once in a print. The walk, the chains, the boxes and the conservation check all ask. Measured 2026-11-07 on the bolletta: about 6 ms of a 61-day bill's print (codeberg.org/BelType/cli issue 2).
  const pageOf: Map<Element,HTMLElement|null> = new Map();
  const pageElementOf = (element: Element) => {
    let page = pageOf.get(element);
    if (page === undefined) {
      page = climbToPage(element);
      pageOf.set(element, page);
    }
    return page;
  };

  const { backgrounds, images } = pageBackgroundsOf(pages);
  const adapted: PageStrip = { strip, probeRoot: shadow, pageElements, pages, pageOfNode, twinOf: (element) => twins.get(element) ?? null, transparent: (element) => isEngineMark(element) && !element.hasAttribute(ARTIFACT_ATTRIBUTE), lang, pageElementOf, inMargin: (element) => marginRoots.has((topOf(element, strip) as Element)), backgrounds, ...(images.length ? { seatPageImages: (gateway: Gateway) => seatPageImages(images, strip, marginRoots, gateway) } : {}) };
  // The record (*an interval is a marked-content sequence*, DESIGN.md S71), derived from the pairing just made: an original presented whole is its own source, an element inside a clone is its twin's, and what the engine wrote itself — the Compositor's marks and its hyphen — is sourceless.
  adapted.intervals = deriveIntervals(adapted, {
    note,
    origin: (node, parent) => {
      if (parent.closest('[data-beltype~="break"], [data-beltype~="fill"]')) return { sourceless: 'artifact', label: 'Compositor mark' };
      if (isEngineHyphen(node)) return { sourceless: 'content', label: 'layout hyphen', text: '\u00AD' };
      if (!parent.closest(FRAGMENT_SELECTOR)) return { source: parent };
      const twin = twins.get(parent);
      if (twin) return { source: twin };
      if (parent.classList.contains(GENERATED_CLASS)) return { sourceless: 'content', label: 'generated content the page delivered' };
      return { unmapped: 'an element inside a clone with no twin' };
    }
  });
  return adapted;
}

/** Whether an element is one of Cicero's continuation clones (R4). */
export function isContinuation( element: Element) {
  return hasWordOn(element, 'split') && !hasWordOn(element, 'start');
}

/** Whether an element is a constructed first fragment — the first half of a divided block (*the engine stopped showing the original*, S47). */
export function isFirstFragment( element: Element) {
  return hasWordOn(element, 'split') && hasWordOn(element, 'start');
}

/** The words that mark an element as the ENGINE's own — the registry's `ENGINE_MARKS`, as a named set (this adapter imports no engine; `test/data-beltype.test.js` pins the two equal). It replaced "a class that starts with `__beltype-`". */
export const ENGINE_MARKS = Object.freeze(['split', 'fixed', 'shell', 'break', 'fill']);

/** R8: whether an element is one of Cicero's own marks inside content — `compose-dom.js`'s filler (`fill`) and break (`break`), `fragments.js`'s painted shell (`shell`), and the divided and fixed clones themselves (`split`, `fixed`). */
export function isEngineMark( element: Element) {
  return ENGINE_MARKS.some((word) => hasWordOn(element, word));
}

/**
 * Element-by-element pairing (*a continuation mirrors its source element by element*, S29): every element under a clone, paired with its twin under the original the clone is a fragment of — a continuation and a first fragment alike, since *the engine stopped showing the original* (S47) made both clones.
 *
 * @remarks
 * The walk goes by position rather than by the belt's `pos:` stamps. Cicero builds a continuation with `cloneNode(true)` and then blanks the characters the earlier page consumed (`fragments.js`'s `mutateToContinuation`), so a clone's children at every level are a contiguous range of its source's — `consumeLeadingWords` removes the elements that stand wholly before the resume point, a blank shell removes them all, and nothing is ever inserted or reordered — and a walk by position sees every element, where a join on stamps sees only what the belt chose to stamp. The belt stamps `p, h1-6, li, blockquote, pre, table, figure` and nothing else (`core/src/plugins/node-map.js`), so a `<figcaption>`, a `<dd>`, a `<caption>`, a `<td>` or a `.katex` inside a clone had no twin at all: its words were silently absent where a stamped sibling carried the clone past the emptiness guard, and the guard refused blaming the host where it did not. Measured on the specimen: the caption of the figure that straddles the page 2/3 cut printed only because the original's clipped tail was being emitted on page 3 by mistake, and vanished the moment *a rectangle belongs to the page its node was assigned to* (S27) attributed that tail to the page it belongs to.
 *
 * Where the range begins is answered by a stamp when one is there — the first clone child whose stamp the source also carries names the offset exactly — and by the suffix otherwise, which is what a continuation that resumes mid-way and runs to the end of its source always is. The alignment is then the thing that makes the adoption legal, so it is checked rather than assumed: a differing tag name, more children in the clone than in the source, or two paired stamps that disagree is a refusal naming both DOM paths. Softening any of them into a skip would put one block's words under another block's structure element, which is the failure the word-suffix check already refuses above.
 *
 * `mutateToContinuation`'s painted shell puts one of Cicero's own wrappers — a `div` with the word `shell` — around the box it slices, so the clone's root may be a wrapper where the source is the box itself. The wrapper gets no twin (it is transparent to the walk, R8) and its one child is paired with the source.
 *
 * @param twins - Filled: clone element → source element.
 * @param pathOf - For the refusals.
 * @param head - Whether the clone is a first fragment rather than a continuation, which is the one thing the alignment differs on (*the engine stopped showing the original*, S47).
 * @throws {CasterError} The clone does not mirror its source: a differing tag, a stamp that disagrees with its twin's, more children than the twin, or stamps that put the first child before the twin's.
 */
export function pairTrees(clone: Element, source: Element, twins: Map<Element,Element>, pathOf: (element: Element) => string, head: boolean = false) {
  const stamp = ( el: Element) => posOf(el);
  /** Pair one clone element with its twin, then its children by position. */
  const pair = (cloneEl: Element, twin: Element) => {
    // A box Cicero kept and did not display (*a box Cicero kept and did not display is on no page*, S67): since *every branch gets a place* (2026-09-21) a box outside a fragment's interval stays in the clone, in its place among its siblings, with the word `away` (the engine's `display: none`) and its text emptied, so that the author's structural selectors read on every page what they read in the source. It is on this page in no sense the printer cares about, so it gets no twin and nothing under it does — paired, it reached the structure tree as an element with no content, and a heading among them refused the export as a destination no page could name. Its siblings still align by position, which is why the count below goes on including it.
    if (isNotDisplayed(cloneEl)) return;
    if (cloneEl.tagName !== twin.tagName && cloneEl.children.length === 1 && isEngineMark(cloneEl)) {
      pair(cloneEl.children[0], twin);
      return;
    }
    if (cloneEl.tagName !== twin.tagName) {
      throw new CasterError(`caster: the continuation of ${pathOf(source)} does not mirror its source — ${pathOf(cloneEl)} is a <${cloneEl.tagName.toLowerCase()}> where the source has a <${twin.tagName.toLowerCase()}> at ${pathOf(twin)}. A continuation is a clone of its source with the consumed characters blanked, so the two trees are the same shape; a printer that guessed past this would put one block's words under another block's structure element.`, { element: pathOf(source) });
    }
    const cloneStamp = stamp(cloneEl);
    const twinStamp = stamp(twin);
    if (cloneStamp !== null && twinStamp !== null && cloneStamp !== twinStamp) {
      throw new CasterError(`caster: the continuation of ${pathOf(source)} does not mirror its source — ${pathOf(cloneEl)} carries the stamp ${cloneStamp} where its twin carries ${twinStamp}.`, { element: pathOf(source) });
    }
    twins.set(cloneEl, twin);
    // A facsimile (DESIGN.md S80, amended) is the copy Cicero's presenter wrote for an `<object type="application/pdf">`: its one `<canvas>` stands where the original holds its fallback `<img>`, and neither is walked, so the pairing stops at the element.
    if (cloneEl.tagName === 'OBJECT' && cloneEl.getAttribute('is') === 'beltype-facsimile') return;
    // The Compositor's hint marks (R8) are inserted into a composed clone and exist in no original, so they have no twin to pair with (*two merges, one arrangement*, S48).
    // A repeated group's copy (the `artifact` word) has no twin, and it stands for a group the source already holds: both leave the alignment, the copy from the clone and the source's group of the same tag from the twin's children, so the rows that continue still line up with their own source rows.
    // A fixed box or a running element written inside the block stays in the original and leaves every clone (`isCopiedPerPage`, 2026-11-08), so it leaves the twin's children too.
    const twinKids = [...twin.children].filter((k) => !isCopiedPerPage(k));
    // The second moment of reification (S79) writes where the page answers: `content: string(family)` reads the family's name in a clone on a page and nothing in its original, which stands on none. So a clone's generated span may have no twin, and it leaves the alignment.
    const generatedHasTwin = twinKids.some((k) => k.classList.contains(GENERATED_CLASS));
    const cloneKids = [...cloneEl.children].filter((k) => !hasWordOn(k, 'break') && !hasWordOn(k, 'fill') && !hasWordOn(k, ARTIFACT_WORD) && (generatedHasTwin || !k.classList.contains(GENERATED_CLASS)));
    for (const copy of cloneEl.children) {
      if (!hasWordOn(copy, ARTIFACT_WORD)) continue;
      const at = twinKids.findIndex((k) => k.tagName === copy.tagName);
      if (at >= 0) twinKids.splice(at, 1);
    }
    if (cloneKids.length > twinKids.length) {
      throw new CasterError(`caster: the continuation of ${pathOf(source)} does not mirror its source — ${pathOf(cloneEl)} has ${cloneKids.length} element children where its twin at ${pathOf(twin)} has only ${twinKids.length}. A continuation drops the children the previous page consumed; it never grows one.`, { element: pathOf(source) });
    }
    // A continuation drops the children the previous page consumed, so its first child aligns with the twin's last ones; a first fragment drops the children the next page resumes at, so its first child aligns with the twin's first (*the engine stopped showing the original*, S47). The stamps say which whenever the host asked for them, and this is the answer where it did not.
    let offset = head ? 0 : twinKids.length - cloneKids.length;
    for (let i = 0; i < cloneKids.length; i++) {
      const key = stamp(cloneKids[i]);
      if (key === null) continue;
      const at = twinKids.findIndex((t) => stamp(t) === key);
      if (at >= 0) { offset = at - i; break; }
    }
    if (offset < 0) {
      throw new CasterError(`caster: the continuation of ${pathOf(source)} does not mirror its source — the stamps under ${pathOf(cloneEl)} put its first child before the start of its twin's children at ${pathOf(twin)}.`, { element: pathOf(source) });
    }
    for (let i = 0; i < cloneKids.length; i++) pair(cloneKids[i], twinKids[offset + i]);
  };
  pair(clone, source);
}

/** Whether Cicero kept a box and did not display it (*a box Cicero kept and did not display is on no page*, S67) — read off the word `away` the engine writes (it was an inline `display: none !important` until *the piece words*, 2026-10-11), so a detached tree answers as a connected one does. */
export function isNotDisplayed( element: Element) {
  return hasWordOn(element, 'away');
}

/** The custom property the host rewrites `position: running(name)` into, the name its value (Cicero's `gcpm-encoding.js`' `RUNNING_PROP`, restated for the reason the engine's words are; `test/data-beltype.test.ts` pins it). */
export const RUNNING_PROPERTY = '--beltype-running';

/**
 * Whether the engine copies this element of an original per page rather than flowing it: a `position: fixed` box or a running element, read off the computed style as Cicero's `word-space.js`' `isFixedBox` reads it.
 *
 * @remarks
 * Egildo's ruling of 2026-11-08: the engine's intake no longer lifts such a box out of the block it was written in, so the original holds it at any depth while the engine's word space never held it and no flow fragment does (`fragments.js`' `stripFixedBoxes`). Its words are printed on every page as chrome, from the per-page copies the adapter reads in the fixed slot and the margin cells, and are checked there; the pairing and the partition leave the subtree out of the original. An element that cannot be asked is no such box.
 */
export function isCopiedPerPage(element: Element): boolean {
  const win = element.ownerDocument?.defaultView;
  if (!win || !element.isConnected) return false;
  const style = win.getComputedStyle(element);
  return style.position === 'fixed' || style.getPropertyValue(RUNNING_PROPERTY).trim() !== '';
}

/** Whether an element is a per-page clone of a `position: fixed` box (R9). */
export function isFixedClone( element: Element) {
  return hasWordOn(element, 'fixed');
}


/**
 * R4's pairing rule.
 *
 * @remarks
 * **The engine is asked first** (*an interval is a marked-content sequence*, DESIGN.md S71). Where the root answers `sourceOf` the source a continuation resumes is the fragment on the nearest earlier page that is a copy of the same original — or that original itself, presented whole — because the engine registered every clone it made at the moment it made it and answers by identity (`.claude/decisions/cicero/the-engine-names-the-source.md`). The rules below are what is left where it does not answer.
 *
 * Cicero stored no reference from a clone to its source when this was written (measured, *a continuation clone carries no link back to its source*, S14; history since 2026-09-18), so the source is found by rule: the belt's `pos:` stamp when the host asked for one (it rides across on `cloneNode`, and it is unique per node), else the last element of the same tag assigned to an earlier page that is neither a continuation nor a fixed clone.
 *
 * **What counts as a source changed with the engine** (*the engine stopped showing the original*, S47). The rule used to be *anything without the `fragment` word* — an original — because the first half of a divided block was the original, clipped. Since *the first fragment is constructed* it is a clone like the continuation, and under the old rule every divided block's continuation had no source at all and the printer refused the ordinary document. So the rule names what a source is rather than what it is not stamped with: a first fragment, or an original.
 *
 * The verification moved with it, to `verifyPartitions`: a continuation is no longer the tail of the thing it is paired with, so *suffix of its source* is no longer the property to check.
 *
 * @param root - The root the pages belong to, asked `sourceOf` where it answers.
 * @throws {CasterError} No earlier page holds a source for the continuation.
 */
export function pairContinuation(clone: Element, page: StripPage, pages: StripPage[], root?: CiceroRoot): { source: Element; sourcePage: number; } {
  const pos = posOf(clone);
  const sourceOf = root?.sourceOf ? ( el: Element) => (root as CiceroRoot).sourceOf?.(el) ?? null : null;
  // A painted monolith's continuation is the engine's `shell` wrapper around the box (`fragments.js`' painted shell), and an engine mark is a copy of nothing — so the box inside it is the one asked.
  const original = sourceOf ? sourceOf(clone) ?? (hasWordOn(clone, 'shell') && clone.children.length === 1 ? sourceOf(clone.children[0]) : null) : null;
  let candidate: { source: Element; sourcePage: number; }|null = null;
  for (let i = page.index - 1; i >= 0 && !candidate; i--) {
    for (const node of pages[i].flow) {
      // A continuation or a fixed box's per-page copy can be nobody's source. A composed block's clone can (*M4 was three defects*, S43): in the composed mode every block on a page is a `fragment` clone and its original is unassigned, so skipping every fragment left a continuation with no source on any page.
      if (isContinuation(node) || isFixedClone(node)) continue;
      if (sourceOf) {
        if (original && (sourceOf(node) ?? node) === original) candidate = { source: node, sourcePage: i };
        continue;
      }
      if (pos !== null) {
        if (posOf(node) === pos) { candidate = { source: node, sourcePage: i }; break; }
        continue;
      }
      if (node.tagName === clone.tagName) candidate = { source: node, sourcePage: i };
    }
  }
  if (!candidate) {
    throw new CasterError(`caster: the continuation on page ${page.index + 1} has no source on any earlier page — ${sourceOf ? (original ? 'the engine was asked (`sourceOf`) and named an original no earlier page presents, whole or as a fragment' : 'the engine was asked (`sourceOf`) and answered that it is a copy of nothing the author wrote') : 'the engine answers no `sourceOf`, and neither the belt\'s stamp nor the last element of its tag on an earlier page names one'}; a continuation is the tail of a block that began somewhere, and printing it under no structure element would put its words outside the tree`, { element: clone.tagName.toLowerCase(), pos: pos === null ? undefined : pos });
  }
  return candidate;
}

/**
 * The verification, which is now a statement about a block's fragments together (*the engine stopped showing the original*, S47): **the first fragment is a prefix of the original, every continuation is a suffix of it, and the first fragment and the fragment that resumes it cover the block exactly** — no word on two pages, none on none.
 *
 * @remarks
 * It replaces *the continuation is a suffix of its source*, which was true only while the first half of a divided block was the original. It is also the stronger claim: a suffix test can say nothing about the half the earlier page shows, and the whole reason the engine constructs a first fragment is that the earlier page now shows a fragment of its own.
 *
 * **Why it is not stated as one partition over every fragment**, which is what the plan for this change said and what the first implementation wrote: a continuation carries the block's whole remaining tail and is clipped at its own page's cut, so an intermediate continuation's words run past the page it is on. Only the last fragment's clipped tail is empty. Measured on the specimen the moment the check was written — nine fragments summing to 16 003 words for a 3 708-word block — and the reading is right: the sum is not the invariant, the two edges are. So the partition is asserted where it is a fact (the first pair covers the block) and containment where it is a fact (every later fragment is a tail of the same block).
 *
 * The original is the canonical box Cicero leaves unassigned in `<beltype-root>`'s light DOM (I6). The engine is asked for it first (`sourceOf`, *an interval is a marked-content sequence*, DESIGN.md S71); where the root does not answer it is found by the belt's `pos:` stamp where the host asked for one, and otherwise by tag where exactly one light-DOM original carries that tag — the belt's own ordinary shape, one top-level `<section>` (*what the slot assigns is coarser than the harness ever met*, S13). **Where the original cannot be found, only half the claim is reachable**, and this checks that half: the continuation's first word is not the fragment's last, which is what a boundary word printed on both pages looks like. A mismatch is an export error naming the block, because a silently wrong pairing prints one block's words under another block's structure element.
 *
 * @throws {CasterError} A block's fragments print a word twice or leave one on no page; a continuation of an original is not a tail of it; or, where the original cannot be found, a boundary word is on both pages.
 */
export function verifyPartitions(pages: StripPage[], strip: CiceroRoot) {
  const bySource: Map<Element,{ sourcePage: number; clones: Element[]; }> = new Map<any, any>();
  for (const page of pages) {
    for (const { clone, source, sourcePage } of page.continuations) {
      const entry = bySource.get(source) ?? { sourcePage, clones: [] };
      bySource.set(source, entry);
      entry.clones.push(clone);
    }
  }
  const originals = [...strip.children].filter((el) => !isFragment(el));
  for (const [source, { sourcePage, clones }] of bySource) {
    const head = joinedWords(source);
    const whole = originalOf(source, originals, strip);
    const where = { element: source.tagName.toLowerCase(), pos: posOf(source) ?? undefined };
    const refuse = ( why: string) => { throw new CasterError(`caster: the block beginning on page ${sourcePage + 1} ${why}. The printer refuses rather than print one block's words under another block's structure element.`, where); };
    if (!whole) {
      const first = joinedWords(clones[0]);
      if (head.length && first.length && head[head.length - 1] === first[0]) {
        refuse(`shares the word ${JSON.stringify(first[0])} across the boundary, so one word would print on two pages — and its original is not in the light DOM under a name this adapter can read (${strip.sourceOf ? 'the engine was asked, `sourceOf`, and named none' : 'the engine answers no `sourceOf`'}), so this is the only half of the claim it can check`);
      }
      continue;
    }
    const all = joinedWords(whole);
    if (!isFirstFragment(source)) {
      // The source is the original itself, shown whole with its tail under the engine's clip — a carried parallel flow, which Cicero has not yet made an interval. Its continuations are still tails, and that is still the property to check.
      for (const clone of clones) {
        const tail = joinedWords(clone);
        if (!isSuffix(tail, all)) refuse(`has a continuation that is not a tail of it — ${tail.length} word(s) against ${all.length}, beginning ${JSON.stringify(tail[0] ?? '')}`);
      }
      continue;
    }
    /**
     * The partition, stated as one at last (*a box Cicero kept and did not display is on no page*, S67). A fragment holds exactly its interval since *every branch gets a place* — a middle fragment is ended at its cut like a first one, and what lies outside a fragment is kept with its text emptied — so the sentence that *the engine stopped showing the original* (S47) could not write is true: **a block's fragments, together, hold the block's words: none twice, none nowhere.** *Every continuation is a suffix* went with it, because a middle fragment is an interval and not a tail, and the old check refused the ordinary three-page block (145 words against 315, measured).
     *
     * @remarks
     * Counted per word and not compared as a sequence. A block that holds a row — two table cells, two flex items — is not a sequence across pages: page one shows the head of each cell and page two the rest of each, so its fragments concatenate to the right words in an order the source never had. Which page a word is on and in what order a fragment holds its own are the engine's claims, checked where they are made (`packages/essay/lib/census.js`); what a printer must refuse is a word printed twice or not at all, and that is a count.
     */
    // A painted slice is the whole box on every page, the page's clip showing a part of it (the shell, `fragments.js`; *the slice wrapper's clip*, S69), so its words are counted once: each fragment holds the block's words, and what a page shows of them is the placement's clip.
    if (clones.every((c) => hasWordOn(c, 'shell'))) {
      for (const words of [source, ...clones].map(joinedWords)) {
        if (words.length !== all.length || words.some((w, i) => w !== all[i])) refuse(`is a painted slice and a fragment of it holds ${words.length} word(s) where the block holds ${all.length}`);
      }
      continue;
    }
    const owed = new Map<any, any>();
    for (const w of all) owed.set(w, (owed.get(w) ?? 0) + 1);
    const lists = [source, ...clones].map(joinedWords);
    for (const words of lists) for (const w of words) owed.set(w, (owed.get(w) ?? 0) - 1);
    // A word divided at the cut is one word (*a word divided at the cut is one word*, S70). Since *a line inside a word is a break point* the engine may end a fragment inside a word, and since *the hyphen is written at the cut* the fragment's half then carries the hyphenation character the browser drew. The two halves, over-printed as words the block never held, are folded back into the one word the block owes — read with and without the head's last character, because the hyphen is ink the engine wrote and not the author's letter.
    for (let i = 0; i + 1 < lists.length; i++) {
      const a = lists[i], b = lists[i + 1];
      if (!a.length || !b.length) continue;
      const head = a[a.length - 1], tail = b[0];
      if ((owed.get(head) ?? 0) >= 0 || (owed.get(tail) ?? 0) >= 0) continue;
      const joined = [head + tail, head.slice(0, -1) + tail].find((w) => (owed.get(w) ?? 0) > 0);
      if (!joined) continue;
      owed.set(head, owed.get(head) + 1);
      owed.set(tail, owed.get(tail) + 1);
      owed.set(joined, owed.get(joined) - 1);
    }
    const twice = [...owed].filter(([, n]) => n < 0).map(([w]) => w);
    const nowhere = [...owed].filter(([, n]) => n > 0).map(([w]) => w);
    if (twice.length || nowhere.length) refuse(`is not partitioned by its ${clones.length + 1} fragments — ${twice.length} word(s) printed more often than the block holds them${twice.length ? ` (${JSON.stringify(twice[0])}…)` : ''}, ${nowhere.length} on no page${nowhere.length ? ` (${JSON.stringify(nowhere[0])}…)` : ''}`);
  }
}

/**
 * The canonical box a fragment is a fragment of, or null when nothing names it.
 *
 * @remarks
 * Itself when it is the original; else the engine's answer, where the root gives one (`sourceOf`, *an interval is a marked-content sequence*, DESIGN.md S71) — by identity, so it holds where the rules below cannot, among seventeen unstamped top-level `<section>`s (measured 2026-10-08 on the manual, `docs/census-2026-10-08.md`); else, only where the root has no such method, the light-DOM original with its stamp, else the only light-DOM original of its tag.
 */
function originalOf(source: Element, originals: Element[], root: CiceroRoot): Element|null {
  if (!isFragment(source)) return source;
  if (root.sourceOf) return root.sourceOf(source);
  const pos = posOf(source);
  if (pos !== null) return originals.find((el) => posOf(el) === pos) ?? null;
  const sameTag = originals.filter((el) => el.tagName === source.tagName);
  return sameTag.length === 1 ? sameTag[0] : null;
}

/** The word space, as `packages/engine-cicero/src/fragments.js`'s own `joinedWords` defines it: maximal non-whitespace runs of the subtree's joined text, where a run crosses a text-node or inline-element seam and never a non-inline one (`word-space.js`'s `isInlineBox`: the computed `display` starts with `inline`, and an element that cannot be asked joins). Restated here rather than imported, because importing it would make the printer depend on an engine's interior — the property Caster exists to avoid. If the two ever drift, the verification above is what says so, loudly — and it did (*M4 was three defects*, S43): this used to be `textContent.split(/\s+/)`, which fuses KaTeX's absolutely-positioned MathML half onto the HTML half as one word, so a cut resuming at a formula paired its continuation against a token the source never had. */
export function joinedWords(root: Element): string[] {
  const words: string[] = [];
  let open = false;
  const win = root.ownerDocument?.defaultView;
  const joins = ( el: Element) => !win || !el.isConnected || win.getComputedStyle(el).display.startsWith('inline');
  const walk = ( node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        if (isEngineHyphen((child as Text))) continue;
        const s = (child as Text).data;
        for (let i = 0; i < s.length; i++) {
          if (s[i] === '\u00AD') continue; // a soft hyphen is no part of a word's identity: drawn only at a break, and there the engine writes the hyphenation character in its place (*a word divided at the cut is one word*, S70)
          if (/\s/u.test(s[i])) { open = false; continue; }
          if (open) words[words.length - 1] += s[i];
          else { words.push(s[i]); open = true; }
        }
      } else if (child.nodeType === 1) {
        // A repeated group's copy is the table's header or footer drawn again, not words of the block: the block's own words are the ones its fragments hold once (*a table Paged.js cut across pages is one table in several fragments*, DESIGN.md S63; the artifact word).
        if (hasWordOn((child as Element), ARTIFACT_WORD)) continue;
        // Generated text is the printer's reading of a pseudo-element, not a word of the block, and the second moment writes it where the page answers (S79): in a clone and not in its original.
        if ((child as Element).classList.contains(GENERATED_CLASS)) continue;
        // A fixed box or a running element is in the original and in no flow fragment, because the engine's word space never held it; its words are the per-page copies', checked where they are printed (`isCopiedPerPage`, 2026-11-08).
        if (isCopiedPerPage(child as Element)) continue;
        const inline = joins((child as Element));
        if (!inline) open = false;
        walk(child);
        if (!inline) open = false;
      }
    }
  };
  walk(root);
  return words;
}

/** The hyphenation character the Compositor wrote, which is ink and not a word (*the Compositor's hyphen is ink, not a word*, S56). `compose-dom.js` breaks a hyphenated word by splitting its text node and inserting the character as a text node of its own directly before a `br` carrying the word `break`, so a fragment's `communica‐tion` read as one word against the original's `communication` and `verifyPartitions` refused every composed block with a hyphenated line — measured by `test/pairing.test.js`. The character is the one the engine chose, css-text-4 §6.3.2's `hyphenate-character` with `auto` meaning U+2010 (`compose-dom.js`'s `hyphenCharOf`, restated for the reason `joinedWords` is); an emergency break writes none, so there is nothing to skip. */
function isEngineHyphen(node: Text) {
  const next = node.nextSibling;
  if (!(next instanceof Element) || !hasWordOn(next, 'break')) return false;
  const parent = node.parentElement;
  const win = node.ownerDocument?.defaultView;
  const raw = parent && win && parent.isConnected ? (win.getComputedStyle(parent).hyphenateCharacter || 'auto').trim() : 'auto';
  const ch = raw === 'auto' || raw === '' ? '\u2010' : /^["']/.test(raw) ? raw.slice(1, -1).replace(/\\(.)/g, '$1') : raw;
  return node.data === ch;
}

/** Whether `tail` is the last words of `whole`. */
function isSuffix(tail: string[], whole: string[]) {
  if (tail.length === 0) return true;
  if (tail.length > whole.length) return false;
  const from = whole.length - tail.length;
  for (let i = 0; i < tail.length; i++) if (whole[from + i] !== tail[i]) return false;
  return true;
}

/** Round to three decimals. */
const round3 = ( n: number) => Math.round(n * 1000) / 1000;

/**
 * R6's artifact kinds, as a decision.
 *
 * @remarks
 * PDF's pagination artifact subtypes are `Header`, `Footer`, `Watermark`, `PageNum` and `Background`. Cicero's sixteen margin cells sit in a 5×5 grid: the top row is a header, the bottom row a footer, and the left and right columns are neither — a side note is nearest to a header, and that is what they get. A cell whose whole text is the page's own folio may be `/PageNum`; the three-row rule is implemented and the folio refinement is recorded as open (DESIGN.md).
 *
 * @param box - The `data-box` value: `top-left`, `left-middle`, `bottom-center`, …
 * @returns The walk's own artifact kind, the value `ARTIFACT_ATTRIBUTE` carries.
 */
export function artifactKindOfBox(box: string): 'header'|'footer' {
  return box.startsWith('bottom') ? 'footer' : 'header';
}

export type MarginText = { cell: HTMLElement, which: '::before'|'::after', text: string };

/**
 * The text a page's margin cells paint as `::before` and `::after`, resolved and not yet written.
 *
 * @remarks
 * The reading half of the lift, done for every page before any page is lifted. Measured 2026-10-29 on the manual (304 pages): read page by page between the lifts, each read came after the previous page's writes and made the browser restyle the document first, and the lift took 0.41 s.
 *
 * The page's own counters are reset on the host, the author's on the cell itself (`chase.js`'s `setCounters`). A page with no shadow root answers nothing here and is refused by name where its content area is read.
 *
 * @param page - The `<beltype-page>` host.
 * @param index - The page's index, for the refusal.
 */
function marginTextsOf(page: HTMLElement, index: number): MarginText[] {
  const view = (page.ownerDocument.defaultView as Window);
  const shadow = page.shadowRoot;
  if (!shadow) return [];
  const hostScopes = pairsOf(view.getComputedStyle(page).counterReset).map(([name, value]) => ({ name, value, ownerDepth: 0 }));
  const texts: MarginText[] = [];
  for (const cell of (shadow.querySelectorAll('.margin-cell') as NodeListOf<HTMLElement>)) {
    const scopes = [...hostScopes, ...pairsOf(view.getComputedStyle(cell).counterReset).map(([name, value]) => ({ name, value, ownerDepth: 1 }))];
    for (const which of (['::before', '::after'] as const)) {
      const content = view.getComputedStyle(cell, which).content;
      if (!content || content === 'none' || content === 'normal') continue;
      const text = resolveGenerated(content, cell, scopes, `page ${index + 1} ${cell.dataset.box ?? ''} margin box`, which);
      if (text.trim() !== '') texts.push({ cell, which, text });
    }
  }
  return texts;
}

/**
 * The margins, lifted into the one spelling the walk reads (*the margins are lifted into the light DOM*, S57).
 *
 * @remarks
 * Cicero delivers a margin box's content two ways. Since *the page carries its conditions* (`engine-cicero`, 2026-10-21) a folio, a literal and a named string are the cell's `::before` (and `::after`, where a running element splits the value), its `content` transliterated into the page's shadow sheet and spelled by the browser against the counters the page host resets and the string properties it sets — inside the page's shadow, which the walk never enters (*the folio is in the file under Paged.js, not under Cicero*, S53), and painted by no text node at all. An `element()` part is a clone of the author's running element, slotted into the cell through a forwarding slot, and it is light DOM already. The second spelling is the one everything downstream can read, so the first is brought to it, in two steps. The pseudo-element is made a text node of the cell, its `content` resolved by reification's own `resolveGenerated` against the computed `counter-reset` of the host (the page's own two) and of the cell (the author's counters at the page's start), every `var()` already substituted in the computed value, and the page's two pseudo-elements on every cell are suppressed by one rule in its shadow; then each text node in a cell becomes a `<span>` appended to the strip's light DOM and slotted back into the same place through the same two-slot chain the engine builds for a running element. The span inherits from the cell in the flattened tree, so it is laid out in the cell's own font at the cell's own position, and the page does not move. A counter in an author's own `@counter-style` is spelled in decimal here, `resolveGenerated`'s own limit.
 *
 * Every element that ends up in a cell is then stamped with the walk's artifact attribute, header or footer by R6's row rule. That keeps margin content out of the structure tree — a running head is pagination, not prose — and it is what the walk already knows how to ink: a stamped element's text is measured, and an `<img>` inside it is placed as the artifact's own XObject.
 *
 * This writes to the engine's presentation, and it may for the reason `prepare()` may: the print frame is Caster's own and is discarded after the export (D1). The span carries the `fragment` word because, like every clone, it is a product of the presentation rather than an element the author wrote, so it is never taken for an original.
 *
 * @param page - The `<beltype-page>` host.
 * @param strip - `<beltype-root>`.
 * @param roots - Filled with every top-level element now in a margin.
 * @param running - Filled with every running element's clone, and its kind.
 * @param index - The page's index, for the refusal.
 * @param texts - The page's generated margin text, from `marginTextsOf`.
 * @throws {CasterError} An element in a margin cell that is neither a lifted span nor a copy the engine marked with the `artifact` word.
 */
function liftMargins(page: HTMLElement, strip: HTMLElement, roots: Set<Element>, running: Map<Element,'header'|'footer'>, index: number, texts: MarginText[]) {
  const doc = page.ownerDocument;
  const shadow = (page.shadowRoot as ShadowRoot);
  const suppress = doc.createElement('style');
  suppress.textContent = '.margin-cell::before, .margin-cell::after { content: none !important; }';
  // The pseudo-elements first, made text nodes of the cell where they stand, so the lift below takes them like any other text.
  for (const { cell, which, text } of texts) {
    if (which === '::before') cell.prepend(doc.createTextNode(text));
    else cell.append(doc.createTextNode(text));
  }
  for (const cell of (shadow.querySelectorAll('.margin-cell') as NodeListOf<HTMLElement>)) {
    const kind = artifactKindOfBox(cell.dataset.box ?? '');
    const lifted: Set<Element> = new Set<any>();
    for (const node of [...cell.childNodes]) {
      if (node.nodeType !== 3 || (node as Text).data.trim() === '') continue;
      const span = doc.createElement('span');
      addWordTo(span, FRAGMENT_WORD);
      span.textContent = (node as Text).data;
      strip.append(span);
      // The engine's own order (`setMarginBox`): the forwarding slot is appended to the page before it assigns, and the cell's slot is assigned to it.
      const forward = doc.createElement('slot');
      page.append(forward);
      forward.assign(span);
      const slot = doc.createElement('slot');
      slot.assign(forward);
      node.replaceWith(slot);
      lifted.add(span);
    }
    for (const slot of cell.querySelectorAll('slot')) {
      for (const element of slot.assignedElements({ flatten: true })) {
        element.setAttribute(ARTIFACT_ATTRIBUTE, kind);
        roots.add(element);
        // A running element's copy is the one the engine marked with the `artifact` word (*the margins are lifted into the light DOM*, DESIGN.md S57 and *a running element's original is the element the engine hid*, S60; the artifact word); a lifted span is ours and carries none. Anything else in a cell means the engine stopped marking its copies, and that is refused by name rather than guessed at.
        if (hasWordOn(element, ARTIFACT_WORD)) running.set(element, kind);
        else if (!lifted.has(element)) throw new CasterError(`caster: page ${index + 1} places <${element.tagName.toLowerCase()}> in a margin box without the data-beltype word \`${ARTIFACT_WORD}\`, so it is not a running element's copy the engine marked. The engine writes the word on every copy a margin cell receives; an element in a cell without it means that stopped.`, { element: element.tagName.toLowerCase() });
      }
    }
  }
  // Every cell read, the pseudo-elements go: the text they painted is the cells' own now.
  shadow.append(suppress);
}

/** The strip child an element sits under, or the element itself when it is outside the strip's light DOM. */
function topOf(element: Element, strip: Element) {
  let node: Element = element;
  while (node.parentElement && node.parentElement !== strip) node = node.parentElement;
  return node;
}

/**
 * The `@page` background each page paints.
 *
 * @remarks
 * Cicero forwards a declaration inside `@page` that it does not own onto the page host — the whole point of *the page context dresses the host* — so the value is on the host's own computed style and nowhere in the document tree. Measured: `@page { background: #fdf2d0 }` reads `rgb(253, 242, 208)` on `<beltype-page>`, and a document declaring nothing reads `rgb(255, 255, 255)`, which is the Chase's own `:host` default rather than anything an author wrote.
 *
 * **Opaque white is skipped, and the reason is the medium rather than a guess about intent.** A PDF page has no ground of its own; the sheet it is printed on or the viewer's canvas is white already, so filling it white paints nothing a reader can see and costs a rectangle on every page — including every page of every document that declares no background at all, which cannot be told apart from one that declares white.
 *
 * **A translucent background is composited against white here, not carried as an alpha.** A page's ground has nothing behind it: the sheet is the bottom of the stack, so `rgba(0, 0, 0, 0.1)` over a page is `rgb(230, 230, 230)`, and computing it at the source spares the emitter an `ExtGState` for a blend whose other operand is known.
 *
 * A `background-image` is read here and placed by {@link seatPageImages}; {@link pageImageOf} refuses what cannot be placed.
 *
 * @throws {CasterError} Whatever {@link pageImageOf} refuses.
 */
function pageBackgroundsOf(pages: StripPage[]): { backgrounds: { page: number; rgb: [number,number,number]; }[]; images: PageImage[]; } {
  const backgrounds = [];
  const images: PageImage[] = [];
  for (const page of pages) {
    const style = getComputedStyle(page.element);
    const image = pageImageOf(style, page);
    if (image) images.push({ page, ...image, backgroundSize: style.backgroundSize, backgroundPosition: style.backgroundPosition, backgroundRepeat: style.backgroundRepeat });
    const ground = groundOf(style.backgroundColor);
    if (ground) backgrounds.push({ page: page.index, rgb: ground });
  }
  return { backgrounds, images };
}

/** One page's `@page` image, read before anything is written to the document: one `url()`, or a list of gradients, which is `url` null and the computed `background-image` itself. */
type PageImage = { page: StripPage; url: string|null; gradients: string; backgroundSize: string; backgroundPosition: string; backgroundRepeat: string; };

/** The background properties a page image does not model, each with the one value it honours. */
const PAGE_IMAGE_PINNED = [['backgroundOrigin', 'background-origin', 'padding-box'], ['backgroundClip', 'background-clip', 'border-box'], ['backgroundAttachment', 'background-attachment', 'scroll'], ['backgroundBlendMode', 'background-blend-mode', 'normal']] as const;

/** The gradients a page background draws as shadings, on the road a box's gradient takes. */
const PAGE_GRADIENT = /^(repeating-)?(linear|radial)-gradient$/;

/**
 * The image a page's computed style paints as its background: one `url()`, or one or more linear and radial gradients; null where it paints none.
 *
 * @remarks
 * A gradient list is seated whole on one box by {@link seatPageImages}, and the walk draws it as it draws any box's gradients, each layer one shading, the first nearest the reader (*a page's gradient takes the box's road*, S107).
 *
 * @throws {CasterError} A background that is neither (a conic gradient, an image beside a gradient, two images), a gradient tile that repeats inside the page, or one that sets a property in {@link PAGE_IMAGE_PINNED}. A printer that dropped it would hand back a page whose ground the author chose and the file does not have.
 */
function pageImageOf(style: CSSStyleDeclaration, page: StripPage): { url: string|null; gradients: string; }|null {
  const image = style.backgroundImage;
  if (!image || image === 'none') return null;
  const index = page.index;
  const element = `page ${index + 1}`;
  const layers = splitTopLevel(image);
  const names = layers.map((layer) => functionCall(layer)?.name ?? '');
  const conic = names.find((name) => /conic-gradient$/.test(name));
  if (conic) throw new CasterError(`caster: the @page background on page ${index + 1} is ${image}, and ${conic}() has no PDF shading to draw it with. A box's conic gradient is rasterised; a page's is refused rather than printed as a page-sized bitmap. Use a linear or radial gradient.`, { element });
  const gradient = names.every((name) => PAGE_GRADIENT.test(name));
  const url = gradient ? null : /^url\("([^"]+)"\)$/.exec(image)?.[1];
  if (url === undefined) throw new CasterError(`caster: the @page background on page ${index + 1} is ${image}, which this printer does not place against a page box yet: it places one url() image, or linear and radial gradients. A colour is placed; anything else would be dropped, and a page whose ground the author chose is not one to drop in silence.`, { element });
  for (const [property, name, value] of PAGE_IMAGE_PINNED) {
    const declared = splitTopLevel(style[property]).find((layer) => layer.trim() !== value);
    if (declared !== undefined) throw new CasterError(`caster: the @page background on page ${index + 1} declares ${name}: ${style[property]}, and this printer places a page's image only with ${name}: ${value}.`, { element });
  }
  if (gradient) {
    const area = { x: 0, y: 0, w: page.declaredPx.widthPx, h: page.declaredPx.heightPx };
    layers.forEach((layer, at) => {
      if (!gradientTile(style, at, area, area)) throw new CasterError(`caster: the @page background on page ${index + 1} has background-repeat: ${style.backgroundRepeat} and background-size: ${style.backgroundSize}, so the tile of ${layer} repeats inside the page box. This printer draws one tile of a gradient; use no-repeat, or a size that covers the page.`, { element });
    });
  }
  return { url, gradients: gradient ? image : '' };
}

/**
 * A page image's own size in CSS px, as `background-size: auto` reads it.
 *
 * @remarks
 * Not an SVG's `naturalWidth`: Chromium rounds it to a whole pixel and answers 300 by 150 for a file with no size at all, where CSS would fit that file to the page. Such a file refuses rather than land somewhere else.
 *
 * @throws {CasterError} An SVG with no absolute width and height.
 */
async function pageImageSizeOf(image: HTMLImageElement, { page, backgroundSize }: PageImage, url: string, gateway: Gateway): Promise<[number,number]> {
  const { bytes, mimeType } = await gateway.getBytes(url);
  if (mimeType !== 'image/svg+xml') return [image.naturalWidth, image.naturalHeight];
  const svg = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'image/svg+xml').documentElement as unknown as SVGSVGElement;
  const absolute = (length: SVGAnimatedLength|undefined) => (length && length.baseVal.unitType !== length.baseVal.SVG_LENGTHTYPE_PERCENTAGE ? length.baseVal.value : 0);
  const [w, h] = svg.hasAttribute('width') && svg.hasAttribute('height') ? [absolute(svg.width), absolute(svg.height)] : [0, 0];
  if (w > 0 && h > 0) return [w, h];
  throw new CasterError(`caster: the @page background on page ${page.index + 1} is an SVG with no width and height of its own (${url}), and background-size: ${backgroundSize} asks for the image's own size. Name the size in background-size, or give the file a width and a height.`, { element: `page ${page.index + 1}` });
}

/**
 * The size of a page image's tile, from `background-size` (CSS Backgrounds 3, §3.9).
 *
 * @param natural - Asked only where the rule does not name both lengths.
 */
async function pageImageTileSize(backgroundSize: string, area: { w: number; h: number; }, natural: () => Promise<[number,number]>): Promise<[number,number]> {
  const tokens = shapeTokens(backgroundSize);
  if (tokens[0] === 'contain' || tokens[0] === 'cover') {
    const [w, h] = await natural();
    const scale = Math[tokens[0] === 'contain' ? 'min' : 'max'](area.w / w, area.h / h);
    return [w * scale, h * scale];
  }
  const named = (token: string|undefined, of: number) => (token === undefined || token === 'auto' ? null : lengthPercentage(token, of));
  const [w, h] = [named(tokens[0], area.w), named(tokens[1], area.h)];
  if (w !== null && h !== null) return [w, h];
  const [ownW, ownH] = await natural();
  return w !== null ? [w, (w * ownH) / ownW] : h !== null ? [(h * ownW) / ownH, h] : [ownW, ownH];
}

/**
 * The `@page` images, seated on their pages as artifacts, so each takes the road an artifact's `<img>` already takes: a raster is embedded and an SVG is a drawing (*an SVG that arrives through an `<img>` is a drawing*, S44).
 *
 * @remarks
 * Nothing in the DOM carries a page's background, and a drawing has to be in the document the collectors walk, so one is made, per page: a box at the tile's rectangle in the page's coordinates, holding an `<img alt="">`. It stands in the strip's light DOM, slotted into the page through the two-slot chain of a lifted margin (*the margins are lifted into the light DOM*, S57), and is margin content for the same reason a margin is: it lies outside the content area by construction, so R5's clip does not apply. It comes last in the strip so that no `:first-child` of the author's moves, and `z-index: -1` is what puts it first in the paint order, under the page's content. The box's position is absolute, so nothing on the page moves; every property is reset, `!important`, because the author's `div` and `img` rules reach this document and an image in a background obeys none of them.
 *
 * The positioning area is the page's nominal box, the size of the file's page, where the host stands a pixel short (*the one-pixel inset is real*, S10). The host has no padding or border of its own, since the capture puts those on `.content-area`, so its padding box and its page box are one.
 *
 * ponytail: one tile, on the road the gradients of `backgroundTile` take. A tile that repeats inside the page refuses; seat one box per tile when a document needs it.
 *
 * @throws {CasterError} A tile that repeats inside the page, and whatever {@link pageImageSizeOf} refuses.
 */
async function seatPageImages(images: PageImage[], strip: HTMLElement, marginRoots: Set<Element>, gateway: Gateway) {
  const sizes: Map<string, Promise<[number,number]>> = new Map();
  for (const entry of images) {
    const { page, url, backgroundSize } = entry;
    const doc = strip.ownerDocument;
    const area = { x: 0, y: 0, w: page.declaredPx.widthPx, h: page.declaredPx.heightPx };
    if (url === null) {
      // A gradient has no size of its own and needs no load: one box over the page box carries the page's own background layers, and the walk tiles and draws them as it does any box's.
      const box = doc.createElement('div');
      const background = (['image', 'size', 'position', 'repeat'] as const).map((p) => `background-${p}: ${p === 'image' ? entry.gradients : p === 'size' ? backgroundSize : p === 'position' ? entry.backgroundPosition : entry.backgroundRepeat} !important;`).join(' ');
      seatPageBox(box, page, strip, marginRoots, `left: 0 !important; top: 0 !important; width: ${area.w}px !important; height: ${area.h}px !important; ${background}`);
      continue;
    }
    const image = doc.createElement('img');
    image.alt = '';
    image.src = url;
    // A file the browser cannot show is not refused here: the gateway refuses it by name when the walk reads its bytes.
    await image.decode().catch(() => {});
    const [w, h] = await pageImageTileSize(backgroundSize, area, () => {
      if (!sizes.has(url)) sizes.set(url, pageImageSizeOf(image, entry, url, gateway));
      return sizes.get(url) as Promise<[number,number]>;
    });
    const placed = backgroundTile(entry, 0, w, h, area, area);
    if (!placed) throw new CasterError(`caster: the @page background on page ${page.index + 1} has background-repeat: ${entry.backgroundRepeat} and a tile of ${w.toFixed(1)} by ${h.toFixed(1)} px, which repeats inside the page box. This printer places one tile; use no-repeat, or a size that covers the page.`, { element: `page ${page.index + 1}` });
    const box = doc.createElement('div');
    image.style.cssText = 'all: initial !important; display: block !important; width: 100% !important; height: 100% !important;';
    box.append(image);
    seatPageBox(box, page, strip, marginRoots, `left: ${placed.tile.x}px !important; top: ${placed.tile.y}px !important; width: ${w}px !important; height: ${h}px !important;`);
  }
}

/** One page's background box, an artifact at `placement`, slotted into its page as a lifted margin is. */
function seatPageBox(box: HTMLElement, page: StripPage, strip: HTMLElement, marginRoots: Set<Element>, placement: string) {
  const doc = strip.ownerDocument;
  box.setAttribute(ARTIFACT_ATTRIBUTE, 'layout');
  addWordTo(box, FRAGMENT_WORD);
  box.style.cssText = `all: initial !important; display: block !important; position: absolute !important; z-index: -1 !important; ${placement}`;
  strip.append(box);
  const forward = doc.createElement('slot');
  page.element.append(forward);
  forward.assign(box);
  const slot = doc.createElement('slot');
  slot.assign(forward);
  (page.element.shadowRoot as ShadowRoot).append(slot);
  marginRoots.add(box);
}

/**
 * A computed `background-color` as the ground a page paints, or null where it paints nothing a reader can see.
 *
 * @remarks
 * Pure, and separated from the walk for exactly that: the compositing and the white rule are the part that can be wrong, and neither needs a browser to check.
 *
 * @param backgroundColor - A computed `rgb()` / `rgba()` — what `getComputedStyle` always answers with.
 */
export function groundOf(backgroundColor: string): [number,number,number]|null {
  const match = /^rgba?\(([^)]+)\)$/.exec((backgroundColor ?? '').trim());
  if (!match) return null;
  // Both serialisations: Chromium answers `rgba(0, 0, 0, 0.5)` for a legacy declaration and `rgb(0 0 0 / 0.5)` for a modern one, so the separator is comma, slash or space alike.
  const parts = match[1].trim().split(/[\s,/]+/).map((value) => Number.parseFloat(value));
  const [r, g, b] = parts;
  const alpha = parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1;
  if (![r, g, b].every(Number.isFinite) || !(alpha > 0)) return null;
  const over = ([r, g, b].map((c) => Math.round(c * alpha + 255 * (1 - alpha))) as [number, number, number]);
  return over[0] === 255 && over[1] === 255 && over[2] === 255 ? null : over;
}
