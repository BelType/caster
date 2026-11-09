/**
 * `displayList.js` — a Caster page as plain data, in the shape of Typst's frame: what the measurement and the walk decided, in the order the writer paints it.
 *
 * Caster's own. The schema and the reasons for it are in `.claude/plans/the-display-list/plan.md`; `.claude/plans/the-display-list/executors.md` is the plan this module is built under. Types, as `adapters/strip.js` is, because the list is a fact about a document and not about a module; `displayList/build.js` makes one. The two functions a reader of a list needs are re-exported beside them, so the package's `./display-list` face is this module: `validateList` (`displayList/validate.js`) and `recordsOf` (`displayList/records.js`).
 *
 * @remarks
 * The list holds plain values and nothing a structured clone or `JSON.stringify` cannot carry: no DOM object, no pdf-lib object, no `Map`, no `Set`. Items are in painting order; reading order lives only in the structure tree, whose children are in it. A `tag` start and its end sit in the same item list, so a marked-content sequence never straddles a graphics-state save (*an interval is a marked-content sequence*, DESIGN.md S71).
 *
 * VERSION 2 (*the display list, version 2*, `.claude/plans/the-display-list/plan-v2.md`). Every length the writer needs is in page points, converted by the builder with the expressions the writer used, so a number is computed once by the code that computed it and only its place moved; a glyph's advance stays in font units, because the writer divides by the face's `upem` itself. Fonts, images, facsimiles and pixels are bytes in `resources.blobs` keyed by their SHA-256, and no item reaches outside the list: the writer reads no page geometry, no measurement and no walk. Item and field names are the schema's (`plan.md`), and krilla 0.8's `Surface` where the schema is silent; what only the report reads is in an `origin`, or beside the list, and the writer ignores it. The structure tree was still the walk's own until version 4.
 *
 * VERSION 3 (stage 1 of `.claude/plans/the-rust-writer/plan-close-the-list.md`). The list carries what the writer used to be handed beside it, so a writer given the list and nothing else writes the same bytes (*the same list prints the same bytes*, DESIGN.md S102, a draft): each font instance's widths (`FontInstance.widths`, HarfBuzz's, asked by the builder, the authority every writer's embedded `hmtx` must equal), the creation date (`info.created`), how the list is to be written (`writing`: the font profile, the photo rule, the colour story with its ICC profiles as blobs), each outgoing link's resolved `uri`, and `resources.fonts` as an array whose order is data. The writer builds the ToUnicode map from the list's clusters, and refuses a list of any other version. What a foreign reader must keep that JSON hides: offsets into `text` and `glyphs.clusters` are UTF-16 code units, and the order of `resources.fonts` is the order of `F0`, `F1`, ….
 *
 * VERSION 4 (stage 2 of the same plan). The structure tree is the builder's, resolved (`structure`, a {@link Structure}): its elements by index, pruned, in allocation order, each `/K` already in reading order, every attribute object written out, so a writer inherits no rule of the walk's and only numbers each page's content starts as MCIDs. A content `tag` names its element by index; so do a link (the `/OBJR` owner), an internal link's destination (already the element with a page) and a bookmark. `figureBoxes` folded into the Figure's Layout attribute, and a content start's `mcid` and `seq` are gone: the writer numbers the first, and the second decided an order the children now hold. Links' `order` runs 0, 1, 2 … over the document.
 *
 * VERSION 5 (stage 3 of the same plan). An image source is what the writer embeds, never what it must still decode: the image pass of `print()` (`images/imagePass.js`) asks the browser for the pixels of a file no PDF filter reads (WebP, AVIF, GIF, an arithmetic-coded JPEG the browser decodes) and runs the opaque-photo rule with its re-encode, before the builder. So a source is a file passed through as is (`blob`, `mime`), decoded pixels (`samples`) or the photo rule's JPEG (`jpeg`), with the rule's evidence (`photo`) wherever it was consulted, and a raster fallback carries the same `photo` and `jpeg`. `writing.photoRule` is gone: the flag reaches the pass, and the list records what the pass decided.
 *
 * VERSION 6 (stage 5 of `.claude/plans/the-rust-writer/plan-rust-writer.md`, Egildo's ruling of 2026-11-03 amending *the same list prints the same bytes*, S102). A PNG whose `IDAT` no `/Predictor 15` describes (an alpha channel, Adam7 interlace, a palette with `tRNS`) is decoded in the image pass too, by fast-png, so the writer decodes nothing at all and a second writer links no PNG decoder. Its `samples` are the file's own, not a canvas's: its bit depth, its colour space, its palette and inflated `iCCP` beside them, its alpha interleaved; `original.why` keeps the reason for the report.

 * THE SCHEMA IN ONE FILE (stage 5 of the same plan). Every type the list is written in is defined here, the matrix, the path, the shading, the print marks, the font profile and the black-text policy among them, and the modules that compute them re-export them; what a writer returns for the list is `displayList/contract.js`, re-exported from here. A foreign writer reads those two files and no other. Order is data in every array and in no object: the writer reads no object's key order (the attribute objects are written in their schema's key order, whatever order a reader kept), and the arrays that carry an order of their own say so (`resources.fonts`, `structure.elements`, an element's `children`, a page's `items`).
 *
 * VERSION 7 (brief 4 of the image round, `.claude/plans/image-handling/`, Egildo's rulings 4, 9 and 10 of 2026-11-03 and the amendment of *the same list prints the same bytes* in `codeberg.org/BelType/decisions`). `ImageSamples.colorSpace` gains `DeviceCMYK`: under `convertImages: 'cmyk'` the image pass converts an RGB or grey image through lcms-wasm to the output intent's CMYK, after the reduction, and the list carries the result as four components a pixel, with the alpha beside them, never with a `palette` or an `icc` (the output intent is the profile). A writer of version 6 must refuse such a list, so the definition is cut at 7; the report says that an image was converted, which the list does not (`original` gains no member). Nothing else in the list moved.
 *
 * @packageDocumentation
 */

export type * from './displayList/contract.ts';
export { validateList } from './displayList/validate.ts';
export { recordsOf } from './displayList/records.ts';

/** The whole document, as the writer needs it and nothing else. */
export type DisplayList = {
  version: 7;
  info: DocumentInfo;
  writing: Writing;
  resources: Resources;
  /** The structure tree, resolved. Version 4. */
  structure: Structure;
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
  /** `tagged` under `standard: 'none'` (*PDF/UA-2 is a flag, not a given*, S103), or once a guess in the tree withdrew the claim (*the printer guesses, says so, and withdraws the claim*, S90): the file then claims nothing in its XMP. */
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
  /** The colour story, written when `print()` decided the document has one (`colourOn`: the `colour` flag, and with `auto` a colour hint or print marks the walk's survey found, or `blackText`). Absent, every colour is `rg` from the computed style, no page carries a `/ColorSpace`, the catalog carries no `/OutputIntents`, and a page with print marks is refused. The decision is the walk's, made on computed style; the list records it and nothing re-derives it. */
  colour?: ColourWriting;
};

/** The colour story's objects, as the writer is to write them. */
export type ColourWriting = {
  /** The two ICC profiles, each a key into `blobs`: the output intent's profile (the operator's CMYK profile, else the sRGB one, and then both keys name the same blob), and the sRGB profile `/DefaultRGB` points at. From `CasterOptions.profile` and the `profiles` capability's `srgb.icc`. */
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
  /** Bytes keyed by their SHA-256, in hex: font programs as the writer reads them, image files as fetched, the RGBA samples of a raster fallback or a colour cluster, a facsimile's PDF, the colour story's ICC profiles. The one place the list holds a typed array. The pool's order is not data, nor is any object's key order anywhere in the list. */
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
  /** Key into `blobs`: the image file as fetched, passed through as is (a JPEG, a PNG), or for a facsimile the PDF it is a page of. Absent where the pass decoded or re-encoded the file, which the list then does not hold. */
  blob?: string;
  /** With a file `blob`. */
  mime?: string;
  /** The pixels the image pass decoded, where no PDF filter reads the file (WebP, AVIF, GIF), or where no predictor describes a PNG's `IDAT` (version 6). Version 5. */
  samples?: ImageSamples;
  /** Key into `blobs`: the JPEG the opaque-photo rule re-encoded the pixels as, which the writer carries under `/DCTDecode`. Version 5. */
  jpeg?: string;
  /** What the source was, where the list holds the pass's pixels or JPEG and not the file: its format as the report names it (the MIME type, or `image/jpeg (arithmetic)` for an arithmetic-coded JPEG the browser decoded), its length, a PNG's `gAMA`-only flag, and why a PNG was decoded (version 6). Report only. Version 5. */
  original?: { format: string, bytes: number, gammaOnly?: boolean, why?: PngDecodeReason };
  /** The opaque-photo rule's evidence, wherever the pass consulted it, `the photoRule flag is off` included. Version 5. */
  photo?: PhotoEvidence;
  /** Why the pass handed the file through when it asked the browser for its pixels: the browser's refusal of an arithmetic-coded JPEG, for the report. Version 5. */
  refusal?: string;
  facsimile?: { url: string, page: number };
};

/**
 * Decoded pixels as the list carries them.
 *
 * @remarks
 * The blob is interleaved samples, row-major from the top: each pixel's colour components in `colorSpace`, then its alpha where `alpha` is set, `bitsPerComponent` bits each, big-endian at 16. Two producers write it. The browser's decode (WebP, AVIF, GIF, an arithmetic JPEG it decodes) gives RGBA at eight bits in its sRGB, as a raster fallback's is: what `createImageBitmap` and `getImageData` gave back, unpremultiplied (version 5). fast-png's decode of a PNG whose `IDAT` no predictor describes gives the file's own samples: its depth, a depth under 8 unpacked to one sample a byte; grey, RGB or a palette's indices; the alpha of an alpha channel, or of the palette's `tRNS` looked up per pixel (version 6). The writer splits the colour from the alpha and writes the `/SMask` only where some pixel is not opaque.
 */
/** Why the image pass decoded a PNG: what in it `/Predictor 15` cannot describe. Version 6. */
export type PngDecodeReason = 'alpha' | 'interlace' | 'palette-trns';

export type ImageSamples = {
  /** Key into `blobs`: the interleaved samples. */
  blob: string;
  width: number;
  height: number;
  /** `Indexed` is over `DeviceRGB`, with `palette`. Version 6 adds `DeviceGray` and `Indexed`; version 7 adds `DeviceCMYK`, four components, never with `palette` or `icc`. */
  colorSpace: 'DeviceRGB' | 'DeviceGray' | 'Indexed' | 'DeviceCMYK';
  /** 16 only from a 16-bit PNG, or from a 16-bit image converted to `DeviceCMYK`, never with `Indexed`. Version 6. */
  bitsPerComponent: 8 | 16;
  /** Each pixel carries an alpha sample after its colour. Version 6. */
  alpha: boolean;
  /** Key into `blobs`: the palette as RGB triples (a PNG's `PLTE`), with `Indexed` only. Version 6. */
  palette?: string;
  /** Key into `blobs`: the ICC profile the colour components are in (a PNG's `iCCP`, inflated), never with `Indexed`. Version 6. */
  icc?: string;
};

/** One quality the opaque-photo rule encoded and measured. */
export type PhotoCandidate = {
  quality: number;
  bytes: number;
  psnrDb: number;
  /** What the browser's own encoder chose at this quality, read back off the frame. */
  subsampling: string;
};

/**
 * What the opaque-photo rule saw and chose, as the image pass recorded it (`docs/guide/images.md` §"The opaque-photo rule"): the four gates, the sampled look, every quality it tried, and the one it chose or null. Report only; the writer's bytes follow from whether a `jpeg` is there. Version 5.
 */
export type PhotoEvidence = {
  isPhoto: boolean;
  /** Why not, or `photographic` when it is. */
  reason: string;
  pixels: number;
  uniqueRatio: number;
  longestRun: number;
  candidates: PhotoCandidate[];
  chosenQuality: number | null;
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
  /** The opaque-photo rule's evidence on the pixels, wherever the pass consulted it. Version 5. */
  photo?: PhotoEvidence;
  /** Key into `blobs`: the JPEG the rule re-encoded the pixels as, which the writer carries instead of the RGBA. Version 5. */
  jpeg?: string;
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
  /** The heading's element, by its index in `structure.elements`. Version 4. */
  element: number;
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
  /** In painting order, the page's `link` items last. The order is data: the writer writes the items in it, and two items swapped are another file. */
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
  /** The clips the line's text object is painted under: the padding box of every ancestor that hides its overflow, and any `clip-path`, outermost first, in the space inside `transform`. Each is applied in turn inside the same graphics-state save as the `cm`, so the list is an intersection. Absent when nothing clips the line. */
  clips?: ClipPath[];
  /** The run's characters: the segments' texts, a space between two where DOM whitespace separated them, and a space first where `leadingSpace`. */
  text: string;
  /** The run owes the reader a space glyph before its first word: DOM whitespace stood across the boundary with the run before it, and this is not the first run of its line. */
  leadingSpace: boolean;
  /** The glyph id of U+0020 in the run's font under its features, which the writer shows for every space it writes. From `spaceGlyph(run.url, run.features, run.coords).gid`. 0 where the face has no space glyph: a list claiming PDF/UA-2 may then owe no gap, and under a list claiming nothing the writer writes each gap as positioning with no glyph (S103). */
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

/** What only the report reads of a run, and the colour emitter's record of it. The writer draws none of it, so it is not in the list: `buildDisplayList` hands it back beside the list, and `print()` joins it to the writer's records by the item (`origins[page][item]`), which is how the report's runs, words, paragraphs and colour rows learn what the measurement knows. */
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
  /** The `Link` element that owns the annotation, by its index in `structure.elements`; its `children` end with this link's `/OBJR`. Version 4. */
  element: number;
  /** The annotation's place among all the document's links, in the walk's order, 0, 1, 2 … over the document: its `/StructParent` is the page count plus this. */
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
  /** Internal links only: where the target is in points, and the element the `/Dest` names, by its index in `structure.elements`: the first element at or under the one the fragment named, in reading order, with content of its own, which the builder resolved (version 4). `struct` is the path of the element the fragment named, which only the report reads. */
  dest?: { page: number, x: number, y: number, element: number, struct: string };
  /** Every link without a `dest`: the `/URI` its action carries, an absolute, ASCII, percent-encoded URI. The builder resolves `href` against the document's base URL and percent-encodes each character once (`absoluteUri`); an `href` the URL parser refuses is kept as written. `href` stays as the author wrote it, for the report. Version 3. */
  uri?: string;
};

/**
 * The structure tree as the writer writes it: every element the file carries, pruned, ordered and resolved by the builder.
 *
 * @remarks
 * Element 0 is the root (`Document`). The array's order is the order the writer allocates the elements' objects in, which is the walk's DOM order with the pruned elements left out; an element's `children` are its `/K` in reading order. Every decision is the builder's (`displayList/structure.js`): which elements survive (an element with no content, no annotation and no surviving child is pruned, a `TH` or `TD` never), the order of every `/K`, the element an internal link's `/Dest` names, the attribute objects. The writer numbers each page's content starts 0, 1, 2 … as its MCIDs and writes what it is given: the ParentTree, the IDTree, each element's `/P`, and `/Pg` with bare MCIDs where all of an element's content is on one page, follow from the children. Version 4.
 */
export type Structure = {
  /** The order is data: the order the writer allocates the elements' objects in, which every index into the array names. */
  elements: StructElement[];
};

/** One structure element, as its dictionary is written. */
export type StructElement = {
  /** The PDF 2.0 standard-namespace structure type, `/S`. */
  type: string;
  /** The walk's structure path, e.g. `Document/Sect[0]/P[2]`. Only the report reads it. */
  path: string;
  /** `/Lang`, a byte string. Each of the four entries is present only when it is written: the builder leaves out an empty one. */
  lang?: string;
  /** `/Alt`, a text string. */
  alt?: string;
  /** `/E`, the expansion of an abbreviation, a text string. */
  expansion?: string;
  /** `/ID`, a byte string, which `/Headers` and the IDTree name the element by. */
  id?: string;
  /** `/A`: the attribute objects in the order they are written; one is written as the dictionary itself, more than one as an array. Absent when there is none. */
  attributes?: StructAttribute[];
  /** `/K` in reading order. The order is data: the writer writes `/K` in it. */
  children: StructChild[];
};

/**
 * One attribute object of `/A`, keyed as its dictionary is written (`/O` first).
 *
 * @remarks
 * Every string value is a PDF name except each entry of `Headers`, which is a byte string (the `/ID` of a header cell). `BBox` is a PDF rectangle `[llx lly urx ury]` in page points, to thousandths. A `Table` object is a cell's: `Scope` on a `TH`, `Headers` where its header set is not empty, `RowSpan` and `ColSpan` only above 1.
 */
export type StructAttribute = { O: 'List', ListNumbering: string }
  | { O: 'Layout', BBox: [number, number, number, number] }
  | { O: 'Table', Scope?: 'Column' | 'Row' | 'Both', Headers?: string[], RowSpan?: number, ColSpan?: number }
  | { O: 'Layout', TextPosition: 'Sub' | 'Sup' };

/** One entry of an element's `/K`: another element by its index in `elements`; a marked-content sequence by the page and the index in that page's `items` of the `tag` item that opens it; or the annotation of the `link` item whose `order` this is, as an `/OBJR`. */
export type StructChild = number | { page: number, item: number } | { link: number };

/** `start` opens one marked-content sequence and `end` closes it; they pair in one item list. */
export type TagItem = { kind: 'tag', start: ContentStart } | { kind: 'tag', start: ArtifactStart } | { kind: 'tag', end: true };

export type ContentStart = {
  /** The structure element that owns the sequence, by its index in `structure.elements`, whose `children` name this item; the sequence is tagged with the element's `type`. Its MCID is the writer's: the content starts of a page are numbered 0, 1, 2 … in item order. Version 4. */
  element: number;
};

export type ArtifactStart = {
  artifact: { type: 'Pagination' | 'Layout' | 'Page', subtype?: string };
  /** The artifact's owner key; absent on the page's own ground, which the report does not list. */
  path?: string;
  /** What the group's first unit was, for the report. */
  kind?: 'paint' | 'image' | 'text';
};

/** A PDF matrix, `[a b c d e f]`: x′ = ax + cy + e, y′ = bx + dy + f. */
export type Matrix = [number, number, number, number, number, number];

/** A PDF rectangle, `[llx lly urx ury]`, in points. */
export type BoxPt = [number, number, number, number];

/** One segment of a clip path, in PDF points. `c` carries two control points. */
export type PathSegment = { op: 'm', to: [number, number] } | { op: 'l', to: [number, number] } | { op: 'c', c1: [number, number], c2: [number, number], to: [number, number] } | { op: 'h' };

/** A path as a flat list of segments: a subpath begins at an `m` and a closed one ends in an `h`. */
export type Path = PathSegment[];

/** One stop of a gradient, with the alpha kept beside the colour rather than folded in. */
export type GradientStop = {
  offset: number;
  rgb: [number, number, number];
  /** Present when the hint of `colour.md` (E8) declared the stop in CMYK. */
  cmyk?: [number, number, number, number];
  alpha: number;
};

/** A shading, in the terms the PDF dictionary uses. */
export type ShadingSpec = {
  /** 2 for axial, 3 for radial; nothing else is built. */
  type: 2 | 3;
  /** `/Coords`, in the space `matrix` maps onto the page. */
  coords: number[];
  extend: [boolean, boolean];
  stops: GradientStop[];
  colorSpace: 'DeviceRGB' | 'DeviceCMYK';
  /** The `cm` concatenated before `sh`, or folded into a pattern's `/Matrix`. */
  matrix: Matrix;
  /** The same coordinates mapped onto the page, for a human reading the report. */
  coordsPt: number[];
  /** `pad`, or the spread the stops were unrolled for. */
  spread: 'pad' | 'reflect' | 'repeat';
  /** How many periods the unrolling covers; 1 when the spread is `pad`. */
  periods: number;
  /** True when any stop is not fully opaque, which is what asks for a soft mask. */
  hasAlpha: boolean;
  /** What the gradient was written as, for the record. */
  source: string;
  /** Set when PDF has no shading that draws what the engine drew, with the reason. The caller rasterises instead of emitting the shading. */
  degenerate?: string;
};

/** One stroked shape of one mark, as a list of subpaths in page points. */
export type MarkShape = {
  kind: 'crop' | 'cross';
  /** Which corner or side the shape belongs to. */
  at: string;
  /** Straight segments, `[x0, y0, x1, y1]`. */
  segments: [number, number, number, number][];
  /** A circle, `[cx, cy, r]`, present on a registration target. */
  circle?: [number, number, number];
};

/** How every font is written. */
export type FontProfile = {
  /** Whether to embed only the glyphs the document shows. */
  subset: boolean;
  /** Decimals in the /W array. The emitter's pen follows the written value. */
  widthDecimals: number;
  /** Whether CFF goes in bare as /CIDFontType0C or wrapped as /OpenType. */
  cffContainer: 'bare'|'opentype';
  /** Whether /DW is the most common width rather than the 1000 default. */
  dwFromMode: boolean;
};

/** What the black-text option does with an unhinted `rgb(0 0 0)` text fill. */
export type BlackTextPolicy = 'none' | '100k';

export {};
