/**
 * `fonts/clusters.js` — pure functions of a cluster: the grouping of shaped glyphs by HarfBuzz cluster, and the code points and kind of a colour cluster for the record.
 *
 * @remarks
 * No import and no DOM, so the writer reads a cluster without reaching the Range reads of `fonts/words.js` or the canvas of `measure/emoji.js`, where these lived (moved in stage 2 of `.claude/plans/the-rust-writer/plan-close-the-list.md`).
 *
 * @packageDocumentation
 */

export type ClusterGroup = {
  /** Inclusive start offset within the word. */
  start: number;
  /** Exclusive end offset within the word. */
  end: number;
  /** Indexes into the shaped glyph array, in output order. */
  glyphIndexes: number[];
};

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

/** The code points of a cluster, as the `U+XXXX` names the record carries. */
export function codePointsOf(cluster: string): string[] {
  return [...cluster].map((character) => `U+${(character.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0')}`);
}

/**
 * What kind of emoji a cluster is, for the record.
 *
 * @remarks
 * Named off the code points rather than off a lookup: a pair of regional indicators is a flag, a zero-width joiner makes a sequence, a modifier in U+1F3FB–U+1F3FF is a skin tone, and anything else is one emoji.
 */
export function clusterKindOf(cluster: string): string {
  const points = [...cluster].map((character) => (character.codePointAt(0) as number));
  if (points.length === 2 && points.every((point) => point >= 0x1f1e6 && point <= 0x1f1ff)) return 'flag (regional indicators)';
  if (points.includes(0x200d)) return 'ZWJ sequence';
  if (points.some((point) => point >= 0x1f3fb && point <= 0x1f3ff)) return 'skin-tone modifier sequence';
  if (points.includes(0xfe0f)) return 'emoji presentation selector';
  return 'single emoji';
}
