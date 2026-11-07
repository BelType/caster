/**
 * `adapters/strip.js` — the page strip, the whole of what the printer asks of whoever presented the pages (PLAN.md §5; the Paged.js adapter's round, DESIGN.md S50–S55; *`print()` takes a strip from its host*, DESIGN.md S62).
 *
 * Caster's own; no harness source — the harness's fixtures laid their pages in one horizontal strip and `frame.ts` read them where they stood (E10), so there was no engine to ask. Guide: `docs/guide/coordinates-and-pages.md`.
 *
 * Types only, because a strip is a fact about a DOM and not about an engine (see CHANGELOG 2026-09-21). A minimal one — one sized box per page, nothing cut across pages — answers `twinOf: () => null`, `transparent: () => false`, `flowBox: null`, `trimBox: null`, `continuations: []`, `backgrounds: []`, and `probeRoot` the strip itself, which must establish a containing block (`position: relative`) for the frame's probes.
 *
 * @packageDocumentation
 */

import type { Gateway } from '../host/gateway.ts';

/** One page of a {@link PageStrip}: its box, its flow, and what the engine cut across it. */
export type StripPage = {
  /** The page's own element — the box whose border box is the page (Cicero's `<beltype-page>` host, Paged.js's `.pagedjs_page`, a host's sized `<div>`). */
  element: HTMLElement;
  index: number;
  /** The page's assigned nodes, in flow order (R3). */
  flow: Element[];
  /** The page box, from the engine's own literals (R2; *the one-pixel inset is real*, S10). */
  nominal: { widthPt: number, heightPt: number };
  /** The same before the pt conversion, as `chase.js` wrote them. */
  declaredPx: { widthPx: number, heightPx: number };
  /** The box the flow is laid out in (Cicero's `.content-area`, Paged.js's `.pagedjs_area`); the page element itself where a page has no margins of its own. */
  contentArea: HTMLElement;
  /** The element whose border box marks the trim inside the page, where the page draws one (`.trim`), else null — `geometryOfPage`'s `trimChild`, read here rather than by a selector in the composition so that the composition knows no engine's markup. */
  trimBox: HTMLElement|null;
  /** `.flow` inside it — the box whose bottom edge `chase.js`'s `setFlow` clips at the cut's own extent, and therefore R5's foot (*R5's clip boundary is `.flow`, not `.content-area`*, DESIGN.md S22). Only its bottom is read: R5's head is the page box, `element`, because since the engine's band round (2026-10-02) the flow's own clip edge at the head stands a page's height above the page box and the page element's clip is the one the head meets (*R5's head is the page box and its foot is the cut*, DESIGN.md S69). Null for an engine that moves its overflow instead of clipping it, and then nothing is clipped. */
  flowBox: HTMLElement|null;
  /** The continuation clones on this page, paired with the fragment each resumes — a first fragment or an original (R4; *the engine stopped showing the original*, S47). */
  continuations: { clone: Element, source: Element, sourcePage: number }[];
};

/**
 * One marked-content sequence the file will contain, before any glyph is placed: a run of one source element's characters on one page (*an interval is a marked-content sequence*, DESIGN.md S71; the round plan, `docs/round-plan-an-interval-is-a-marked-content-sequence.md`).
 *
 * @remarks
 * THE TILING INVARIANT, stated per rendered text node over its non-whitespace characters: a source text node a rendered piece maps to is covered by its content intervals exactly — every non-whitespace character on one page, none on two, none on none. Rendered is `measure/conservation.js`'s `renderedTextNodes`, the one predicate, so KaTeX's MathML half and a box kept and not displayed are outside the domain rather than gaps, and the whitespace both fragments keep at a cut is not an overlap (whitespace collapse is the measurement's business). Repeats and artifacts are not tiled; a sourceless content interval is counted and not tiled. `measure/tiling.js` asks it.
 *
 * An interval never crosses a fragmentainer. Order on a page is source order — `(source document order, start)`, never y.
 */
export type Interval = {
  /** Zero-based page index. */
  page: number;
  /** The presented element on that page whose text nodes hold these characters (a Cicero fragment or original, a Paged.js shell or moved element, a host's own box). The measurement reads rectangles off it. */
  carrier: Element;
  /** The source element, or null for a sourceless interval. Under Cicero the original in the root's light DOM; under Paged.js the element of the snapshot `prepare()` keeps; for a host strip the carrier itself. */
  source: Element|null;
  /** Character offset into the source's text: the concatenated `data` of its descendant text nodes, document order, no normalisation. 0 for a sourceless interval. */
  start: number;
  /** Exclusive. */
  end: number;
  /** The logical text. For a sourced interval, the source's characters [start, end) — U+00AD where the engine drew a hyphen in a soft hyphen's place, since a sourced character drawn as another glyph stays sourced. For a sourceless one, what `/ActualText` must say: U+00AD for a layout hyphen, '' for decoration, the digits for a folio. */
  text: string;
  /** Content is owned by a structure element — and may have no source, where an engine wrote it while paginating: the contents' page numbers, a footnote's number. Artifact is pagination furniture (margin boxes, crop marks, the folio). Repeat is a second presentation of a source already presented as content on an earlier page (a repeated `<thead>`, a fixed box's per-page copy, a running element's copy): tagged as a pagination artifact, and drawable as one Form XObject reused. */
  kind: 'content'|'artifact'|'repeat';
  /** The content interval a repeat repeats. */
  repeatOf: Interval|null;
  /** The element whose border box clips this interval: the page element today (the head of *R5's head is the page box and its foot is the cut*, S69), the column's box once the fragmentainer-inside-a-fragmentainer round lands. */
  clip: HTMLElement;
  /** Set where the source is a reified pseudo-element span, so a `::before` belongs to the first fragment only and a `::after` to the last only. */
  pseudo: 'before'|'after'|'marker'|null;
};

/**
 * Every page an engine presented, and the answers about its DOM that only the engine's adapter can give.
 *
 * @remarks
 * PLAN.md §5 wrote the contract as requirements on the Cicero adapter; this is where each one lands for any engine.
 *
 * R1 — Pages: `pageElements` and `pages`, in order, and `probeRoot` wherever they are laid out (a shadow root for Cicero, the strip itself for a light-DOM engine). `coordinates/frame.js` finds a point's page by rectangle, so pages may stack in either direction.
 *
 * R2 — Nominal page size: `StripPage.nominal`, from the engine's own literals and never a measured rectangle (*the one-pixel inset is real*, DESIGN.md S10; for Paged.js's CSS length, *the page box is a CSS length the engine wrote*, S50).
 *
 * R3 — The flow of a page: `StripPage.flow` and `pageOfNode`. The structure walk runs over these lists and never over the strip's light DOM, where unrendered originals may sit.
 *
 * R4 — Continuations: `StripPage.continuations` and `twinOf`, which together make a block and its fragments one structure element with content on several pages (*a continuation mirrors its source element by element*, DESIGN.md S29; *the engine stopped showing the original*, S47).
 *
 * R5 — Clipping to the page: the page box (`StripPage.element`) at the head and `StripPage.flowBox`'s bottom at the foot, the boundary a straddler's tail is dropped against (*R5's clip boundary is `.flow`, not `.content-area`*, DESIGN.md S22; *R5's head is the page box and its foot is the cut*, S69); no clip at all where the engine moves overflow instead of clipping it and names no flow box. `inMargin` exempts margin content (*the margins are lifted into the light DOM*, DESIGN.md S57), and *the conservation of words* (DESIGN.md S61) reads the same clip.
 *
 * R6 — Furniture: not a member. The adapter stamps margin content with the walk's artifact attribute before the walk runs; `inMargin` is what R5 asks of it afterwards.
 *
 * R7 — Page-level `--pdf-*` properties: not a member. They are read off the document root (`adapters/cicero.js`'s `pageHintsOf`; *the page-level `--pdf-*` properties are read from the document root*, DESIGN.md S12), because Chromium's `@page` parser drops a custom property before the CSSOM sees it (*Chromium's `@page` parser discards a custom property*, S11); `backgrounds` and `seatPageImages` are the page-context facts the strip carries.
 *
 * R8 — The engine's own marks inside content: `transparent`, which makes an element introduce no node and no owner while its text is measured like any other.
 */
export type PageStrip = {
  /** The element that holds every page (Cicero's `<beltype-root>`, Paged.js's `.pagedjs_pages`) — the element every coordinate is taken against, and the container the structure walk runs over. */
  strip: HTMLElement;
  /** Where `beginFrame` appends its probes: the root's open shadow, because the pages are laid out there and a probe in the light DOM would be assigned to no slot and never laid out (§5 R1; *Cicero's pages stack vertically*, DESIGN.md S9). An engine whose pages live in the light DOM answers with the strip itself. */
  probeRoot: HTMLElement|ShadowRoot;
  pageElements: HTMLElement[];
  pages: StripPage[];
  /** Every assigned node to the page it is on. */
  pageOfNode: Map<Element, number>;
  /** R4: the element this one continues — for a Cicero clone, its positionally paired twin in the original, for every descendant of the clone as well as for the clone itself (*a continuation mirrors its source element by element*, S29), and for a first fragment as well as for a continuation (*the engine stopped showing the original*, S47). The walk asks per element and adopts; the pairing and its verification live here. */
  twinOf: (element: Element) => Element|null;
  /** R8: whether the element is Cicero's own mark inside content (the words `fill`, `break`, `shell`) — no node, no owner, children walked in its place. */
  transparent: (element: Element) => boolean;
  /** The document's `lang`, which becomes the catalog `/Lang`. */
  lang: string;
  /** The page element a node belongs to; `ctm.js`'s chains stop there. */
  pageElementOf: (element: Element) => HTMLElement|null;
  /** *the margins are lifted into the light DOM* (S57): whether the element is margin content — a running element's clone, or a margin cell's text lifted into the light DOM — and so lies outside R5's content area by construction rather than in a straddler's clipped tail. */
  inMargin?: (element: Element) => boolean;
  /** The `@page` background each page paints — see `pageBackgroundsOf`. Empty where every page is the medium's own white. */
  backgrounds: { page: number, rgb: [number, number, number] }[];
  /** The `@page` images, seated on their pages as artifacts (`seatPageImages`), which `print()` asks for once, before anything reads the strip's elements. Asynchronous because an image's own size is known only once it is loaded. Absent where no page paints one. */
  seatPageImages?: (gateway: Gateway) => Promise<void>;
  /** The record: every marked-content sequence the pages present, in page order. Transitional beside `twinOf`, `StripPage.continuations` and `transparent` (*an interval is a marked-content sequence*, DESIGN.md S71) — derived from today's pairing by `adapters/intervals.js`'s `deriveIntervals` and checked by the tiling invariant, consumed by nothing yet; `twinOf` and `continuations` retire when both adapters emit it from the engine's own record, and `transparent` stays. Absent on a host's own strip, for which `print()` derives it. */
  intervals?: Interval[];
};

export {};
