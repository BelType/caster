/**
 * `vectors/skipInk.js` — `text-decoration-skip-ink: auto` (`structure-tree.md`, E12F): the underline cut where the glyphs cross it.
 *
 * Ported from `harness/src/export/skipInk.ts` (E12F). Guide: `docs/guide/structure-tree.md` §"Skip-ink underlines" — the `13` px dilation cap and the `0.5` px band inset.
 *
 * WHAT THE PORT CHANGED. The port records no change here beyond the language. The fontkit handles stay `any` (`FontkitFont`, `types/vendor.d.ts`): fontkit's shipped declarations describe its node build.
 *
 * The harness's own header follows.
 *
 * `text-decoration-skip-ink: auto` (`structure-tree.md`, E12F): the underline cut where the glyphs cross it.
 *
 * E9 (`vector-painting.md`) painted the line continuous and wrote the fact down as a deferral, because skipping needs the outlines and E9 had the advances. E12 (`structure-tree.md`) has the outlines — fontkit parses the same programs E4 (`font-embedding.md`) embeds — so the deferral is closed with the method Blink itself uses rather than with an approximation of it.
 *
 * **The method.** Blink asks Skia for the *intercepts* of the text against a horizontal band: the x intervals over which the glyph outlines are inside `[top, bottom]`. Each interval becomes a clip-out rectangle, widened horizontally by a dilation, and the line is painted through what is left. Everything about the band and the dilation is read from the pinned source rather than guessed:
 *
 * - `TextPainter::ClipDecorationLine` (`core/paint/text_painter.cc`) takes the decoration's own bounds — for a solid stroke, the underline rectangle — and insets it vertically by 0.5 px, "in order to ignore intersects less than 0.5px". The band is therefore the underline rectangle shrunk by half a pixel top and bottom, which is `[top + 0.5, top + thickness − 0.5]`.
 * - The dilation is `std::min(geometry.Thickness(), kDecorationClipMaxDilation)` with `kDecorationClipMaxDilation = 13`, and the comment beside the constant says why: the cap "closely matches FireFox' implementation". It is applied as a horizontal outset on each side of every intercept.
 * - The vertical outset of 1 px in the same function is about covering the clip rectangle on a device-pixel grid, not about the geometry, and has no meaning in a PDF whose units are points; it is not applied here.
 *
 * **Whose thickness the band is.** The band is the *decoration's* rectangle, and Blink's decoration is not this exporter's. `ComputeDecorationThickness` in `core/paint/text_decoration_info.cc` gives an `auto` underline `computed_font_size / 10`, floored at one pixel by `ComputeUnderlineThickness` — 1.6 px at the 16 px this fixture measures at — while E9 (`vector-painting.md`) decided the exporter paints the face's own `post.underlineThickness`, which for Crimson Text at that size is 0.781 px. E9 verified its *offset* against Chromium and fixed the thickness rule, and E12 (`structure-tree.md`) may not change a decision E9 recorded, so the two numbers are kept apart: the band is Blink's, because a band is a claim about where Chromium found ink and 0.781 px inset by half a pixel top and bottom is not a band at all; the line that is painted through the gaps is E9's. The gap between the two thicknesses is recorded per run and named in the exit notes as a follow-up against E9's rule rather than fixed here.
 *
 * **What this implementation does not have.** Skia intersects the real outline against the band; this flattens each contour to a polyline first, at a tolerance fine enough that the error is far under the quarter point anything is asserted to. And a segment's per-glyph GPOS x-offsets are not in the measurement — only advances are — so a mark positioned off its advance is placed at the advance. Latin text at body sizes has neither, which is what this fixture is; a script that did would need the offsets carried through.
 *
 * @packageDocumentation
 */
import { PX_TO_PT } from '../coordinates/units.ts';
import { pageGeometryFor } from '../coordinates/pageGeometry.ts';
import { rectPath, walkDecorations } from './decorations.ts';

import type { ReportSkipInkRun } from '../report.ts';
import type { PathSegment } from '../images/imagePlace.ts';
import type { MeasuredRun } from '../measure/textMeasure.ts';
import type { DecoratedLine, DecorationRecordLike } from './decorations.ts';

/** `kDecorationClipMaxDilation`, `third_party/blink/renderer/core/paint/text_painter.cc`. */
export const MAX_DILATION_PX = 13;

/** The vertical inset Blink applies to the decoration bounds before taking intercepts. */
export const BAND_INSET_PX = 0.5;

/** Where the two numbers came from, quoted in the report so nobody has to trust this file. */
export const BLINK_SOURCE =
  'third_party/blink/renderer/core/paint/text_painter.cc at chromium 141.0.7390.37 (TextPainter::ClipDecorationLine, kDecorationClipMaxDilation)';

/**
 * Blink's own resolved thickness for an `auto` underline, in px.
 *
 * @remarks
 * `ComputeDecorationThickness`: `auto` is `computed_font_size / 10`. `ComputeUnderlineThickness`: the result is floored at one pixel, because the painter constructs the decoration info with `MinimumThickness1(true)`.
 */
export function blinkThicknessPx(fontSizePx: number): number {
  return Math.max(1, fontSizePx / 10);
}

/** How finely a curve is flattened, in font units per step at 1000 upem. */
const FLATTEN_STEPS = 8;

/** One closed interval on the x axis. */
export type Interval = [number, number];

/** Merge overlapping and touching intervals, in place order. */
function merge(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [sorted[0]];
  for (const [start, end] of sorted.slice(1)) {
    const last = out[out.length - 1];
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** A glyph outline as polylines in font units, y up. */
function contoursOf(font: FontkitFont, gid: number): [number,number][][] {
  const commands = font.getGlyph(gid).path.commands;
  const contours: [number,number][][] = [];
  let current: [number,number][] = [];
  let x = 0;
  let y = 0;
  const push = (px: number, py: number) => {
    current.push([px, py]);
    x = px;
    y = py;
  };
  for (const { command, args } of commands) {
    if (command === 'moveTo') {
      if (current.length > 1) contours.push(current);
      current = [];
      push(args[0], args[1]);
      continue;
    }
    if (command === 'lineTo') {
      push(args[0], args[1]);
      continue;
    }
    if (command === 'quadraticCurveTo') {
      const [cx, cy, ex, ey] = args;
      const [x0, y0] = [x, y];
      for (let i = 1; i <= FLATTEN_STEPS; i++) {
        const t = i / FLATTEN_STEPS;
        const u = 1 - t;
        push(u * u * x0 + 2 * u * t * cx + t * t * ex, u * u * y0 + 2 * u * t * cy + t * t * ey);
      }
      continue;
    }
    if (command === 'bezierCurveTo') {
      const [c1x, c1y, c2x, c2y, ex, ey] = args;
      const [x0, y0] = [x, y];
      for (let i = 1; i <= FLATTEN_STEPS; i++) {
        const t = i / FLATTEN_STEPS;
        const u = 1 - t;
        push(
          u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ex,
          u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ey,
        );
      }
      continue;
    }
    if (command === 'closePath' && current.length > 1) {
      current.push([current[0][0], current[0][1]]);
      contours.push(current);
      current = [];
    }
  }
  if (current.length > 1) contours.push(current);
  return contours;
}

/**
 * The x intervals over which one contour is inside a horizontal band.
 *
 * @remarks
 * Each edge is clipped to the band and the clipped part contributes its own x extent; the intervals are merged afterwards, so a letter whose two stems cross the band separately gives two intercepts and an `o` gives one.
 *
 * @param into - Where the intercepts are pushed, unmerged.
 */
function interceptsOfContour(contour: readonly [number,number][], top: number, bottom: number, into: Interval[]) {
  for (let i = 1; i < contour.length; i++) {
    const [x0, y0] = contour[i - 1];
    const [x1, y1] = contour[i];
    const lo = Math.min(y0, y1);
    const hi = Math.max(y0, y1);
    if (hi < top || lo > bottom) continue;
    const at = (y: number): number => (y1 === y0 ? x1 : x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
    const from = Math.max(lo, top);
    const to = Math.min(hi, bottom);
    const xa = at(from);
    const xb = at(to);
    into.push([Math.min(xa, xb), Math.max(xa, xb)]);
  }
}

/** One run of glyphs with the pen positions the emitter will lay them at. */
export type SkipInkGlyph = {
  gid: number;
  /** Pen x in CSS px, relative to the same origin the underline's x is in. */
  xPx: number;
  /** px per font unit for this glyph. */
  scale: number;
  font: FontkitFont;
};

/**
 * The intervals the glyphs of one line cut out of an underline.
 *
 * @remarks
 * `bandTopPx` and `bandBottomPx` are relative to the baseline and grow downwards, which is the sign convention every px measurement in this harness uses; a glyph outline's y grows upwards, so the band is negated once here and nothing else in the file has to think about it.
 */
export function interceptsOf(glyphs: readonly SkipInkGlyph[], bandTopPx: number, bandBottomPx: number, dilationPx: number): Interval[] {
  const raw: Interval[] = [];
  for (const glyph of glyphs) {
    const top = -bandBottomPx / glyph.scale;
    const bottom = -bandTopPx / glyph.scale;
    const own: Interval[] = [];
    for (const contour of contoursOf(glyph.font, glyph.gid)) interceptsOfContour(contour, top, bottom, own);
    for (const [a, b] of merge(own)) raw.push([glyph.xPx + a * glyph.scale - dilationPx, glyph.xPx + b * glyph.scale + dilationPx]);
  }
  return merge(raw);
}

/** The pieces of `[left, right]` that the intervals do not cover. */
export function complementOf(left: number, right: number, cuts: readonly Interval[]): Interval[] {
  const pieces: Interval[] = [];
  let x = left;
  for (const [start, end] of cuts) {
    if (end <= left || start >= right) continue;
    if (start > x) pieces.push([x, Math.min(start, right)]);
    x = Math.max(x, end);
    if (x >= right) break;
  }
  if (x < right) pieces.push([x, right]);
  return pieces.filter(([a, b]) => b - a > 1e-6);
}

/** Everything one underline needs to be cut. */
export type SkipInkUnderline = {
  /** The artifact path of the decoration, which is what the request carries. */
  owner: string;
  page: number;
  /** The paragraph the line belongs to, for the record. */
  path: string;
  text: string;
  sizePx: number;
  baselinePx: number;
  /** The underline rectangle in CSS px: left, top, width, thickness. */
  leftPx: number;
  topPx: number;
  widthPx: number;
  /** What the exporter paints, which is the rule of E9 (`vector-painting.md`): the face's own `post` thickness. */
  thicknessPx: number;
  /** What Blink resolves for the same line, which is what the band is taken over. */
  bandThicknessPx: number;
  glyphs: SkipInkGlyph[];
};

/** What the skip-ink pass answers: the cut paths, and the record of each cut. */
export type SkipInkResult = {
  /** The path each cut underline is painted as, keyed by the decoration's owner. */
  pathsByOwner: Map<string, PathSegment[]>;
  records: ReportSkipInkRun[];
};

/**
 * Cut every underline handed in, and say by how much.
 *
 * @remarks
 * The result is keyed by the decoration artifact's own path rather than returned in order, so the caller replaces exactly the requests it recognises and a decoration this pass had nothing to say about keeps the continuous line E9 (`vector-painting.md`) painted.
 */
export function skipInkUnderlines(underlines: readonly SkipInkUnderline[]): SkipInkResult {
  const pathsByOwner: Map<string,PathSegment[]> = new Map<any, any>();
  const records: ReportSkipInkRun[] = [];

  for (const underline of underlines) {
    const bandTop = underline.topPx + BAND_INSET_PX - underline.baselinePx;
    const bandBottom = underline.topPx + underline.bandThicknessPx - BAND_INSET_PX - underline.baselinePx;
    const dilation = Math.min(underline.bandThicknessPx, MAX_DILATION_PX);
    const cuts = bandBottom <= bandTop ? [] : interceptsOf(underline.glyphs, bandTop, bandBottom, dilation);
    const right = underline.leftPx + underline.widthPx;
    const pieces = complementOf(underline.leftPx, right, cuts);

    const path: PathSegment[] = [];
    for (const [start, end] of pieces) {
      path.push(...rectPath(underline.page, start, underline.topPx, end - start, underline.thicknessPx));
    }
    pathsByOwner.set(underline.owner, path);

    const painted = pieces.reduce((total, [a, b]) => total + (b - a), 0);
    const toPt = (n: number): number => Math.round(n * PX_TO_PT * 1000) / 1000;
    records.push({
      path: underline.path,
      text: underline.text,
      sizePx: underline.sizePx,
      bandPx: [Math.round(bandTop * 1000) / 1000, Math.round(bandBottom * 1000) / 1000],
      dilationPx: Math.round(dilation * 1000) / 1000,
      paintedThicknessPx: Math.round(underline.thicknessPx * 1000) / 1000,
      bandThicknessPx: Math.round(underline.bandThicknessPx * 1000) / 1000,
      gapsPt: complementOf(underline.leftPx, right, pieces).map(([a, b]) => ([toPt(a), toPt(b)] as [number, number])),
      piecesPt: pieces.map(([a, b]) => ([toPt(a), toPt(b)] as [number, number])),
      removedFraction: underline.widthPx > 0 ? Math.round((1 - painted / underline.widthPx) * 1e4) / 1e4 : 0,
    });
  }

  return { pathsByOwner, records };
}

/**
 * The glyphs of one measured run, at the pen positions the emitter will use.
 *
 * @param fontOf - The parsed face at the run's variation coordinates.
 */
export function glyphsOfRun(run: MeasuredRun, fontOf: (url: string,coords: MeasuredRun['coords']) => FontkitFont): SkipInkGlyph[] {
  const font = fontOf(run.url, run.coords);
  const glyphs: SkipInkGlyph[] = [];
  for (const segment of run.segments) {
    const scale = segment.sizePx / segment.upem;
    let pen = segment.xPx;
    segment.gids.forEach((gid, index) => {
      glyphs.push({ gid, xPx: pen, scale, font });
      pen += (segment.advanceUnits[index] / segment.upem) * segment.sizePx + segment.letterSpacingPx;
    });
  }
  return glyphs;
}

/**
 * The underlines of a document, ready for the intercept pass.
 *
 * @remarks
 * The pairing between a decoration record and the run it came from is `walkDecorations`' job, because E12A (`images.md`) needs the same pairing for a different reason; what is left here is the part that is about skipping ink — which decorations are underlines that asked to be skipped, and what their band is.
 *
 * The rectangle is taken back off the record rather than recomputed. E9 (`vector-painting.md`) owns where an underline sits — the `post` table, `text-underline-offset`, `text-decoration-thickness` — and a second implementation of that rule here would be a second answer to a question already settled.
 *
 * @throws {CasterError} From `walkDecorations`, when the records and the decorations do not pair.
 */
export function underlinesOf(lines: readonly DecoratedLine[], paragraphs: readonly { element: string; text: string; }[], records: readonly DecorationRecordLike[], glyphsOf: (run: MeasuredRun) => SkipInkGlyph[]): SkipInkUnderline[] {
  const out: SkipInkUnderline[] = [];
  for (const entry of walkDecorations(lines, records)) {
    if (entry.kind !== 'underline' || !entry.record.skipInkIgnored) continue;
    const geometry = pageGeometryFor(entry.record.page);
    const [, bottomPt, , heightPt] = entry.record.rectPt;
    const topPx = (geometry.heightPt - geometry.marginPt - (bottomPt + heightPt)) / PX_TO_PT;
    out.push({
      owner: entry.record.path,
      page: entry.record.page,
      path: paragraphs[entry.line.paragraph]?.element ?? '',
      text: entry.run.segments.map((segment) => segment.text).join(' '),
      sizePx: entry.run.sizePx,
      baselinePx: entry.line.baselinePx,
      leftPx: entry.leftPx,
      topPx,
      widthPx: entry.rightPx - entry.leftPx,
      thicknessPx: heightPt / PX_TO_PT,
      bandThicknessPx: blinkThicknessPx(entry.run.sizePx),
      glyphs: glyphsOf(entry.run),
    });
  }
  return out;
}
