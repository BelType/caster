/**
 * `adapters/intervals.js` — the record, derived: every marked-content sequence the pages present, reconstructed from what the adapters already know (*an interval is a marked-content sequence*, DESIGN.md S71).
 *
 * Caster's own; no harness source. Lifted whole from stage 0's census (`scripts/intervals-census.js`, `docs/census-2026-10-08.md`), which measured it on the specimen, the cards, the sixty-row table and the manual before anything was built on it. It is the transitional producer of `PageStrip.intervals`: both adapters call it last, and `print()` calls it for a host's own strip. The round plan's stage 2 replaces it under Cicero with the engine's own ledger and under Paged.js with ranges the adapter computes from its stamps; for a host's strip it stays, where every node is wholly on its page.
 *
 * ponytail: a fragment is located by substring search — its trimmed text inside its source's own direct text nodes, greedily in page order — rather than by any record an engine keeps. Exact wherever a fragment's text is a contiguous run of its source's, which is what both engines' cuts produce; wrong only where the same run repeats inside one element and a fragment lands on the earlier copy. The engine's ledger is the upgrade, and it is stage 2.
 *
 * It names no engine. What it must know about one comes in through `origin`, from the adapter that knows that engine's DOM.
 *
 * @packageDocumentation
 */

import { ARTIFACT_ATTRIBUTE } from '../walk/structure.ts';
import { renderedTextNodes } from '../measure/conservation.ts';
import { GENERATED_CLASS, MARKER_CLASS } from './reify.ts';

/** The engine's `artifact` word as a selector, for a copy that is furniture (*the margins are lifted into the light DOM*, DESIGN.md S57 and *a running element's original is the element the engine hid*, S60; the artifact word). The word has one meaning, PDF's artifact, so a fixed box's copy after the first page is read like every other (S82, *an artifact is never read*). */
const ARTIFACT_WORD_SELECTOR = '[data-beltype~="artifact"]';

import type { Interval, PageStrip } from './strip.ts';

/**
 * Where one presented text node's characters come from, as the adapter that knows the engine answers it.
 *
 * @remarks
 * `source` with `repeat` says the carrier sits where a second presentation of covered text is lawful (a continued table's `<thead>`): a range found only behind what its source already presented is then a repeat rather than an overlap. `sourceless` is text the engine wrote, by kind, `text` standing for it where the presented glyph is not the logical character (U+00AD for a layout hyphen). `unmapped` names why the adapter has no answer.
 */
export type Origin = { source: Element, repeat?: boolean } | { sourceless: 'content'|'artifact', label: string, text?: string } | { unmapped: string };

/** What the derivation met that no interval says by itself, for a caller that reports it — the census. */
export type DerivationNote = {
  what: 'margin'|'sourceless'|'unmapped'|'clipped'|'fold';
  label: string;
  parent: Element;
  node: Text;
};

/**
 * Derive the record from the strip.
 *
 * @remarks
 * Every rendered text node (`renderedTextNodes`, the one predicate) is a presented piece; one the clip cuts is reduced to the characters inside the clip, located character by character. Margin content — `inMargin`, or under an element the adapter stamped an artifact — is an artifact interval with no source. Otherwise `origin` says where the piece comes from, and a sourced piece is located where the pairing finds its words: its trimmed text inside its source's own direct text nodes, at or after the end of that source's previous piece in page order — the prefix for a first fragment, the suffix for the last, the run between for a middle one. A piece found only before that point is a second presentation: a repeat where `origin` said one is lawful, content otherwise, which the tiling then refuses as an overlap.
 *
 * The hyphen Cicero writes at a cut replaces the soft hyphen it stands for (*the hyphen is written at the cut*, S70), so a fragment's last character may read U+2010 or `-` where its source reads U+00AD; the two are folded, and the interval's `text` is the source's.
 *
 * A piece with no answer is not dropped: it becomes a sourceless content interval carrying its own text, so nothing presented is missing from the record, and the conservation of words still asks the DOM about it.
 *
 * @param options - `origin` defaults to a host's strip, where the carrier is its own source.
 * @returns In page order, then document order within a page.
 */
export function deriveIntervals(strip: PageStrip, { origin = (_, parent) => ({ source: parent }), note }: { origin?: (node: Text,parent: Element) => Origin; note?: (note: DerivationNote) => void; } = {}): Interval[] {
  const doc = strip.strip.ownerDocument;
  const view = doc.defaultView ?? window;
  const range = doc.createRange();
  const intervals: Interval[] = [];
  type Piece = { page: number, node: Text, parent: Element, raw: string };
  const bySource: Map<Element,{ piece: Piece; repeat: boolean; }[]> = new Map<any, any>();
  /** Every interval in the order its text was met, a sourced piece standing in its place until its source's pieces are located together. */
  const order: (Interval|Piece)[] = [];
  const located: Map<Piece,Interval|null> = new Map<any, any>();

  for (const { node, parent, page, clip, rects } of renderedTextNodes(strip)) {
    const clipEl = strip.pages[page].element;
    if (strip.inMargin?.(parent) || parent.closest(`[${ARTIFACT_ATTRIBUTE}]`) || parent.closest(ARTIFACT_WORD_SELECTOR)) {
      note?.({ what: 'margin', label: 'margin content', parent, node });
      order.push(sourceless(page, parent, 'artifact', node.data.trim(), clipEl));
      continue;
    }
    let raw = node.data;
    if (clip && rects.some((r) => r.width > 0 && r.height > 0 && !(r.bottom > clip.top && r.top < clip.bottom))) {
      note?.({ what: 'clipped', label: 'cut by the page clip', parent, node });
      let lo = -1;
      let hi = -1;
      for (let i = 0; i < node.data.length; i++) {
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        if ([...range.getClientRects()].some((r) => r.width > 0 && r.height > 0 && r.bottom > clip.top && r.top < clip.bottom)) { if (lo < 0) lo = i; hi = i + 1; }
      }
      raw = lo < 0 ? '' : node.data.slice(lo, hi);
    }
    const from = origin(node, parent);
    if ('sourceless' in from) {
      note?.({ what: 'sourceless', label: from.label, parent, node });
      order.push(sourceless(page, parent, from.sourceless, from.text ?? raw.trim(), clipEl));
      continue;
    }
    if ('unmapped' in from) {
      note?.({ what: 'unmapped', label: from.unmapped, parent, node });
      order.push(sourceless(page, parent, 'content', raw.trim(), clipEl));
      continue;
    }
    const group = bySource.get(from.source) ?? [];
    bySource.set(from.source, group);
    const piece = { page, node, parent, raw };
    group.push({ piece, repeat: from.repeat === true });
    order.push(piece);
  }

  // Each source's pieces located in its own text, in page order — the order `renderedTextNodes` met them in.
  for (const [source, group] of bySource) {
    // Ruling 1's space: every descendant text node's data, in document order, no normalisation.
    const offsets: Map<Node,number> = new Map<any, any>();
    let total = 0;
    const tw = doc.createTreeWalker(source, view.NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) { offsets.set(n, total); total += (n as Text).data.length; }
    // The direct text nodes, joined by a character no text holds, so a match never spans two of them.
    let joined = '';
    const seats: { node: Text; at: number; }[] = [];
    for (const n of source.childNodes) if (n.nodeType === 3) { seats.push({ node: (n as Text), at: joined.length }); joined += `${(n as Text).data}\u0000`; }
    let cursor = 0;
    const placed: Interval[] = [];
    for (const { piece, repeat } of group) {
      const needle = piece.raw.trim();
      if (!needle) { located.set(piece, null); continue; }
      const folded = /[‐-]$/u.test(needle) ? `${needle.slice(0, -1)}­` : null;
      let used = needle;
      let at = joined.indexOf(needle, cursor);
      if (at < 0 && folded) { at = joined.indexOf(folded, cursor); if (at >= 0) used = folded; }
      let behind = false;
      if (at < 0) { at = joined.lastIndexOf(needle, cursor); behind = at >= 0; }
      if (at < 0 && folded) { at = joined.lastIndexOf(folded, cursor); if (at >= 0) { used = folded; behind = true; } }
      if (at < 0) {
        note?.({ what: 'unmapped', label: "text not found among its source's own text nodes", parent: piece.parent, node: piece.node });
        located.set(piece, sourceless(piece.page, piece.parent, 'content', needle, strip.pages[piece.page].element));
        continue;
      }
      if (used === folded) note?.({ what: 'fold', label: 'a hyphen standing for a soft hyphen', parent: piece.parent, node: piece.node });
      let seat = seats[0];
      for (const s of seats) if (s.at <= at) seat = s;
      const start = (offsets.get(seat.node) as number) + at - seat.at;
      cursor = Math.max(cursor, at + used.length);
      const kind = behind && repeat ? 'repeat' : 'content';
      const interval: Interval = {
        page: piece.page, carrier: piece.parent, source, start, end: start + used.length,
        text: seat.node.data.slice(at - seat.at, at - seat.at + used.length),
        kind, repeatOf: kind === 'repeat' ? placed.find((iv) => iv.kind === 'content' && iv.start <= start && start < iv.end) ?? null : null,
        clip: strip.pages[piece.page].element, pseudo: pseudoOf(source)
      };
      placed.push(interval);
      located.set(piece, interval);
    }
  }

  for (const entry of order) {
    const interval = located.has((entry as Piece)) ? located.get((entry as Piece)) : (entry as Interval);
    if (interval) intervals.push(interval);
  }
  return intervals;
}

/** A sourceless interval. */
function sourceless(page: number, carrier: Element, kind: 'content'|'artifact', text: string, clip: HTMLElement): Interval {
  return { page, carrier, source: null, start: 0, end: 0, text, kind, repeatOf: null, clip, pseudo: null };
}

/**
 * Which pseudo-element a reified span stood for, read off the span `reify.js` made.
 *
 * ponytail: `reify.js` marks a `::before` and a `::after` with one class, so the two are told apart by position — `::after` is appended last. A `::before` on an element with no other content reads as `::after`; a reification that kept the pseudo's name on the span is the upgrade.
 */
function pseudoOf(source: Element): Interval['pseudo'] {
  if (source.classList.contains(MARKER_CLASS)) return 'marker';
  if (!source.classList.contains(GENERATED_CLASS)) return null;
  return source.nextSibling ? 'before' : 'after';
}
