/**
 * `report.js` — the report, the record every checker reads.
 *
 * Ported from `harness/src/sidecar.ts` (E0 built it; every experiment from E1 to E12 added to it). Guide: `docs/guide/verification.md`.
 *
 * WHAT THE PORT CHANGED (D7). PLAN.md D7: the report replaces the sidecar by renaming rather than by redesign. The harness's modules fill this value in as they work and its node checkers assert against it; ripping that out would be a larger and riskier diff than keeping it, and the panel wants exactly the same facts a checker does. So every `Sidecar*` interface is a `Report*` typedef here, with the same field names and the same doc comments, and the five fixture-only fields are dropped: `fixture`, `structure.chromiumPrinted`, `structure.chromiumError`, `container.state`, `container.description`.
 *
 * What the port adds is Caster's own composition record, which the harness had no place for because each fixture composed the modules itself: `capabilities` (PLAN.md §4 — what loaded, how many bytes, how long), `needs` (what the walk found that decided the loads), `options` (the flags the run was made with), `errors` and `warnings`, and `ms` per stage. The panel renders these; `test/acceptance.test.js` asserts against them.
 *
 * There is no `sidecarVersion` successor. The harness bumped one because node checkers in another process read files written by an older browser build; here the report never leaves the run that made it.
 *
 * @packageDocumentation
 */

import type { ReportColor, ReportPaint } from './displayList/contract.ts';
export type { ColorTarget, ResolvedColor, ReportColorElement, ReportColorSpace, ReportColorExtGState, ReportOutputIntent, ReportHintRegistration, ReportWorklistEntry, ReportColor, ReportShadingStop, ReportShadingParams, ReportPaint } from './displayList/contract.ts';
/** A three-valued check: `match`, `mismatch`, or not applicable. */
export type LigatureCheck = 'match'|'mismatch'|'n/a';

/** One measured line of the smoke measurement, in PDF points. */
export type ReportLine = {
  /** [x, y] of the line origin in PDF points, origin bottom-left. */
  originPt: [number, number];
  widthPt: number;
  /** Baseline y in PDF points, origin bottom-left. Equals originPt[1]. */
  baselinePt: number;
  /** PostScript name of the embedded font. */
  font: string;
  sizePt: number;
};

/** One paragraph of the smoke measurement, as its lines. */
export type ReportElement = {
  /** Stable-ish DOM path, e.g. "body>p[0]". */
  path: string;
  tag: string;
  text: string;
  lines: ReportLine[];
};

/**
 * One embedded font program, with everything `finish()` learned about it.
 *
 * @remarks
 * `id` is the instance key — the face id, or the face id plus the pinned coordinates — because one variable face painted at two weights is two programs, two subset tags and two `/W` arrays.
 */
export type ReportFace = {
  id: string;
  url: string;
  /** Which produced file carries this program; absent when there is only one. */
  document?: string;
  faceId?: string;
  /** The name written into `/BaseFont`, subset tag included. */
  postScriptName?: string;
  /** Six uppercase letters, from a hash of face, coordinates and glyph set. */
  subsetTag?: string;
  /** `CIDFontType2` or `CIDFontType0`. */
  subtype?: string;
  /** Which `FontFile` key the descriptor carries. */
  fontFileKey?: string;
  /** CIDs retained in the subset. */
  glyphs?: number;
  /** Bytes of the embedded program, uncompressed. */
  subsetBytes?: number;
  /** The same after Flate. */
  subsetFlateBytes?: number;
  /** CIDs the `/W` array covers. */
  widthEntries?: number;
  widthDecimals?: number;
  toUnicodeEntries?: number;
  /** CIDs whose `ToUnicode` destination is more than one character. */
  multiCharToUnicode?: number;
  /** CIDs whose destination is empty. */
  emptyToUnicode?: number;
  upem?: number;
  /** 80, constant, on every font. */
  stemV?: number;
  /** The pinned variable-font coordinates, when the program is an instance. */
  coords?: Record<string, number>;
  /** Whether the program's `hmtx` carries the instance's advances. */
  hmtxInstanced?: boolean;
  /** Glyphs whose `/W` came from the reference instance because `hmtx` was stale. */
  staleAdvances?: number;
  /** Whether the program is CFF. */
  cff?: boolean;
  /** `bare` or `opentype`. */
  cffContainer?: string;
  /** What embedding this program cost, by step (*the fonts stage, measured*, DESIGN.md S87). */
  ms?: { instance: number, parse: number, subset: number, write: number };
};

/**
 * What one face's bytes cost the fonts stage, step by step.
 *
 * @remarks
 * One entry per URL the table read, so two descriptors that share a file share an entry and their parses add up. Measured 2026-10-19, *the fonts stage, measured* (DESIGN.md S87).
 */
export type ReportFontLoad = {
  /** The browser's own word for the face from `document.fonts` when the table was built: `loaded`, `loading`, `error`, or `unknown` where the set listed no such rule (S88). */
  status: string;
  url: string;
  /** The first descriptor that read this URL. */
  family: string;
  /** What the page loaded: `ttf`, `otf`, `woff` or `woff2`. */
  format: string;
  /** The gateway's `getBytes`, response and body. */
  fetchMs: number;
  /** Resource Timing's `transferSize` for the URL, where the realm has an entry: `0` with a body means the browser's HTTP cache served it. */
  transferBytes?: number;
  /** Resource Timing's `deliveryType` (`cache`, `navigational-prefetch`, or `''` for the network), or `service-worker` where a worker answered. */
  delivery?: string;
  /** WOFF or WOFF2 back to an SFNT; `0` for a bare SFNT. */
  decodeMs: number;
  /** The name table and fontkit's axes, per descriptor, summed. */
  parseMs: number;
  /** HarfBuzz's face load; `0` where the realm already held it. */
  shaperMs: number;
  sfntBytes: number;
};

/** The fonts stage, broken down. */
export type ReportFontTiming = {
  /** Reading every `@font-face` out of the CSSOM. */
  declareMs: number;
  /** Rules found in the CSSOM. */
  declared: number;
  /** Distinct faces `document.fonts` listed. */
  fontFaces: number;
  /** How many of those stood in each status when the table was built. */
  fontFaceStatuses: Record<string, number>;
  /** Declared rules the set had no entry for, as pairing keys. */
  unmatched: string[];
  /** The set's own keys, present only when a rule went unmatched. */
  faceKeys?: string[];
  /** Rules the browser never loaded, left unread (*the table reads the faces the browser loaded*, DESIGN.md S88). */
  unloaded: number;
  faces: ReportFontLoad[];
  /** Compiling and instantiating the subset wasm; `0` where the realm already held it. */
  subsetterMs: number;
};

/** Where one paragraph's marked content sits: one MCID per page it reaches. */
export type ReportParagraph = {
  block: string;
  path: string;
  text: string;
  mcids: { page: number, mcid: number }[];
};

/** One `Tf`/`rg`/`Tc`/`Tm`/`TJ` group: contiguous text with one state. */
export type ReportRun = {
  index: number;
  page: number;
  /** Index of the line the run belongs to, within the whole document. */
  line: number;
  faceId: string;
  /** The embedded program the run is painted with; the face id for a static face. */
  instanceKey: string;
  sizePt: number;
  /** The computed CSS colour the run was painted with. */
  color: string;
  letterSpacingPt: number;
  mcid: number;
};

/**
 * One measured segment and everything the PDF was asked to do with it.
 *
 * @remarks
 * Every coordinate is already page space: y runs up from the bottom of the page, so a checker compares against these numbers directly instead of re-deriving the geometry.
 */
export type ReportWord = {
  page: number;
  mcid: number;
  runIndex: number;
  block: string;
  text: string;
  xPt: number;
  rightPt: number;
  /** Top of the browser rect, in page space. */
  topPt: number;
  /** `rect.top + measureText().fontBoundingBoxAscent`, in page space. */
  baselineMeasureTextPt: number;
  /** DOM baseline probe placed after the word's last character, in page space. */
  baselineProbePt?: number;
  /** The same placed before its first character. */
  baselineProbeBeforePt?: number;
  /** The working probe moved the word; that voids its reading. */
  probeMoved?: boolean;
  /** The working probe did not land on the word's line. */
  probeOffLine?: boolean;
  probeBeforeOffLine?: boolean;
  gids: number[];
  /** Cluster value per glyph, as a UTF-16 offset into `text`. */
  clusters: number[];
  /** Advance per glyph in points, as the shaper positioned it. Carries kerning. */
  advancePt: number[];
  /** Sum of `advancePt`. Carries no letter-spacing. */
  advanceWidthPt: number;
  /** Whether DOM whitespace separated this segment from the one before it. */
  spaceBefore: boolean;
  /** Whether a space glyph was emitted before it. False on a line's first word. */
  spaceEmitted: boolean;
  /** The TJ adjustment written before this segment; null when a Tm placed it. */
  emittedAdj: number|null;
};

/** A letter-spaced segment's evidence about trailing letter-spacing. */
export type ReportTrailing = {
  block: string;
  text: string;
  glyphs: number;
  letterSpacingPx: number;
  /** `(rect width − Σ advances) / letter-spacing`: the glyph count, or one less. */
  ratio: number;
};

/** The page geometry the emitter wrote, and which of the measured answers it chose. */
export type ReportEmission = {
  marginPt: number;
  pageCount: number;
  pageWidthPt: number;
  pageHeightPt: number;
  /** Which of the two measured baselines the exporter actually emitted. */
  baselineMethod: 'measureText'|'probe';
  /** Whether Blink adds letter-spacing after the last glyph of a run. */
  trailingLetterSpacing: boolean;
  trailingSamples: ReportTrailing[];
  /** max |measureText baseline − probe baseline| over every usable probe, in points. */
  baselineAgreementPt?: number;
  usableProbes?: number;
  probeMoved?: number;
  probeOffLine?: number;
  probeBeforeOffLine?: number;
  columnWidthPx?: number;
  containerScrollWidthPx?: number;
  /** TJ adjustments written inside a word to carry a GPOS kern. */
  kernAdjustments: number;
  /** Glyph occurrences wrapped in `/Span <</ActualText …>>` because their CID is ambiguous. */
  actualTextSpans: number;
  faces: ReportFace[];
  paragraphs: ReportParagraph[];
  runs: ReportRun[];
  words: ReportWord[];
};

/** One marked-content sequence, by page and MCID. */
export type ReportStructureMcid = {
  page: number;
  mcid: number;
};

/**
 * The tree the walker intended, in the shape a checker reads back out of the file.
 *
 * @remarks
 * `pg` is present exactly when the element owns content items and all of them are on one page, which is also exactly when `/K` carries bare integer MCIDs rather than `/MCR` dictionaries.
 */
export type ReportStructureNode = {
  tag: string;
  path: string;
  pg?: number;
  mcids: ReportStructureMcid[];
  attrs: { lang?: string, listNumbering?: string, alt?: string, scope?: 'Column'|'Row'|'Both', id?: string, headers?: string[], rowSpan?: number, colSpan?: number, expansion?: string, textPosition?: string };
  /** The annotation reference a Link element ends with. */
  objr?: { page: number, structParent: number };
  kids: ReportStructureNode[];
};

/** The link annotation, as the emitter wrote it. */
export type ReportStructureAnnot = {
  /** The annotation's `/StructParent`, i.e. its key in the ParentTree. */
  structParent: number;
  page: number;
  ownerPath: string;
  href: string;
  contents: string;
  /** `/Rect`, the union of the line rectangles, in PDF points. */
  rectPt: [number, number, number, number];
  /** `/QuadPoints`: eight numbers per line rectangle, upper-left first. */
  quads: number[];
};

/** One artifact the content stream carries, and where. */
export type ReportStructureArtifact = {
  path: string;
  /** E12d (`coordinates-and-pages.md`) adds `Page`, ISO 32000-2's artifact type for printer's marks. */
  type: 'Pagination'|'Layout'|'Page';
  subtype?: 'Header'|'Footer'|'PageNum';
  page: number;
  kind: 'text'|'paint'|'image';
};

/** One page's MCID owners. */
export type ReportStructurePage = {
  /** Per page, the element that owns each MCID, indexed by MCID. */
  mcidOwners: string[];
};

/** The structure tree the emitter wrote, as a checker compares it. */
export type ReportStructure = {
  /** The URI of the one namespace object every element points at. */
  namespace: string;
  /** The catalog `/Lang`. */
  lang: string;
  expectedTree: ReportStructureNode;
  annots: ReportStructureAnnot[];
  artifacts: ReportStructureArtifact[];
  pages: ReportStructurePage[];
  /** Every heading in DOM order; the walker asserted the levels do not skip. */
  headings: { path: string, level: number }[];
  tagCounts: { tag: string, count: number }[];
};

/** One image, from the file it came out of to the matrix it was painted with. */
export type ReportImage = {
  /** `currentSrc`, the background URL, or `canvas:<dom path>`. */
  src: string;
  domPath: string;
  /** What the gateway sniffed: `image/jpeg`, `image/png`, `image/avif`, … */
  format: string;
  path: 'passthrough'|'decode-flate'|'decode-jpeg'|'form';
  filter: string;
  bpc: number;
  /** `DeviceRGB`, `DeviceGray`, `DeviceCMYK`, `Indexed`, `ICCBased`. */
  colorSpace: string;
  hasSMask: boolean;
  /** The `/Decode` array, present only where one is written. */
  decode?: number[];
  /** The XObject's `/Width` and `/Height`. */
  intrinsic: [number, number];
  /** The same in the browser's terms, after the EXIF orientation. */
  displayedIntrinsic: [number, number];
  /** `[x, y, w, h]` in PDF points. */
  paintedRectPt: [number, number, number, number];
  clipRectPt?: [number, number, number, number];
  clipReason?: string;
  cm: [number, number, number, number, number, number];
  /** SHA-256 of the source bytes plus the decode parameters: the dedupe key. */
  xobjectHash: string;
  xobjectName: string;
  page: number;
  tag: 'Figure'|'Artifact';
  alt?: string;
  effectiveDpi: number;
  bytesIn: number;
  bytesOut: number;
  decodeMs: number;
  encodeMs: number;
  /** Where the image pass reduced the file to `imageResolution`: its stored size, the size it was reduced to, the smallest resolution it prints at over all its uses, and the filter. */
  resampled?: { from: [number, number], to: [number, number], ppi: number, type: 'bicubic'|'average'|'subsample' };
  /** Milliseconds in the resampler, with `resampled`. */
  resampleMs?: number;
  /** Why a file that qualified for reduction was left as it was (a CMYK JPEG, a one-bit image, an indexed PNG). */
  notResampled?: string;
  exifOrientation?: number;
  imageOrientation?: string;
  declaredExifOrientation?: number;
  icc: 'embedded'|'none';
  /** A `gAMA` with no `iCCP` and no `sRGB`: recorded, deliberately not acted on. */
  gammaOnly: boolean;
  interpolate: boolean;
  objectFit: string;
  objectPosition: string;
  transform: string;
  /** Which path was taken and why, in one phrase. */
  reason: string;
};

/** One `text-decoration` line, with the font numbers it was positioned from. */
export type ReportDecoration = {
  path: string;
  line: 'underline'|'overline'|'line-through';
  page: number;
  rectPt: [number, number, number, number];
  thicknessPt: number;
  fontUnits: { position: number, thickness: number, upem: number };
  source: string;
  rgb: [number, number, number];
  skipInkIgnored: boolean;
};

/** One stacking context the painting order found, and what made it one. */
export type ReportStackingContext = {
  path: string;
  reason: string;
  zIndex: string;
  position: string;
};

/** A feature painted as something other than what the engine drew. */
export type ReportDeferred = {
  path: string;
  feature: string;
  paintedAs: string;
};

/** What the vector pass painted, in what order, with which resources. */
export type ReportVectorNotes = {
  paintOrderMode: 'dom'|'css';
  stackingContexts: ReportStackingContext[];
  decorations: ReportDecoration[];
  resources: { shadings: number, patterns: number, extGStates: number, forms: number };
  /** The element paths the content stream painted, in stream order. */
  streamOrder: string[];
  figures: { path: string, tag: string, alt: string }[];
};

/**
 * What the container frame recovered before a rectangle was read, and what it refused.
 *
 * @remarks
 * The harness's `state` and `description` are dropped (D7): they named which of the ten container states of `coordinates-and-pages.md` (E10) a fixture ran under, and there is one state here — the print frame Caster made.
 */
export type ReportContainer = {
  /** The probe answer, which is what every coordinate was divided by. */
  scaleRecovered: number;
  scaleFromHeight: number;
  scaleFromWidthRatio?: number;
  scaleFromHeightRatio?: number;
  /** The 2×2 part the corner probes measured: `[a, b, c, d]`. */
  linear: [number, number, number, number];
  /** How far the probes put the strip's corners off a rectangle, in px. */
  offAxisPx: number;
  cornersAxisAligned: boolean;
  /** Viewport rect of each page element as painted. */
  pageRectPx: [number, number, number, number][];
  untransformedWidthPx: number[];
  offsetWidthPx?: number[];
  widthSource: 'computed'|'offsetWidth';
  zoomSeen: string[];
  scrollPx: { windowX: number, windowY: number, ancestorX: number, ancestorY: number };
  devicePixelRatio: number;
  warnings: string[];
  errors: string[];
};

/** One page's boxes as the file carries them, and the pixels behind them. */
export type ReportPageBox = {
  nominal: string;
  /** `[llx lly urx ury]`. */
  media: [number, number, number, number];
  trim?: [number, number, number, number];
  bleed?: [number, number, number, number];
  /** The page element's measured border-box size, which the nominal size replaced. */
  measuredWidthPx?: number;
  measuredHeightPx?: number;
};

/** The measurement's cost, per page and per word. */
export type ReportTiming = {
  pages: number;
  words: number;
  rectsRead: number;
  ms: number;
  wordsPerSecond: number;
};

/** One segment or paint measured under an in-page transform. */
export type ReportCtmNode = {
  kind: 'segment'|'image'|'line';
  page: number;
  path: string;
  text?: string;
  ctmChain: [number, number, number, number, number, number];
  cm?: [number, number, number, number, number, number];
  links?: { path: string, transform: string, originPx: [number, number] }[];
  neutralisedPx?: [number, number, number, number];
};

/** One cell of one table, as the model built it and the tree emitted it. */
export type ReportTableCell = {
  index: number;
  kind: 'th'|'td';
  path: string;
  id: string;
  domId: string;
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  section: 'thead'|'tbody'|'tfoot';
  rowGroup: number;
  scope?: 'Column'|'Row'|'Both';
  empty: boolean;
  /** True when the model invented the cell to make a ragged row rectangular. */
  synthetic: boolean;
  fragment: number;
  domPath: string;
};

/** One page's part of a table: its rows, and the header rows repeated there. */
export type ReportTableFragment = {
  page: number;
  rows: string[];
  repeatedRows: string[];
};

/** One declaration competing for a collapsed border edge. */
export type ReportEdgeCandidate = {
  origin: 'cell'|'row'|'row-group'|'column'|'column-group'|'table';
  style: string;
  widthPx: number;
  color: string;
};

/** One grid edge of a collapsed table, as CSS 2.1 §17.6.2 resolved it. */
export type ReportCollapsedEdge = {
  table: string;
  /** `row-line-2[0..3]`: the grid line and the slots the painted segment covers. */
  edge: string;
  axis: 'h'|'v';
  line: number;
  from: number;
  to: number;
  style: string;
  widthPx: number;
  color: string;
  origin: 'cell'|'row'|'row-group'|'column'|'column-group'|'table';
  declaredBy: string;
  rectPx: [number, number, number, number];
  candidates: ReportEdgeCandidate[];
};

/** One `Table` structure element and the grid it was built from (`tables.md`, E11). */
export type ReportTable = {
  /** Structure path of the one `Table` element. */
  path: string;
  /** `data-pdf-table`, or the first fragment's DOM path. */
  key: string;
  rows: number;
  columns: number;
  collapsed: boolean;
  grid: (string|null)[][];
  headerMap: Record<string, string[]>;
  scopes: Record<string, 'Column'|'Row'|'Both'>;
  spans: Record<string, [number, number]>;
  cells: ReportTableCell[];
  fragments: ReportTableFragment[];
  collapsedEdges: ReportCollapsedEdge[];
  warnings: string[];
};

/** One mark drawn on one page. */
export type ReportPrintMark = {
  page: number;
  /** `crop` or `cross`. */
  kind: string;
  at: string;
  segmentsPt: number[][];
  circlePt?: [number, number, number];
};

/** The crop and registration marks the run drew, per page (`coordinates-and-pages.md`, E12D). */
export type ReportPrintMarks = {
  convention: string;
  pages: { page: number, marks: string, bleedPt: number, offsetPt: number, lengthPt: number, growthPt: number, mediaBefore: [number, number, number, number], mediaAfter: [number, number, number, number], trim?: [number, number, number, number], bleed?: [number, number, number, number] }[];
  separation: string;
  strokeWidthPt: number;
  marks: ReportPrintMark[];
};

/**
 * One bookmark of the document outline, flattened in `/Outlines` order.
 *
 * @remarks
 * `depth` is the nesting the heading levels produced rather than the level itself.
 */
export type ReportOutlineItem = {
  path: string;
  title: string;
  level: number;
  depth: number;
  page: number;
  topPt: number;
  count: number;
};

/** One page's label, as declared and as written to `/PageLabels`. */
export type ReportPageLabel = {
  page: number;
  declared: string;
  /** `/S`, as the PDF name without its slash. */
  style: string;
  start?: number;
  prefix?: string;
  opensRun: boolean;
  /** What a reader shows for the page. */
  label: string;
};

/** One link annotation, and where it goes. */
export type ReportLink = {
  ownerPath: string;
  href: string;
  kind: 'internal'|'external'|'mailto';
  action: 'URI'|'Dest';
  page: number;
  targetId?: string;
  destPage?: number;
  destLeftPt?: number;
  destTopPt?: number;
  destStructPath?: string;
};

/** One `/Lang` the walk recorded: the element, its language, and where that came from. */
export type ReportLangRecord = {
  path: string;
  tag: string;
  lang: string;
  source: 'element'|'container'|'documentElement';
};

/** One underline the intercept method cut, and by how much. */
export type ReportSkipInkRun = {
  path: string;
  text: string;
  sizePx: number;
  bandPx: [number, number];
  /** `min(thickness, 13)`, Blink's dilation, in px. */
  dilationPx: number;
  paintedThicknessPx: number;
  bandThicknessPx: number;
  gapsPt: [number, number][];
  piecesPt: [number, number][];
  removedFraction: number;
};

/** One colour-face cluster, rasterised. */
export type ReportEmojiCluster = {
  owner: string;
  text: string;
  codePoints: string[];
  kind: string;
  page: number;
  face: string;
  rectLeftPt: number;
  rectWidthPt: number;
  placedRectPt: [number, number, number, number];
  xDeviationPt: number;
  ascentPx: number;
  descentPx: number;
  xobjectName: string;
  xobjectHash: string;
  hasSMask: boolean;
  rasterPx: [number, number];
  dpi: number;
};

/** Caster's own: one capability the registry loaded, with what it cost. PLAN.md §4. */
export type ReportCapability = {
  name: string;
  bytes: number;
  ms: number;
  loaded: boolean;
  /** Why it loaded, or why it did not. */
  reason?: string;
};

/** Caster's own: what the walk and the font table found, which is what decided the loads. PLAN.md §4. */
export type ReportNeeds = {
  /** Any `<img>` whose src spells `.png`. A URL test, not a survey of the bytes: a `data:` PNG or an extension-less one is not counted here, and reaching `decodePng` without the capability refuses by name rather than blaming this flag. */
  forcedPngDecode: boolean;
  /** Any `@font-face` whose whole `src` list is WOFF2. A CSSOM test, not a survey of the bytes, and deliberately narrow: `url(x.woff2), url(x.woff)` is false, because the font table takes the WOFF (*BelType ships faces of its own, and WOFF2 is decoded*, S46). */
  woff2Only?: boolean;
  /** Any `--pdf-*` colour declaration found. */
  colourHints: boolean;
  hasTables: boolean;
  hasSvg: boolean;
  hasEmoji: boolean;
  /** Distinct `@font-face` faces a measured run resolved to. */
  faces?: number;
};

/** Caster's own: one error, in the shape the panel opens a source line from. P5. */
export type ReportProblem = {
  message: string;
  /** The `CasterError` subclass's name. */
  name?: string;
  /** The DOM path. */
  element?: string;
  /** The belt's `pos:` stamp. */
  pos?: number;
  capability?: string;
};

/** The report. */
export type Report = {
  page: { widthPt: number, heightPt: number };
  elements: ReportElement[];
  emission?: ReportEmission;
  structure?: ReportStructure;
  fonts?: ReportFace[];
  /** What the fonts stage spent, by face and by step. */
  fontTiming?: ReportFontTiming;
  images?: ReportImage[];
  /** The `<img>` elements whose file was an SVG and which were seated as drawings rather than decoded to pixels (*an SVG that arrives through an `<img>` is a drawing*, S44). An empty list is the ordinary answer; a non-empty one says which pictures in this file are vectors that arrived through an `<img>`. */
  svgImages?: { domPath: string, src: string }[];
  xobjects?: number;
  color?: ReportColor;
  paint?: ReportPaint[];
  paintOrder?: string[];
  deferred?: ReportDeferred[];
  rasterDpi?: number;
  vectorNotes?: ReportVectorNotes;
  container?: ReportContainer;
  pageBoxes?: ReportPageBox[];
  timing?: ReportTiming;
  ctm?: ReportCtmNode[];
  tables?: ReportTable[];
  idTree?: string[];
  printMarks?: ReportPrintMarks;
  emoji?: ReportEmoji;
  outline?: ReportOutlineItem[];
  pageLabels?: ReportPageLabel[];
  links?: ReportLink[];
  langs?: ReportLangRecord[];
  skipInk?: ReportSkipInkRun[];
  capabilities: ReportCapability[];
  needs?: ReportNeeds;
  /** *the printer guesses, says so, and withdraws the claim* (S90): every custom element the walk tagged by its layout under `unknownElements: 'infer'`, with what it became and the computed `display` it was read from. */
  inferred?: { element: string, tag: string, display: string }[];
  /** *the printer guesses, says so, and withdraws the claim* (S90): what the file claims. `'pdfua2'` writes the PDF/UA-2 identification into the XMP; `'tagged'` is a tagged PDF with a guess in it, which claims nothing more. */
  conformance: 'pdfua2'|'tagged';
  /** The flags the run was made with. */
  options: Record<string, unknown>;
  errors: ReportProblem[];
  warnings: string[];
  /** Milliseconds per stage of PLAN.md §3. */
  ms: Record<string, number>;
  /** Size of the produced file. */
  bytes?: number;
};

/**
 * A fresh report, with every list present and empty.
 *
 * @remarks
 * The modules fill it in as they work, exactly as the harness's fixtures filled the sidecar.
 */
export function createReport(options: Record<string,unknown> = {}): Report {
  return {
    page: { widthPt: 0, heightPt: 0 },
    elements: [],
    capabilities: [],
    conformance: 'pdfua2',
    options,
    errors: [],
    warnings: [],
    ms: {}
  };
}

/**
 * Record a problem on the report.
 *
 * @remarks
 * A `CasterError`'s context travels with it so the panel can open the author's source line.
 */
export function recordProblem(report: Report, error: unknown) {
  const e = ((error ?? {}) as { message?: string, name?: string, element?: string, pos?: number, capability?: string });
  const problem: ReportProblem = { message: e.message ?? String(error) };
  if (e.name) problem.name = e.name;
  if (e.element !== undefined) problem.element = e.element;
  if (e.pos !== undefined) problem.pos = e.pos;
  if (e.capability !== undefined) problem.capability = e.capability;
  report.errors.push(problem);
  return problem;
}

/**
 * Record one stage's cost.
 *
 * @remarks
 * The keys are PLAN.md §3's step names.
 */
export function stage( report: Report,  name: string,  ms: number) {
  report.ms[name] = Math.round(ms * 10) / 10;
}

/** What the two PNG decoders disagreed about, which is what decides which one the printer uses. `docs/guide/images.md` §"The two decoders". */
export type ReportDecoderComparison = {
  /** Pixels where the JS decoder and the canvas differ by more than 1 in any channel, at alpha below 30. */
  lowAlphaDiffPixels: number;
  lowAlphaPixelsCompared: number;
  lowAlphaWorstDelta: number;
  /** Whether a canvas read of a 16-bit PNG loses samples the file carries. */
  rgb16Lossy: boolean;
  rgb16DiffSamples: number;
  p3DiffPixels?: number;
  pngIccPixels?: number;
  pngGammaPixels?: number;
  method: string;
};

/** One JPEG quality the photo rule tried. */
export type ReportPhotoCandidate = {
  quality: number;
  bytes: number;
  psnrDb: number;
  subsampling?: string;
};

/** The opaque-photo rule's four gates and what they decided. `docs/guide/images.md`. */
export type ReportPhotoRule = {
  pixelThreshold: number;
  uniqueRatioThreshold: number;
  runThreshold: number;
  psnrTargetDb: number;
  candidates: ReportPhotoCandidate[];
  chosenQuality: number|null;
  photoUniqueRatio?: number;
  photoLongestRun?: number;
  screenshotRejected?: boolean;
  reason?: string;
};

/** The skip-ink measurement and the decision taken on the number. `docs/guide/structure-tree.md` §"Skip-ink underlines". */
export type ReportSkipInk = {
  /** `kDecorationClipMaxDilation` as the pinned Blink source carries it. */
  maxDilationPx: number;
  /** The vertical inset Blink applies to the band before taking intercepts. */
  bandInsetPx: number;
  /** The source file and tag the two numbers were read from. */
  source: string;
  runs: ReportSkipInkRun[];
  differingPixels?: number;
  differingPixelsContinuous?: number;
  bandPixels?: number;
  comparisonSizePx?: number;
  comparisonDpi?: number;
  decision?: string;
};

/** One RGB colour and the CMYK it converted to (`colour.md`, E12E). */
export type ReportConversionEntry = {
  path: string;
  target: string;
  rgb: [number, number, number];
  css: string;
  cmyk: [number, number, number, number];
  otherCmyk?: [number, number, number, number];
  maxDelta?: number;
  uses: number;
};

/** What the RGB→CMYK tier converted, and what it cost. `docs/guide/colour.md` §"The conversion tier". */
export type ReportConversion = {
  mode: 'endpoint'|'wasm'|'none';
  condition: string;
  intent: string;
  blackPointCompensation: boolean;
  entries: ReportConversionEntry[];
  untouched: { path: string, reason: string }[];
  wasm?: { package: string, version: string, wasmBytes: number, loadMs: number, transformMs: number };
  endpoint?: { table: string, entries: number, roundTripMs: number };
  fallbackDecision?: string;
};

/** What `getCTM`, `getScreenCTM` and `getBBox` answered, rather than what was assumed (`vector-painting.md`, E9). */
export type ReportCtmReading = {
  path: string;
  case: string;
  ctm: number[]|null;
  screenCtm: number[]|null;
  bbox: [number, number, number, number]|null;
  clientRect: [number, number, number, number]|null;
  note: string;
};



/**
 * What the engine computes for a collapsed cell's own borders, against the resolution.
 *
 * @remarks
 * `tables.md` (E11) — the load-bearing reading, because it decides whether §17.6.2 has to be done at all.
 */
export type ReportComputedBorderWidth = {
  table: string;
  cell: string;
  computedPx: [number, number, number, number];
  specifiedPx: [number, number, number, number];
  resolvedPx: [number, number, number, number];
};

/** The whole emoji record (`images.md`, E12A). */
export type ReportEmoji = {
  rasterDpi: number;
  route?: 'subset'|'local';
  routeNote?: string;
  faceFile?: string;
  faceBytes?: number;
  clusters: ReportEmojiCluster[];
  /** One XObject per cluster is the rule; this is what the file actually has. */
  xobjects: number;
  exception?: string;
};
