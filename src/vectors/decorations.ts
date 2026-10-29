/**
 * `vectors/decorations.js` — the bookkeeping two E12 sub-cases need about the text decorations of `vector-painting.md` (E9).
 *
 * Ported from `harness/src/export/decorations.ts` (E12A, E12F). Guide: `docs/guide/images.md` §"The underline across a cluster", `docs/guide/structure-tree.md` §"Skip-ink underlines".
 *
 * WHAT THE PORT CHANGED. The port records no change here beyond the language.
 *
 * The harness's own header follows.
 *
 * The bookkeeping two E12 sub-cases need about the text decorations of `vector-painting.md` (E9).
 *
 * `textDecorationVectors` walks lines, then the runs of each line, then the kinds of each run's decoration, and pushes one request and one record per step. Nothing it returns says which line or which run a record came from — E9 (`vector-painting.md`) had no reason to record it — and both the skip-ink pass of `structure-tree.md` (E12F) and the emoji bridge of `images.md` (E12A) need exactly that. Rather than each of them re-deriving it, the walk lives here once: the same three loops in the same order, consuming the records in step, with a count check so the day that loop changes the other one is told rather than silently mispaired.
 *
 * The px-to-points rectangle helper lives here for the same reason — both sub-cases build a decoration rectangle of their own, and both have to build it in the coordinates `textDecorationVectors` already used or their rectangle lands somewhere else on the page.
 *
 * @packageDocumentation
 */
import { PX_TO_PT } from '../coordinates/units.ts';
import { pageGeometryFor } from '../coordinates/pageGeometry.ts';
import { CasterError } from '../errors.ts';

import type { PathSegment } from '../images/imagePlace.ts';
import type { MeasuredLine, MeasuredRun } from '../measure/textMeasure.ts';

/** The half of a decoration record this module reads; `cssBoxes` supplies the rest. */
export type DecorationRecordLike = {
  /** The decoration artifact's own path, which is what its request carries as `owner`. */
  path: string;
  line: string;
  page: number;
  /** `[x, y, width, height]` in points, origin bottom left. */
  rectPt: [number, number, number, number];
  skipInkIgnored: boolean;
};

/** The lines a caller hands in, narrowed to what this module reads off them. */
export type DecoratedLine = Pick<MeasuredLine, 'page' | 'baselinePx' | 'paragraph' | 'runs'>;

/** One decoration, with the line and run it came from. */
export type WalkedDecoration = {
  /** Index into the `requests` and `records` arrays, which are parallel. */
  index: number;
  /** Index into the lines array the caller passed. */
  lineIndex: number;
  line: DecoratedLine;
  run: MeasuredRun;
  kind: string;
  record: DecorationRecordLike;
  /** The run's own x extent in page-local px, which is the rectangle's own. */
  leftPx: number;
  rightPx: number;
};

/**
 * Pair every decoration record with the line and run that produced it.
 *
 * @remarks
 * The loops are `textDecorationVectors`' own, written a second time; the count check at the end is what keeps the second copy honest.
 *
 * @throws {CasterError} The records and the decorations walked do not pair one to one — the loop of `vector-painting.md` (E9) and this one disagree.
 */
export function walkDecorations(lines: readonly DecoratedLine[], records: readonly DecorationRecordLike[]): WalkedDecoration[] {
  const out: WalkedDecoration[] = [];
  let index = 0;
  lines.forEach((line, lineIndex) => {
    for (const run of line.runs) {
      const decoration = run.decoration;
      if (!decoration || !run.element) continue;
      for (const kind of decoration.lines) {
        const record = records[index];
        if (!record) throw new CasterError('decorations: the records ran out before the lines did');
        out.push({
          index,
          lineIndex,
          line,
          run,
          kind,
          record,
          leftPx: Math.min(...run.segments.map((segment) => segment.xPx)),
          rightPx: Math.max(...run.segments.map((segment) => segment.rightPx)),
        });
        index += 1;
      }
    }
  });
  if (index !== records.length) {
    throw new CasterError(`decorations: ${records.length} record(s) for ${index} decoration(s) walked; the two loops disagree`);
  }
  return out;
}

/** One rectangle in CSS px as a closed PDF path in page points. */
export function rectPath(page: number, xPx: number, topPx: number, widthPx: number, heightPx: number): PathSegment[] {
  const geometry = pageGeometryFor(page);
  const round = (n: number): number => Math.round(n * 1000) / 1000;
  const x0 = geometry.marginPt + xPx * PX_TO_PT;
  const x1 = geometry.marginPt + (xPx + widthPx) * PX_TO_PT;
  const y0 = geometry.heightPt - geometry.marginPt - topPx * PX_TO_PT;
  const y1 = geometry.heightPt - geometry.marginPt - (topPx + heightPx) * PX_TO_PT;
  return [
    { op: 'm', to: [round(x0), round(y0)] },
    { op: 'l', to: [round(x1), round(y0)] },
    { op: 'l', to: [round(x1), round(y1)] },
    { op: 'l', to: [round(x0), round(y1)] },
    { op: 'h' },
  ];
}

/** What one colour cluster contributes to the question, in page-local px. */
export type ClusterExtent = {
  text: string;
  page: number;
  /** Index into the same lines array `walkDecorations` was given. */
  line: number;
  xPx: number;
  rightPx: number;
};

/** One rectangle that has to be painted so a decorated line has no hole in it. */
export type DecorationBridge = {
  /** The cluster the hole was under. */
  text: string;
  /** The decoration whose rectangle, colour and thickness this one copies. */
  source: WalkedDecoration;
  page: number;
  leftPx: number;
  rightPx: number;
};

/**
 * The rectangles a decorated line needs so that a colour cluster is underlined too.
 *
 * @remarks
 * The rule of `vector-painting.md` (E9) is one decoration rectangle per *run*, and a colour cluster is not a run: it carries no glyphs, so it is not a `MeasuredSegment` and it is not in any run's extent. The rule is right and stays — a decoration belongs to the text state it decorates — but the consequence on the page is a hole in the line under every emoji, which is not what Chromium paints: the browser underlines the whole *decorating box*, and an emoji sits inside it like any other inline content.
 *
 * The hole is filled rather than the rule changed. For each cluster on a decorated line, the bridge runs from the right edge of the nearest decoration ending at or before the cluster to the left edge of the nearest one starting at or after it, so it abuts its neighbours exactly and there is no seam; with no neighbour on a side, the cluster's own edge is used. Its rectangle's y and height, its colour and its fill rule are the neighbour's, so nothing about where a decoration sits is decided twice.
 */
export function decorationBridges(walked: readonly WalkedDecoration[], clusters: readonly ClusterExtent[]): DecorationBridge[] {
  const bridges: DecorationBridge[] = [];
  for (const cluster of clusters) {
    const onLine = walked.filter((entry) => entry.lineIndex === cluster.line && entry.record.page === cluster.page);
    if (onLine.length === 0) continue;
    for (const kind of new Set(onLine.map((entry) => entry.kind))) {
      const sameKind = [...onLine.filter((entry) => entry.kind === kind)].sort((a, b) => a.leftPx - b.leftPx);
      // A cluster already inside a decoration's extent needs no bridge: two runs of one element with the cluster between them is the case this is for, and a cluster inside one run's extent is not a hole.
      if (sameKind.some((entry) => entry.leftPx <= cluster.xPx && entry.rightPx >= cluster.rightPx)) continue;
      const before = [...sameKind].reverse().find((entry) => entry.rightPx <= cluster.xPx);
      const after = sameKind.find((entry) => entry.leftPx >= cluster.rightPx);
      const source = before ?? after;
      if (!source) continue;
      const leftPx = before ? before.rightPx : cluster.xPx;
      const rightPx = after ? after.leftPx : cluster.rightPx;
      if (rightPx - leftPx <= 1e-6) continue;
      bridges.push({ text: cluster.text, source, page: cluster.page, leftPx, rightPx });
    }
  }
  return bridges;
}

/**
 * A bridge's rectangle, in the coordinates the decoration it copies was built in.
 *
 * @remarks
 * The y and the height come back off the source record rather than out of the face's metrics a second time: the bridge exists to be the same line as its neighbours, and a rectangle derived independently would agree with them only as far as two roundings do.
 */
export function bridgeRect(bridge: DecorationBridge): { topPx: number; heightPx: number; rectPt: [number,number,number,number]; } {
  const geometry = pageGeometryFor(bridge.page);
  const [, bottomPt, , heightPt] = bridge.source.record.rectPt;
  const topPx = (geometry.heightPt - geometry.marginPt - (bottomPt + heightPt)) / PX_TO_PT;
  const round = (n: number): number => Math.round(n * 1000) / 1000;
  return {
    topPx,
    heightPx: heightPt / PX_TO_PT,
    rectPt: [
      round(geometry.marginPt + bridge.leftPx * PX_TO_PT),
      round(bottomPt),
      round((bridge.rightPx - bridge.leftPx) * PX_TO_PT),
      round(heightPt),
    ],
  };
}

/** The same rectangle as a closed PDF path, ready to be a vector node's own. */
export function bridgePath(bridge: DecorationBridge): PathSegment[] {
  const { topPx, heightPx } = bridgeRect(bridge);
  return rectPath(bridge.page, bridge.leftPx, topPx, bridge.rightPx - bridge.leftPx, heightPx);
}
