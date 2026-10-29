/**
 * `measure/emoji.js` — colour glyphs, which PDF has no version that can show.
 *
 * Ported from `harness/src/export/emoji.ts` in the `browser-to-pdf-experiments` repository (E12A). Guide: `docs/guide/images.md` §"Emoji and colour clusters (E12A)".
 *
 * The harness's own header follows.
 *
 * E12A (`images.md`): colour glyphs, which PDF has no version that can show.
 *
 * No PDF, 2.0 included, has colour-font support: a `/FontFile2` is outlines and a CIDFontType2 shows one of them in one colour. A COLR/CBDT/sbix face is therefore not embeddable as a font at all, and the choice is between painting an emoji in black, dropping it, or turning the picture into a picture. E12A (`images.md`) turns it into a picture.
 *
 * **The rule.** Every grapheme cluster that resolves to a colour face is rasterised: the browser draws it with `canvas.fillText`, with the same `font` string the element's computed style carries, at the raster DPI of `vector-painting.md` (E9); the pixels become an image XObject with an `/SMask` through the writer of `images.md` (E7); and the image is placed on the baseline — x and width from the browser's own Range rect for the cluster, the vertical from the colour face's ascent as the canvas reports it — inside the enclosing text element's marked content, wrapped in `/Span <</ActualText (cluster)>> BDC … EMC`. A reader extracting the page gets the cluster's characters back; a reader looking at the page sees the emoji the browser drew.
 *
 * **The exception this makes to E2 (`font-fallback.md`).** E2's rule is that the exporter only ever paints with a face the document declared, and that a generic family name or a system font is an export error rather than a silent substitution. A colour cluster is the one case where that rule is relaxed, and only in one direction: no font program is embedded, so nothing about the file depends on a face the recipient does not have. What is embedded is pixels, and pixels are pixels wherever they came from. The declaration still matters for *reproducibility* — the venue declares the colour family with `local()` so the DOM and the canvas resolve the same face — and the exit notes record this as the sole exception E2's predictor allows.
 *
 * **Which clusters.** `\p{RGI_Emoji}` under the `v` flag: the Unicode set of "recommended for general interchange" emoji, which is exactly the set of clusters a colour font is expected to have a picture for. It covers a single emoji, a ZWJ sequence, a flag as a pair of regional indicators and a base with a skin-tone modifier, in one property rather than in four hand-written rules. A cluster outside it — a dingbat with no emoji presentation, a lone regional indicator — is text and goes through the shaper like every other word.
 *
 * @packageDocumentation
 */
import { CasterError } from '../errors.ts';

/**
 * One cluster of `text`, with the offsets it occupies.
 *
 * @remarks
 * `Intl.Segmenter` is the grapheme-cluster boundary algorithm the browser already runs for cursor movement and for `text-decoration`; re-deriving UAX #29 here would be a second implementation of something the platform is authoritative about.
 */
export type Cluster = {
  text: string;
  start: number;
  end: number;
  emoji: boolean;
};

let segmenter: Intl.Segmenter|null = null;

/**
 * `\p{RGI_Emoji}` under the `v` flag, built at run time.
 *
 * @remarks
 * A literal would be the obvious way to write it and the type checker refuses one: the flag is ES2024 and this project targets ES2023, and raising the target for one regular expression would change how every other file is checked. The constructor form is the same expression with the same semantics, and a runtime that does not have the flag says so here rather than silently matching nothing.
 */
let rgiEmoji: RegExp|null = null;

/**
 * The expression, built once.
 *
 * @throws {CasterError} The engine has no `v` flag.
 */
function rgi(): RegExp {
  if (rgiEmoji) return rgiEmoji;
  try {
    rgiEmoji = new RegExp('^\\p{RGI_Emoji}$', 'v');
  } catch (error) {
    throw new CasterError(
      `emoji: this engine has no /v regular-expression flag, so \\p{RGI_Emoji} cannot be asked for: ${String(error)}`,
    );
  }
  return rgiEmoji;
}

/**
 * Whether one grapheme cluster is one a colour face paints.
 *
 * @throws {CasterError} The engine has no `v` flag.
 */
export function isColorCluster(cluster: string): boolean {
  return rgi().test(cluster);
}

/** Every grapheme cluster of a string, in order, each flagged. */
export function clustersOf(text: string): Cluster[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const out: Cluster[] = [];
  for (const { segment, index } of segmenter.segment(text)) {
    out.push({ text: segment, start: index, end: index + segment.length, emoji: isColorCluster(segment) });
  }
  return out;
}

/**
 * A run of text split into the parts that go to the shaper and the parts that go to the raster.
 *
 * @remarks
 * Adjacent non-emoji clusters are merged back into one part, because the shaper's unit is the word and splitting a word into graphemes would break every ligature and every kern in it. Adjacent emoji clusters stay separate: one raster per cluster is the rule, and two emoji beside each other are two pictures.
 *
 * @param offset - Added to every part's `start` and `end`, so the parts index the string the run was cut from.
 */
export function splitForRaster(text: string, offset: number = 0): { start: number; end: number; emoji: boolean; text: string; }[] {
  const parts: { start: number; end: number; emoji: boolean; text: string; }[] = [];
  for (const cluster of clustersOf(text)) {
    const last = parts[parts.length - 1];
    if (!cluster.emoji && last && !last.emoji) {
      last.end = offset + cluster.end;
      last.text += cluster.text;
      continue;
    }
    parts.push({ start: offset + cluster.start, end: offset + cluster.end, emoji: cluster.emoji, text: cluster.text });
  }
  return parts;
}

/** What one cluster's canvas said about the face it painted with. */
export type ClusterMetrics = {
  /** `fontBoundingBoxAscent` at the run's own size, in CSS px. */
  ascentPx: number;
  descentPx: number;
  /** `width`, which is the advance the canvas would lay the cluster out with. */
  advancePx: number;
  /** The `font` the canvas ended up with, which is how a family it refused shows up. */
  usedFont: string;
};

let metricsCanvas: OffscreenCanvas|null = null;

/**
 * A 1×1 context, cached: the metrics do not depend on the surface.
 *
 * @throws {CasterError} The browser gave no 2d context.
 */
function metricsContext(): OffscreenCanvasRenderingContext2D {
  metricsCanvas ??= new OffscreenCanvas(1, 1);
  const context = metricsCanvas.getContext('2d');
  if (!context) throw new CasterError('emoji: the browser gave no 2d context for the metrics canvas');
  return context;
}

/**
 * The colour face's own metrics at one size, as the canvas reports them.
 *
 * @remarks
 * This is the "colour face's ascent" the rule names, and the canvas is the one place it can be had: the face is not embedded, so no table of it is ever parsed, and `getComputedStyle` reports the *element's* line metrics rather than the fallback face's. Setting `font` and reading it back is also the only way to find out whether the browser accepted the family list at all — a refused string leaves the previous value in place, which is what the caller asserts on.
 *
 * @throws {CasterError} The browser gave no 2d context.
 */
export function clusterMetrics(cluster: string, font: string): ClusterMetrics {
  const context = metricsContext();
  context.font = font;
  const measured = context.measureText(cluster);
  return {
    ascentPx: measured.fontBoundingBoxAscent,
    descentPx: measured.fontBoundingBoxDescent,
    advancePx: measured.width,
    usedFont: context.font,
  };
}

/** One cluster's raster, as the pixels and the box they fill. */
export type ClusterRaster = {
  /** Straight off `getImageData`, so the splitter of `images.md` (E7) can take it from here. */
  image: ImageData;
  /** The DPI the pixels were drawn at. */
  dpi: number;
  /** The scale from CSS px to raster px, i.e. `dpi / 96`. */
  scale: number;
  /** Milliseconds spent drawing and reading back. */
  ms: number;
};

/**
 * Draw one cluster into its own canvas at the raster DPI.
 *
 * @remarks
 * The canvas is exactly the box the image will be placed into — the Range rect's width by the face's ascent plus descent — and the pen goes at `(0, ascent)`, which is the same origin the browser laid the cluster out from. Nothing is centred and nothing is fitted: the placement is the browser's own geometry scaled by 0.75, so a raster drawn any other way would land somewhere the browser did not put it.
 *
 * The surface is left transparent, which is what makes the `/SMask`: the writer of `images.md` (E7) keeps the alpha plane whenever a sample is not opaque, and every pixel around an emoji is.
 *
 * @throws {CasterError} The browser gave no 2d context.
 */
export function rasterizeCluster(cluster: string, font: string, widthPx: number, ascentPx: number, descentPx: number, dpi: number): ClusterRaster {
  const scale = dpi / 96;
  const width = Math.max(1, Math.round(widthPx * scale));
  const height = Math.max(1, Math.round((ascentPx + descentPx) * scale));
  const started = performance.now();
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new CasterError('emoji: the browser gave no 2d context for the raster canvas');
  // The scale goes on the transform rather than into the font size, so the cluster is laid out at exactly the CSS size the DOM used and then drawn large; a font asked for at 300/96 of its size can pick a different bitmap strike and a different advance.
  context.scale(scale, scale);
  context.font = font;
  context.textBaseline = 'alphabetic';
  context.fillText(cluster, 0, ascentPx);
  const image = context.getImageData(0, 0, width, height);
  return { image, dpi, scale, ms: performance.now() - started };
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
