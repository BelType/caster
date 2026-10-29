/**
 * `measure/tiling.js` — THE TILING INVARIANT (*an interval is a marked-content sequence*, DESIGN.md S71): a source's text is presented once — every non-whitespace character of a rendered source text node on exactly one page.
 *
 * Caster's own; no harness source — the round *an interval is a marked-content sequence*, stage 1, after its census (`docs/census-2026-10-08.md`).
 *
 * It stands beside the conservation of words (S61) and sees what that one cannot. The conservation asks whether a word a reader can see was handed to the measurement; a word laid out below a page's clip is lawfully unseen there (R5), so a word the engine clipped on one page and never resumed on the next passes it, and so does a word the engine presented twice — both are handed over, every time. The tiling asks of the source: which of its characters the pages present, and how often. Measured on the manual the day it was written: under Paged.js 12 311 characters presented on two pages (a duplicated run after three tables), under Cicero 38 on none (a divided table row whose first lines sat below the clip).
 *
 * Its domain is the census's: every direct text node of a source element that received a content interval, and every text node an interval reaches, minus the text no reader sees (`renderedTextNodes`' exclusions). A source never presented at all is outside it — the per-node tiling cannot see a whole element on no page, and the conservation of words is what answers for an element on a page.
 *
 * @packageDocumentation
 */

import { CasterError } from '../errors.ts';
import { domPathOf } from './textMeasure.ts';

import type { Interval, PageStrip } from '../adapters/strip.ts';

/** One source text node the invariant does not hold for. */
export type TileFault = {
  node: Text;
  /** The source element whose text it is. */
  source: Element;
  /** Non-whitespace characters on no page (a gap) or on more than one (an overlap). */
  chars: number;
  /** The first such character's offset in the node. */
  at: number;
  /** Zero-based. For an overlap, the pages the first such character is presented on; for a gap, the pages its source is presented on. */
  pages: number[];
};

/** The tiling, measured. */
export type Tiling = {
  /** Source text nodes in the domain. */
  total: number;
  /** Those covered exactly. */
  tiled: number;
  gaps: TileFault[];
  overlaps: TileFault[];
  /** Sourceless intervals, by kind — counted, never tiled. */
  sourceless: Record<'content'|'artifact'|'repeat', number>;
};

/**
 * Measure the tiling of the content intervals over their sources' text.
 *
 * @remarks
 * Per source text node, over its non-whitespace characters: whitespace collapse is the measurement's business (ruling 1), and the space between the last word on one page and the first on the next stays in both fragments (`fragments.js`' `consumeLeadingWords`), so a whitespace character on two pages is a seam and not an overlap. Repeats and artifacts are excluded; so is a sourceless content interval, which has no source to tile.
 */
export function tileOf(intervals: Interval[]): Tiling {
  const sourceless: Tiling['sourceless'] = { content: 0, artifact: 0, repeat: 0 };
  const bySource: Map<Element,Interval[]> = new Map<any, any>();
  for (const interval of intervals) {
    if (!interval.source) { sourceless[interval.kind]++; continue; }
    if (interval.kind !== 'content') continue;
    const list = bySource.get(interval.source) ?? [];
    bySource.set(interval.source, list);
    list.push(interval);
  }

  const nodes: Map<Text,{ source: Element; counts: Uint16Array; spans: { from: number; to: number; page: number; }[]; }> = new Map<any, any>();
  const outside = ( n: Text) => !!n.parentElement?.closest('.katex-mathml, script, style, template');
  for (const [source, list] of bySource) {
    const seat = (n: Text) => {
      let entry = nodes.get(n);
      if (!entry) { entry = { source, counts: new Uint16Array(n.data.length), spans: [] }; nodes.set(n, entry); }
      return entry;
    };
    for (const n of source.childNodes) if (n.nodeType === 3 && /\S/u.test((n as Text).data) && !outside((n as Text))) seat((n as Text));
    // Ruling 1's space: the source's descendant text nodes in document order, each at the sum of the lengths before it.
    const doc = source.ownerDocument;
    const walker = doc.createTreeWalker(source, (doc.defaultView ?? window).NodeFilter.SHOW_TEXT);
    let base = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n as Text);
      const length = text.data.length;
      for (const { start, end, page } of list) {
        const from = Math.max(start, base) - base;
        const to = Math.min(end, base + length) - base;
        if (from >= to || outside(text)) continue;
        const entry = seat(text);
        entry.spans.push({ from, to, page });
        for (let k = from; k < to; k++) entry.counts[k]++;
      }
      base += length;
    }
  }

  const tiling: Tiling = { total: 0, tiled: 0, gaps: [], overlaps: [], sourceless };
  for (const [node, { source, counts, spans }] of nodes) {
    let gap = 0;
    let over = 0;
    let firstGap = -1;
    let firstOver = -1;
    for (let k = 0; k < counts.length; k++) {
      if (/\s/u.test(node.data[k])) continue;
      if (counts[k] === 0) { gap++; if (firstGap < 0) firstGap = k; } else if (counts[k] > 1) { over++; if (firstOver < 0) firstOver = k; }
    }
    tiling.total++;
    if (!gap && !over) tiling.tiled++;
    if (gap) tiling.gaps.push({ node, source, chars: gap, at: firstGap, pages: [...new Set((bySource.get(source) ?? []).map((iv) => iv.page))].sort((a, b) => a - b) });
    if (over) tiling.overlaps.push({ node, source, chars: over, at: firstOver, pages: [...new Set(spans.filter((s) => s.from <= firstOver && firstOver < s.to).map((s) => s.page))].sort((a, b) => a - b) });
  }
  const byPage = ( a: TileFault,  b: TileFault) => (a.pages[0] ?? 0) - (b.pages[0] ?? 0);
  tiling.gaps.sort(byPage);
  tiling.overlaps.sort(byPage);
  return tiling;
}

/**
 * Refuse a print whose pages present a source's text other than once, naming the first few by the page the reader would meet them on.
 *
 * @throws {CasterError} A non-whitespace character of a rendered source text node is on no page or on more than one, naming the character count, the first five by page, DOM path and excerpt, and for an overlap the pages the same text is on.
 */
export function assertTiled(intervals: Interval[], strip: PageStrip) {
  const { gaps, overlaps } = tileOf(intervals);
  if (gaps.length === 0 && overlaps.length === 0) return;
  const chars = ( list: TileFault[]) => list.reduce((n, f) => n + f.chars, 0);
  const pages = ( list: number[]) => list.map((p) => p + 1).join(' and ');
  const where = (fault: TileFault) => {
    const excerpt = fault.node.data.slice(fault.at).trim().replace(/\s+/gu, ' ');
    return `${domPathOf(((fault.node.parentElement ?? fault.source) as HTMLElement), strip.strip)}: ${JSON.stringify(excerpt.length > 48 ? `${excerpt.slice(0, 48)}…` : excerpt)}`;
  };
  const parts = [];
  if (overlaps.length) {
    const shown = overlaps.slice(0, 5).map((f) => `pages ${pages(f.pages)}, ${where(f)}`);
    parts.push(`${chars(overlaps)} character${chars(overlaps) === 1 ? '' : 's'} in ${overlaps.length} source text node${overlaps.length === 1 ? '' : 's'} are presented on more than one page, so the file would print them twice. The engine laid the same text out again; nothing in the pages marks the second copy as a repeat, and tagging either copy an artifact would choose in silence which page a reader's assistive technology hears. The first: ${shown.join('; ')}${overlaps.length > shown.length ? `; and ${overlaps.length - shown.length} more` : ''}.`);
  }
  if (gaps.length) {
    const shown = gaps.slice(0, 5).map((f) => `of a block on page${f.pages.length === 1 ? '' : 's'} ${pages(f.pages)}, ${where(f)}`);
    parts.push(`${chars(gaps)} character${chars(gaps) === 1 ? '' : 's'} in ${gaps.length} source text node${gaps.length === 1 ? '' : 's'} are presented on no page, though the element they belong to is: the engine left them below a page's clip and did not resume them on the next, and the conservation of words cannot see a word no page shows. The first: ${shown.join('; ')}${gaps.length > shown.length ? `; and ${gaps.length - shown.length} more` : ''}.`);
  }
  const first = overlaps[0] ?? gaps[0];
  throw new CasterError(`caster: the pages do not present each word of the source once (the tiling invariant, DESIGN.md S71). ${parts.join(' ')}`, { element: where(first) });
}
