/**
 * `fonts/words.js` — the word split, the Range reads, and the cluster grouping.
 *
 * Ported from `harness/src/shaping/words.ts` (E1, E1b). Guide: `docs/guide/shaping.md`.
 *
 * @packageDocumentation
 */

export type WordSpan = {
  text: string;
  /** Inclusive start offset in the text node. */
  start: number;
  /** Exclusive end offset in the text node. */
  end: number;
};

export type ClusterGroup = {
  /** Inclusive start offset within the word. */
  start: number;
  /** Exclusive end offset within the word. */
  end: number;
  /** Indexes into the shaped glyph array, in output order. */
  glyphIndexes: number[];
};

import { CasterError } from '../errors.ts';

/** Split on whitespace only, so punctuation stays attached to its word exactly as the spec asks. Offsets are kept because every measurement is a Range over precisely the word's characters, never over a re-found substring. */
export function wordSpans(text: string): WordSpan[] {
    const spans: WordSpan[] = [];
    for (const match of text.matchAll(/\S+/gu)) {
        const start = (match.index as number);
        spans.push({ text: match[0], start, end: start + match[0].length });
    }
    return spans;
}
/**
 * The single text node a fixture paragraph is required to hold.
 *
 * @throws {CasterError} The block holds anything but exactly one text node.
 */
export function soleTextNode(p: HTMLElement): Text {
    const node = p.firstChild;
    if (p.childNodes.length !== 1 || !node || node.nodeType !== Node.TEXT_NODE) {
        throw new CasterError(`caster: the block ${p.tagName.toLowerCase()} must hold exactly one text node for a per-word Range read`, { element: p.tagName.toLowerCase() });
    }
    return (node as Text);
}
/** Client rects for the characters in [start, end). More than one means it wrapped. */
export function rectsFor(node: Text, start: number, end: number): DOMRect[] {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    return Array.from(range.getClientRects());
}
/** One rect width per character in [start, end). A ligated cluster is where Chromium has to make something up, which is the point of the secondary check. */
export function perCharacterWidths(node: Text, start: number, end: number): number[] {
    const widths: number[] = [];
    for (let i = start; i < end; i++) {
        const rects = rectsFor(node, i, i + 1);
        widths.push(rects.reduce((sum, r) => sum + r.width, 0));
    }
    return widths;
}
/**
 * Group shaped glyphs by HarfBuzz cluster and give each group the characters it owns. Clusters are monotonic within a run, so the next distinct cluster bounds the current one; RTL output comes back in visual order and is put into logical order first so the arithmetic is uniform.
 *
 * @remarks
 * A group spanning two or more characters with a single glyph is a ligature, which is what the secondary check needs to find.
 */
export function clusterGroups(clusters: number[], direction: 'ltr'|'rtl', wordLength: number): ClusterGroup[] {
    const indexes = clusters.map((_, i) => i);
    const logical = direction === 'rtl' ? indexes.slice().reverse() : indexes;
    const groups: { start: number; glyphIndexes: number[]; }[] = [];
    for (const gi of logical) {
        const cluster = clusters[gi];
        const last = groups[groups.length - 1];
        if (last && last.start === cluster)
            last.glyphIndexes.push(gi);
        else
            groups.push({ start: cluster, glyphIndexes: [gi] });
    }
    return groups.map((g, i) => ({
        start: g.start,
        end: i + 1 < groups.length ? groups[i + 1].start : wordLength,
        glyphIndexes: g.glyphIndexes,
    }));
}
