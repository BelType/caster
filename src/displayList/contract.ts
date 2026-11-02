/**
 * `displayList/contract.js` — what a writer returns for a display list: the file, and the records of what it chose. Types only.
 *
 * @remarks
 * THE WRITER'S RECORDS. The list's schema is `displayList.js`, which re-exports this module, so a foreign writer reads two files: that one for what it is given, this one for what it gives back. Every type a record names is defined here, the report's own types among them (`report.js` and `fonts/fontEmbed.js` re-export the ones they share with it), and nothing here is a pdf-lib value. Moved here unchanged from `displayList.js`, `report.js` and `fonts/fontEmbed.js` (stage 5 of `.claude/plans/the-rust-writer/plan-close-the-list.md`, in the BelType monorepo).
 *
 * @packageDocumentation
 */

/**
 * What a writer returns for a list: the file, and the records of what it chose.
 *
 * @remarks
 * THE WRITER'S RECORDS (stage 4 of `.claude/plans/the-rust-writer/plan-close-the-list.md`). `emitStructure(list)` returns this and nothing else, and a foreign writer returns the same shape: plain data, no pdf-lib value, every record that belongs to an item keyed by its page and its index in that page's `items`. What the report says of the file beyond these records is derivable from the list and them, and `recordsOf` makes it (`displayList/records.js`); what it says of the measurement and the walk, `print()` joins by the item through the origins the builder hands back beside the list.
 */
export type WriterResult = {
  bytes: Uint8Array;
  records: WriterRecords;
  /** Each page's content stream as text, a diagnostic for a checker; a writer that has none leaves it out. */
  pageStreams?: string[];
};

/**
 * The records a writer returns: each one a choice the writer made, or the arithmetic of one.
 *
 * @remarks
 * Every member is chosen, except where its own documentation says partly. The derivable records the report reads (the structure tree as written, the annotations and links, the artifacts, each page's MCID owners, the tag counts, the `/IDTree`, the outline, the runs and words, the stream order, what each image's source was) are `recordsOf`'s, and a writer does not return them.
 */
export type WriterRecords = {
  /** Chosen: the MCIDs. Per page, the item index of the content start each MCID opens, indexed by MCID. This writer numbers a page's content starts 0, 1, 2 … in item order. */
  mcids: number[][];
  /** Chosen: the pen arithmetic. One entry per text item, in the order written. */
  pens: WriterPen[];
  /** Chosen: how many kerning adjustments the pen arithmetic wrote into the `TJ` arrays. */
  kernAdjustments: number;
  /** Chosen: how many `/ActualText` spans the content streams carry (an ambiguous glyph's, a colour cluster's). */
  actualTextSpans: number;
  /** Chosen: what each font instance became, one per instance in the order of `resources.fonts` (the subset tag, the glyphs kept, the program's sizes, the `/W` entries, the ToUnicode counts). */
  faces: CidFontStats[];
  /** Chosen: one entry per image item, in painting order. */
  images: ImageUse[];
  /** Chosen: how many distinct image XObjects the file holds, raster fallbacks and colour clusters included, by the writer's dedupe rule. */
  xobjects: number;
  /** Partly chosen: one row per vector node painted, in painting order. The geometry, the label and the reasons are the item's own `origin`; the resource names (`xobject`, `extGState`, `form`, a shading's) are the writer's. */
  paint: ReportPaint[];
  /** Chosen: how many of each vector resource the writer made. */
  vectorResources: { shadings: number, patterns: number, extGStates: number, forms: number };
  /** Partly chosen, and present only when the list has a colour story (`writing.colour`). */
  colour?: WrittenColour;
  /** Chosen: one entry per colour-cluster raster item, its `source` a key into `resources.emoji`. Dormant: no print reaches a colour cluster, and `print()` composes no report of them. */
  emoji: ImageUse[];
};

/** An item of the list, by its page and its index in that page's `items`: the key every writer record that belongs to an item carries. */
export type ListPlace = { page: number, item: number };

/** One text item the writer wrote, and the pen adjustment it wrote before each segment, in thousandths of an em (null for the first): chosen, the writer's pen arithmetic. */
export type WriterPen = ListPlace & { adjustments: (number|null)[] };

/**
 * The colour record a writer returns when the list has a colour story (`writing.colour`): the report's, with a text run's rows keyed by the item.
 *
 * @remarks
 * Partly chosen. The resource names (`resource`, the colour spaces' and graphics states' names) and the output intent's object are the writer's; the resolved colour and the operator follow from the item's `fill` and the list's `blackText`. A rectangle's row is the report's row whole, from the item's own `paint`. A text run's row leaves out what the measurement alone knows (the paragraph's path where the item has no owner, the hint as declared, the ink box) and the run's text, and `print()` completes it.
 */
export type WrittenColour = Omit<ReportColor, 'elements' | 'worklist'> & {
  /** One row per painted thing, in the order the writer painted them. */
  elements: (ReportColorElement | WrittenRunColour)[];
  /** One entry per distinct RGB colour left as `rg`, in the order each was first painted. */
  worklist: (ReportWorklistEntry | WrittenRunWorklistEntry)[];
};

/** A text run's colour row, without what the measurement knows. */
export type WrittenRunColour = Omit<ReportColorElement, 'path' | 'hint' | 'rectPt' | 'text' | 'page' | 'target'> & { at: ListPlace, target: 'fill' };

/** A work-list entry a text run painted first: its path and computed colour are the measurement's. */
export type WrittenRunWorklistEntry = Omit<ReportWorklistEntry, 'path' | 'css'> & { at: ListPlace };

/**
 * One image item the writer painted, and the XObject it painted it with: a record the writer returns, keyed by the item.
 *
 * @remarks
 * Every member but the key is the writer's choice: the resource name, the dedupe hash (two items share an XObject when their hashes agree) and everything in `info`. What the report says of the source itself (its format, its length, why the road was taken) is derivable from the list and the writer's road, and `recordsOf` makes it (`displayList/records.js`).
 */
export type ImageUse = {
  page: number;
  /** The image item's index in `pages[page].items`. */
  item: number;
  /** Key into `resources.images`. */
  source: number;
  /** The XObject's resource name on its page, without the slash. */
  name: string;
  /** The writer's dedupe key for the XObject. */
  hash: string;
  info: WrittenImageInfo;
};

/** What one image XObject became in the file: the writer's road and what it wrote. */
export type WrittenImageInfo = {
  /** How the samples got into the file: the file's own bytes under a filter that reads them, samples decoded and deflated, the photo rule's JPEG, or a facsimile's Form XObject. */
  path: 'passthrough' | 'decode-flate' | 'decode-jpeg' | 'form';
  filter: string;
  bitsPerComponent: number;
  /** `DeviceRGB`, `DeviceGray`, `DeviceCMYK`, `Indexed`, `ICCBased`. */
  colorSpace: string;
  hasSMask: boolean;
  /** The `/Decode` array, when one is written. */
  decode?: number[];
  width: number;
  height: number;
  interpolate: boolean;
  /** Stream bytes out, the `/SMask` included. */
  bytesOut: number;
  /** What the writer spent decoding, a timing the report rounds. */
  decodeMs: number;
  encodeMs: number;
  icc: 'embedded' | 'none';
  /** A `gAMA` with no `iCCP` and no `sRGB`: recorded, deliberately not acted on. */
  gammaOnly: boolean;
};

export type EmbedTiming = {
  /** Pinning a variable face with `hb_subset`; `0` for a static face. */
  instance: number;
  /** fontkit over the instance, and over the source again for the reference advances when pinned. */
  parse: number;
  /** `hb_subset` to the glyphs shown, the identity-charset retry included. */
  subset: number;
  /** The program's checks, its dictionaries, and Flate over the program and the `ToUnicode` CMap. */
  write: number;
};

/** Which outline table the embedded program carries. `glyf` goes to `CIDFontType2` with `FontFile2`; every flavour of CFF goes to `CIDFontType0` with `FontFile3`; `cff2` is an error, because PDF 2.0 accepts no variable font and a CFF2 that survived pinning renders as nothing. */
export type OutlineType = 'glyf'|'cff'|'cff-cid'|'cff2';

export type CidFontStats = {
  id: string;
  postScriptName: string;
  /** Glyphs the content stream actually shows. */
  usedGlyphs: number;
  /** Bytes of the embedded font program, uncompressed. */
  fontFileBytes: number;
  /** Glyphs whose ToUnicode destination is more than one character. */
  multiCharToUnicode: number;
  /** Glyphs a second, different text was recorded for under the first-seen rule. */
  toUnicodeConflicts: number;
  faceId: string;
  family: string;
  sourceFormat: 'ttf'|'otf'|'woff'|'woff2';
  outlineType: OutlineType;
  /** Units per em of the embedded program; what `/W` is scaled from. */
  upem: number;
  /** The axis coordinates the instance is pinned at, by tag; empty for a static face. */
  coords: Record<string, number>;
  /** The glyph ids shown, ascending. They are the CIDs. */
  glyphsUsed: number[];
  /** Bytes of the source face as the exporter received it. */
  sourceBytes: number;
  /** Bytes of the embedded program before Flate. Equals `fontFileBytes`. */
  subsetBytes: number;
  /** Bytes of the stream in the file, i.e. after Flate. */
  subsetFlateBytes: number;
  /** `maxp.numGlyphs` (or the CharStrings count) of the embedded program. */
  numGlyphs: number;
  /** Glyph ids in the embedded program that still carry an outline. */
  nonEmptyGlyphs: number;
  /** The six-letter /BaseFont prefix; empty when the whole file is embedded. */
  subsetTag: string;
  cffContainer: 'bare'|'opentype';
  /** Which cluster strings each shown CID stood for, most frequent first. */
  cidToText: Record<number, string[]>;
  ambiguousCids: number[];
  /** Table tags of the embedded program, in directory order. */
  tables: string[];
  /** Whether the embedded program's `hmtx` is the instance's. False for a CFF2 face pinned by HarfBuzz 14.4.0, whose `hmtx` stays at the default master. Always true for a static face, which has only one set of advances. */
  hmtxInstanced: boolean;
  /** Glyphs whose `/W` had to come from the reference instance rather than `hmtx`. */
  staleAdvances: number;
  /** Whether a CID-keyed CFF's charset maps every kept glyph id to itself. */
  charsetIdentity: boolean|null;
  /** Whether CFF_IDENTITY_CHARSET had to be asked for to make that true. */
  charsetRetried: boolean;
  /** OS/2 fsType as the face declares it; policy, not enforced here. */
  fsType: string;
  path: 'B';
  /** What this instance cost the emit stage, by step (*the fonts stage, measured*, DESIGN.md S87). */
  ms: EmbedTiming;
};

export type ColorTarget = 'fill'|'stroke'|'background'|'border'|'gradient';

/** A colour the exporter resolved. */
export type ResolvedColor = {
  kind: 'rgb'|'cmyk'|'spot'|'all'|'none';
  /** RGB components 0–1, or the CMYK quadruple, or a spot's alternate. */
  values: number[];
  /** The colourant name, for a spot or a predefined separation. */
  name?: string;
  /** 0–1; the `scn` operand. */
  tint?: number;
};

/** One painted element and everything the file was asked to do with its colour. */
export type ReportColorElement = {
  path: string;
  target: ColorTarget;
  /** The hint verbatim, as `getComputedStyle` returned it. */
  hint?: string;
  resolved: ResolvedColor;
  overprint?: string;
  /** The colour operator the emitter wrote, e.g. `k`, `scn` or `rg`. */
  operator: string;
  resource?: string;
  /** Whether the black-text policy, rather than a hint, chose this colour. */
  blackTextPolicy?: boolean;
  /** Whether the conversion tier chose it. */
  converted?: boolean;
  text?: string;
  rectPt?: [number, number, number, number];
  page?: number;
};

/** One colour space the file carries. */
export type ReportColorSpace = {
  /** The resource name, or `DefaultRGB`. */
  name: string;
  kind: 'Separation'|'ICCBased';
  alternate: string;
  colorant?: string;
  /** The colourant name after UTF-8 encoding and `#xx` escaping, as the file spells it. */
  escaped?: string;
  /** The tint transform's `/C1`, i.e. the ink at full strength. */
  c1?: number[];
};

/** One overprint graphics state the file carries. */
export type ReportColorExtGState = {
  name: string;
  mode: string;
  /** Stroking overprint. */
  OP: boolean;
  /** Non-stroking overprint. */
  op: boolean;
  OPM: number;
};

/** The output intent, when the run writes one (D8). */
export type ReportOutputIntent = {
  subtype: string;
  condition: string;
  registryName: string;
  info: string;
  /** Components of the destination profile, i.e. the stream's `/N`. */
  n: number;
  profileBytes: number;
  profileSha256: string;
  /** The ICC device class at offset 12; PDF/A-4 6.2.3 t1 wants prtr or mntr. */
  profileClass: string;
  /** The ICC data colour space at offset 16. */
  profileSpace: string;
  profileVersion: string;
};

/** What `CSS.registerProperty` did with one hint property, recorded rather than assumed. */
export type ReportHintRegistration = {
  name: string;
  registered: boolean;
  emptyInitialValue: boolean;
  error?: string;
};

/** One RGB colour a conversion tier would have to convert. */
export type ReportWorklistEntry = {
  path: string;
  target: ColorTarget;
  rgb: [number, number, number];
  css: string;
  uses: number;
};

/** Every colour fact of the run: the elements, the spaces, the graphics states and the output intent. */
export type ReportColor = {
  elements: ReportColorElement[];
  colorSpaces: ReportColorSpace[];
  extGStates: ReportColorExtGState[];
  outputIntent?: ReportOutputIntent;
  defaultRgbBytes?: number;
  defaultRgbSha256?: string;
  blackTextPolicy: string;
  blackTextRuns: number;
  convertRgb?: string;
  convertedElements?: number;
  worklist: ReportWorklistEntry[];
  registrations: ReportHintRegistration[];
};

/** One gradient stop, as the shading carries it. */
export type ReportShadingStop = {
  offset: number;
  rgb: [number, number, number];
  cmyk?: [number, number, number, number];
  alpha: number;
};

/** One shading as written: its type, coordinates, domain and stops. */
export type ReportShadingParams = {
  /** 2 for axial, 3 for radial. */
  type: 2|3;
  /** `/Coords` as written, in the space `matrix` maps onto the page. */
  coords: number[];
  coordsPt: number[];
  extend: [boolean, boolean];
  /** `/Domain`, which is the stops' own range rather than always `[0 1]`. */
  domain: [number, number];
  stops: ReportShadingStop[];
  colorSpace: string;
  matrix: number[];
  spread: string;
  periods: number;
  shading: string;
  pattern?: string;
  source: string;
};

/** One thing the emitter painted, in emission order. */
export type ReportPaint = {
  path: string;
  /** The structure element or artifact that owns the marked content it is in. */
  owner: string;
  kind: 'fill'|'stroke'|'shading'|'clip'|'group'|'smask'|'raster'|'decoration'|'form';
  /** `background`, `border-top`, `circle`… */
  label: string;
  page: number;
  /** Position in CSS painting order. */
  paintIndex: number;
  artifact: boolean;
  /** The painted bounds in page points, `[llx lly urx ury]`. */
  geometry?: number[];
  ctm?: number[];
  /** The in-page CTM chain the whole item was painted under (`coordinates-and-pages.md`, E10). */
  chainCm?: number[];
  evenOdd?: boolean;
  reason?: string;
  feature?: string;
  dpi?: number;
  xobject?: string;
  hasSMask?: boolean;
  extGState?: string;
  form?: string;
  params?: ReportShadingParams|Record<string, unknown>;
};

export {};
