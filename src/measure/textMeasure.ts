/**
 * `measure/textMeasure.js` — the browser-side measurement: what the engine did, word by word, and the one coordinate hub every rectangle in the printer goes through.
 *
 * Ported from `harness/src/export/textMeasure.ts` (E3, E5, E7, E8, E9, E10, E12A). Guide: `docs/guide/text-emission.md`, `docs/guide/coordinates-and-pages.md`.
 *
 * WHAT THE PORT CHANGED (P3). Two fixture imports had to find homes. `requestFor` moved to `fonts/fontResolve.js`, beside `matchFace`, because reading a `FaceRequest` off a computed style is not a fixture fact. `FAMILY` — the one family name of the fixture of `text-emission.md` (E3), which was the default `familyOf` — is gone: Caster's default reads the first family of the element's own computed `font-family`, which is what a document with a family per page needs and what a document with one family answers identically. `COLUMN_WIDTH_PX` comes from `coordinates/units.js` and is only ever reached on the no-frame fallback path, which Caster never takes (the engine's adapter installs a frame before anything is measured).
 *
 * The harness's own header follows.
 *
 * The browser-side measurement of `text-emission.md` (E3): what the engine did, word by word.
 *
 * The unit is a *segment*, not a word: a maximal run of non-whitespace inside one text node. That is narrower than a word on purpose, because an inline boundary can split a word (`<strong>bold</strong>face`) and the exporter has to place both halves; and it is wider than a character on purpose, because everything inside a segment is the shaper's business rather than the browser's.
 *
 * Nothing here decides anything. It records the engine's positions, the shaper's glyphs, and — for the two questions the experiment exists to settle — both candidate baselines and the trailing-letter-spacing ratio, so the exit notes can quote numbers instead of a belief.
 *
 * @packageDocumentation
 */
import { shapeWord, upemOf } from '../fonts/hbShaper.ts';
import { instanceKeyOf, shaperVariations } from '../fonts/axisMap.ts';
import { COLUMN_WIDTH_PX } from '../coordinates/units.ts';
import { matchFace, requestFor, resolveWord } from '../fonts/fontResolve.ts';
import { apply } from '../coordinates/matrix.ts';
import { placeImage } from '../images/imagePlace.ts';
import { activeFrame, toLocal, toLocalOn, toLocalY } from '../coordinates/frame.ts';
import { beginChains, inverseRectOf, isIdentityMatrix } from '../coordinates/ctm.ts';
import { colorKey } from '../colour/colorHints.ts';
import { clusterMetrics, splitForRaster } from './emoji.ts';
import { CasterError } from '../errors.ts';
import { fontVariantTags } from './fontVariant.ts';

import type { CasterErrorContext } from '../errors.ts';
import type { Coords } from '../fonts/axisMap.ts';
import type { FaceDescriptor, FaceMatch, FaceRequest } from '../fonts/fontResolve.ts';
import type { Matrix, PlacedImage } from '../images/imagePlace.ts';
import type { PagedRect } from '../coordinates/frame.ts';
import type { ChainContext } from '../coordinates/ctm.ts';
import type { ElementColor, OverprintMode, ResolvedColor } from '../colour/colorHints.ts';
import type { TextDecoration } from '../vectors/cssBoxes.ts';
import type { SvgTextRequest } from '../vectors/svgGeometry.ts';
import type { ClipSpec, MeasuredVector, VectorRequest } from '../vectors/vector.ts';

/**
 * An image the caller wants placed, named by the element that owns its content item.
 *
 * @remarks
 * This is the shape `walkStructure` produces, narrowed to the four fields the measurement needs: the walker's own record carries the tag, the alt text and the source beside them, and the emitter reads those from the walker rather than having them copied through here.
 */
export type ImageRequest = {
  path: string;
  element: HTMLElement;
  /** Which CSS box the image fills; a background paints over the padding box. */
  box: 'content'|'padding';
};

/**
 * E12A (`images.md`): one grapheme cluster a colour face paints, measured but not shaped.
 *
 * @remarks
 * It is not a `MeasuredSegment` and never will be: a segment carries glyph ids and advances from the shaper, and a colour cluster has neither — the whole point is that no font program can show it. What it carries instead is the browser's own rectangle for the cluster and the metrics the canvas reports for the face that painted it, which is everything a raster needs to be placed exactly where the browser put the picture.
 */
export type MeasuredEmoji = {
  /** Index into `MeasureResult.emoji`, i.e. DOM order. */
  index: number;
  paragraph: number;
  block: string;
  /** Structure element that owns the cluster's marked content. */
  owner: string;
  /** Position among everything the emitter paints, shared with a paragraph's. */
  domIndex: number;
  paintIndex?: number;
  page: number;
  /** The cluster itself, which is also its `/ActualText`. */
  text: string;
  /** The element's computed font, which is what the canvas is handed. */
  fontString: string;
  sizePx: number;
  /** The Range rect, in the same page-local px every other measurement uses. */
  xPx: number;
  rightPx: number;
  topPx: number;
  heightPx: number;
  /** `topPx` plus the colour face's canvas ascent: the line's baseline. */
  baselinePx: number;
  /** The colour face's metrics at this size, as the canvas reports them. */
  ascentPx: number;
  descentPx: number;
  /** What the canvas's own advance said, beside the Range rect's width. */
  advancePx: number;
  /** The `font` the canvas ended up with; a refused family list shows up here. */
  usedFont: string;
  /** Index into `MeasureResult.lines` of the line the cluster sits on. */
  line: number;
  /** E10 (`coordinates-and-pages.md`): the chain the cluster's line carries, when it carries one. */
  chain?: Matrix;
};

/** The pixel size the file itself stores, and the orientation the browser already applied. */
export type ImageIntrinsics = {
  storedIntrinsic: [number, number];
  exifOrientation: number;
  /** DESIGN.md S80: the fit to place by, where the element is not a replaced element and its computed `object-fit` is not the truth. */
  objectFit?: string;
};

/**
 * How a caller names one block.
 *
 * @remarks
 * The harness's default reproduced the `[data-block]` fixture scheme of E3 (`text-emission.md`); it is dead in Caster, where `walkStructure` always names the blocks.
 */
export type DescribeBlock = (block: HTMLElement) => { block: string, path: string };

/** One measured block, as the emitter orders and tags it. */
export type MeasuredParagraph = {
  block: string;
  /** Stable path within the fixture, e.g. `[data-block="6"] p[2]`. */
  path: string;
  /** Structural path of the block element itself, e.g. `section[1]/p[2]`. */
  element: string;
  /** Position of the block among everything the emitter paints — blocks and paints together — in DOM order, so the two can be interleaved without the emitter re-deriving the order from the DOM it no longer holds. */
  domIndex: number;
  /** Position in CSS painting order, from the order walker of E9 (`vector-painting.md`). Absent under the `dom` painting order, which is every fixture before E9. */
  paintIndex?: number;
  text: string;
};
/** A rectangle the caller wants measured beside the text. */
export type PaintRequest = {
  /** Path of the artifact the rectangle belongs to. */
  path: string;
  element: HTMLElement;
  /** Fill colour, as PDF `rg` operands. */
  rgb: [number, number, number];
  /** The computed CSS colour `rgb` came from, for the E8b (`colour.md`) work list. */
  color?: string;
  /** E8 (`colour.md`): which paint of the element this rectangle is. */
  target?: 'background'|'border'|'fill';
  /** E8 (`colour.md`): the colour hint verbatim, as the computed style returned it. */
  hint?: string;
  /** E8 (`colour.md`): the hint parsed; absent means the RGB path. */
  colorHint?: ResolvedColor;
  /** E8 (`colour.md`): the overprint mode the element declared. */
  overprint?: OverprintMode;
};
/** A {@link PaintRequest}, measured into page-local px. */
export type MeasuredPaint = {
  path: string;
  /** Shared with MeasuredParagraph.domIndex; the emitter orders on it. */
  domIndex: number;
  /** E9 (`vector-painting.md`): position in CSS painting order, when the caller computed one. */
  paintIndex?: number;
  /** Column the rectangle landed in, i.e. the PDF page. */
  page: number;
  /** Left edge relative to the column. */
  xPx: number;
  /** Top edge relative to the container top. */
  yPx: number;
  wPx: number;
  hPx: number;
  rgb: [number, number, number];
  /** The computed CSS colour `rgb` came from, for the E8b (`colour.md`) work list. */
  color?: string;
  /** E8 (`colour.md`): which paint of the element this rectangle is. */
  target?: 'background'|'border'|'fill';
  /** E8 (`colour.md`): the colour hint verbatim. */
  hint?: string;
  /** E8 (`colour.md`): the hint parsed; absent means the RGB path. */
  colorHint?: ResolvedColor;
  /** E8 (`colour.md`): the overprint mode the element declared. */
  overprint?: OverprintMode;
};
/** An {@link ImageRequest}, placed. */
export type MeasuredImage = {
  index: number;
  path: string;
  /** Shared with MeasuredParagraph.domIndex; the emitter orders on it. */
  domIndex: number;
  /** E9 (`vector-painting.md`): position in CSS painting order, when the caller computed one. */
  paintIndex?: number;
  page: number;
  placement: PlacedImage;
};

/**
 * R5's clip on a page, in page-local px: the page box at the head and the cut at the foot.
 *
 * @property sliceTopPx - Set inside a painted slice's wrapper (`shell`), whose own `overflow-y: clip` is the head there (*the slice wrapper's clip*, DESIGN.md S69): the wrapper's top, page-local.
 */
export type PageClip = { topPx: number; bottomPx: number; sliceTopPx?: number };

/** Whether a rectangle lies above the head of `area`: wholly above the page box, or inside a slice and with its top above the wrapper's, because a rectangle belongs to the page that holds its top, as at the foot (*the slice wrapper's clip*, S69). */
export function aboveClip(area: PageClip, yPx: number, hPx: number): boolean {
  if (area.sliceTopPx !== undefined && yPx < area.sliceTopPx - 0.01) return true;
  return yPx + hPx <= area.topPx + 0.01;
}

/**
 * What a caller hands `measureText`; every member is optional, and each absent one reproduces the experiment that preceded it.
 *
 * @remarks
 * `clipToPage` is new in the port, and it is a rule rather than a convenience. Cicero presents a straddling block as its original on the page where it begins, with the tail laid out and clipped by `.content-area { overflow: clip }`, and as a continuation clone on the next page. Those clipped lines have real rectangles below the content area's bottom edge, and the printer would otherwise emit them below the page — measured on the specimen: 130 of 9454 words at y = −3.7, −15.4, −16.6 pt, every one of them a line whose own words are already on the next page inside the clone. They belong to the clone, and the clone emits them.
 *
 * The foot is `.flow`'s own clip edge and not `.content-area`'s, and the test is on the rectangle's top alone. `chase.js` says why in its own words: the clip boundary is the cut's extent, because "a cut line box can overflow contentH while its ink starts above it, and the print text layer keeps ink". Measured on the specimen: a line at 1026.42..1045.42 against a content-area bottom of 1031.78 is a line Cicero kept, so a printer that called that a straddle and refused would refuse the ordinary case. The head is the page box (*R5's head is the page box and its foot is the cut*, DESIGN.md S69): ink above the page area and inside the page box is ink the engine paints, and ink wholly above the page box is ink its page clips away.
 */
export type MeasureOptions = {
  /** Content-bearing block elements, in DOM order. Default: `[data-block] p`. */
  blocks?: HTMLElement[];
  /** Which CSS family a run's face is matched in. E3 (`text-emission.md`) and E5 (`structure-tree.md`) have exactly one family and name it; a fixture with a family per page reads it off the computed style, which is what the default cannot do. */
  familyOf?: (parent: Element, request: FaceRequest) => string;
  /** Told the family a run landed on, for the families in the stack it passed over to get there. */
  passedOver?: (parent: Element, request: FaceRequest, chosen: string) => void;
  /** The variable-font instance a run is painted at, from the computed style and the face's own axes. The default is no axes at all, which is every static face and is the whole world of E3 (`text-emission.md`) and E5 (`structure-tree.md`). */
  coordsOf?: (parent: Element, face: FaceDescriptor) => Coords;
  /** The structure element that owns text appearing directly inside `parent`, as an opaque key. Runs split where it changes, so a content item never spans two owners. Default: every segment has the same, empty, owner. */
  ownerOf?: (parent: Element) => string;
  /** Rectangles to measure beside the text, interleaved by DOM order. */
  paints?: PaintRequest[];
  /** Images to place beside the text, interleaved by DOM order. */
  images?: ImageRequest[];
  /** The stored pixel size and the EXIF orientation of one image. Neither can be read off the DOM: `naturalWidth` is the size *after* the engine applied the orientation, and a background has no intrinsic size in the DOM at all. Both come out of the file's own header, which the caller has already parsed. The default answers from the element, which is right for everything with orientation 1. */
  imageIntrinsicsOf?: (request: ImageRequest, index: number) => ImageIntrinsics;
  describe?: DescribeBlock;
  /** E8 (`colour.md`): the colour hint and the overprint mode an element declares. Runs split where either changes. The default is undefined, which is no hint anywhere and is what keeps the runs of E3 (`text-emission.md`), E4 (`font-embedding.md`) and E5 exactly as they were. */
  colorOf?: (parent: Element) => ElementColor;
  /** E8 (`colour.md`): rectangles the caller measured itself, merged into `paints` in DOM order. A hint-gated background or border is not an element the structure walker knows about, so it arrives already measured rather than as a request. */
  extraPaints?: MeasuredPaint[];
  /** E9 (`vector-painting.md`): vector items — CSS box decorations and inline SVG — measured beside the text and interleaved by DOM order. They arrive with their geometry already in page points, because only the browser can read a transform chain back. */
  vectors?: VectorRequest[];
  /** E9 (`vector-painting.md`): `<text>` inside an inline `<svg>`, routed into the same run emitter. */
  svgTexts?: SvgTextRequest[];
  /** E9 (`vector-painting.md`): where an element sits in CSS painting order. `decoration` is the element's own background and borders, `content` its text and images; the two are painted in different phases of the same stacking context, which is the whole reason the CSS order is not the DOM order. */
  paintIndexOf?: (element: Element, kind: 'decoration'|'content') => number|undefined;
  /** E9 (`vector-painting.md`): the `text-decoration` an element's text is painted with. Runs split on it. */
  decorationOf?: (parent: Element) => TextDecoration|undefined;
  /** *a rectangle belongs to the page its node was assigned to* (S27): which page the engine assigned a node to. A rect's page is the page of the node that owns it, and it is expressed against that page whatever viewport band it happens to fall in — because Cicero lays a straddling block's whole tail out on the page where it begins and only clips it visually, so line boxes belonging to page 3 have real rectangles inside the bands of pages 4, 5 and 6, and each continuation clone does the same again for the pages after it. Read by the rectangle's own origin, that tail was emitted on every one of those pages: the specimen's 2 521 source words printed as 7 616, page 4 alone carrying 2 611. Named by its owner instead, the tail is expressed against its own page, falls below that page's `.flow` bottom, and `clipToPage` drops it — which is what the clip of *R5's clip boundary is `.flow`, not `.content-area`* (S22) was always for and could not reach while the page was read off the rectangle. Absent, `toLocal`'s own rule answers and every earlier experiment is unchanged. */
  pageIndexOf?: (element: Element) => number;
  /** E10 (`coordinates-and-pages.md`): which page element a node belongs to, which is where an in-page CTM chain stops. Supplying it turns the chain builder on: every transformed ancestor is neutralised for the length of the measurement pass, every rect is read untransformed, and each segment, line and image carries the chain the emitter has to write as a `cm`. Absent, nothing is neutralised and nothing carries a chain, which is E3 (`text-emission.md`) through E9 (`vector-painting.md`) exactly as they were. */
  pageElementOf?: (element: Element) => HTMLElement|null;
  /** E12A (`images.md`): turn colour clusters into rasters rather than into glyphs. Absent — which is every fixture before E12 — nothing looks for a cluster and every character of every word goes to the shaper exactly as it did, which is what keeps E3 (`text-emission.md`) through E11 (`tables.md`) byte-identical. */
  emoji?: { rasterDpi: number };
  /** Run the baseline-probe pass. It inserts a zero-width `Range` and reads four rectangles per word, and everything it produces — `baselineProbePx`, `baselineAgreementPx`, `usableProbes`, the three probe flags — feeds the report and nothing else: a line's emitted baseline is `baselineAscentPx` from the colour face's own canvas ascent (`textEmit.js`'s `emitRun` reads `line.baselinePx`, and `linesOf` builds that from the ascent). It is the experiments' own cross-check of the two ways to find a baseline, and it is what a round arguing about baselines turns back on. Default off, which is what Caster runs. */
  probes?: boolean;
  /** R5: the page's own clip, in page-local px — the page box at the head, the cut at the foot (*R5's head is the page box and its foot is the cut*, DESIGN.md S69) — so a line the engine laid out and then clipped is dropped here rather than emitted below the page it overflows. */
  clipToPage?: (page: number, element: Element) => PageClip|null;
  /** An already-open chain builder, when the caller opened one itself. From the integration of E9 (`vector-painting.md`) and E10 (`coordinates-and-pages.md`) a vector pass runs *before* the text pass and has to read its rectangles in the same neutralised window: one `beginChains` for the whole export rather than one per module, because a second `beginChains` would capture the transforms the first one had already set to `none` and find no chain at all. The caller owns it; `end()` here is idempotent and restoring it twice is harmless. */
  chains?: ChainContext;
  /** The clips an element's overflow imposes on the text it holds, page-local and inside the element's chain (`textClips`, `vectors/cssBoxes.ts`). Absent, no text is clipped. Answers are kept per element and page, so a paragraph of many segments asks once. */
  clipsOf?: (parent: Element, page: number, chain: Matrix|null) => ClipSpec[];
};
/** One segment — a maximal run of non-whitespace in one text node — with the engine's rectangle and the shaper's glyphs. */
export type MeasuredSegment = {
  /** Index into MeasureResult.segments, i.e. DOM order. */
  index: number;
  /** Index into MeasureResult.paragraphs. */
  paragraph: number;
  block: string;
  /** MeasuredParagraph.path of the block the segment came from. */
  blockPath: string;
  /** Key of the structure element that owns this segment's marked content, as `ownerOf` returned it. Empty when the caller named no owners. */
  owner: string;
  /** Column the segment landed in, i.e. the PDF page. */
  page: number;
  text: string;
  /** Whether DOM whitespace separated this segment from the previous one. */
  spaceBefore: boolean;
  /** Whether DOM whitespace follows the segment. The engine shapes a whole line at once, so a word whose last glyph kerns against the following space — Inter kerns a comma against one by 51 units — measures narrower on screen than the same word shaped on its own, and a checker that compares the two has to shape the space too. */
  spaceAfter: boolean;
  /** FaceDescriptor.id chosen by matchFace. */
  faceId: string;
  /** Feature tags the segment was shaped with, from `font-variant-*`, `font-feature-settings` and letter-spacing. */
  features: string[];
  /** The variable-font instance the run is painted at; empty for a static face. */
  coords: Coords;
  /** `faceId` plus the coordinates: the key one embedded font program is built for. Equal to `faceId` whenever there are no axes, which is why E3 (`text-emission.md`) and E5 (`structure-tree.md`) see no change at all from this becoming the key. */
  instanceKey: string;
  /** Font URL, which is also the shaper's cache key. */
  url: string;
  sizePx: number;
  /** Computed colour, as `getComputedStyle` reports it. */
  color: string;
  /** The same colour as PDF `rg` operands. */
  rgb: [number, number, number];
  /** E8 (`colour.md`): the `--pdf-color` hint verbatim, as the computed style returned it. */
  hint?: string;
  /** E8 (`colour.md`): the hint parsed; absent means the segment is painted `rg`. */
  colorHint?: ResolvedColor;
  /** E8 (`colour.md`): the overprint mode the segment's element declared. */
  overprint?: OverprintMode;
  /** E9 (`vector-painting.md`): the element the text sits directly inside, for the decoration walker. */
  element?: Element;
  /** E9 (`vector-painting.md`): the `text-decoration` in force, propagation resolved. */
  decoration?: TextDecoration;
  letterSpacingPx: number;
  /** Left edge of the Range rect, relative to the column the segment is in. */
  xPx: number;
  /** Right edge of the same rect, relative to the column. */
  rightPx: number;
  /** Top of the same rect, relative to the container top. */
  topPx: number;
  /** Width of the same rect. Includes trailing letter-spacing if Blink adds it. */
  rectWidthPx: number;
  /** `topPx + measureText().fontBoundingBoxAscent`. */
  baselineAscentPx: number;
  /** Baseline from the probe placed after the segment's last character. */
  baselineProbePx: number;
  /** Baseline from the probe placed before the segment's first character, as the plan asks. */
  baselineProbeBeforePx: number;
  /** The working probe moved the segment; that voids its reading. */
  probeMoved: boolean;
  /** The working probe did not land on the segment's line; that voids its reading. */
  probeOffLine: boolean;
  /** The plan's placement did not land on the segment's line. */
  probeBeforeOffLine: boolean;
  gids: number[];
  /** Cluster value per glyph, as a UTF-16 offset into `text`. */
  clusters: number[];
  /** Advance per glyph, in font units, as the shaper positioned it. */
  advanceUnits: number[];
  upem: number;
  /** Σ advances at this size, in px. Carries kerning; carries no letter-spacing. */
  advanceWidthPx: number;
  /** E10 (`coordinates-and-pages.md`): the in-page CTM chain from the page element down to this segment, in page-local px. Absent when the chain is the identity, which is every segment of every fixture before E10. */
  chain?: Matrix;
  /** The clips the segment's element and its ancestors impose (`overflow: hidden`, `clip-path`), outermost first, in the space inside `chain`. Absent when there are none. */
  clips?: ClipSpec[];
  /** E10 (`coordinates-and-pages.md`): the same rectangle as the plan's other method recovers it — the painted bounding box mapped back through `chain⁻¹`. Present only for a segment that carries a chain. */
  inverseRectPx?: { xPx: number; yPx: number; wPx: number; hPx: number };
  /** E10 (`coordinates-and-pages.md`): the worst of the four differences between the two, in px. */
  inverseDeviationPx?: number;
};
/** Consecutive segments of one line that share everything a run of glyphs can carry. */
export type MeasuredRun = {
  index: number;
  /** The owner every segment of the run shares; runs split where it changes. */
  owner: string;
  faceId: string;
  /** The font resource the run is painted with; runs split where it changes. */
  instanceKey: string;
  coords: Coords;
  /** Feature tags every segment of the run shares; runs split where they change. */
  features: string[];
  url: string;
  sizePx: number;
  color: string;
  rgb: [number, number, number];
  /** E8 (`colour.md`): the `--pdf-color` hint verbatim, shared by every segment of the run. */
  hint?: string;
  /** E8 (`colour.md`): the hint parsed; absent means the run is painted `rg`. */
  colorHint?: ResolvedColor;
  /** E8 (`colour.md`): the overprint mode every segment of the run shares. */
  overprint?: OverprintMode;
  /** E9 (`vector-painting.md`): the element the run's text sits inside. */
  element?: Element;
  /** E9 (`vector-painting.md`): the `text-decoration` every segment of the run shares. */
  decoration?: TextDecoration;
  letterSpacingPx: number;
  segments: MeasuredSegment[];
};
/** One line of one paragraph, the unit a `cm` wraps. */
export type MeasuredLine = {
  paragraph: number;
  page: number;
  /** Grouping key: the baseline in px below the container top. */
  baselinePx: number;
  /** E10 (`coordinates-and-pages.md`): the chain every segment of the line shares. A line is the unit the `cm` wraps, because a `q`/`Q` pair may not straddle a `BT`/`ET`, so lines split where the chain changes as surely as runs split where the font does. */
  chain?: Matrix;
  /** The clips every segment of the line shares. A `q`/`Q` pair may not straddle a text object, so lines split where the clips change, as they do where the chain changes. */
  clips?: ClipSpec[];
  runs: MeasuredRun[];
};
/** One letter-spaced segment's evidence for whether Blink adds spacing after the last glyph. */
export type TrailingSample = {
  block: string;
  text: string;
  glyphs: number;
  letterSpacingPx: number;
  /** `(rectWidthPx − Σ advances) / letterSpacingPx`, unrounded. */
  ratio: number;
};
/** Everything one measurement pass produced. */
export type MeasureResult = {
  paragraphs: MeasuredParagraph[];
  segments: MeasuredSegment[];
  lines: MeasuredLine[];
  /** The requested rectangles, measured. Empty unless the caller asked for any. */
  paints: MeasuredPaint[];
  /** The requested images, placed. Empty unless the caller asked for any, and shorter than the request list when a picture fell inside a straddling block's clipped tail (*the raster half of a continuation's drawing*, S42) — each record carries its own request `index`, which is what a caller joins on; position no longer answers. */
  images: MeasuredImage[];
  /** E9 (`vector-painting.md`): the requested vectors, with the DOM index the emitter interleaves on. */
  vectors: MeasuredVector[];
  /** E12A (`images.md`): every colour cluster, in DOM order. Empty unless the caller asked. */
  emoji: MeasuredEmoji[];
  /** The embedded programs the document needs, in first-use order: one per `(face, coordinates)` pair. A document with no variable faces has exactly one entry per face and `instanceKey` equal to `faceId`. */
  usedInstances: { instanceKey: string; faceId: string; url: string; coords: Coords }[];
  pageCount: number;
  /** *the conservation of words* (S61): every text node a block's own walk reached and cut into words — what the conservation check reads, so that "the measurement was handed this text" is the measurement's own word. A node reached and then lawfully dropped (R5's clipped tail) is claimed; a node no block ever reached is not. */
  claimed: Set<Text>;
  containerScrollWidthPx: number;
  /** True when Blink adds letter-spacing after the last glyph of a run too. */
  trailingLetterSpacing: boolean;
  trailingSamples: TrailingSample[];
  /** max |baselineAscentPx − baselineProbePx| over every usable probe, in px. */
  baselineAgreementPx: number;
  /** Segments whose probe reading is evidence: it did not move them and it landed on their line. */
  usableProbes: number;
  /** Segments the probe insertion moved. */
  probeMovedCount: number;
  /** Segments no probe placement could measure. */
  probeOffLineCount: number;
  /** Segments the plan's probe placement — before the first character — could not measure. */
  probeBeforeOffLineCount: number;
};
/** A segment's characters, before anything is measured. */
export type RawSegment = {
  node: Text;
  start: number;
  end: number;
  spaceBefore: boolean;
  spaceAfter: boolean;
};
/** Both baseline probes' readings for one segment. */
export type ProbeReading = {
  /** Baseline read with the probe after the segment's last character. */
  afterPx: number;
  /** The segment moved while that probe was in; the reading is not evidence. */
  afterMoved: boolean;
  /** That probe did not land on the segment's line; the reading is not evidence. */
  afterOffLine: boolean;
  /** Baseline read with the probe before the segment's first character. */
  beforePx: number;
  beforeMoved: boolean;
  beforeOffLine: boolean;
};

/**
 * Feature tags handed to the shaper for a letter-spaced run.
 *
 * @remarks
 * Blink turns the ligature features off as soon as `letter-spacing` is non-zero, so a shaper that left them on would produce glyphs the browser never drew.
 */
export const LETTER_SPACED_FEATURES = ['-liga', '-clig', '-calt', '-dlig'];
/**
 * `"ss01"` and `"smcp", "c2sc"` as the computed style spells them, turned into the tags the shaper takes.
 *
 * @remarks
 * Blink applies `font-feature-settings` and a shaper that did not would produce different glyphs from the ones on the screen — a different ligature, a different alternate, or a small capital that is not there. A value of `1` or a missing value is the tag on; `0` is `-tag`, which is what `hb_feature_from_string` reads as "off".
 */
export function cssFeatureTags(value: string): string[] {
    if (!value || value === 'normal')
        return [];
    const tags: string[] = [];
    for (const match of value.matchAll(/["']([A-Za-z0-9 ]{4})["'](?:\s+(on|off|\d+))?/g)) {
        const setting = match[2];
        const off = setting === 'off' || setting === '0';
        tags.push(`${off ? '-' : ''}${match[1]}`);
    }
    return tags;
}
/**
 * Every feature tag one run is shaped with: the `font-variant-*` features, then `font-feature-settings`, then the letter-spacing rule of E3 (`text-emission.md`).
 *
 * @remarks
 * The order is CSS Fonts 4's: `font-feature-settings` is applied after the `font-variant-*` longhands and overrides them, so a `font-feature-settings: "liga" 1` beside `font-variant-ligatures: none` shapes with the ligature on. HarfBuzz applies the tags in order and the later one wins, which is why the tags are concatenated in this order rather than merged. The letter-spacing tags come last, as they always have.
 *
 * @param context - The element the style belongs to, handed to a `font-variant-*` refusal.
 * @throws {CasterError} A `font-variant-*` value with no feature mapping (see fontVariant.js).
 */
export function featureTagsFor(style: CSSStyleDeclaration, letterSpacingPx: number, context: CasterErrorContext = {}): string[] {
    const tags = [...fontVariantTags(style, context), ...cssFeatureTags(style.getPropertyValue('font-feature-settings'))];
    return letterSpacingPx === 0 ? tags : [...tags, ...LETTER_SPACED_FEATURES];
}
/** Per face URL, whether shaping with `smcp` changes any glyph of a lowercase sample. */
const SMALL_CAPS_OF = new Map<string, boolean>();

/** Lowercase letters a face with small capitals substitutes, which is what `smcp` covers. */
const SMALL_CAPS_SAMPLE = 'abcdefghijklmnopqrstuvwxyz';

/**
 * Refuses a run that asks for small capitals from a face without them.
 *
 * @remarks
 * Blink synthesises small capitals for a face with no `smcp` (scaled capitals) and HarfBuzz does not, so the file would print the lowercase letters the screen does not show (*`font-variant-*` is read, and a value with no feature is refused by name*, S73). The face lacks the feature when a lowercase sample shapes to the same glyphs with the tag and without it. A run with no lowercase letter prints the same either way and passes.
 *
 * @throws {CasterError} The run asks for `smcp`, holds a lowercase letter, and the face has no small capitals.
 */
function refuseMissingSmallCaps(face: FaceDescriptor, features: readonly string[], text: string, context: CasterErrorContext): void {
    if (!features.includes('smcp') || !/\p{Ll}/u.test(text)) return;
    let has = SMALL_CAPS_OF.get(face.url);
    if (has === undefined) {
        const plain = shapeWord(face.url, SMALL_CAPS_SAMPLE, 100, []).gids;
        const caps = shapeWord(face.url, SMALL_CAPS_SAMPLE, 100, ['smcp']).gids;
        has = plain.length !== caps.length || plain.some((gid, i) => gid !== caps[i]);
        SMALL_CAPS_OF.set(face.url, has);
    }
    if (!has) throw new CasterError(`caster: ${JSON.stringify(text)} at ${context.element ?? 'an element'} asks for small capitals (smcp) from the face ${face.id} of "${face.family}", which has none. The screen fakes them with scaled capitals and the printer does not, so the PDF would print lowercase. Use a face of the family that has small capitals, or write the text in capitals.`, context);
}

/**
 * How far a colour cluster's baseline may sit from its line's, in px.
 *
 * @remarks
 * The two are computed differently — the line's from the text face's canvas ascent, the cluster's from the colour face's — so they agree to within the rounding of two font metrics rather than exactly. A whole pixel is far more than that and far less than a line.
 */
const BASELINE_TOLERANCE_PX = 1;
/**
 * `rgb(204, 0, 0)` and friends, as PDF `rg` operands.
 *
 * @throws {CasterError} The string holds fewer than three numbers.
 */
function parseRgb(color: string): [number,number,number] {
    const numbers = color.match(/[\d.]+/g);
    if (!numbers || numbers.length < 3)
        throw new CasterError(`caster: cannot parse colour ${color}`);
    return [Number(numbers[0]) / 255, Number(numbers[1]) / 255, Number(numbers[2]) / 255];
}
const ascentCache = new Map<any, any>();
/**
 * The ascent Chromium lays text out with, read through the canvas.
 *
 * @remarks
 * Blink's SimpleFontData rounds the face's ascent to whole pixels and canvas `measureText` reads the same object, which is why this is expected to be the same number the DOM probe finds. It is the exporter's baseline source; the probe is measured beside it so the experiment can say whether that holds.
 *
 * @throws {CasterError} No 2d context, a font string the canvas rejects, or no `fontBoundingBoxAscent`.
 */
function ascentPx(fontString: string): number {
    const hit = ascentCache.get(fontString);
    if (hit !== undefined)
        return hit;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx)
        throw new CasterError('caster: 2d canvas context unavailable');
    ctx.font = fontString;
    if (ctx.font === '')
        throw new CasterError(`caster: canvas rejected the font string ${fontString}`);
    const ascent = ctx.measureText('Hxg').fontBoundingBoxAscent;
    if (typeof ascent !== 'number' || Number.isNaN(ascent)) {
        throw new CasterError(`caster: fontBoundingBoxAscent unavailable for ${fontString}`);
    }
    ascentCache.set(fontString, ascent);
    return ascent;
}
/**
 * Every non-whitespace run of a paragraph, in DOM order.
 *
 * @remarks
 * `\s` includes U+00A0, so a non-breaking space separates two segments exactly like an ordinary space does, which is what the emission model wants: both become one space glyph. Whitespace that ends a text node counts as whitespace before the first segment of the next one.
 *
 * @param blockSet - Every block in the pass, so the walk can stop at a descendant that is one (*a block inside a block is measured once under its nearest owner*, S28).
 */
function rawSegments(p: HTMLElement, blockSet?: Set<Element>): RawSegment[] {
    const out: RawSegment[] = [];
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let pendingSpace = false;
    /** Is this text node's nearest enclosing block someone else (*a block inside a block is measured once under its nearest owner*, S28)? A block inside a block — a nested list, a loose `<li><p>`, a `<figcaption>`, a KaTeX span inside a paragraph — is measured under itself, so the outer block's walk stops at its edge. Without this the same characters are measured twice, once under each, and `origins` and `segments` lose the lockstep the probe pass reads them in. */
    const belongsToAnother = ( node: Node) => {
        if (!blockSet) return false;
        for (let el = node.parentElement; el && el !== p; el = el.parentElement) if (blockSet.has(el)) return true;
        return false;
    };
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (belongsToAnother(node)) continue;
        // Text inside an `<svg>` is SVG's own, and never this walk's. A `<text>` element is measured by `measureSvgText` from `getStartPositionOfChar`, because SVG positions characters rather than lines and no `Range` rectangle means anything there; a `<title>` is not rendered at all, so a Range over it produces no rect and the segment loop below refuses by name. The harness never met either case because its inline `<svg>` did not sit inside a measured block — BelType's belt wraps one in a `<p>` — and the refusal it produced (`no rect for "Two"`, the first word of a `<title>`) is exactly the shape a silent guess would have hidden.
        if (node.parentElement?.closest('svg')) continue;
        // KaTeX writes the formula twice, and only one of the two is painted (beltype#25). `<span class="katex-mathml">` holds a `<math>` for a reader that speaks MathML and the author's own TeX inside `<annotation encoding="application/x-tex">`; `<span class="katex-html">` holds the positioned spans the eye sees. KaTeX's own sheet hides the first half at `clip: rect(1px,1px,1px,1px)` with `position: absolute` and a width and height of one pixel, which is not `display: none` — so its `<math>` glyph text does produce rectangles, and a walk that measured it painted ghost glyphs in a family (`math`, from the MathML Core UA sheet) no document supplies bytes for, while the annotation's TeX source produced no rectangle at all and refused by name. The whole subtree is skipped, which is the same rule `structure.js` already applies from the other side: the `.katex` span is one `Formula` whose `/Alt` is that annotation, and the glyphs that are measured and painted are the `.katex-html` half.
        if (node.parentElement?.closest('.katex-mathml')) continue;
        // Text that is not shown is no word of the page: under `display: none` or `hidden` it has no box, and under `visibility: hidden` its box paints nothing (codeberg.org/BelType/caster issues 16 and 17). The browser answers for the whole ancestry, and a `visibility: visible` child of a hidden parent is shown again, as the census in `conservation.ts` reads it.
        if (!node.parentElement?.checkVisibility({ visibilityProperty: true })) continue;
        const text = (node as Text).data;
        let last = 0;
        for (const match of text.matchAll(/\S+/g)) {
            const start = match.index;
            out.push({ node: (node as Text), start: (start as number), end: (start as number) + match[0].length, spaceBefore: pendingSpace || start > last, spaceAfter: false });
            pendingSpace = false;
            last = start + match[0].length;
        }
        if (last < text.length)
            pendingSpace = true;
    }
    // What follows a segment matters as much as what precedes it: the engine shapes the whole line, so a word whose last glyph kerns against the following space is *narrower* on screen than the same word shaped alone.
    out.forEach((item, index) => {
        item.spaceAfter = index + 1 < out.length ? out[index + 1].spaceBefore : pendingSpace;
    });
    return out;
}
/**
 * `text-transform`, applied to the string the shaper is given.
 *
 * @remarks
 * The browser transforms at layout: the text node still holds `Motore` while the box shows `MOTORE`, so a `Range` over it measures the uppercase width and the shaped string is the lowercase one. That mismatch is invisible in every width assertion — the rectangles are right — and shows up only as the wrong letters on the page, which is the same failure mode the shaper's own fallback refusal exists to prevent (*the capability registry never falls back*, S6). Measured on a `<th>` declaring `text-transform: uppercase`, whose header row printed in lower case.
 *
 * `capitalize` needs to know it is looking at a word start, because a word split across two rectangles arrives here as two pieces and only the first of them begins one. The exotic values are refused by name rather than ignored: a printer that silently dropped `full-width` would ship a document nobody could tell was wrong.
 *
 * @param wordStart - Whether this string begins a `\S+` run — what CSS means by a word for `capitalize`.
 * @throws {CasterError} A `text-transform` other than `none`, `uppercase`, `lowercase` or `capitalize`.
 */
function transformCase(text: string, style: CSSStyleDeclaration, domPath: string, wordStart: boolean): string {
    const transform = style.textTransform;
    if (transform === 'none' || !transform) return text;
    if (transform === 'uppercase') return text.toUpperCase();
    if (transform === 'lowercase') return text.toLowerCase();
    // The first letter, not the first character: CSS Text 3 §2.1.1 titlecases the first typographic letter unit of each word, and a word beginning with an apostrophe or an opening bracket still has one. Anchoring on `\p{Alphabetic}` alone left `'hello` and `(hello` untouched.
    if (transform === 'capitalize') return wordStart ? text.replace(/^\P{Alphabetic}*\p{Alphabetic}/u, (c) => c.toUpperCase()) : text;
    throw new CasterError(`caster: text-transform: ${transform} on ${domPath} is not one this printer can apply. It transforms at layout, so the shaped string would be the untransformed one and the page would show the wrong letters at the right widths.`, { element: domPath });
}
/** Rects of [start, end) in one text node, with the empty ones dropped. */
function rectsOf(node: Text, start: number, end: number): DOMRect[] {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    return Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
}
/**
 * Split a segment that produced more than one rect at the character where the next rect starts.
 *
 * @remarks
 * Each returned piece is one line's worth of characters, so a word the line breaker divided is drawn in two pieces, each at its own place.
 *
 * Blink's own hyphenation (`hyphens: auto`, or a soft hyphen it breaks at) draws a hyphen that is in no text node, and reports its box inside the rects of both characters around the break: `tem‐` / `perature` answers the hyphen's box for `m` after its glyph and for `p` before its glyph. Each character is therefore placed by the rects that are its alone, and a box the two share is the hyphen: it joins the piece before the break, which is marked `hyphen` so the drawing can add the glyph (measured 2026-10-30 on Chromium 153, `hyphens: auto` in a 46 mm column).
 */
function splitByRect(node: Text, start: number, end: number) {
    const pieces: { start: number; end: number; rect: DOMRect; hyphen: boolean; }[] = [];
    const rects = Array.from({ length: end - start }, (_, k) => rectsOf(node, start + k, start + k + 1));
    const shared = (a: DOMRect[] | undefined, b: DOMRect[] | undefined) => (a && b ? a.find((r) => b.some((q) => sameRect(r, q) && Math.abs(r.width - q.width) <= 0.05)) : undefined);
    let pieceStart = start;
    let pieceRect: DOMRect|null = null;
    const union = (a: DOMRect, b: DOMRect) => new DOMRect(Math.min(a.left, b.left), a.top, Math.max(a.right, b.right) - Math.min(a.left, b.left), a.height);
    for (let i = start; i < end; i++) {
        const own = rects[i - start] ?? [];
        const before = shared(rects[i - start - 1], own);
        const after = shared(own, rects[i - start + 1]);
        const rect = own.find((r) => r !== before && r !== after && !(before && sameRect(r, before)) && !(after && sameRect(r, after))) ?? own[0];
        if (!rect)
            continue;
        if (pieceRect && Math.abs(rect.top - pieceRect.top) > 0.5) {
            const hyphen = shared(rects[i - start - 1], own);
            pieces.push({ start: pieceStart, end: i, rect: hyphen && Math.abs(hyphen.top - pieceRect.top) <= 0.5 ? union(pieceRect, hyphen) : pieceRect, hyphen: Boolean(hyphen) });
            pieceStart = i;
            pieceRect = rect;
            continue;
        }
        pieceRect = pieceRect ? union(pieceRect, rect) : rect;
    }
    if (pieceRect)
        pieces.push({ start: pieceStart, end, rect: pieceRect, hyphen: false });
    return pieces;
}
/**
 * The character Blink draws where it hyphenates a word in `element`: `hyphenate-character`, whose `auto` is U+2010.
 *
 * @remarks
 * Blink draws U+2010 for `auto` when the face has it and U+002D otherwise; the caller shapes the first and falls back to the second on a missing glyph.
 */
function hyphenateCharacterOf(element: Element): string {
    const value = (getComputedStyle(element).hyphenateCharacter || 'auto').trim();
    if (value === 'auto' || value === '') return '\u2010';
    const quoted = /^(["'])(.*)\1$/.exec(value);
    return quoted ? (quoted[2] ?? '') : value;
}
/** A zero-size inline-block whose bottom margin edge is the baseline of its line. */
function baselineProbeElement(): HTMLElement {
    const probe = document.createElement('span');
    probe.style.cssText =
        'display:inline-block;width:0;height:0;vertical-align:baseline;font-size:0;line-height:0;margin:0;padding:0;border:0';
    return probe;
}
function insertProbeAt(node: Text, offset: number): HTMLElement {
    const probe = baselineProbeElement();
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    range.insertNode(probe);
    return probe;
}
const sameRect = (a: DOMRect|undefined, b: DOMRect): boolean => a !== undefined && Math.abs(a.left - b.left) <= 0.05 && Math.abs(a.top - b.top) <= 0.05;
/** The probe landed on the segment's own line when its baseline is inside the segment's rect. */
const onOwnLine = (baselinePx: number, expected: DOMRect): boolean => baselinePx >= expected.top - 0.05 && baselinePx <= expected.bottom + 0.05;
/**
 * Both baseline probes for one segment.
 *
 * @remarks
 * The plan's placement is before the segment's first character. That placement is wrong for the first segment of a wrapped line: the break opportunity is the collapsed space that ended the previous line, so a zero-width inline block put in front of the segment stays at the end of *that* line and reports its baseline. The placement that works is after the segment's last character, where the probe is inside the line by construction. Both are read and both are recorded, because which one is right is one of the questions of E3 (`text-emission.md`).
 *
 * `Range.insertNode` splits the text node, so the probe after the last character is taken first: it truncates the node at the segment's end, which leaves every offset at or before the segment's start still valid. Segments are walked in reverse document order for the same reason.
 */
function probeSegment(node: Text, start: number, end: number, expected: DOMRect) {
    const length = end - start;
    const probeAfter = insertProbeAt(node, end);
    const afterPx = probeAfter.getBoundingClientRect().bottom;
    const afterMoved = !sameRect(rectsOf(node, start, end)[0], expected);
    probeAfter.remove();
    const probeBefore = insertProbeAt(node, start);
    const beforePx = probeBefore.getBoundingClientRect().bottom;
    const tail = probeBefore.nextSibling instanceof Text ? probeBefore.nextSibling : null;
    const beforeMoved = !tail || !sameRect(rectsOf(tail, 0, length)[0], expected);
    probeBefore.remove();
    return {
        afterPx,
        afterMoved,
        afterOffLine: !onOwnLine(afterPx, expected),
        beforePx,
        beforeMoved,
        beforeOffLine: !onOwnLine(beforePx, expected),
    };
}
/** The space glyph of one instance of one face under one feature set, shaped once. */
const spaceCache = new Map<any, any>();
/**
 * The space glyph of one face instance under one feature set, from {@link spaceCache}.
 *
 * @throws {CasterError} The space shapes to anything but one glyph.
 */
export function spaceGlyph(url: string, features: string[], coords: Coords = {}) {
    const variations = shaperVariations(coords);
    const key = `${url}|${features.join(',')}|${variations ? JSON.stringify(variations) : ''}`;
    const hit = spaceCache.get(key);
    if (hit)
        return hit;
    const run = shapeWord(url, ' ', 100, features, undefined, variations);
    if (run.gids.length !== 1)
        throw new CasterError(`caster: the space of ${url} shaped to ${run.gids.length} glyphs`);
    const glyph = { gid: run.gids[0], advanceUnits: run.advances[0] };
    spaceCache.set(key, glyph);
    return glyph;
}
/** The default block set and naming: the `[data-block] p` of E3 (`text-emission.md`), described by its section. */
function defaultBlocks(container: HTMLElement): HTMLElement[] {
    return [...(container.querySelectorAll('[data-block] p') as NodeListOf<HTMLElement>)].map((el) => (el as HTMLElement));
}
/**
 * The default naming: a block by its `[data-block]` section and its ordinal there.
 *
 * @throws {CasterError} The block sits in no `[data-block]` section.
 */
function defaultDescribe(block: HTMLElement): { block: string; path: string; } {
    const section = ((block.closest('[data-block]') as HTMLElement|null) as HTMLElement|null);
    if (!section)
        throw new CasterError('caster: a default block outside any [data-block] section');
    const name = (section.dataset.block as string);
    const indexInBlock = [...section.querySelectorAll('p')].indexOf((block as HTMLParagraphElement));
    return { block: name, path: `[data-block="${name}"] p[${indexInBlock}]` };
}
/** The addresses held for the export that is running — module-scope state, made safe by `precheck.js`'s lock as `coordinates/frame.js`'s frame is. Per container, each element's address; and each element's same-tag ordinal among its siblings, counted once per parent. */
let held: { paths: Map<Element,Map<Element,string>>; ordinals: Map<Element,number>; }|null = null;
/**
 * Hold every address `domPathOf` answers until `releaseDomPaths`.
 *
 * @remarks
 * Only for a stretch in which no element is added, removed or moved under the container, since a held address is the one the element had when it was first asked for. `print()` holds them over the walk, which writes nothing, and again from the paint order to its end, after the last write to the tree (`inlineSvgImages`).
 *
 * Measured 2026-10-29 on the manual (304 pages), under the DevTools profiler: unheld, `domPathOf` was 51.9 s of the 64.4 s of JavaScript in `print()`, because every call copied and filtered the children of every ancestor up to the strip, and the paint order, `colorOf` and the collectors call it per element, per run and per box.
 */
export function holdDomPaths() { held = { paths: new Map<any, any>(), ordinals: new Map<any, any>() }; }
/** Drop the held addresses, so the next call counts the siblings again. */
export function releaseDomPaths() { held = null; }
/** `section[1]/p[2]`: tag names and same-tag ordinals from the container down. */
export function domPathOf(element: Element, container: Element): string {
    if (held) return heldPathOf(element, container, held);
    const parts: string[] = [];
    let node: Element|null = element;
    for (; node && node !== container; node = node.parentElement) {
        const parent: Element|null = node.parentElement;
        const tag = node.tagName.toLowerCase();
        const index = parent ? [...parent.children].filter((c) => c.tagName === (node as Element).tagName).indexOf((node as Element)) : 0;
        parts.unshift(`${tag}[${index}]`);
    }
    return parts.join('/');
}
/** `domPathOf`'s answer from the held addresses: up to the nearest ancestor already answered, then down again, recording each step. */
function heldPathOf(element: Element, container: Element, cache: NonNullable<typeof held>): string {
    let paths = cache.paths.get(container);
    if (!paths) cache.paths.set(container, (paths = new Map<any, any>()));
    const climbed: Element[] = [];
    let path = '';
    for (let node = (element as Element|null); node && node !== container; node = node.parentElement) {
        const known = paths.get(node);
        if (known !== undefined) { path = known; break; }
        climbed.push(node);
    }
    for (let i = climbed.length - 1; i >= 0; i--) {
        const node = climbed[i];
        const step = `${node.tagName.toLowerCase()}[${ordinalOf(node, cache.ordinals)}]`;
        path = path === '' ? step : `${path}/${step}`;
        paths.set(node, path);
    }
    return path;
}
/** An element's index among its parent's children of the same tag, counted for all of them at once; 0 for an element with no parent, as `domPathOf` answers. */
function ordinalOf(node: Element, ordinals: Map<Element,number>): number {
    const known = ordinals.get(node);
    if (known !== undefined) return known;
    const parent = node.parentElement;
    if (!parent) return 0;
    const counts: Map<string,number> = new Map<any, any>();
    for (const child of parent.children) {
        const n = counts.get(child.tagName) ?? 0;
        ordinals.set(child, n);
        counts.set(child.tagName, n + 1);
    }
    return (ordinals.get(node) as number);
}
/**
 * Which page a rect landed in, and where it sits inside it.
 *
 * @remarks
 * The one hub every coordinate in the exporter goes through. With the container frame of E10 (`coordinates-and-pages.md`) installed the page is the page element whose x-range the rect falls in and the coordinates are the rect's offset from that page's own top-left divided by the recovered container scale; with no frame it is the column rule of E3 (`text-emission.md`) against the container's top-left, unchanged, which is what keeps every earlier experiment's output byte-identical.
 *
 * A caller that knows which page the node was assigned to names it (*a rectangle belongs to the page its node was assigned to*, S27), and the rectangle is expressed against that page rather than against whichever band it fell in. With no page named the rectangle's own origin decides, which is E10 (`coordinates-and-pages.md`) unchanged.
 */
export function pageRectOf(rect: DOMRect, containerRect: DOMRect, page: number|null = null): PagedRect {
    const local = page === null ? toLocal(rect) : toLocalOn(rect, page);
    if (local)
        return local;
    const column = Math.max(0, Math.floor((rect.left - containerRect.left) / COLUMN_WIDTH_PX));
    return {
        page: column,
        xPx: rect.left - containerRect.left - column * COLUMN_WIDTH_PX,
        yPx: rect.top - containerRect.top,
        wPx: rect.width,
        hPx: rect.height,
    };
}
/**
 * Document order over the elements the emitter paints: blocks and paints together.
 *
 * @remarks
 * Exported because the hint-gated box paints of E8 (`colour.md`) arrive already measured and have to carry an index on this same scale — half a step before the block they belong to — so a background is painted before the text that sits on it. A caller that hands in the same element set gets the same numbering.
 *
 * @throws {CasterError} An element is not inside the container.
 */
export function domOrderOf(container: HTMLElement, elements: Element[]): Map<Element,number> {
    const wanted = new Set(elements);
    const order: Map<Element,number> = new Map<any, any>();
    let next = 0;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
    if (wanted.has(container))
        order.set(container, next++);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (wanted.has((node as Element)))
            order.set((node as Element), next++);
    }
    for (const element of elements) {
        if (!order.has(element))
            throw new CasterError('caster: an element to measure is not inside the container');
    }
    return order;
}
/**
 * Measure the rendered container.
 *
 * @remarks
 * Two passes, because the second one mutates: everything positional is read first, then the probes are inserted one at a time in reverse order and removed again.
 *
 * E3 (`text-emission.md`) calls this with no options at all and gets E3's behaviour: every `p` inside a `[data-block]`, one nameless owner, no paints. E5 (`structure-tree.md`) hands it the structure walker's block list, the walker's owner function and the rectangles the walker wants filled, and nothing else about the measurement changes.
 *
 * @throws {CasterError} Whatever the measurement cannot place, by name: no face in a family matches a run, a cluster no face in the stack covers (D2), a face that would need synthesis, a word or colour cluster with no rectangle, a colour cluster on no line, letter-spaced segments that disagree on the trailing spacing, an image with no intrinsic size, an SVG `<text>` whose characters do not count out, an unsupported `text-transform`.
 */
export function measureText(container: HTMLElement, table: FaceDescriptor[], options: MeasureOptions = {}): MeasureResult {
    const containerRect = container.getBoundingClientRect();
    const blocks = options.blocks ?? defaultBlocks(container);
    const describe = options.describe ?? defaultDescribe;
    const ownerOf = options.ownerOf ?? (() => '');
    /**
     * R5's clip: is this rectangle at or below the cut, and therefore the continuation clone's rather than this page's, or wholly above the page box, where the page's own clip hides it (*R5's head is the page box and its foot is the cut*, S69)?
     *
     * @param element - The element the rectangle belongs to, which is how the caller exempts margin content (*the margins are lifted into the light DOM*, S57).
     */
    const clipped = (page: number, topPx: number, heightPx: number, element: Element) => {
        const area = options.clipToPage?.(page, element);
        if (!area) return false;
        const bottomPx = topPx + heightPx;
        // The test is on the rectangle's top alone, and that is the engine's own rule rather than a tolerance. `chase.js`'s `setFlow`: the clip boundary is the cut's extent, and "a cut line box can overflow contentH while its ink starts above it, and the print text layer keeps ink". A line whose top is above the cut is a line the engine kept, whatever its box does below; a line whose top is at or below it is the continuation clone's, and the clone emits it.
        if (topPx >= area.bottomPx - 0.01) return true;
        if (aboveClip(area, topPx, heightPx)) return true;   // wholly above the page box, which the page's own clip hides (*R5's head is the page box and its foot is the cut*, S69)
        return false;
    };
    const familyOf = options.familyOf ?? (( parent: Element,  request: FaceRequest) => request.families[0] ?? getComputedStyle(parent).fontFamily);
    const coordsOf = options.coordsOf ?? (() => ({}));
    const paintRequests = options.paints ?? [];
    const imageRequests = options.images ?? [];
    const imageIntrinsicsOf = options.imageIntrinsicsOf ?? defaultIntrinsics;
    const vectorRequests = options.vectors ?? [];
    const svgTextRequests = options.svgTexts ?? [];
    const paintIndexOf = options.paintIndexOf ?? (() => undefined);
    const pageIndexOf = options.pageIndexOf ?? null;
    /** The whole block set, so a block's text walk can stop at a descendant block (*a block inside a block is measured once under its nearest owner*, S28). */
    const blockSet = new Set(blocks);
    /** `domPathOf` walks to the container and builds a string per call, and it was being called once per word and once per piece — for a message that is only ever read when something throws. One answer per element. */
    const pathCache: Map<Element,string> = new Map<any, any>();
    const pathOf = (element: Element) => {
        let path = pathCache.get(element);
        if (path === undefined) { path = domPathOf((element as HTMLElement), container); pathCache.set(element, path); }
        return path;
    };
    /**
     * CSS font fallback, per grapheme cluster, and only where it is needed (*BelType ships faces of its own, and WOFF2 is decoded*, S46).
     *
     * @remarks
     * The gate is the shape itself, and that is what keeps this free. `resolveWord` asks the shaper about every cluster separately, which is the right question and the wrong cost to pay on every word of a 130-page document. So the primary face shapes the whole word once — the same call the segment below makes anyway, one font object already cached — and a word with no `.notdef` in it is one part, the primary's, which is byte-for-byte what this loop did before. Only a word that actually fell through goes down the walk. That is also exactly Blink's own rule: fallback happens on a missing glyph, never speculatively.
     *
     * A run the walk could not place is D2's refusal, raised here rather than three modules later at `buildToUnicode`, because here the element and the cluster are both in hand and there the file is already half written.
     */
    const fallbackParts = (part: { start: number; end: number; emoji: boolean; text: string; }, parent: Element, request: FaceRequest, primary: FaceMatch, primaryCoords: Coords, sizePx: number, features: string[]) => {
        const whole = [{ ...part, match: primary, coords: primaryCoords }];
        if (part.text === '') return whole;
        if (!shapeWord(primary.face.url, part.text, sizePx, features, undefined, shaperVariations(primaryCoords)).gids.includes(0)) return whole;
        const resolved = resolveWord(part.text, request, table, sizePx);
        return resolved.runs.map((run) => {
            const descriptor = run.face === null ? null : table.find((d) => d.id === run.face);
            if (descriptor) options.passedOver?.(parent, request, descriptor.family);
            const match = descriptor ? matchFace(table, descriptor.family, request) : null;
            if (!match) {
                const clusters = [...run.text].map((ch) => 'U+' + ((ch.codePointAt(0) as number)).toString(16).toUpperCase().padStart(4, '0')).join(' ');
                throw new CasterError(`caster: no face in ${JSON.stringify(request.families.join(', '))} covers ${JSON.stringify(run.text)} (${clusters}) at ${pathOf(parent)} — the printer embeds font PROGRAMS, so every cluster has to reach a family the document declares an @font-face for, and this stack fell through to the generic. ${resolved.errors.map((e) => e.reason).join('; ')}`, { element: pathOf(parent) });
            }
            return {
                start: part.start + run.charRange[0],
                end: part.start + run.charRange[1],
                emoji: false,
                text: run.text,
                match,
                coords: coordsOf(parent, match.face)
            };
        });
    };
    /** The page a node was assigned to (*a rectangle belongs to the page its node was assigned to*, S27), or null where the caller named none and the rectangle's own origin decides. */
    const ownedPage = (element: Element) => (pageIndexOf ? pageIndexOf(element) : null);
    /** The one conversion every rectangle in this pass goes through. */
    const localOf = (rect: DOMRect, page: number|null) => (page === null ? toLocal(rect) : toLocalOn(rect, page));
    const domIndexOf = domOrderOf(container, [
        ...blocks,
        ...paintRequests.map((p) => p.element),
        ...imageRequests.map((i) => i.element),
        ...vectorRequests.map((v) => v.element),
        ...svgTextRequests.map((t) => t.element),
    ]);
    // E10 (`coordinates-and-pages.md`): the in-page transforms come off for the whole pass. Layout is unaffected by a transform, so the document underneath is the same document; what changes is that every rectangle read from here to `chains.end()` is the untransformed geometry a CTM chain is expressed against, instead of the axis-aligned box around a rotation.
    const chains: ChainContext|null = options.chains ?? (options.pageElementOf ? beginChains(container, options.pageElementOf) : null);
    const paragraphs: MeasuredParagraph[] = [];
    const segments: MeasuredSegment[] = [];
    /** E12A (`images.md`): the colour clusters, collected in the same pass as the words. */
    const emoji: MeasuredEmoji[] = [];
    const usedInstances = new Map<any, any>();
    const claimed: Set<Text> = new Set<any>();
    /** Where each segment's characters live, kept beside the serialisable record. */
    const origins: { node: Text; start: number; end: number; rect: DOMRect; segment: number; }[] = [];
    /** E10 (`coordinates-and-pages.md`): each segment's untransformed rect height, for the inverse comparison. */
    const neutralHeightPx: number[] = [];
    /** The segments that end in a hyphen Blink drew: its hyphen is the last glyph and carries no letter-spacing, so it is no part of the trailing-spacing vote. */
    const hyphenated = new Set<number>();
    const clipMemo = new Map<Element, Map<number, ClipSpec[]>>();
    const clipsOfCached = (parent: Element, page: number, chain: Matrix|null): ClipSpec[] => {
        let byPage = clipMemo.get(parent);
        if (!byPage)
            clipMemo.set(parent, byPage = new Map());
        let clips = byPage.get(page);
        if (!clips)
            byPage.set(page, clips = (options.clipsOf as NonNullable<MeasureOptions['clipsOf']>)(parent, page, chain));
        return clips;
    };
    {
        for (const p of blocks) {
            const named = describe(p);
            const block = named.block;
            // Resolved once for the whole block (*a rectangle belongs to the page its node was assigned to*, S27). Every text node under it, every emoji cluster in it and every piece a line box was split into belongs to the page the engine assigned the block to; an inline inside it cannot be on a different page than the block that contains it.
            const blockPage = ownedPage(p);
            const paragraph = paragraphs.length;
            paragraphs.push({
                block,
                path: named.path,
                element: domPathOf(p, container),
                domIndex: (domIndexOf.get(p) as number),
                ...(paintIndexOf(p, 'content') !== undefined ? { paintIndex: paintIndexOf(p, 'content') } : {}),
                text: p.textContent ?? '',
            });
            for (const item of rawSegments(p, blockSet)) {
                claimed.add(item.node);
                const parent: Element|null = item.node.parentElement;
                if (!parent)
                    throw new CasterError('caster: text node without a parent element');
                const style = getComputedStyle(parent);
                const sizePx = parseFloat(style.fontSize);
                const letterSpacingPx = style.letterSpacing === 'normal' ? 0 : parseFloat(style.letterSpacing);
                const features = featureTagsFor(style, letterSpacingPx, { element: pathOf(parent) });
                const owner = ownerOf(parent);
                const declaredColor = options.colorOf?.(parent);
                const declaredDecoration = options.decorationOf?.(parent);
                const request = requestFor(parent);
                const family = familyOf(parent, request);
                const primary = matchFace(table, family, request);
                if (!primary)
                    throw new CasterError(`caster: no face in ${family} matched ${JSON.stringify(request)}`);
                const primaryCoords = coordsOf(parent, primary.face);
                // E12A (`images.md`): a word may contain a cluster no font program can show. Without the option the word is one part and the loop below is that of E3 (`text-emission.md`) exactly; with it the word is split into the runs the shaper can carry and the clusters that become pictures, and the two are measured separately because they are measured against different things.
                const wordText = transformCase(item.node.data.slice(item.start, item.end), style, pathOf(parent), true);
                const rasterParts = options.emoji
                    ? splitForRaster(wordText, item.start)
                    : [{ start: item.start, end: item.end, emoji: false, text: wordText }];
                // …and *the character-fallback walk turned out never to have been called* (S46): a word may also contain a cluster this face cannot show while a later family in the same stack can. That is ordinary CSS font fallback, it is what Blink does per grapheme cluster, and this composition never reached it: `familyFor` chose one family for the whole element and `resolveWord` — the ported walk whose entire job this is — was called from nowhere in the package. BelType's own default stacks put 'Noto Emoji' behind the text face precisely so a pictographic cluster has somewhere to go, and every one of them landed on the text face and refused at `buildToUnicode` with `painted .notdef`.
                const wordParts = rasterParts.flatMap((part) => (part.emoji ? [{ ...part, match: primary, coords: primaryCoords }] : fallbackParts(part, parent, request, primary, primaryCoords, sizePx, features)));
                for (const [partIndex, part] of wordParts.entries()) {
                    const match = part.match;
                    const coords = part.coords;
                    if (match.synthesis.bold || match.synthesis.italic) {
                        throw new CasterError(`caster: ${match.face.id} would need synthesis, which the engine forbids`);
                    }
                    if (!part.emoji) refuseMissingSmallCaps(match.face, features, part.text, { element: pathOf(parent) });
                    const instanceKey = instanceKeyOf(match.face.id, coords);
                    usedInstances.set(instanceKey, { instanceKey, faceId: match.face.id, url: match.face.url, coords });
                    if (part.emoji) {
                        const rect = rectsOf(item.node, part.start, part.end)[0];
                        if (!rect)
                            throw new CasterError(`caster: no rect for the colour cluster ${JSON.stringify(part.text)}`);
                        const local = localOf(rect, blockPage);
                        const page = local ? local.page : Math.max(0, Math.floor((rect.left - containerRect.left) / COLUMN_WIDTH_PX));
                        const topPx = local ? local.yPx : rect.top - containerRect.top;
                        // R5's clip, for the same reason and in the same place the text branch applies it: a colour cluster in a straddler's tail is the continuation clone's, and the clone raster is the one that prints. It was missing here, so an emoji below the cut printed twice.
                        if (clipped(page, topPx, local ? local.hPx : rect.height, parent)) continue;
                        // The whole family list, not the one family the shaper matched: the canvas has to fall back the way the DOM did, and a font string naming only `LatinA` would resolve to a face with no emoji in it.
                        const clusterFont = `${style.fontStyle} ${style.fontWeight} ${sizePx}px ${style.fontFamily}`;
                        const metrics = clusterMetrics(part.text, clusterFont);
                        const chain = chains?.chainOf(parent) ?? null;
                        emoji.push({
                            index: emoji.length,
                            paragraph,
                            block,
                            owner,
                            domIndex: (domIndexOf.get(p) as number),
                            ...(paintIndexOf(p, 'content') !== undefined ? { paintIndex: paintIndexOf(p, 'content') } : {}),
                            page,
                            text: part.text,
                            fontString: clusterFont,
                            sizePx,
                            xPx: local ? local.xPx : rect.left - containerRect.left - page * COLUMN_WIDTH_PX,
                            rightPx: local ? local.xPx + local.wPx : rect.right - containerRect.left - page * COLUMN_WIDTH_PX,
                            topPx,
                            heightPx: local ? local.hPx : rect.height,
                            baselinePx: topPx + metrics.ascentPx,
                            ascentPx: metrics.ascentPx,
                            descentPx: metrics.descentPx,
                            advancePx: metrics.advancePx,
                            usedFont: metrics.usedFont,
                            line: -1,
                            ...(chain && !isIdentityMatrix(chain.matrix) ? { chain: chain.matrix } : {}),
                        });
                        continue;
                    }
                    const rects = rectsOf(item.node, part.start, part.end);
                    if (rects.length === 0)
                        throw new CasterError(`caster: no rect for ${JSON.stringify(item.node.data.slice(part.start, part.end))}`);
                    const pieces: { start: number; end: number; rect: DOMRect; hyphen: boolean; }[] = rects.length === 1
                        ? [{ start: part.start, end: part.end, rect: rects[0], hyphen: false }]
                        : splitByRect(item.node, part.start, part.end);
                    pieces.forEach((piece, pieceIndex) => {
                        const word = transformCase(item.node.data.slice(piece.start, piece.end), style, pathOf(parent), piece.start === item.start);
                        // Where Blink hyphenated, the piece draws its hyphenation character after the word, and the text it stands for is a soft hyphen, so a reader's extraction rejoins the word (PDF 2.0 §14.8.2.2.3).
                        const hyphen = piece.hyphen ? hyphenateCharacterOf(parent) : '';
                        const text = hyphen.length === 1 ? word + '\u00AD' : word + hyphen;
                        // The one hub, when a frame is installed; the inline column arithmetic of E3 (`text-emission.md`), to the bit, when there is not.
                        const local = localOf(piece.rect, blockPage);
                        const page = local ? local.page : Math.max(0, Math.floor((piece.rect.left - containerRect.left) / COLUMN_WIDTH_PX));
                        const topPx = local ? local.yPx : piece.rect.top - containerRect.top;
                        // R5's clip comes before the pushes, and that order is load-bearing: `origins` and `segments` are read back in lockstep by the baseline-probe pass below, so a piece dropped after its origin was recorded would shift every probe by one from there on.
                        if (clipped(page, topPx, local ? local.hPx : piece.rect.height, parent)) return;
                        origins.push({ node: item.node, start: piece.start, end: piece.end, rect: piece.rect, segment: segments.length });
                        if (hyphen)
                            hyphenated.add(segments.length);
                        neutralHeightPx.push(local?.hPx ?? piece.rect.height);
                        let shaped = shapeWord(match.face.url, word + hyphen, sizePx, features, undefined, shaperVariations(coords));
                        if (hyphen === '\u2010' && shaped.gids[shaped.gids.length - 1] === 0)
                            shaped = shapeWord(match.face.url, word + '-', sizePx, features, undefined, shaperVariations(coords));
                        const upem = upemOf(match.face.url);
                        // The PART's own family, not the element's first one: a fallback run is set in the face the walk found, and `ascentPx(fontString)` below reads the baseline off it. Naming the text face for an emoji run would place the picture on the text face's ascent.
                        const fontString = `${style.fontStyle} ${style.fontWeight} ${sizePx}px "${match.face.family}"`;
                        const chain = chains?.chainOf(parent) ?? null;
                        const clips = options.clipsOf ? clipsOfCached(parent, page, chain && !isIdentityMatrix(chain.matrix) ? chain.matrix : null) : [];
                        segments.push({
                            index: segments.length,
                            paragraph,
                            block,
                            blockPath: named.path,
                            owner,
                            page,
                            text,
                            spaceBefore: pieceIndex === 0 && partIndex === 0 ? item.spaceBefore : false,
                            spaceAfter: pieceIndex === pieces.length - 1 && partIndex === wordParts.length - 1 ? item.spaceAfter : false,
                            faceId: match.face.id,
                            features,
                            coords,
                            instanceKey,
                            url: match.face.url,
                            sizePx,
                            color: style.color,
                            rgb: parseRgb(style.color),
                            ...(declaredColor?.declared ? { hint: declaredColor.declared } : {}),
                            ...(declaredColor?.color ? { colorHint: declaredColor.color } : {}),
                            ...(declaredColor?.overprint ? { overprint: declaredColor.overprint } : {}),
                            element: parent,
                            ...(declaredDecoration ? { decoration: declaredDecoration } : {}),
                            letterSpacingPx,
                            xPx: local ? local.xPx : piece.rect.left - containerRect.left - page * COLUMN_WIDTH_PX,
                            rightPx: local ? local.xPx + local.wPx : piece.rect.right - containerRect.left - page * COLUMN_WIDTH_PX,
                            topPx,
                            rectWidthPx: local ? local.wPx : piece.rect.width,
                            ...(chain && !isIdentityMatrix(chain.matrix) ? { chain: chain.matrix } : {}),
                            ...(clips.length > 0 ? { clips } : {}),
                            baselineAscentPx: topPx + ascentPx(fontString),
                            baselineProbePx: Number.NaN,
                            baselineProbeBeforePx: Number.NaN,
                            probeMoved: false,
                            probeOffLine: false,
                            probeBeforeOffLine: false,
                            gids: shaped.gids,
                            clusters: shaped.clusters,
                            advanceUnits: shaped.advances,
                            upem,
                            advanceWidthPx: (shaped.advances.reduce((a, b) => a + b, 0) / upem) * sizePx,
                        });
                    });
                }
            }
        }
    }
    // Paints are read in the same pass as the text, before any probe has touched the document: the probe removes itself again, but a rectangle measured between an insertion and a removal would be the odd one out.
    const paints: MeasuredPaint[] = [
        ...paintRequests.map((request) => ({
            path: request.path,
            domIndex: (domIndexOf.get(request.element) as number),
            ...(paintIndexOf(request.element, 'decoration') !== undefined
                ? { paintIndex: paintIndexOf(request.element, 'decoration') }
                : {}),
            ...pageRectOf(request.element.getBoundingClientRect(), containerRect, ownedPage(request.element)),
            rgb: request.rgb,
            ...(request.color ? { color: request.color } : {}),
            ...(request.target ? { target: request.target } : {}),
            ...(request.hint ? { hint: request.hint } : {}),
            ...(request.colorHint ? { colorHint: request.colorHint } : {}),
            ...(request.overprint ? { overprint: request.overprint } : {}),
        })),
        ...(options.extraPaints ?? []),
    ].sort((a, b) => (a.domIndex ?? 0) - (b.domIndex ?? 0));
    // Images are placed in the same pass and for the same reason: `placeImage` sets the element's transform to none for the length of one measurement, and a rectangle read while a probe was in the document would be the odd one out.
    const images: MeasuredImage[] = [];
    imageRequests.forEach((request, index) => {
        // E10 (`coordinates-and-pages.md`): the element's own transform was captured before the pass neutralised it, and the chain is what its ancestors add to it.
        const parentChain = request.element.parentElement ? chains?.chainOf(request.element.parentElement) : null;
        const placement = placeImage(request.element, containerRect, {
            ...imageIntrinsicsOf(request, index),
            box: request.box,
            page: ownedPage(request.element),
            ...(chains ? { transform: chains.transformOf(request.element) } : {}),
            ...(parentChain && !isIdentityMatrix(parentChain.matrix) ? { chain: parentChain.matrix } : {}),
        });
        // R5's clip, applied to a picture rather than to a line (*the raster half of a continuation's drawing*, S42 for the raster, *a drawing inside a continuation was painted on no page*, S40 for the drawing). A straddling block's original carries its whole tail laid out below the cut and only clipped visually, so an image in that tail is expressed against the page its owner was assigned to and lands far below it — off the media box, painted where no reader can see it. The copy the reader sees is inside the continuation clone, which the walk collects now; without both halves the same picture is painted twice, or nowhere.
        if (clipped(placement.page, placement.contentBoxPx.y, placement.contentBoxPx.h, request.element)) return;
        images.push({
            index,
            path: request.path,
            domIndex: (domIndexOf.get(request.element) as number),
            ...(paintIndexOf(request.element, 'content') !== undefined
                ? { paintIndex: paintIndexOf(request.element, 'content') }
                : {}),
            page: placement.page,
            placement,
        });
    });
    // SVG text goes through the same shaper and the same run model as every other word on the page; only the positions come from a different DOM call.
    for (const request of svgTextRequests) {
        measureSvgText(request, {
            container,
            containerRect,
            table,
            paragraphs,
            segments,
            usedInstances,
            claimed,
            familyOf,
            coordsOf,
            domIndex: (domIndexOf.get(request.element) as number),
        });
    }
    const vectors: MeasuredVector[] = vectorRequests.map((request) => ({
        ...request,
        domIndex: (domIndexOf.get(request.element) as number),
    }));
    // The transforms go back on for exactly one pass, and the plan's other method is measured against the one that was used: the segment's painted bounding box, mapped back through the inverse of its chain. It happens here rather than at the end because `Range.insertNode` splits the text node it lands in, so after the probe pass below no recorded offset points at the text it was recorded for. Both answers travel to the sidecar so the exit notes can quote the difference rather than assert it.
    if (chains) {
        chains.end();
        segments.forEach((segment, i) => {
            if (!segment.chain)
                return;
            const origin = origins[i];
            const [painted] = rectsOf(origin.node, origin.start, origin.end);
            if (!painted)
                return;
            const local = pageRectOf(painted, containerRect, pageIndexOf ? segment.page : null);
            const inverse = inverseRectOf(segment.chain, local);
            segment.inverseRectPx = inverse;
            segment.inverseDeviationPx = Math.max(Math.abs(inverse.xPx - segment.xPx), Math.abs(inverse.yPx - segment.topPx), Math.abs(inverse.wPx - segment.rectWidthPx), Math.abs(inverse.hPx - (neutralHeightPx[i] ?? inverse.hPx)));
        });
        chains.reapply();
    }
    // Probe pass, in reverse document order with one probe alive at a time: an insertion truncates the text node it lands in, so every offset earlier in the document is still valid and every later one has already been used.
    let probeMovedCount = 0;
    let probeOffLineCount = 0;
    let probeBeforeOffLineCount = 0;
    // Two `Range.insertNode` calls and four rectangle reads per word, all of it for report fields. See `probes` in `MeasureOptions`.
    // Only the segments that came out of a DOM text node have an origin to probe; SVG text is positioned per character and has no line box to insert into.
    for (let i = options.probes ? origins.length - 1 : -1; i >= 0; i--) {
        const segment = segments[i];
        const origin = origins[i];
        const [rect] = rectsOf(origin.node, origin.start, origin.end);
        if (!rect) {
            segment.probeOffLine = true;
            probeOffLineCount += 1;
            continue;
        }
        const reading = probeSegment(origin.node, origin.start, origin.end, rect);
        segment.baselineProbePx = toLocalY(reading.afterPx, segment.page) ?? reading.afterPx - containerRect.top;
        segment.baselineProbeBeforePx = toLocalY(reading.beforePx, segment.page) ?? reading.beforePx - containerRect.top;
        segment.probeMoved = reading.afterMoved;
        segment.probeOffLine = reading.afterOffLine;
        segment.probeBeforeOffLine = reading.beforeOffLine || reading.beforeMoved;
        if (reading.afterMoved)
            probeMovedCount += 1;
        if (reading.afterOffLine)
            probeOffLineCount += 1;
        if (segment.probeBeforeOffLine)
            probeBeforeOffLineCount += 1;
    }
    chains?.end();
    const trailingSamples: TrailingSample[] = segments
        .filter((s) => s.letterSpacingPx !== 0)
        .map((s) => ({
        block: s.block,
        text: s.text,
        glyphs: s.gids.length - (hyphenated.has(s.index) ? 1 : 0),
        letterSpacingPx: s.letterSpacingPx,
        ratio: (s.rectWidthPx - s.advanceWidthPx) / s.letterSpacingPx,
    }));
    const trailingLetterSpacing = decideTrailing(trailingSamples);
    const usableProbes = segments.filter((s) => !s.probeMoved && !s.probeOffLine);
    const baselineAgreementPx = usableProbes.reduce((worst, s) => Math.max(worst, Math.abs(s.baselineAscentPx - s.baselineProbePx)), 0);
    const lines: MeasuredLine[] = groupLines(segments);
    // E12A (`images.md`): which line a colour cluster sits on. A cluster carries no glyphs, so it is not a segment and `groupLines` never sees it; it is matched to the line whose baseline it shares, in its own paragraph and on its own page, because that is what "on the baseline" means and because the emitter has to put the picture between the words it stands among rather than after them.
    for (const cluster of emoji) {
        let best = -1;
        let closest = Number.POSITIVE_INFINITY;
        lines.forEach((line, index) => {
            if (line.page !== cluster.page || line.paragraph !== cluster.paragraph)
                return;
            const distance = Math.abs(line.baselinePx - cluster.baselinePx);
            if (distance < closest) {
                closest = distance;
                best = index;
            }
        });
        if (best < 0 || closest > BASELINE_TOLERANCE_PX) {
            throw new CasterError(`caster: the colour cluster ${JSON.stringify(cluster.text)} sits at baseline ${cluster.baselinePx.toFixed(3)} px and no line of its paragraph is within ${BASELINE_TOLERANCE_PX} px of it`);
        }
        cluster.line = best;
    }
    return {
        paragraphs,
        segments,
        lines,
        paints,
        images,
        vectors,
        emoji,
        usedInstances: [...usedInstances.values()],
        claimed,
        pageCount: Math.max(1, ...segments.map((s) => s.page + 1), ...paints.map((p) => p.page + 1), ...images.map((i) => i.page + 1), ...vectors.map((v) => v.page + 1), ...emoji.map((e) => e.page + 1)),
        containerScrollWidthPx: container.scrollWidth,
        trailingLetterSpacing,
        trailingSamples,
        baselineAgreementPx,
        usableProbes: usableProbes.length,
        probeMovedCount,
        probeOffLineCount,
        probeBeforeOffLineCount,
    };
}
/**
 * Whether Blink adds letter-spacing after the last glyph of a run.
 *
 * @remarks
 * Every letter-spaced segment votes: the measured surplus over the shaper's advances, divided by the letter-spacing, is the glyph count if the trailing space is there and one less if it is not. A unanimous vote is required, because a split answer would mean the surplus is not letter-spacing at all.
 *
 * @throws {CasterError} The samples disagree, or the surplus is far from either answer.
 */
function decideTrailing(samples: TrailingSample[]): boolean {
    if (samples.length === 0)
        return false;
    const votes = samples.map((s) => Math.round(s.ratio) - s.glyphs);
    const first = votes[0];
    if (votes.some((v) => v !== first)) {
        const spread = samples
            .map((sample, i) => `${JSON.stringify(sample.text)} ${sample.glyphs} glyphs, ratio ${sample.ratio.toFixed(3)}, vote ${votes[i]}`)
            .join('; ');
        throw new CasterError(`caster: letter-spaced segments disagree on trailing spacing: ${spread}`);
    }
    if (first !== 0 && first !== -1) {
        throw new CasterError(`caster: letter-spacing surplus is ${first} glyphs away from either answer`);
    }
    return first === 0;
}
/**
 * The stored size and orientation an element can answer for itself.
 *
 * @remarks
 * Right for every image the engine did not reorient, and for a `<canvas>`, whose backing store is its intrinsic size by definition. A caller with the file's header in hand supplies the real answer instead.
 *
 * @throws {CasterError} The element has no intrinsic size in the DOM.
 */
export function defaultIntrinsics(request: ImageRequest): ImageIntrinsics {
    const element = request.element;
    if (element instanceof HTMLCanvasElement)
        return { storedIntrinsic: [element.width, element.height], exifOrientation: 1 };
    if (element instanceof HTMLImageElement) {
        return { storedIntrinsic: [element.naturalWidth, element.naturalHeight], exifOrientation: 1 };
    }
    throw new CasterError(`caster: ${element.tagName.toLowerCase()} has no intrinsic size in the DOM; pass imageIntrinsicsOf with the size the file stores`);
}
/** What a line's clips are, for comparing two: each clip's reason names the element that imposes it. */
const clipKeyOf = (clips: ClipSpec[]|undefined) => (clips ? clips.map((clip) => clip.reason).join('|') : '');
/** Lines in emission order, each carrying its runs. Lines never cross a paragraph. */
function groupLines(segments: MeasuredSegment[]): MeasuredLine[] {
    const lines: MeasuredLine[] = [];
    let runIndex = 0;
    for (const segment of segments) {
        const baselinePx = Math.round(segment.baselineAscentPx * 2) / 2;
        let line = lines[lines.length - 1];
        // E10 (`coordinates-and-pages.md`): the chain joins the line key. The `cm` that carries it wraps the whole `BT … ET`, and a `q`/`Q` pair may not straddle a text object, so two segments under different transforms cannot share a line however close their baselines are.
        const chainKey = segment.chain ? segment.chain.join(',') : '';
        const clipKey = clipKeyOf(segment.clips);
        if (!line ||
            line.paragraph !== segment.paragraph ||
            line.page !== segment.page ||
            line.baselinePx !== baselinePx ||
            (line.chain ? line.chain.join(',') : '') !== chainKey ||
            clipKeyOf(line.clips) !== clipKey) {
            line = { paragraph: segment.paragraph, page: segment.page, baselinePx, ...(segment.chain ? { chain: segment.chain } : {}), ...(segment.clips ? { clips: segment.clips } : {}), runs: [] };
            lines.push(line);
        }
        const run = line.runs[line.runs.length - 1];
        // The owner joins the text state in the run key: a content item carries one structure element's marked content and nothing else, so a run that straddled two owners could not be wrapped in a single BDC.
        const sameState = run &&
            run.owner === segment.owner &&
            run.instanceKey === segment.instanceKey &&
            run.features.join(',') === segment.features.join(',') &&
            run.sizePx === segment.sizePx &&
            run.color === segment.color &&
            // E8 (`colour.md`): two segments the browser painted the same colour are still two runs when one of them declares a CMYK or spot hint and the other does not, because the operator that opens them is a different operator.
            colorKey(run.colorHint) === colorKey(segment.colorHint) &&
            run.overprint === segment.overprint &&
            // E9 (`vector-painting.md`): two runs with different decorations are two runs, because the rectangle that underlines one is not the rectangle that underlines the other and each is measured from its own run's extent.
            (run.decoration?.key ?? '') === (segment.decoration?.key ?? '') &&
            run.letterSpacingPx === segment.letterSpacingPx;
        if (sameState)
            run.segments.push(segment);
        else {
            line.runs.push({
                index: runIndex++,
                owner: segment.owner,
                faceId: segment.faceId,
                instanceKey: segment.instanceKey,
                coords: segment.coords,
                features: segment.features,
                url: segment.url,
                sizePx: segment.sizePx,
                color: segment.color,
                rgb: segment.rgb,
                ...(segment.hint ? { hint: segment.hint } : {}),
                ...(segment.colorHint ? { colorHint: segment.colorHint } : {}),
                ...(segment.overprint ? { overprint: segment.overprint } : {}),
                ...(segment.element ? { element: segment.element } : {}),
                ...(segment.decoration ? { decoration: segment.decoration } : {}),
                letterSpacingPx: segment.letterSpacingPx,
                segments: [segment],
            });
        }
    }
    return lines;
}
/**
 * The words of an SVG `<text>` as the browser placed them: every run of non-space characters, divided again wherever a character does not follow the one before it.
 *
 * @remarks
 * The text's characters are its collapsed `textContent`, and two `<tspan>`s of one `<text>` join with no space between them, so the last word of one line and the first of the next are one run, "romanoAnno" (codeberg.org/BelType/caster issue 12). A run is placed from its first character, so such a run printed on the first line. A character starts a new piece when its start is neither where the previous character ends nor where it starts (a character of the previous one's cluster shares its start), which is what an absolute `x` or `y`, a `dx` or a `dy` does. The low half of a surrogate pair is never a start. A tolerance of a twentieth of the font size absorbs the layout's own rounding: Blink answers in 1/64 px, and two neighbours of a kerned face differ by 0.016 (measured 2026-11-05), while a line or a `dx` moves by whole units.
 *
 * @param rendered - The collapsed text, whose length the caller has checked against `getNumberOfChars()`.
 */
export function svgWords(element: SVGTextContentElement, rendered: string): { start: number; end: number; text: string; }[] {
    const out: { start: number; end: number; text: string; }[] = [];
    const tolerance = parseFloat(getComputedStyle(element).fontSize) / 20;
    const near = (a: DOMPoint, b: DOMPoint) => Math.abs(a.x - b.x) < tolerance && Math.abs(a.y - b.y) < tolerance;
    for (const match of rendered.matchAll(/\S+/gu)) {
        let start = match.index as number;
        const end = start + match[0].length;
        for (let i = start + 1; i < end; i++) {
            const code = rendered.charCodeAt(i);
            if (code >= 0xdc00 && code <= 0xdfff) continue;
            const here = element.getStartPositionOfChar(i);
            if (near(here, element.getEndPositionOfChar(i - 1)) || near(here, element.getStartPositionOfChar(i - 1))) continue;
            out.push({ start, end: i, text: rendered.slice(start, i) });
            start = i;
        }
        out.push({ start, end, text: rendered.slice(start, end) });
    }
    return out;
}
/**
 * `<text>` inside an inline `<svg>`, measured into the same words every other line of the page is made of.
 *
 * @remarks
 * SVG positions characters rather than lines: there is no line box, no baseline the DOM will name, and no `Range` whose rectangle means anything useful once a `transform` is in play. What there is, is `getStartPositionOfChar` and `getEndPositionOfChar`, which answer in the element's own user space and already carry `text-anchor`, every `dx` on every `tspan`, and whatever the layout did with them. Pushing those two points through the element's CTM lands in the same pixel grid a paragraph is measured in, and from there the word is an ordinary run: shaped by `shapeWord`, placed by `emitRun`, owned by the enclosing `Figure`.
 *
 * The one thing SVG does that HTML does not is collapse whitespace before it counts characters, so the rendered string is rebuilt here and checked against `getNumberOfChars()`; a disagreement is an error rather than an off-by-one that would silently place every word of the line one character to the left.
 *
 * @throws {CasterError} The rendered character count disagrees with `getNumberOfChars()`, or no face in the family matches.
 */
function measureSvgText(request: SvgTextRequest, ctx: { claimed: Set<Text>; container: HTMLElement; containerRect: DOMRect; table: FaceDescriptor[]; paragraphs: MeasuredParagraph[]; segments: MeasuredSegment[]; usedInstances: Map<string,{ instanceKey: string; faceId: string; url: string; coords: Coords; }>; familyOf: (parent: Element,request: FaceRequest) => string; coordsOf: (parent: Element,face: FaceDescriptor) => Coords; domIndex: number; }) {
    const element = request.element;
    const rendered = (element.textContent ?? '').replace(/\s+/gu, ' ').trim();
    if (rendered === '')
        return;
    // An SVG `<text>` is measured here and not by a block's walk, so this is where its text nodes are claimed (*the conservation of words*, S61).
    const textWalker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let n = textWalker.nextNode(); n; n = textWalker.nextNode()) ctx.claimed.add((n as Text));
    const count = element.getNumberOfChars();
    if (count !== rendered.length) {
        throw new CasterError(`caster: the <text> at ${request.domPath} renders ${count} characters but its collapsed text has ${rendered.length}; ` +
            'E9 measures SVG text through per-character positions and cannot align a string it cannot reconstruct');
    }
    // A `<tspan>` sets its words in its own face, size and spacing, which the `<text>` may not share: each is read from the element holding the word's text node, once per element.
    const fonts = new Map<Element, ReturnType<typeof fontOf>>();
    const fontOf = (owner: Element) => {
        const own = getComputedStyle(owner);
        const sizePx = parseFloat(own.fontSize) * request.scale;
        const letterSpacingPx = own.letterSpacing === 'normal' ? 0 : parseFloat(own.letterSpacing) * request.scale;
        const features = featureTagsFor(own, letterSpacingPx, { element: request.domPath });
        const faceRequest = requestFor(owner);
        const family = ctx.familyOf(owner, faceRequest);
        const match = matchFace(ctx.table, family, faceRequest);
        if (!match)
            throw new CasterError(`caster: no face in ${family} matched the <text> at ${request.domPath}`);
        const coords = ctx.coordsOf(owner, match.face);
        const instanceKey = instanceKeyOf(match.face.id, coords);
        ctx.usedInstances.set(instanceKey, { instanceKey, faceId: match.face.id, url: match.face.url, coords });
        return { style: own, sizePx, letterSpacingPx, features, match, coords, instanceKey, upem: upemOf(match.face.url), key: `${instanceKey} ${sizePx} ${letterSpacingPx} ${features.join(',')}` };
    };
    const font = (owner: Element) => { let f = fonts.get(owner); if (!f) fonts.set(owner, f = fontOf(owner)); return f; };
    const paragraph = ctx.paragraphs.length;
    ctx.paragraphs.push({
        block: 'svg-text',
        path: request.domPath,
        element: request.domPath,
        domIndex: ctx.domIndex,
        ...(request.paintIndex !== Number.MAX_SAFE_INTEGER ? { paintIndex: request.paintIndex } : {}),
        text: rendered,
    });
    // The column offset is the harness's page model — pages laid out side by side one `COLUMN_WIDTH_PX` apart — and it is the fallback road, exactly as it is for an ordinary segment (`local ? local.xPx : rect.left - containerRect.left - page * COLUMN_WIDTH_PX`). Under a frame `request.toContainer` was composed with `clientToLocalMatrix`, which already expresses the point against the page's own origin, so subtracting the offset a second time moved every `<text>` on page N one page-width to the left and off the page. Latent until a drawing was collected on a page other than the first (*a drawing inside a continuation was painted on no page*, S40); load-bearing the moment one was.
    const columnOffset = activeFrame() ? 0 : request.page * COLUMN_WIDTH_PX;
    // A `<tspan>` paints with its own computed `fill`, which the `<text>` may not share: Mermaid fills an actor's `<text>` with the box's own colour and its `<tspan>` black, so the `<text>`'s fill printed the label invisible. Each rendered character's paint is its text node's parent's, indexed as `rendered` collapses whitespace.
    const owners: Element[] = [];
    let space = true;
    const paintWalker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let n = paintWalker.nextNode(); n; n = paintWalker.nextNode()) {
        for (const ch of (n as Text).data.split('')) {
            const white = /\s/u.test(ch);
            if (white && space) continue;
            owners.push((n as Text).parentElement ?? element);
            space = white;
        }
    }
    // A word whose characters change face or size inside it (`a<tspan font-weight="bold">b</tspan>`) is two runs, one per font.
    const words = svgWords(element, rendered).flatMap((word) => {
        const out: typeof word[] = [];
        let from = word.start;
        for (let i = word.start + 1; i < word.end; i++) {
            if (font(owners[i] ?? element).key === font(owners[from] ?? element).key) continue;
            out.push({ start: from, end: i, text: rendered.slice(from, i) });
            from = i;
        }
        out.push({ start: from, end: word.end, text: rendered.slice(from, word.end) });
        return out;
    });
    words.forEach((match2) => {
        const { start, end } = match2;
        const paint = getComputedStyle(owners[start] ?? element);
        const { sizePx, letterSpacingPx, features, match, coords, instanceKey, upem, style: own } = font(owners[start] ?? element);
        const color = paint.fill && paint.fill.startsWith('rgb') ? paint.fill : paint.color;
        const first = element.getStartPositionOfChar(start);
        const last = element.getEndPositionOfChar(end - 1);
        // `getStartPositionOfChar` answers the alignment point, before `dominant-baseline` or `alignment-baseline` moved the glyphs; `getExtentOfChar` answers the moved cell, whose top is the alphabetic baseline less the ascent. Measured 2026-11-07 on Chromium: 16px sans-serif at y=100 starts at 100 under every baseline, its cell's top at 86 under `alphabetic`, 91 under `central`, 90.19 under `middle`. Mermaid centres every sequence-diagram label this way.
        const aligned = (paint.dominantBaseline !== 'auto' && paint.dominantBaseline !== 'alphabetic') || !['auto', 'baseline', 'alphabetic'].includes(paint.alignmentBaseline);
        const shift = aligned ? element.getExtentOfChar(start).y + ascentPx(`${own.fontStyle} ${own.fontWeight} ${own.fontSize} "${match.face.family}"`) - first.y : 0;
        const [startX, startY] = apply(request.toContainer, first.x, first.y + shift);
        const [endX] = apply(request.toContainer, last.x, last.y + shift);
        refuseMissingSmallCaps(match.face, features, match2.text, { element: request.domPath });
        const shaped = shapeWord(match.face.url, match2.text, sizePx, features, undefined, shaperVariations(coords));
        ctx.segments.push({
            index: ctx.segments.length,
            paragraph,
            block: 'svg-text',
            blockPath: request.domPath,
            owner: request.owner,
            page: request.page,
            text: match2.text,
            spaceBefore: rendered[start - 1] === ' ',
            spaceAfter: rendered[end] === ' ',
            faceId: match.face.id,
            features,
            coords,
            instanceKey,
            url: match.face.url,
            sizePx,
            color,
            rgb: parseRgb(color),
            element,
            letterSpacingPx,
            xPx: startX - columnOffset,
            rightPx: endX - columnOffset,
            topPx: startY - sizePx,
            rectWidthPx: endX - startX,
            // The baseline is the character origin, which is what the DOM answered with; there is no ascent to add and no probe to place.
            baselineAscentPx: startY,
            baselineProbePx: startY,
            baselineProbeBeforePx: startY,
            probeMoved: false,
            probeOffLine: false,
            probeBeforeOffLine: false,
            gids: shaped.gids,
            clusters: shaped.clusters,
            advanceUnits: shaped.advances,
            upem,
            advanceWidthPx: (shaped.advances.reduce((a, b) => a + b, 0) / upem) * sizePx,
        });
    });
}
