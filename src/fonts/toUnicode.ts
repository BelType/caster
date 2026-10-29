/**
 * `fonts/toUnicode.js` — the `ToUnicode` CMap, from clusters, with the most-frequent rule and `/ActualText` for the rest.
 *
 * Ported from `harness/src/export/toUnicode.ts` (E4). Guide: `docs/guide/font-embedding.md` §"ToUnicode".
 *
 * @packageDocumentation
 */

import { isClusterStart, textForGlyph } from '../emit/textEmit.ts';
import { CasterError } from '../errors.ts';

import type { TextSegment } from '../emit/textEmit.ts';

/** One CID whose glyph was painted for more than one string, so one of them needs an `/ActualText` span. */
export type AmbiguousCid = {
  cid: number;
  chosen: string;
  variants: { text: string, count: number }[];
};

export type InstanceToUnicode = {
  instanceKey: string;
  /** CID to the string the CMap maps it to. */
  text: Map<number, string>;
  /** Every string the CID was painted for, most frequent first. */
  cidToText: Record<number, string[]>;
  ambiguous: AmbiguousCid[];
};

export type ToUnicodeResult = {
  byInstance: Map<string, InstanceToUnicode>;
  /** The string one occurrence has to be wrapped in a `/Span <</ActualText …>>` for, or null when the CMap already says it. */
  actualTextFor: (segment: TextSegment, glyphIndex: number) => string|null;
  actualTextOccurrences: number;
};

/**
 * Collect the map over every segment the display list sets, as `segmentViews` reads them.
 *
 * @remarks
 * The count is of *occurrences*, not of distinct contexts, because the reason to prefer one string is that more of the document extracts correctly without a span.
 *
 * @throws {CasterError} A segment that painted `.notdef`, or a cluster whose first glyph stands for no characters — either is a glyph a reader cannot extract; the error names the block.
 */
export function buildToUnicode(segments: readonly TextSegment[]): ToUnicodeResult {
    const counts: Map<string,Map<number,Map<string,number>>> = new Map<any, any>();
    for (const segment of segments) {
        const perInstance = counts.get(segment.instanceKey) ?? (new Map<any, any>() as Map<number, Map<string, number>>);
        counts.set(segment.instanceKey, perInstance);
        segment.gids.forEach(( gid: number,  index: number) => {
            const text = textForGlyph(segment, index);
            if (gid === 0) {
                throw new CasterError(`caster: ${segment.instanceKey} painted .notdef in ${JSON.stringify(segment.text)} — no face covers that cluster, and a glyph a reader cannot map is a document a reader cannot extract`, { element: segment.blockPath });
            }
            // An empty string is legal for a glyph that is not the first of its cluster — a combining mark, the second half of an Indic syllable — and means "this glyph adds no characters of its own"; the cluster's whole text rides on its first glyph. What is not legal is a cluster whose first glyph has no text, which is a glyph standing for nothing at all.
            if (text === '' && isClusterStart(segment, index)) {
                throw new CasterError(`caster: glyph ${gid} of ${segment.instanceKey} begins a cluster that maps to no characters in ${JSON.stringify(segment.text)}`, { element: segment.blockPath });
            }
            if (text === '') return;
            const perCid = perInstance.get(gid) ?? (new Map<any, any>() as Map<string, number>);
            perInstance.set(gid, perCid);
            perCid.set(text, (perCid.get(text) ?? 0) + 1);
        });
    }
    const byInstance: Map<string,InstanceToUnicode> = new Map<any, any>();
    for (const [instanceKey, perInstance] of counts) {
        const text: Map<number,string> = new Map<any, any>();
        const cidToText: Record<number,string[]> = {};
        const ambiguous: AmbiguousCid[] = [];
        for (const [cid, perCid] of [...perInstance].sort(([a], [b]) => a - b)) {
            // Ties break on the string itself so the choice is a property of the document and not of the order the segments happened to be walked in.
            const variants = [...perCid]
                .map(([value, count]) => ({ text: value, count }))
                .sort((a, b) => b.count - a.count || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
            text.set(cid, variants[0].text);
            cidToText[cid] = variants.map((v) => v.text);
            if (variants.length > 1)
                ambiguous.push({ cid, chosen: variants[0].text, variants });
        }
        byInstance.set(instanceKey, { instanceKey, text, cidToText, ambiguous });
    }
    let actualTextOccurrences = 0;
    const wrapped: WeakMap<TextSegment,Map<number,string>> = new WeakMap<any, any>();
    for (const segment of segments) {
        const chosen = (byInstance.get(segment.instanceKey) as InstanceToUnicode).text;
        segment.gids.forEach(( gid: number,  index: number) => {
            const value = textForGlyph(segment, index);
            if (chosen.get(gid) !== value) {
                const bySegment = wrapped.get(segment) ?? (new Map<any, any>() as Map<number, string>);
                wrapped.set(segment, bySegment);
                bySegment.set(index, value);
                actualTextOccurrences += 1;
            }
        });
    }
    return {
        byInstance,
        actualTextFor: ( segment: TextSegment,  glyphIndex: number) => wrapped.get(segment)?.get(glyphIndex) ?? null,
        actualTextOccurrences,
    };
}
