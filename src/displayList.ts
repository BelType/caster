/**
 * `displayList.js` — a Caster page as plain data, in the shape of Typst's frame: what the measurement and the walk decided, in the order the writer paints it.
 *
 * Caster's own. The schema and the reasons for it are in `.claude/plans/the-display-list/plan.md`; `.claude/plans/the-display-list/executors.md` is the plan this module is built under. Types only, as `adapters/strip.js` is, because the list is a fact about a document and not about a module; `displayList/build.js` makes one.
 *
 * @remarks
 * The list holds plain values and nothing a structured clone or `JSON.stringify` cannot carry: no DOM object, no pdf-lib object, no `Map`, no `Set`. Items are in painting order; reading order lives only in the structure tree and in each content tag's `seq`. A `tag` start and its end sit in the same item list, so a marked-content sequence never straddles a graphics-state save (*an interval is a marked-content sequence*, DESIGN.md S71).
 *
 * VERSION 2 (*the display list, version 2*, `.claude/plans/the-display-list/plan-v2.md`). Every length the writer needs is in page points, converted by the builder with the expressions the writer used, so a number is computed once by the code that computed it and only its place moved; a glyph's advance stays in font units, because the writer divides by the face's `upem` itself. Fonts, images, facsimiles and pixels are bytes in `resources.blobs` keyed by their SHA-256, and no item reaches outside the list: the writer reads no page geometry, no measurement and no walk. Item and field names are the schema's (`plan.md`), and krilla 0.8's `Surface` where the schema is silent; what only the report reads is in an `origin`, or beside the list, and the writer ignores it. One thing is still the walk's own, marked `display list v1:` where it stands: the structure tree.
 *
 * @packageDocumentation
 */

import type { Matrix } from './images/imagePlace.ts';
import type { Path } from './vectors/pathData.ts';
import type { ShadingSpec } from './vectors/vector.ts';
import type { StructureNode, ArtifactDescriptor } from './walk/structure.ts';
import type { MarkShape } from './coordinates/printMarks.ts';
import type { BoxPt } from './coordinates/pageGeometry.ts';
import type { FontProfile } from './fonts/fontEmbed.ts';
import type { BlackTextPolicy } from './colour/colorResources.ts';

/** The whole document, as the writer needs it and nothing else. */
export type DisplayList = {
  version: 2;
  info: DocumentInfo;
  writing: Writing;
  resources: Resources;
  /** The root of the structure tree, in reading order. // display list v1: the walk's own tree; a `StructElement` of its own waits for a second writer to need it, and `walk/structure.js` is the walk's own business (see results.md, version 2 stage 4). */
  structure: StructureNode;
  /** Each Figure's Layout `/BBox` in page points `[x y w h]`, by structure path. */
  figureBoxes: Record<string, [number, number, number, number]>;
  /** The headings a bookmark points at, in order; empty where the document asked for no outline. */
  outline: OutlineEntry[];
  /** The runs of `/PageLabels`; empty where no page declared one. */
  pageLabels: PageLabelRun[];
  pages: Page[];
};

export type DocumentInfo = {
  /** The catalog `/Lang`. */
  lang: string;
  title: string;
  /** `tagged` once a guess in the tree withdrew the claim (*the printer guesses, says so, and withdraws the claim*, S90). */
  conformance: 'pdfua2' | 'tagged';
  pageCount: number;
  /** The moment the file says it was made: an ISO 8601 instant in UTC, `YYYY-MM-DDTHH:mm:ss` with optional fractional seconds and a final `Z`, as `Date.prototype.toISOString` writes it. Set by `print()` from the host's `created`, or from the wall clock when the host gives none; the writer writes it at whole seconds into both `/CreationDate` and `/ModDate`, and reads no clock. Version 3. */
  created: string;
};

/**
 * How the writer writes what the rest of the list holds: the choices `print()` made from the flags. They change bytes and are not facts about the document, so they are kept apart from `info`. Version 3.
 */
export type Writing = {
  /** How every font is written: subset or whole, the decimals of `/W`, the CFF container, `/DW` from the most common width. From `SUBSET_FONT_PROFILE` with the `widthDecimals` and `cffContainer` flags. */
  fontProfile: FontProfile;
  /** Whether the opaque-photo rule may re-encode a raster as JPEG. The `photoRule` flag. */
  photoRule: boolean;
  /** The colour story, written when `print()` decided the document has one (`colourOn`: the `colour` flag, and with `auto` a colour hint or print marks the walk's survey found, or `blackText`). Absent, every colour is `rg` from the computed style, no page carries a `/ColorSpace`, the catalog carries no `/OutputIntents`, and a page with print marks is refused. The decision is the walk's, made on computed style; the list records it and nothing re-derives it. */
  colour?: ColourWriting;
};

/** The colour story's objects, as the writer is to write them. */
export type ColourWriting = {
  /** The two ICC profiles, each a key into `blobs`: the CMYK output profile of the output intent, and the sRGB profile `/DefaultRGB` points at. From the `profiles` capability, `default_cmyk.icc` and `srgb.icc`. */
  profiles: { cmyk: string, srgb: string };
  /** The output intent's `/OutputConditionIdentifier`. */
  condition: string;
  /** The output intent's `/Info`, a description of the condition for a person. */
  info: string;
  /** The `blackText` flag: `100k` writes black text as `0 0 0 1 k`. */
  blackText: BlackTextPolicy;
};

/** What the items name by key, and the bytes behind them. */
export type Resources = {
  /** Bytes keyed by their SHA-256, in hex: font programs as the writer reads them, image files as fetched, the RGBA samples of a raster fallback or a colour cluster, a facsimile's PDF, the colour story's ICC profiles. The one place the list holds a typed array. */
  blobs: Record<string, Uint8Array>;
  /** Every font instance the text is set in, each carrying its key. The order is data: the writer embeds the instances in this order and names them `F0`, `F1`, … on every page, so a reader keeps the array as it is and never re-sorts it. */
  fonts: FontInstance[];
  /** Keyed by the walk's image index. */
  images: Record<string, ImageSource>;
  /** Keyed by the form's name: content written once and drawn wherever a `form` item names it. */
  forms: Record<string, FormDefinition>;
  /** Keyed by the index of the raster fallback's spec, in the order the print drew them. */
  rasters: Record<string, RasterSource>;
  /** Keyed by the cluster's index in the measurement. */
  emoji: Record<string, EmojiSource>;
};

/** Content written once into a form XObject. */
export type FormDefinition = {
  /** `[llx lly urx ury]` in the form's own space. */
  bbox: BoxPt;
  items: VectorItem[];
};

export type FontInstance = {
  /** The instance key (the measurement's `instanceKey`: the face and the coordinates it is pinned at), which a text item's `font` names. Unique in `fonts`. */
  key: string;
  /** Key into `blobs`: the font program, unwrapped to an SFNT. */
  blob: string;
  /** Where the page loaded it from; the report names the face by it. */
  url: string;
  faceId: string;
  /** The CSS family, for the report. */
  family: string;
  /** What the page loaded, which is what the report calls the source format. */
  sourceFormat: 'ttf' | 'otf' | 'woff' | 'woff2';
  coords: Record<string, number>;
  /** The face's units per em, which a text item's `glyphs.advances` are in. Absent on an instance no text is set in. */
  upem?: number;
  /** The instance's own advance of every glyph its text items show and of every space glyph they name: the authority for the font's widths. */
  widths: FontWidths;
};

/**
 * An instance's widths, as a struct of arrays sorted by glyph id, one entry per glyph.
 *
 * @remarks
 * Asked by the builder, which calls HarfBuzz's `glyphAdvance` for the instance's URL at `shaperVariations(coords)`: the font the words were shaped with, at the coordinates the browser painted, unkerned. A text item's `glyphs.advances` cannot stand in for these, because they are the shaper's positions with kerning applied, and the writer's kern adjustment is exactly the difference between the two. The writer's `/W` is these numbers and nothing else, it refuses a glyph that is not here, and the program any writer embeds must carry an `hmtx` equal to them to the unit (*the widths are HarfBuzz's, the shaper's own*, DESIGN.md S99, amended 2026-11-02). Version 3.
 */
export type FontWidths = {
  /** Glyph ids, ascending. */
  gids: number[];
  /** The advance of the glyph at the same index, in the face's font units. */
  units: number[];
};

export type ImageSource = {
  src: string;
  kind: 'img' | 'canvas' | 'background' | 'facsimile';
  tag: 'Figure' | 'Artifact';
  domPath: string;
  alt?: string;
  /** Key into `blobs`: the image file as fetched, or for a facsimile the PDF it is a page of. */
  blob?: string;
  /** With a file `blob`. */
  mime?: string;
  facsimile?: { url: string, page: number };
};

/** A raster fallback, as the print drew it: what PDF had no operator for. */
export type RasterSource = {
  feature: string;
  reason: string;
  /** `[x y w h]` in page points. */
  rectPt: [number, number, number, number];
  dpi: number;
  cm: number[];
  /** Key into `blobs`: the pixels as RGBA, row-major from the top. Absent where the print drew none. */
  blob?: string;
  width?: number;
  height?: number;
};

/** A colour cluster, as the print drew it (dormant in `print()`: the `emoji` option is not composed, so no print reaches this). */
export type EmojiSource = {
  /** The cluster itself, which is also its `/ActualText`. */
  text: string;
  sizePx: number;
  /** Key into `blobs`: the pixels as RGBA. */
  blob?: string;
  width?: number;
  height?: number;
};

export type OutlineEntry = {
  /** The heading's structure path. */
  path: string;
  title: string;
  level: number;
  page: number;
  /** The top of the heading's first line on its page, in points from the page's bottom, the `y` of the destination. */
  topPt: number;
};

export type PageLabelRun = {
  /** The page the run opens on. */
  page: number;
  label: { style: string, prefix: string, start: number };
};

export type Page = {
  /** Width and height in points: the nominal size, which is the `MediaBox` before any marks. */
  size: [number, number];
  /** `media` is `[0 0 w h]` and, where the page grew to hold its printer's marks, the grown box. */
  boxes: { media: BoxPt, trim?: BoxPt, bleed?: BoxPt };
  /** In painting order, the page's `link` items last. */
  items: Item[];
};

export type Item = GroupItem | TextItem | RectItem | PathItem | ImageItem | RasterItem | RasterFallbackItem | FormItem | MarksItem | LinkItem | TagItem;

/** One run on one line, placed: Typst's `Text` item with Caster's additions. Lengths are points and unrounded where the browser's pixels were multiplied by `PX_TO_PT`, and rounded to thousandths where the measurement's own `xToPt` and `yToPt` rounded them (the writer's arithmetic starts from the numbers it was always given). A glyph's advance stays in the font's units, because the writer divides by `upem` itself and `(advance / upem) * 1000` is not always `advance * 1000 / upem`. */
export type TextItem = {
  kind: 'text';
  owner: string;
  /** Consecutive items with one `lineIndex` share a text object. */
  lineIndex: number;
  /** The `key` of an instance in `resources.fonts`. From `run.instanceKey`. */
  font: string;
  /** Points. From `run.sizePx * PX_TO_PT`. */
  size: number;
  /** Points. From `run.letterSpacingPx * PX_TO_PT`. */
  letterSpacing: number;
  fill: Fill;
  /** Points from the page's bottom. From `yToPt(line.baselinePx, page)`. */
  baseline: number;
  /** The `cm` the line's text object is wrapped in, in page points. From `toPdfMatrix(line.chain, pageGeometryFor(page))`. */
  transform?: Matrix;
  /** The run's characters: the segments' texts, a space between two where DOM whitespace separated them, and a space first where `leadingSpace`. */
  text: string;
  /** The run owes the reader a space glyph before its first word: DOM whitespace stood across the boundary with the run before it, and this is not the first run of its line. */
  leadingSpace: boolean;
  /** The glyph id of U+0020 in the run's font under its features, which the writer shows for every space it writes. From `spaceGlyph(run.url, run.features, run.coords).gid`. */
  space: number;
  glyphs: TextGlyphs;
  segments: TextSegments;
};

/** The run's glyphs as a struct of arrays, one entry per glyph, the segments' glyphs one after the other. */
export type TextGlyphs = {
  ids: number[];
  /** In font units, as the shaper positioned them (justification and the browser's own positions are `segments.x`, not here). */
  advances: number[];
  /** The shaper's cluster value of each glyph, moved onto `text`: the offset of the first character the glyph's cluster stands for. A cluster ends where the next distinct one begins, or where its segment does (`segments.start`), and runs of equal values are the glyphs of one cluster; in a right-to-left segment the values fall. */
  clusters: number[];
};

/** The run's measured segments (words), as a struct of arrays, one entry per segment. */
export type TextSegments = {
  /** Index into `glyphs` of the segment's first glyph. */
  firstGlyph: number[];
  /** Offset into `text` of the segment's first character. */
  start: number[];
  /** Points from the page's left edge, where the browser put the segment: the one place the browser overrides the shaper, and the writer's pen jumps there. From `xToPt(segment.xPx, page)`. */
  x: number[];
  /** Whether DOM whitespace separated the segment from the one before it. */
  spaceBefore: boolean[];
};

/** What a run or a rectangle is painted with: a paint, in the schema's sense, with the computed colour kept beside a declared ink because `colour: 'off'` paints a hinted run in its computed colour. */
export type Fill = {
  /** The computed colour as PDF `rg` operands, 0 to 1. From `run.rgb`. */
  rgb: [number, number, number];
  /** The colour the author declared, which wins when the colour story is on. From `run.colorHint`; The names `All` and `None` are the two colourants PDF predefines. */
  ink?: { cmyk: [number, number, number, number] } | { spot: string, alternate: [number, number, number, number], tint: number };
  /** From `run.overprint`. */
  overprint?: 'fill' | 'stroke' | 'both';
};

/** What only the report reads of a run, and the colour emitter's record of it. The writer draws none of it, so it is not in the list: `buildDisplayList` hands it back beside the list, and `print()` answers the writer's `originOf(page, itemIndex)` from it. */
export type TextOrigin = {
  /** The run's index in the measurement. */
  run: number;
  /** The paragraph's index in the measurement. */
  paragraph: number;
  /** The paragraph's path (`blockPath`). */
  path: string;
  /** The computed CSS colour the run's `rgb` came from. */
  color: string;
  /** The `--pdf-color` hint verbatim. */
  hint?: string;
  /** The run's ink box `[x y w h]` in page points, as the colour report records it. */
  rectPt: [number, number, number, number];
};

/** A rectangle: a measured paint, or the page's own ground. Typst's `Rect`, written as `re`. */
export type RectItem = {
  kind: 'shape';
  owner: string;
  /** `[x y w h]` in page points from the page's bottom. From the paint's four edges by `xToPt` and `yToPt`. */
  rect: [number, number, number, number];
  fill: Fill;
  /** What the colour report records of a measured paint. Absent on the page's own ground, which the colour emitter is not asked about, so this is also what tells the writer to ask. */
  paint?: PaintOrigin;
};

/** What the colour report records of a measured paint, and the colour emitter reads to decide. */
export type PaintOrigin = {
  path: string;
  target: 'background' | 'border' | 'fill';
  page: number;
  /** The `--pdf-color` hint verbatim. */
  hint?: string;
  /** The computed CSS colour the paint's `rgb` came from, or the empty string. */
  color: string;
};

/** What every vector item carries whatever its kind: the transform, clips, alpha, blend and mask it is painted under. Names are the schema's; where the schema is silent they are krilla 0.8's `Surface` (`push_transform`, `push_clip_path`, `push_opacity`, `push_blend_mode`, `push_mask`, `push_isolated`), item by item in results.md. */
export type Painting = {
  /** The in-page CTM chain of every transformed HTML ancestor between the page element and this item, as the `cm` a content stream carries; absent when there is none. The writer concatenates it first, so the item's clips, paths and children are in the untransformed space they were measured in. */
  transform?: Matrix;
  /** Clips in force, already intersected by nesting: each is applied in turn inside the same graphics-state save, so the list is an intersection and cannot be one path. (The schema's `clip` is singular; a list is what the byte contract allows.) */
  clips?: ClipPath[];
  /** `/ca`; absent when 1. */
  opacity?: number;
  /** `/CA`; absent when 1. */
  strokeOpacity?: number;
  /** `/BM`, PDF's names (which are krilla's `BlendMode` variants); absent when `Normal`. */
  blend?: string;
  softMask?: SoftMask;
  origin: VectorOrigin;
};

export type ClipPath = {
  path: Path;
  rule: 'nonzero' | 'evenodd';
};

/** A luminosity or alpha soft mask, as a transparency group of its own. */
export type SoftMask = {
  type: 'luminosity' | 'alpha';
  items: VectorItem[];
  bbox: BoxPt;
  /** `/BC`, the backdrop the group is composited against. */
  backdrop?: number[];
};

/** What a vector fill or stroke paints with. */
export type Paint = { rgb: [number, number, number] } | { cmyk: [number, number, number, number] } | { gradient: Gradient };

/** A gradient, in the terms the PDF dictionary uses. `coordsPt` and `source` are for the report. */
export type Gradient = Omit<ShadingSpec, 'type'> & { type: 'axial' | 'radial' };

export type Stroke = {
  paint: Paint;
  /** Points. */
  width: number;
  /** `J`'s numbering: 0 butt, 1 round, 2 projecting square. */
  cap: 0 | 1 | 2;
  /** `j`'s numbering: 0 miter, 1 round, 2 bevel. */
  join: 0 | 1 | 2;
  miterLimit: number;
  /** Points. */
  dash: number[];
  /** Points. */
  dashPhase: number;
};

/** Where a vector item came from, for the report. Every nested item has `domPath` and `label`; the top-level item also has the page and the paint index, and the reasons the report gives for what the item asked for. */
export type VectorOrigin = {
  /** DOM path of the element the item came from. */
  domPath: string;
  /** A short name for the report, e.g. `background`, `border-top`, `circle`. */
  label: string;
  /** Top-level item only. */
  page?: number;
  /** Top-level item only. */
  paintIndex?: number;
  /** What asked for each clip, parallel to `clips`. */
  clipReasons?: string[];
  /** What asked for the soft mask. */
  maskReason?: string;
  /** A `group`: why it is a form of its own. */
  isolatedReason?: string;
  /** A `form`: why it is one. */
  reason?: string;
  /** A `shape` with a stroke: `vector-effect: non-scaling-stroke`, whose points were pre-transformed. */
  nonScaling?: boolean;
};

/**
 * A path, filled and stroked: Typst's `Shape`, krilla's `draw_path` with a `Fill` and a `Stroke`.
 *
 * @remarks
 * `strokeFirst` is SVG's `paint-order: stroke`: PDF fills first when one operator does both, so a path that wants the other order is written twice. Set only where fill and stroke are both there.
 */
export type PathItem = Painting & { kind: 'shape', owner?: string, path: Path, fill?: Paint, rule: 'nonzero' | 'evenodd', stroke?: Stroke, strokeFirst?: true };

/** Children painted together; a form XObject of their own when `isolated` (krilla's `push_isolated`). */
export type GroupItem = Painting & { kind: 'group', owner?: string, items: VectorItem[], bbox: BoxPt, isolated?: true };

/**
 * A reference to content written once and drawn many times.
 *
 * @remarks
 * `form` names a `FormDefinition` in `resources.forms`; `matrix` is the `cm` that places it. (`transform` is the chain, as on every vector item; an image has none, so its `transform` is its placement.)
 */
export type FormItem = Painting & { kind: 'form', owner?: string, form: string, matrix: Matrix };

/** A raster fallback, painted as an image where PDF has no vector that draws what the engine drew. Its pixels, rectangle, reason and placing `cm` are the resource's (`resources.rasters[source]`). */
export type RasterFallbackItem = Painting & { kind: 'raster', owner?: string, table: 'rasters', source: number };

/** One vector item: what a collector measured, painted under a transform, clips, alpha and a mask. */
export type VectorItem = PathItem | GroupItem | FormItem | RasterFallbackItem;

/** A placed image: the unit square onto the page, clipped, drawn. */
export type ImageItem = {
  kind: 'image';
  owner: string;
  /** Key into `resources.images`. */
  source: number;
  /** The `cm` that puts the unit square on the painted rectangle, in page points. From `placement.cm`. */
  transform: Matrix;
  /** The path the image is clipped to, in page points, non-zero. From `placement.clipPath`. */
  clip?: Path;
  /** From `placement.interpolate`. */
  interpolate: boolean;
};

/** A vector item as a page lists it: with its owner, and the page and paint index it came from. */
export type PlacedVector = VectorItem & { owner: string, origin: VectorOrigin & { page: number, paintIndex: number } };

/** A colour-emoji cluster drawn as pixels, whose words are its `actualText` (dormant in `print()`: the `emoji` option is not composed, so no print reaches this). A raster fallback of a vector is a {@link RasterFallbackItem}. */
export type RasterItem = {
  kind: 'raster';
  owner: string;
  table: 'emoji';
  /** Key into `resources.emoji`. */
  source: number;
  /** The cluster's text. */
  actualText: string;
  /** The `cm` that puts the unit square on the cluster's box. From `emojiBox`. */
  transform: Matrix;
  /** The `cm` of the line's chain, when the cluster's line carries one. */
  chain?: Matrix;
  emojiOrigin: EmojiOrigin;
};

/** What the report records of a colour cluster. Untested: no print reaches it. */
export type EmojiOrigin = {
  /** The font the canvas ended up with. */
  face: string;
  rectLeftPt: number;
  rectWidthPt: number;
  ascentPx: number;
  descentPx: number;
  /** The box `[x y w h]`. */
  rectPt: [number, number, number, number];
};

/** The page's printer's marks, stroked in the one colourant that reaches every plate. They belong to no element; the media box they grew is the page's `boxes.media`. */
export type MarksItem = {
  kind: 'marks';
  shapes: MarkShape[];
};

/** One link annotation on one page, and the `Link` element whose `/OBJR` points at it. Not painted: the writer collects the page's link items after its content. */
export type LinkItem = {
  kind: 'link';
  /** The path of the `Link` element that owns the annotation. */
  struct: string;
  /** The annotation's place among all the document's links, in the walk's order: the `/StructParent` numbering follows it. */
  order: number;
  /** `[left, top, right, bottom]` in page points, y up (so `top` is the larger). */
  rects: [number, number, number, number][];
  target: LinkTarget;
  /** The link's text, for the annotation's `/Contents`. */
  contents: string;
};

/** Where a link goes. */
export type LinkTarget = {
  href: string;
  /** An `href` beginning `#` is a place in this file and becomes a `/Dest`; anything else is an address and becomes a `/URI`. */
  kind: 'internal' | 'external' | 'mailto';
  /** Internal links only: the id the fragment named. */
  targetId?: string;
  /** Internal links only: where the target is in points, and which structure element it is. */
  dest?: { page: number, x: number, y: number, struct: string };
  /** Every link without a `dest`: the `/URI` its action carries, an absolute, ASCII, percent-encoded URI. The builder resolves `href` against the document's base URL and encodes it with `encodeURI`; an `href` the URL parser refuses is kept as written. `href` stays as the author wrote it, for the report. Version 3. */
  uri?: string;
};

/** `start` opens one marked-content sequence and `end` closes it; they pair in one item list. */
export type TagItem = { kind: 'tag', start: ContentStart } | { kind: 'tag', start: ArtifactStart } | { kind: 'tag', end: true };

export type ContentStart = {
  /** The structure element's path; its tag is the node's. */
  struct: string;
  /** Runs 0, 1, 2 … on one page. */
  mcid: number;
  /** The group's place in reading order across the document: page-major, then the DOM rank of the item it came from. The only ordering key the structure tree has. */
  seq: number;
};

export type ArtifactStart = {
  artifact: { type: ArtifactDescriptor['type'] | 'Page', subtype?: string };
  /** The artifact's owner key; absent on the page's own ground, which the report does not list. */
  path?: string;
  /** What the group's first unit was, for the report. */
  kind?: 'paint' | 'image' | 'text';
};

export {};
