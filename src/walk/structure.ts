/**
 * `walk/structure.js` — the structure walker: the DOM in, the tree the PDF will carry out.
 *
 * Ported from `harness/src/export/structure.ts` (E5, E7, E9, E11, E12F). Guide: `docs/guide/structure-tree.md`, `docs/guide/tables.md`.
 *
 * WHAT THE PORT CHANGED — the tag table is v2 (P7). v1 refuses anything it does not name, which is right and is why the table can grow safely; BelType's belt emits a wider vocabulary than the fixture of `structure-tree.md` (E5) did (`docs/syntax.md` lists every construct, and `packages/core/src/plugins/` says what each emits). v1's mappings are kept exactly, except one correction the plan states and this port takes in half (*veraPDF folds a `Div`*, S25): a `<figure>` whose content is one image keeps v1's `Figure`, with the `Caption` inside it where ISO 14289-2 8.2.5.27 wants it, and a `<figure>` holding a table or a code block becomes an `Aside` with its `Caption`, or a `Div` with none, instead of throwing (`visitAsFigure`). v1 required a `<figure>` to hold an `<img>` and threw otherwise; the half-correction lets a figure hold something that is not a raster without moving a Caption out from under the rule that governs it.
 *
 * The additions, each with what emits it: `<blockquote>` -> `Div` (`BlockQuote` is not in the PDF 2.0 standard namespace — `structure-tree.md` §"What is not in the PDF 2.0 standard namespace"); `<pre>` -> `P`; `<dl>`/`<dt>`/`<dd>` -> `L` with `Lbl`/`LBody` per item; `<details>`/`<summary>` -> `Div`/`P`; `<nav>` -> `Div` around its lists; `<del>`/`<s>`/`<mark>`/`<ins>`/`<u>`/`<i>`/`<b>`/`<small>`/`<cite>`/`<q>`/`<var>`/`<samp>`/`<time>`/`<data>`/`<bdi>`/`<bdo>`/`<ruby>` -> `Span`; a `.footnote` span (the belt's `inline-footnotes.js`) -> `FENote`; a KaTeX span (`rehype-katex`) -> `Formula` with `/Alt` from its `<annotation encoding="application/x-tex">` and its inner HTML transparent; a mermaid `<svg>` -> the SVG rule of E9 (`vector-painting.md`) unchanged.
 *
 * And two rules that are an engine's rather than the vocabulary's, each answered by the adapter through `WalkOptions` and never by a class the walk names. R8: an element the adapter calls transparent (`transparentOf`) introduces no node and no owner, and its text is measured like any other — Cicero's `__beltype-fill`, `__beltype-break` and `__beltype-slice`, Paged.js's content wrapper. R4: an element the adapter pairs with a twin (`twinOf`) continues that twin's structure element rather than opening a second one. And a custom element — a `bt-` element, a `<beltype-*>`, anything with a hyphen in its tag — is an error by name, because the printer has no way to know what it means and guessing is the failure mode the whole design refuses.
 *
 * The harness's own header follows.
 *
 * The structure walker of `structure-tree.md` (E5): the DOM in, the tree the PDF will carry out.
 *
 * The walker decides three things and nothing else. Which structure element every element of the fixture becomes — the v1 HTML→tag table, frozen in `docs/E5-structure-plan.md`. Which structure element owns the text that appears directly inside an element, which is what turns a stream of measured segments into marked content with an owner. And which parts of the page are artifacts rather than content, which is the only way a running header, a page number, a rule and a decorative box can be painted at all in a file that forbids untagged content.
 *
 * Reading order is DOM order, always. CSS visual reordering — floats, flex `order`, absolute positioning, multi-column fragmentation — is the engine's business; the exporter reads positions out of the engine and never reorders anything, so the structure tree, the content stream and the DOM all agree about sequence even when the painted page does not.
 *
 * Nothing here measures. Everything positional the walker needs — which column a rectangle landed in, where a line of a link is — goes through the same two helpers `textMeasure` uses, so a rectangle in the annotation and a rectangle in the text come off the same arithmetic.
 *
 * @packageDocumentation
 */
import { backgroundUrlOf, currentSourceOf } from '../host/gateway.ts';
import { readHint } from '../colour/colorHints.ts';
import { paintsDecoration } from '../vectors/cssBoxes.ts';
import { SHAPE_ATTRIBUTE } from '../vectors/listMarkers.ts';
import { assignHeaders, scopeNameOf } from './tableHeaders.ts';
import { buildTableModel, isRepeated, regularityOf, TABLE_FRAGMENT_ATTRIBUTE } from './tableModel.ts';
import { domPathOf, pageRectOf } from '../measure/textMeasure.ts';
import { UnknownElementError, CasterError } from '../errors.ts';

import type { PaintRequest } from '../measure/textMeasure.ts';
import type { ReportLangRecord } from '../report.ts';
import type { SvgRoot } from '../vectors/svgGeometry.ts';
import type { TableCell, TableModel, TableRowGroup } from './tableModel.ts';

/**
 * One image the walker found, named by the element that will own its content item.
 *
 * @remarks
 * The walker decides the tag and the owner and nothing else: it never reads a byte and never measures a box, so the same list drives the measurement, the embedding and the emission without any of the three re-deriving what the others decided.
 */
export type WalkImage = {
  /** Owner key: a `Figure` element's path, or an artifact's path. */
  path: string;
  /** The element the picture is painted from — a continuation's clone where one carries it, mirrored onto the source's record (*the raster half of a continuation's drawing*, S42); everything else in the record is then the source's, because the two are one Figure whose content item happens to land on a later page. */
  element: HTMLElement;
  kind: ImageKind;
  tag: 'Figure'|'Artifact';
  /** `currentSrc` for an `img`, the URL for a background, `canvas:<path>` for a canvas, `facsimile:<url>#<page>` for a facsimile. */
  src: string;
  /** A facsimile's source file (absolute URL) and the page of it, one-based. */
  facsimile?: { url: string, page: number };
  alt?: string;
  /** Which CSS box the image fills. A background paints over the padding box. */
  box: 'content'|'padding';
  /** The DOM path of the element the author wrote, which is what an error message names and what the report shows — a mirrored clone keeps its source's, as it keeps its owner. */
  domPath: string;
};

/**
 * One table the walker built, with everything the emitter, the border painter and the report need to say about it.
 *
 * @remarks
 * The grid model is the source of every one of those answers; nothing downstream re-reads the DOM to find out how many columns a table has or which `TH` heads a cell.
 */
export type WalkTable = {
  /** `data-pdf-table` when the table declares one, else the first fragment's DOM path. */
  key: string;
  /** Path of the one `Table` element, however many fragments it was written as. */
  path: string;
  model: TableModel;
  /** Structure path of every cell, indexed as the model indexes cells. */
  cellPaths: string[];
  /** `/ID` of every cell that carries one, indexed the same way; '' when it carries none. */
  cellIds: string[];
  /** Per data cell index, the header cell indices in emitted order. */
  headerMap: Map<number, number[]>;
  /** Every row, in grid order: the `TR` it became, or the artifact it was painted as. */
  rows: { index: number; path: string; fragment: number; repeated: boolean; domPath: string }[];
  /** The rows the engine repeated on a continuation page, as artifacts. */
  repeatedRows: { path: string; domPath: string; fragment: number }[];
  /** Which page element each fragment sits in, when the caller can say. */
  fragmentPages: number[];
  /** True when the computed `border-collapse` of the table is `collapse`. */
  collapsed: boolean;
  warnings: string[];
};

/** The artifact kinds `data-pdf-artifact` may declare. */
export type ArtifactKind = 'header'|'footer'|'pagenum'|'pagination'|'layout';

/** Where an image's pixels come from. */
export type ImageKind = 'img'|'canvas'|'background'|'facsimile';

/** One structure element of the tree the PDF will carry. */
export type StructureNode = {
  tag: string;
  /** Stable path through the tree, e.g. `Document/Sect[0]/P[2]/Em[0]`. */
  path: string;
  attrs: { lang?: string, listNumbering?: string, alt?: string, scope?: 'Column'|'Row'|'Both', id?: string, headers?: string[], rowSpan?: number, colSpan?: number, expansion?: string, textPosition?: 'Sub'|'Sup' };
  kids: StructureNode[];
};
/** Something painted outside the tree, and the artifact type it is written as. */
export type ArtifactDescriptor = {
  /** `artifact:` plus the element's DOM path; also the owner key of its text. */
  path: string;
  kind: ArtifactKind;
  type: 'Pagination'|'Layout';
  subtype?: 'Header'|'Footer'|'PageNum';
};
/** One line rectangle of a link, on its page. */
export type AnnotRect = {
  page: number;
  xPx: number;
  yPx: number;
  wPx: number;
  hPx: number;
};
/** One link annotation, and the `Link` element whose `/OBJR` will point at it. */
export type WalkAnnot = {
  /** Path of the `Link` element whose `/OBJR` points at the annotation. */
  ownerPath: string;
  href: string;
  /** The link's text, written to the annotation's `/Contents`. */
  contents: string;
  page: number;
  rects: AnnotRect[];
  /** E12F (`structure-tree.md`): what the href names. An `href` beginning `#` is a place in this file and becomes a `/Dest`; everything else is an address and becomes a `/URI`, `mailto:` included — a mail address is a URI and a reader that is handed one opens a mail client, which is exactly the behaviour the author asked for. */
  kind: 'internal'|'external'|'mailto';
  /** Internal links only: the id the fragment named. */
  targetId?: string;
  /** Internal links only: where the target is, and which structure element it is. PDF/UA-2 8.8 t1 makes every destination inside the file a *structure* destination, so a page reference is not enough: the emitter needs the element the fragment names, and the page and the corner are what the `/XYZ` after it carries. */
  dest?: { page: number; xPx: number; yPx: number; structPath: string };
};
/**
 * The engine's answers about its own DOM, which the adapter supplies and the walk asks per element.
 *
 * @remarks
 * `twinOf` is new in the port, and it is the `/MCR` rule of E5 (`structure-tree.md`) applied to an engine's fragments. A block that straddles a cut is presented on more than one page, and a walk that did not know this would tag the later presentation as a second element — the same prose twice in the tree, the original owning only the lines above the cut and the copy owning the rest under a structure element nobody wrote. **A source and its continuations are one structure element whose content items land on several pages.**
 *
 * So an element with a twin introduces no node. It takes the twin's owner, structure path, block description and drawing root, and its children are then visited: a child with a twin of its own continues in turn; a child without one is new prose and is walked under the structure node the twin produced. That one rule covers both spellings a paged engine has: Cicero clones the whole subtree and blanks the consumed words (`fragments.js`'s `mutateToContinuation`), so every clone descendant has a twin and no child is ever fresh; Paged.js rebuilds the ancestor chain as empty shells (`rebuildAncestors`) and moves the tail's nodes into them, so only the shells have twins and everything under them is fresh. Which is which — how a continuation is recognised, how it is paired, and how the pairing is verified — is the adapter's answer, because it is the engine's DOM that spells it; the walk asks per element and never looks at a class or an attribute itself.
 */
export type WalkOptions = {
  /** R4, generalised: the element this one continues, if any — an element the walk already tagged, on an earlier page, whose structure element this one's words belong to. Absent, every element is walked as new, which is every fixture the harness ever had. */
  twinOf?: (element: Element) => Element|null;
  /** R8, generalised: whether an element is the ENGINE's own mark inside content — a fill span, a break, a slice wrapper, a page-content wrapper — which introduces no node and no owner, its children walked in its place and its text, if any, measured like any other. Cicero's are the `__beltype-` classes; Paged.js's are its bare content `<div>` and its footnote scaffolding. Absent, nothing is transparent. */
  transparentOf?: (element: Element) => boolean;
  /** *the engine stopped showing the original* (S47): whether the engine rendered this element — whether it is on a page at all. Since *the first fragment is constructed* every divided block leaves its original unassigned in the light DOM, where before this it was assigned to the page it began on, so the walk now meets an element that has structure and no rectangle. It keeps its structure node, which is what every fragment continues onto (I6: the document lives once, pages are views), and its ink is taken from the fragment that renders it instead. Absent, everything renders, which is every fixture the harness ever had. */
  renders?: (element: Element) => boolean;
  /** *the printer guesses, says so, and withdraws the claim* (S90): what a custom element the table does not name becomes. `'refuse'` throws {@link UnknownElementError}; `'infer'`, the default, walks it as CSS laid it out, the `<span>` rule when inline and the `<div>` rule when a block, and lists the guess in {@link WalkResult}'s `inferred`. */
  unknownElements?: 'refuse'|'infer';
  /** *PDF/UA-2 is a flag, not a given* (S103, amended 2026-11-08): under `'none'` an `<img>` with no `alt`, a `<canvas>` with no `aria-label`, a facsimile with no alternative text, an inline `<svg>` with no description, an element with `role="img"` and no `aria-label`, a KaTeX formula with no TeX annotation and a link to an element that produced no structure element are each one sentence in {@link WalkResult}'s `warnings`, where under `'ua-2'`, the default, each is refused. */
  standard?: 'ua-2'|'none';
  /** Which page element an element belongs to, as an index. E11 (`tables.md`) only, and only for naming: a `/ID` has to be unique in the document and `th-<page>-<n>` is a name a human reading the file can place. With no answer every table is on page 1 and the counter alone keeps the ids apart, which is what a fixture with no page elements gets. */
  pageIndexOf?: (element: Element) => number;
};
import type { ShapeMarker } from '../vectors/listMarkers.ts';

/** Everything the walk decided: the tree, and every list the measurement, the painters and the emitter read. */
export type WalkResult = {
  tree: StructureNode;
  /** The container's `lang`, which becomes the catalog `/Lang`. */
  lang: string;
  /** Content-bearing block elements in DOM order, for `measureText`. */
  blocks: HTMLElement[];
  describe: (block: HTMLElement) => { block: string; path: string };
  ownerOf: (parent: Element) => string;
  paints: PaintRequest[];
  images: WalkImage[];
  artifacts: ArtifactDescriptor[];
  annots: WalkAnnot[];
  /** Every heading in DOM order; the non-skipping rule was checked over this. */
  headings: { path: string; level: number }[];
  /** E12F (`structure-tree.md`): the same headings with the text a bookmark shows. Separate from `headings` because that list goes into the report verbatim and a bookmark's title is the emitter's business, not the structure record's. */
  outline: { path: string; level: number; title: string }[];
  /** E12F (`structure-tree.md`): every `/Lang` the walk produced, and where the tag came from. */
  langs: ReportLangRecord[];
  /** E12F (`structure-tree.md`): where the catalog `/Lang` came from. */
  langSource: 'container'|'documentElement';
  /** E9 (`vector-painting.md`): every element whose computed style paints a background, a border, an outline or a shadow, in DOM order. The walker finds them because it is the one pass that already visits everything; what to do with them is `vectors/cssBoxes.js`'s business. */
  decorated: HTMLElement[];
  /** E9 (`vector-painting.md`): every inline `<svg>`, with the Figure or artifact that owns it. */
  svgs: SvgRoot[];
  /** Every `disc`, `circle` or `square` marker that owns a `Lbl`, for `vectors/listMarkers.js` to draw under it. */
  markerShapes: ShapeMarker[];
  /** E11 (`tables.md`): every table, in DOM order of its first fragment. */
  tables: WalkTable[];
  /** E11 (`tables.md`): ragged rows padded, and anything else a table had to be told about. */
  tableWarnings: string[];
  /** *the printer guesses, says so, and withdraws the claim* (S90): every custom element the walk tagged by its layout under `unknownElements: 'infer'`, in DOM order. Empty under `'refuse'`, and empty is what lets the file claim PDF/UA-2. */
  inferred: WalkInference[];
  /** *the printer guesses, says so, and withdraws the claim* (S90): one sentence per guess and per role the walk did not honour, for the report's warnings. */
  warnings: string[];
};
/** One guess the walk made about a custom element (*the printer guesses, says so, and withdraws the claim*, S90). */
export type WalkInference = {
  /** The DOM path. */
  element: string;
  /** What the element became: a structure element, an anonymous `P` for its direct text, or nothing of its own. */
  tag: 'Div'|'Span'|'P'|'transparent';
  /** The computed `display` the guess was read from. */
  display: string;
};

/** The attribute that marks an element as an artifact. */
export const ARTIFACT_ATTRIBUTE = 'data-pdf-artifact';
/**
 * The custom property read beside the attribute.
 *
 * @remarks
 * Custom properties inherit, so a value set on a container would silently claim every descendant; the attribute is the mechanism and the property is only honoured where it agrees.
 */
export const ARTIFACT_PROPERTY = '--pdf-artifact';
/** The artifact type and subtype each kind is written as. */
const ARTIFACT_KINDS: Record<ArtifactKind,{ type: 'Pagination'|'Layout'; subtype?: 'Header'|'Footer'|'PageNum'; }> = {
    header: { type: 'Pagination', subtype: 'Header' },
    footer: { type: 'Pagination', subtype: 'Footer' },
    pagenum: { type: 'Pagination', subtype: 'PageNum' },
    // A fixed box's repeat after the first page: pagination with no subtype, because `Watermark` would claim an intent the printer cannot know (DESIGN.md S82).
    pagination: { type: 'Pagination' },
    layout: { type: 'Layout' },
};
/** `list-style-type` as computed by the engine, to the PDF `/ListNumbering` name. */
const LIST_NUMBERING: Record<string,string> = {
    disc: 'Disc',
    circle: 'Circle',
    square: 'Square',
    decimal: 'Decimal',
    'lower-roman': 'LowerRoman',
    'upper-roman': 'UpperRoman',
    'lower-alpha': 'LowerAlpha',
    'lower-latin': 'LowerAlpha',
    'upper-alpha': 'UpperAlpha',
    'upper-latin': 'UpperAlpha',
    // v2. v1 had no entry for `none` and refused the document, with the reason "a list whose items carry Lbl kids may not be None" — which is the right rule and the wrong place to enforce it. `/None` is a legal `/ListNumbering` value, a list with no marker is an ordinary thing (a `@toc` nav is one, and so is every navigation list BelType's addendum styles), and what the rule actually forbids is a `Lbl` beside it. So `none` maps to `None` here and the LI branch below builds no `Lbl` for an item whose marker is empty — the rule holds by construction rather than by refusing the document.
    none: 'None',
};
/**
 * Structure elements that may own marked content in v1.
 *
 * @remarks
 * `Figure` owns exactly one content item and it is an image; `Caption` owns text like any other block. Both joined the set in E7 (`images.md`) and neither changes what any earlier element may own.
 */
const CONTENT_OWNERS = new Set([
    'P',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'Lbl',
    'LBody',
    'Em',
    'Strong',
    'Link',
    'Span',
    'Figure',
    'Caption',
    // E11 (`tables.md`): a cell owns the text written straight into it, the way a paragraph does. A cell holding blocks owns nothing itself and those blocks are tagged inside it, which is the same division `LI` and `LBody` already make.
    'TH',
    'TD',
    // v2 (P7). `FENote` owns the note's own text — a `.footnote` span the belt relocated is a run of prose, not a wrapper. `Formula` owns the marked content of a KaTeX span, whose inner markup is transparent, so the content items have nowhere else to belong. `Sub` is not here and never will be: a subscript is a `Span` carrying `/TextPosition`, because 32000-2's `Sub` element is a sub-division of a block.
    'FENote',
    'Formula',
]);
/**
 * Table elements that survive with no content of their own.
 *
 * @remarks
 * Everything else is pruned when the engine painted nothing for it, because an element with no content items is a DOM node that produced no ink. A cell is the exception: an empty `TD` is what makes a ragged row rectangular, and PDF/UA-2 asks for the rectangle rather than for the ink. Their ancestors are kept for the same reason — a `TR` of empty cells is still a row.
 */
const KEEP_WHEN_EMPTY = new Set(['TH', 'TD']);

/**
 * v2 (P7): the inline elements that all come out as a `Span` and differ only in what the `Span` carries.
 *
 * @remarks
 * `<del>`, `<s>` and `<ins>` are edits; `<mark>` is a highlight; `<u>` and `<i>` and `<b>` and `<small>` are presentational; `<cite>`, `<q>`, `<var>`, `<samp>`, `<time>`, `<data>`, `<bdi>`, `<bdo>` and `<ruby>` each mean something HTML can say and PDF 2.0's standard namespace cannot. None of them earns an element of its own, and inventing one would fail ISO 14289-2:2024 8.2.4 t1 the way `Code` does. `<em>`, `<strong>`, `<abbr>`, `<sub>`, `<sup>`, `<code>` and `<kbd>` are not here: each has its own branch above, because each carries something a `Span` has to be told.
 */
const INLINE_SPANS = new Set(['DEL', 'S', 'INS', 'MARK', 'U', 'I', 'B', 'SMALL', 'CITE', 'Q', 'VAR', 'SAMP', 'TIME', 'DATA', 'BDI', 'BDO', 'RUBY', 'RT', 'RP', 'WBR', 'DFN']);
/**
 * `rgb(204, 0, 0)` and friends, as PDF `rg` operands.
 *
 * @throws {CasterError} A value with fewer than three numbers in it.
 */
function parseRgb(color: string): [number,number,number] {
    const numbers = color.match(/[\d.]+/g);
    if (!numbers || numbers.length < 3)
        throw new CasterError(`caster: cannot parse colour ${color}`);
    return [Number(numbers[0]) / 255, Number(numbers[1]) / 255, Number(numbers[2]) / 255];
}
/**
 * The artifact kind an element declares, or null.
 *
 * @remarks
 * Both mechanisms are read. The attribute is authoritative because it does not inherit; the custom property is honoured only where it names the same kind, so a disagreement is a fixture bug and says so rather than picking a winner.
 *
 * @throws {CasterError} The attribute and the property disagree; a kind that is not one of {@link ArtifactKind}.
 */
function artifactKindOf(element: Element): ArtifactKind|null {
    const attribute = element.getAttribute(ARTIFACT_ATTRIBUTE)?.trim() ?? '';
    const property = readHint(element, ARTIFACT_PROPERTY);
    const own = element.parentElement ? readHint(element.parentElement, ARTIFACT_PROPERTY) : '';
    // An inherited value is not a declaration: only a property that differs from the parent's was set on this element.
    const declared = property !== '' && property !== own ? property : '';
    if (attribute !== '' && declared !== '' && attribute !== declared) {
        throw new CasterError(`caster: ${ARTIFACT_ATTRIBUTE}="${attribute}" and ${ARTIFACT_PROPERTY}: ${declared} disagree`);
    }
    const value = attribute || declared;
    if (value === '')
        return null;
    if (!(value in ARTIFACT_KINDS))
        throw new CasterError(`caster: unknown artifact kind ${JSON.stringify(value)}`);
    return (value as ArtifactKind);
}
/** Whether a reified list marker gets a `Lbl`: text that paints, or a shape the vector pass draws (`adapters/reify.js`). */
function isLabelled(marker: Element): boolean {
    return (marker.textContent ?? '').trim() !== '' || marker.hasAttribute(SHAPE_ATTRIBUTE);
}

/** Whether the element takes part in block layout, as the engine computed it. */
function isBlockLevel(element: Element): boolean {
    const display = getComputedStyle(element).display;
    return display !== 'none' && display !== 'contents' && !display.startsWith('inline');
}
/**
 * ARIA roles with a standard PDF structure type, honoured on every element in both modes (*the printer guesses, says so, and withdraws the claim*, S90).
 *
 * @remarks
 * A declared role is a declaration, not a guess, and ARIA's own rule is that it overrides the element's native semantics, so a `<p role="heading" aria-level="2">` is an `H2` and a `<div role="list">` an `L`. `heading` takes its level from `aria-level`, and `img` its `/Alt` from `aria-label`; neither is guessed. `presentation` and `none` make the element transparent. ARIA's `note` is not here: PDF 2.0's standard namespace has no `Note`, only `FENote`, which is a note with a reference elsewhere in the flow and is not what the role says. A role this table does not name is a warning, and the element keeps its own tag.
 */
const ARIA_TAGS: Record<string,'P'|'H'|'L'|'LI'|'Figure'|'transparent'> = { paragraph: 'P', heading: 'H', list: 'L', listitem: 'LI', figure: 'Figure', img: 'Figure', presentation: 'transparent', none: 'transparent' };
/** The role each element already has natively; a role that restates it changes nothing. */
const NATIVE_ROLE: Record<string,string> = { P: 'paragraph', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading', UL: 'list', OL: 'list', MENU: 'list', LI: 'listitem', FIGURE: 'figure' };
/** Elements whose own branch decides what they are and reads the attributes it needs, so the role table is not asked: a picture's description is its `alt`, `<title>` or label. */
const ROLE_NOT_ASKED = new Set(['IMG', 'svg', 'SVG', 'CANVAS', 'PICTURE', 'SOURCE', 'HR', 'BR']);
/** Lists whose items would be stranded outside any list if the list went transparent, so `presentation` and `none` on them are a warning. */
const LIST_TAGS = new Set(['UL', 'OL', 'MENU', 'DL']);
/** The engine's and the editing tools' own custom elements: inside a printed document they are a defect of the host, never a vocabulary gap, and are refused under both modes (*the printer guesses, says so, and withdraws the claim*, S90). */
const OWN_ELEMENT = /^(BT|BELTYPE)-/u;
/** A heading tag, its level captured. */
const HEADING = /^H([1-6])$/;
/** Inline children that carry no words of their own, so their presence alone does not make an anonymous block (*the anonymous block*, DESIGN.md S64). */
const INLINE_VOID = new Set(['IMG', 'BR', 'CANVAS', 'PICTURE', 'SVG', 'svg', 'SOURCE', 'WBR']);
/**
 * A page of another PDF, read off either of its two forms (DESIGN.md S80, amended): the author's `<object type="application/pdf" data="x.pdf#page=N">` with a fallback `<img alt>`, or the copy Cicero's presenter writes, `<object is="beltype-facsimile" data-src data-page aria-label>`. `null` for any other element.
 *
 * @remarks
 * The original's fragment is read exactly as the presenter reads it (`engine-cicero/seam/facsimile.js`'s `locate`: RFC 8118's `page=` among the fragment's parameters, anything that is not a positive integer meaning page 1), so the two forms name one page by one key. Under Paged.js only the original exists, shown by the browser's own viewer, and it prints as the same vector figure.
 */
function facsimileOf(element: Element): { form: string; source: string; page: string; alt: string; }|null {
    if (element.tagName !== 'OBJECT') return null;
    if (element.getAttribute('is') === 'beltype-facsimile') {
        return { form: '<object is="beltype-facsimile">', source: element.getAttribute('data-src') ?? '', page: element.getAttribute('data-page') ?? '1', alt: (element.getAttribute('aria-label') ?? '').trim() };
    }
    if ((element.getAttribute('type') ?? '').trim().toLowerCase() !== 'application/pdf') return null;
    const data = element.getAttribute('data') ?? '';
    const hash = data.indexOf('#');
    const wanted = hash < 0 ? NaN : Number(new URLSearchParams(data.slice(hash + 1)).get('page'));
    return { form: '<object type="application/pdf">', source: hash < 0 ? data : data.slice(0, hash), page: Number.isInteger(wanted) && wanted >= 1 ? String(wanted) : '1', alt: (element.querySelector('img')?.getAttribute('alt') ?? '').trim() };
}

/**
 * Walk one container into the structure tree and every list the rest of the print reads.
 *
 * @throws {CasterError} Anything the tree cannot honestly carry, each refused by name with the DOM path: no `lang` anywhere; an image, canvas, SVG or KaTeX formula with no description; a link with no rectangles, one that crosses a page, or an internal one with no destination; a table that is not rectangular or whose fragments are out of order; a list style with no `/ListNumbering`; a heading level that skips on the way down; a continuation whose words would land outside the tree; text with no owner.
 * @throws {UnknownElementError} An element the v2 tag table does not name, every custom element under `unknownElements: 'refuse'`, and a `bt-` or `beltype-` element under either.
 */
export function walkStructure(container: HTMLElement, options: WalkOptions = {}): WalkResult {
    const containerRect = container.getBoundingClientRect();
    const pageIndexOf = options.pageIndexOf ?? (() => 0);
    /** What the walk starts from: the container's children, originals included — the tree is read from the element the author wrote (I6), and the fragments take their ink from the pages they are on. */
    const roots = [...container.children];
    /** Every element matching `selector` under the roots, in root order. */
    const under = (selector: string): HTMLElement[] => roots.flatMap((root) => [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)]).map((el) => (el as HTMLElement));
    const tables: WalkTable[] = [];
    const tableWarnings: string[] = [];
    const inferred: WalkInference[] = [];
    const warnings: string[] = [];
    const tableByKey = new Map<any, any>();
    const idCounters = new Map<any, any>();
    const ownerByElement = new Map<any, any>();
    /** Every structure node by its path, so a continuation can find the node its twin produced and put fresh children under it. */
    const nodeByPath: Map<string,StructureNode> = new Map<any, any>();
    const describeByBlock = new Map<any, any>();
    const blocks: HTMLElement[] = [];
    const paints: PaintRequest[] = [];
    const images: WalkImage[] = [];
    /** Every image the walk registered, by the element that carries it, so a continuation's copy can join the list under the source's own owner (*the raster half of a continuation's drawing*, DESIGN.md S42). */
    const imageByElement: Map<Element,WalkImage> = new Map<any, any>();
    /** The one door into `images`: every record is registered by its element on the way in, because the mirror joins on the element and a record pushed past this helper is one a continuation could never find. */
    const pushImage = (record: WalkImage) => {
        images.push(record);
        imageByElement.set(record.element, record);
    };
    const artifacts: ArtifactDescriptor[] = [];
    const annots: WalkAnnot[] = [];
    const headings: { path: string; level: number; }[] = [];
    const svgs: SvgRoot[] = [];
    /** Every shape marker the walk gave a `Lbl`, for `vectors/listMarkers.js` to draw under it. */
    const shapes: ShapeMarker[] = [];
    /** Every `<svg>` the walk registered, by element, so a continuation's copy can join the roots under the source's own owner (*a drawing inside a continuation was painted on no page*, DESIGN.md S40). */
    const svgRootOf: Map<Element,SvgRoot> = new Map<any, any>();
    // E12F (`structure-tree.md`): a container with no `lang` is not an error while the document itself has one. `<html lang>` is where a document states its language and a view container inside it is a box, not a document; the catalog `/Lang` therefore falls back to `document.documentElement.lang` and only a document that states nothing anywhere is refused.
    const containerLang = container.getAttribute('lang')?.trim() ?? '';
    const documentLang = document.documentElement.getAttribute('lang')?.trim() ?? '';
    const lang = containerLang || documentLang;
    const langSource: 'container'|'documentElement' = containerLang !== '' ? 'container' : 'documentElement';
    if (lang === '') {
        throw new CasterError('caster: neither the container nor <html> carries a lang attribute');
    }
    const langs: ReportLangRecord[] = [
        { path: 'catalog', tag: langSource === 'container' ? container.tagName.toLowerCase() : 'html', lang, source: langSource },
    ];
    const outline: { path: string; level: number; title: string; }[] = [];
    /**
     * The `lang` an element declares itself, as structure-node attributes.
     *
     * @remarks
     * E5 (`structure-tree.md`) read the attribute on a `span` and nowhere else, which made a `/Lang` a property of one tag rather than of the document. It is read on every element from E12 (`structure-tree.md`) on, and it is a *declaration* rather than an inherited value: `getAttribute` answers only for the element that carries it, so a paragraph inside a French section does not restate French.
     */
    const langAttrs = (element: Element): { lang?: string; } => {
        const value = element.getAttribute('lang')?.trim() ?? '';
        return value === '' ? {} : { lang: value };
    };
    /** The structure path each element became, for an internal link's destination. */
    const structPathByElement = new Map<any, any>();
    /**
     * Record the structure element an element became, and the language it declared.
     *
     * @remarks
     * One helper for both because both are answers to "which node did this element produce": the language goes on that node, and an internal link's destination has to name it. An element that produces no node of its own — a plain `div`, a `span` with nothing to say — is not registered, and a link that points at one resolves to the nearest ancestor that is.
     *
     * @returns `node`, so a branch can register and bind in one expression.
     */
    const noteLang = (element: Element, node: StructureNode): StructureNode => {
        structPathByElement.set(element, node.path);
        if (node.attrs.lang)
            langs.push({ path: node.path, tag: element.tagName.toLowerCase(), lang: node.attrs.lang, source: 'element' });
        return node;
    };
    /** A new structure node under `parent`, its path ordinal counted among the parent's kids of the same tag. */
    const node = (tag: string, parent: StructureNode|null, attrs: StructureNode['attrs'] = {}): StructureNode => {
        const ordinal = parent ? parent.kids.filter((k) => k.tag === tag).length : 0;
        const path = parent ? `${parent.path}/${tag}[${ordinal}]` : tag;
        const created: StructureNode = { tag, path, attrs, kids: [] };
        if (parent)
            parent.kids.push(created);
        nodeByPath.set(path, created);
        return created;
    };
    /** Anchors the engine rendered nowhere, kept until the walk knows which fragment renders each (*the engine stopped showing the original*, DESIGN.md S47). */
    const unrenderedAnchors: { element: HTMLAnchorElement; path: string; }[] = [];
    /** A source element to the fragments that continue it, in page order — where an unrendered element's ink is re-homed at the end of the walk (*the engine stopped showing the original*, DESIGN.md S47). */
    const twinsOf: Map<Element,Element[]> = new Map<any, any>();
    /** Register a block whose text is measured, named by the node that owns it. */
    const block = (element: HTMLElement, name: string, path: string) => {
        // A block inside a block is ordinary and is no longer refused (*a block inside a block is measured once under its nearest owner*, S28). A nested list, a loose `<li><p>`, an `<li><pre>`, a `<figcaption>` inside a `<figure>` that is itself a block, a KaTeX span inside a paragraph — every one of them refused the whole document here. The reason the refusal existed was real: two blocks whose subtrees overlap measured the same characters twice, and `origins` and `segments` are read back in lockstep by the probe pass. It is answered in the measurement now instead, where the walk of a block's text stops at any descendant that is itself a block, so each character is measured exactly once under its nearest owner.
        blocks.push(element);
        describeByBlock.set(element, { block: name, path });
    };
    /**
     * A child is a block by its computed display, not by its tag (DESIGN.md S75). The tag names the structure role (a `b` is a `Span`); whether the element is a block or an inline box is what the engine computed. An inline-role element that CSS lays out as a block owns its own text, so it is the block that is measured, the way a note laid out as a block is (the footnote branch in `visit`).
     *
     * @remarks
     * Measured 2026-10-14 on a grid of `div`s holding `<b>24</b><span>Titles published</span>` with both set `display: block`: the walk tagged both as inline spans, registered no block for them, and the conservation of words refused seven words in four text nodes. The tag table was asked where the CSS had already answered.
     *
     * @param self - The node the element's tag made, which owns its text.
     */
    const blockIfDisplayed = (element: Element, self: StructureNode) => {
        if (isBlockLevel(element) && (element.textContent ?? '').trim() !== '')
            block((element as HTMLElement), self.tag, self.path);
    };
    /**
     * The anonymous block (DESIGN.md S64). Visit a grouping element's children, and first give its own inline content an owner.
     *
     * @remarks
     * CSS 2.1 §9.2.1.1: a block container with inline content beside its blocks — or with nothing but inline content — wraps each run in an anonymous block box. The walk had no word for that box, and ink is a by-product of tagging here, so `<div>text</div>`, a `<strong>` beside a `<ul>`, a lone `<span>` in a section were drawn nowhere: every grouping branch visited `element.children` and a text node is not one. The belt never writes that shape — Markdown puts prose in a `<p>` — which is how it hid until a pug fence did (the manual, page 41) and the conservation census named it (*the conservation of words*, S61).
     *
     * The anonymous box reads as a paragraph, so it is a `P`, and the grouping element itself is the block: the measurement's walk over it stops at every descendant that is a block in its own right (*a block inside a block is measured once under its nearest owner*, S28), which leaves it exactly the runs CSS wraps. Inline children are tagged under the `P`; block children under the group, where they always were. Where an ancestor is already a block — an `<li>` holding a `<div>` — that ancestor's walk reaches this text today and nothing changes. A `P` that turns out to own nothing (its inline child was a footnote or a formula, blocks of their own) is pruned like any other empty element.
     *
     * ponytail: one anonymous `P` per container, where CSS makes one box per run. Every word is placed where the browser placed it; what is coarser is the tree — `text <ul>…</ul> more text` reads as one paragraph before the list rather than two around it. A block is keyed by its element (`describeByBlock`), so a `P` per run wants the measurement to take a node range for a block; do that when a document that mixes runs and blocks needs its reading order exact.
     *
     * @param self - The node block children go under.
     * @returns The anonymous `P`, when one was made.
     */
    const visitGrouped = (element: Element, self: StructureNode): StructureNode|null => {
        const inlineText = ( child: Element) => !isBlockLevel(child) && getComputedStyle(child).display !== 'none' && !INLINE_VOID.has(child.tagName) && (child.textContent ?? '').trim() !== '';
        const orphaned = [...element.childNodes].some((n) => n.nodeType === 3 && /\S/u.test((n as Text).data)) || [...element.children].some(inlineText);
        let claimedAbove = false;
        for (let up = element.parentElement; up && up !== container && !claimedAbove; up = up.parentElement) claimedAbove = describeByBlock.has(up);
        let anonymous: StructureNode|null = null;
        if (orphaned && !claimedAbove && !describeByBlock.has(element)) {
            anonymous = node('P', self);
            ownerByElement.set(element, anonymous.path);
            block((element as HTMLElement), anonymous.tag, anonymous.path);
        }
        for (const child of element.children) visit(child, anonymous && !isBlockLevel(child) ? anonymous : self);
        return anonymous;
    };
    /** Declare an element an artifact of `kind`, and make its path the owner of its text. */
    const artifact = (element: HTMLElement, kind: ArtifactKind): ArtifactDescriptor => {
        const descriptor: ArtifactDescriptor = { path: `artifact:${domPathOf(element, container)}`, kind, ...ARTIFACT_KINDS[kind] };
        artifacts.push(descriptor);
        ownerByElement.set(element, descriptor.path);
        return descriptor;
    };
    /**
     * The link's line rectangles, in the column each landed in.
     *
     * @throws {CasterError} A link with no rectangles, one whose rectangles fall on two pages, or an internal link whose id nothing in the container carries.
     */
    const linkRects = (anchor: HTMLAnchorElement, ownerPath: string): WalkAnnot => {
        const range = document.createRange();
        range.selectNodeContents(anchor);
        // The anchor's own assigned page, not the band each line rect fell in (*a rectangle belongs to the page its node was assigned to*, S27). A link inside a straddling block's tail has line rectangles reaching into the pages below, and reading them by their own origins made an ordinary link look like one that crosses a page break.
        const anchorPage = options.pageIndexOf ? pageIndexOf(anchor) : null;
        const rects = [...range.getClientRects()]
            .filter((r) => r.width > 0 && r.height > 0)
            .map((r) => pageRectOf(r, containerRect, anchorPage));
        if (rects.length === 0)
            throw new CasterError(`caster: the link at ${ownerPath} has no rectangles`);
        const pages = new Set(rects.map((r) => r.page));
        if (pages.size > 1) {
            throw new CasterError(`caster: the link at ${ownerPath} crosses a page break, which v1 does not build`);
        }
        const href = anchor.getAttribute('href') ?? '';
        // E12F (`structure-tree.md`): three kinds, decided off the href alone. A fragment names a place in this file and is the one that becomes a `/Dest`; `mailto:` and every other scheme are addresses outside it and stay `/URI` actions.
        const kind: WalkAnnot['kind'] = href.startsWith('#') ? 'internal' : href.startsWith('mailto:') ? 'mailto' : 'external';
        const annot: WalkAnnot = {
            ownerPath,
            href,
            contents: (anchor.textContent ?? '').replace(/\s+/gu, ' ').trim(),
            page: rects[0].page,
            rects,
            kind,
        };
        if (kind === 'internal') {
            const targetId = href.slice(1);
            const target = targetId === '' ? null : ((under(`#${CSS.escape(targetId)}`)[0] ?? null) as HTMLElement|null);
            if (!target) {
                throw new CasterError(`caster: the link at ${ownerPath} points at ${JSON.stringify(href)} and nothing inside the container carries that id; an internal link with no destination is a dead link, not a /URI`);
            }
            const rect = pageRectOf(target.getBoundingClientRect(), containerRect, options.pageIndexOf ? pageIndexOf(target) : null);
            annot.targetId = targetId;
            // The structure path is filled in after the walk: the target may be further down the document than the link, and the element it becomes does not exist until the walk reaches it.
            annot.dest = { page: rect.page, xPx: rect.xPx, yPx: rect.yPx, structPath: '' };
            internalTargets.push({ annot, target });
        }
        return annot;
    };
    /** Internal links whose destination is resolved once the whole tree exists. */
    const internalTargets: { annot: WalkAnnot; target: HTMLElement; }[] = [];
    /** The row-group structure element each section becomes. */
    const GROUP_TAG = { thead: 'THead', tbody: 'TBody', tfoot: 'TFoot' };
    /**
     * One table: the grid, the header association, the ids, and the elements.
     *
     * @remarks
     * The order inside is forced. The model has to exist before anything is tagged, because a ragged row is padded in the model and the padding is a `TD` in the tree; the header assignment has to run before the ids are handed out, because a `TD` another cell names as its header needs one; and the ids have to exist before the first `TD` node is built, because its `/Headers` is a list of them and an explicit `headers` attribute may point at a cell further down the table.
     *
     * @throws {CasterError} Fragments out of DOM order; a grid that is not rectangular; a header that was never given an `/ID`; and whatever {@link buildTableModel} refuses.
     */
    const visitTable = (element: HTMLElement, parent: StructureNode) => {
        const domPath = domPathOf(element, container);
        const key = (element.getAttribute(TABLE_FRAGMENT_ATTRIBUTE) ?? '').trim();
        // A continuation fragment was already merged into its table when the first one was met; meeting it again is the DOM's business, not the tree's.
        if (key !== '' && tableByKey.has(key))
            return;
        const fragments = key === ''
            ? [element]
            : under(`table[${TABLE_FRAGMENT_ATTRIBUTE}=${JSON.stringify(key)}]`);
        if (fragments[0] !== element) {
            throw new CasterError(`caster: the fragments of ${JSON.stringify(key)} are not in DOM order; ${domPath} is not the first of them`);
        }
        const model = buildTableModel(fragments, ( el: Element) => domPathOf(el, container));
        const regularity = regularityOf(model.grid);
        if (!regularity.rectangular) {
            throw new CasterError(`caster: the table at ${domPath} is ${regularity.rows} rows by ${regularity.columns} columns with ${regularity.missing.length} slot(s) uncovered (${regularity.missing.map(( pair: [number,number]) => `${pair[0]},${pair[1]}`).join('; ')}); a table PDF/UA-2 accepts is rectangular`);
        }
        const headerMap = new Map<any, any>();
        for (const assignment of assignHeaders(model)) {
            if (assignment.headers.length > 0)
                headerMap.set(assignment.cell, assignment.headers);
        }
        // Every `TH` is named, and so is every cell some other cell names as its header — which, because `headers` resolves against cells rather than header cells, can be a `TD`.
        const named = new Set(model.cells.filter(( c: TableCell) => c.kind === 'th').map(( c: TableCell) => c.index));
        for (const list of headerMap.values())
            for (const index of list)
                named.add(index);
        const cellIds = model.cells.map(() => '');
        for (const cell of model.cells) {
            if (!named.has(cell.index))
                continue;
            const page = pageIndexOf(cell.element ?? fragments[cell.fragment]) + 1;
            const ordinal = (idCounters.get(page) ?? 0) + 1;
            idCounters.set(page, ordinal);
            cellIds[cell.index] = `${cell.kind}-${page}-${ordinal}`;
        }
        const tableNode = node('Table', parent);
        structPathByElement.set(element, tableNode.path);
        const caption = [...fragments[0].children].find((c) => c.tagName === 'CAPTION');
        if (caption) {
            // 8.2.5.27 t1 wants the Caption first or last; it is written first here whatever `caption-side` paints, because the tree carries reading order and a caption is read before the table it names.
            const captionNode = node('Caption', tableNode);
            ownerByElement.set(caption, captionNode.path);
            if ((caption.textContent ?? '').trim() !== '')
                block((caption as HTMLElement), captionNode.tag, captionNode.path);
            for (const child of caption.children)
                visit(child, captionNode);
        }
        const groupNodes = model.rowGroups.map(( group: TableRowGroup) => node((GROUP_TAG[(group.section as 'thead'|'tbody'|'tfoot')] as string), tableNode));
        const cellPaths = model.cells.map(() => '');
        const repeatedRows: WalkTable['repeatedRows'] = [];
        const rows = [];
        for (const row of model.rowList) {
            if (row.repeated) {
                // A repeated head row is ink the engine added for the reader of a continuation page. It is painted, it is a Pagination artifact, and it is nowhere in the tree — the row it repeats is already there.
                // `element` is optional on a `RepeatedRow` because the model can synthesise a row; a repeated row is always a real one, which is what the walk is looking at here.
                const rowElement = (row.element as HTMLElement);
                const descriptor: ArtifactDescriptor = artifact(rowElement, 'header');
                if ((rowElement.textContent ?? '').trim() !== '')
                    block(rowElement, 'artifact:header', descriptor.path);
                repeatedRows.push({ path: descriptor.path, domPath: row.domPath, fragment: row.fragment });
                rows.push({ index: row.index, path: descriptor.path, fragment: row.fragment, repeated: true, domPath: row.domPath });
                continue;
            }
            const rowNode = node('TR', groupNodes[row.rowGroup]);
            rows.push({ index: row.index, path: rowNode.path, fragment: row.fragment, repeated: false, domPath: row.domPath });
            for (const index of row.cells) {
                const cell = model.cells[index];
                const attrs: StructureNode['attrs'] = {};
                if (cell.kind === 'th')
                    attrs.scope = scopeNameOf(model, index);
                if (cellIds[index] !== '')
                    attrs.id = cellIds[index];
                const headers = headerMap.get(index);
                if (headers && headers.length > 0) {
                    const ids = headers.map(( i: number) => cellIds[i]);
                    if (ids.some(( id: string) => id === ''))
                        throw new CasterError(`caster: a header of ${cell.domPath} was never given an /ID`);
                    attrs.headers = ids;
                }
                if (cell.rowSpan > 1)
                    attrs.rowSpan = cell.rowSpan;
                if (cell.colSpan > 1)
                    attrs.colSpan = cell.colSpan;
                if (cell.element)
                    Object.assign(attrs, langAttrs(cell.element));
                const cellNode = node(cell.kind === 'th' ? 'TH' : 'TD', rowNode, attrs);
                if (cell.element)
                    noteLang(cell.element, cellNode);
                cellPaths[index] = cellNode.path;
                if (!cell.element)
                    continue;
                ownerByElement.set(cell.element, cellNode.path);
                // A cell holding blocks owns no text of its own: the blocks are tagged inside it and each owns its own. A cell holding words owns them.
                const grouping = [...cell.element.children].some(isBlockLevel);
                if (!grouping && (cell.element.textContent ?? '').trim() !== '')
                    block(cell.element, cellNode.tag, cellNode.path);
                for (const child of cell.element.children)
                    visit(child, cellNode);
            }
        }
        const walked: WalkTable = {
            key: model.key,
            path: tableNode.path,
            model,
            cellPaths,
            cellIds,
            headerMap,
            rows,
            repeatedRows,
            fragmentPages: fragments.map((f) => pageIndexOf(f)),
            collapsed: getComputedStyle(fragments[0]).borderCollapse === 'collapse',
            warnings: model.warnings,
        };
        tables.push(walked);
        tableWarnings.push(...model.warnings.map(( w: string) => `${domPath}: ${w}`));
        if (key !== '')
            tableByKey.set(key, walked);
    };
    /**
     * The Figure for a page of another PDF, in either form ({@link facsimileOf}), with its image record; refused by name where it cannot print.
     *
     * @param element - the `<object>`, original or copy.
     * @param langFrom - the element whose `lang` the Figure takes: the object itself, or the `<figure>` it is the whole content of.
     * @throws {CasterError} no alternative text, no PDF named, or a page that is not a one-based number.
     */
    const facsimileFigure = (element: Element, parent: StructureNode, langFrom: Element): StructureNode => {
        const facsimile = (facsimileOf(element) as NonNullable<ReturnType<typeof facsimileOf>>);
        const domPath = domPathOf(element, container);
        if (facsimile.alt === '') {
            if (options.standard !== 'none') throw new CasterError(`caster: ${facsimile.form} at ${domPath} carries no alternative text (an aria-label on the copy, an alt on the original's fallback <img>); a page of another PDF is a picture of something, and nothing but the author can say what`, { element: domPath });
            warnings.push(`caster: ${facsimile.form} at ${domPath} carries no alternative text, so it printed as a Figure with no /Alt; the file does not claim PDF/UA-2`);
        }
        if (facsimile.source === '') {
            throw new CasterError(`caster: ${facsimile.form} at ${domPath} names no PDF, so there is nothing to embed`, { element: domPath });
        }
        const page = Number(facsimile.page);
        if (!Number.isInteger(page) || page < 1) {
            throw new CasterError(`caster: ${facsimile.form} at ${domPath} names page "${facsimile.page}", which is not a one-based page number`, { element: domPath });
        }
        const url = new URL(facsimile.source, element.baseURI).href;
        const self = noteLang(langFrom, node('Figure', parent, { alt: facsimile.alt, ...langAttrs(langFrom) }));
        ownerByElement.set(element, self.path);
        structPathByElement.set(element, self.path);
        pushImage({ path: self.path, element: (element as HTMLElement), kind: 'facsimile', tag: 'Figure', src: `facsimile:${url}#${page}`, facsimile: { url, page }, alt: facsimile.alt, box: 'content', domPath });
        return self;
    };

    /**
     * R4, generalised: an element that continues one the walk already tagged introduces no node of its own.
     *
     * @remarks
     * The positional pairing of a Cicero clone against its source (*a continuation mirrors its source element by element*, DESIGN.md S29) — the twin walk, the `shell` step-through, the three refusals — is the Cicero adapter's now (`adapters/cicero.js`'s `twinsOf`), because it is a fact about how one engine spells a continuation; Paged.js spells it with a `data-ref` the engine itself wrote, and a third engine will spell it a third way. What is the walk's is what every spelling needs once a pairing exists: the twin's owner, so the words are measured under the block the author wrote; the twin's structure path, so a link into the continuation lands on the element the author wrote; the twin's block description, so the block is measured at all (*a block inside a block is measured once under its nearest owner* (S28) holds here too: a continuation's blocks nest exactly where its source's do, and the measurement stops each block's text walk at its nearest descendant block); and the twin's drawing root, so the copy of an `<svg>` the engine paints is collected under the source's owner (*a drawing inside a continuation was painted on no page*, S40). Then the children, each either continuing a twin of its own or walked as new prose under the node the twin produced.
     *
     * @param parent - The node the element would have been tagged under — where a fresh child goes when the twin produced no node of its own.
     */
    const continueAs = (element: Element, twin: Element, parent: StructureNode) => {
        const twins = twinsOf.get(twin) ?? [];
        twinsOf.set(twin, twins);
        twins.push(element);
        const owner = ownerByElement.get(twin);
        if (owner !== undefined) ownerByElement.set(element, owner);
        const structPath = structPathByElement.get(twin);
        if (structPath !== undefined) structPathByElement.set(element, structPath);
        const sourceRoot = svgRootOf.get(twin);
        if (sourceRoot) svgs.push({ ...sourceRoot, element: ((element as unknown) as SVGSVGElement) });
        // And a raster is the same fact about the other collector (*the raster half of a continuation's drawing*, S42). *a drawing inside a continuation was painted on no page* (S40) closed this for the drawing and named the gap it was leaving: `images` was filled from the walk's own `IMG`, background and `<canvas>` branches, and a continuation returns before every one of them, so the list held the source alone — laid out below the cut, clipped away, and placed against the page its owner was assigned to, which is why the specimen's two figures were blank on the pages they belong to. The copy joins the list under the source's owner, structure path, tag, alt and `src`: the bytes are the source's file, the EXIF orientation is that file's own, and the copy the reader sees is this one.
        const sourceImage = imageByElement.get(twin);
        if (sourceImage) pushImage({ ...sourceImage, element: (element as HTMLElement) });
        const described = describeByBlock.get((twin as HTMLElement));
        if (described && !describeByBlock.has((element as HTMLElement))) {
            blocks.push((element as HTMLElement));
            describeByBlock.set((element as HTMLElement), described);
        }
        // A facsimile's copy holds the preview's canvas where its twin holds a fallback <img>; neither is walked (S80, amended), so the copy's record above is all it brings.
        if (facsimileOf(element)) return;
        const self = nodeByPath.get(structPath ?? owner ?? '') ?? parent;
        for (const child of element.children) visit(child, self);
    };

    /** A block that owns its own text: a `<p>`, a `<pre>`, a `<summary>`, a `role="paragraph"`. */
    const visitAsOwner = (element: Element, parent: StructureNode, tag: string) => {
        const self = noteLang(element, node(tag, parent, langAttrs(element)));
        ownerByElement.set(element, self.path);
        block((element as HTMLElement), self.tag, self.path);
        for (const child of element.children)
            visit(child, self);
    };
    /** A heading at `level`, and its bookmark. */
    const visitAsHeading = (element: Element, parent: StructureNode, level: number) => {
        const self = noteLang(element, node(`H${level}`, parent, langAttrs(element)));
        headings.push({ path: self.path, level });
        outline.push({ path: self.path, level, title: (element.textContent ?? '').replace(/\s+/gu, ' ').trim() });
        ownerByElement.set(element, self.path);
        block((element as HTMLElement), self.tag, self.path);
        for (const child of element.children)
            visit(child, self);
    };
    /** A list, its items walked under it. */
    const visitAsList = (element: Element, parent: StructureNode, listNumbering: string) => {
        const self = noteLang(element, node('L', parent, { listNumbering, ...langAttrs(element) }));
        for (const child of element.children)
            visit(child, self);
    };
    /** A list item: its reified marker the `Lbl`, everything else the `LBody`. */
    const visitAsListItem = (element: Element, parent: StructureNode) => {
        const self = noteLang(element, node('LI', parent, langAttrs(element)));
        const marker = (element.querySelector('.marker') as HTMLElement|null);
        // An empty marker is no marker: `list-style-type: none` makes `adapters/prepare.js`'s counter answer with the empty string, and a `Lbl` owning nothing beside a `/ListNumbering /None` is exactly what v1's rule forbids. A shape marker is empty too, and is a marker all the same: its shape is the content, drawn by `vectors/listMarkers.js`.
        if (marker && isLabelled(marker)) {
            const label = node('Lbl', self);
            ownerByElement.set(marker, label.path);
            if (marker.hasAttribute(SHAPE_ATTRIBUTE)) shapes.push({ element: (marker as HTMLElement), owner: label.path, domPath: domPathOf(marker, container) });
        }
        // LBody is implicit: the engine has no element for it, and everything in the item that is not the label belongs to it. Real content inside an LI outside a Lbl has to be inside an LBody (8.2.5.25 t2), so there is no shape in which the item's text can hang off the LI directly.
        const body = node('LBody', self);
        ownerByElement.set(element, body.path);
        block((element as HTMLElement), self.tag, self.path);
        for (const child of element.children) {
            if (child === marker)
                continue;
            visit(child, body);
        }
    };
    /** The `<figcaption>` of `figure`, if it has one, as the last child of `self`: 8.2.5.27 t1 asks a Caption first or last of what it captions, and DOM order puts it last only by a coincidence of authoring. */
    const captionInto = (figure: Element, self: StructureNode) => {
        const figcaption = (figure.querySelector(':scope > figcaption') as HTMLElement|null);
        if (!figcaption) return;
        const caption = node('Caption', self);
        ownerByElement.set(figcaption, caption.path);
        block(figcaption, caption.tag, caption.path);
        for (const child of figcaption.children) visit(child, caption);
        self.kids = [...self.kids.filter((k) => k !== caption), caption];
    };
    /**
     * A figure, and the shape P7's correction settles on: a `Figure` with its `Caption` inside it when its content is one picture (an image, a page of another PDF, a `<canvas>` or an `<svg>` that is not decorative), an `Aside` holding its content and its `Caption` when it has a caption and other content, a `Div` when it has neither (see the `FIGURE` branch).
     *
     * @remarks
     * The `Aside` is measured (2026-11-07, veraPDF 1.30.0, `--flavour ua2`): a `Caption` in a `Div` fails ISO 32005's Table 5 as *`<Document>` shall not contain `<Caption>`*, because the validator folds the `Div` into its parent, and 8.2.5.27 t1 when the folded parent has more kids after it; the paper's table figure and SVG figure and the canvas figure failed both ways. An `Aside` may hold one `Caption` and is not folded. A `Figure` would pass the profile too, but it asks an `/Alt`, which a reader is told in place of the table or the code it holds.
     *
     * @throws {CasterError} The one image has no alt text.
     */
    const visitAsFigure = (element: Element, parent: StructureNode) => {
        const inner = element.querySelectorAll(':scope > img, :scope > picture > img');
        const others = [...element.children].filter((child) => child.tagName !== 'FIGCAPTION' && child.tagName !== 'IMG' && child.tagName !== 'PICTURE');
        const single = inner.length === 1 && others.length === 0 ? (inner[0] as HTMLImageElement) : null;
        if (single) {
            const domPath = domPathOf(single, container);
            const alt = single.getAttribute('alt');
            if (alt === null || alt.trim() === '') {
                throw new CasterError(`caster: the <img> inside the <figure> at ${domPathOf(element, container)} has no alt text; a Figure without /Alt is a PDF/UA-2 failure, and alt="" on the image inside a captioned figure says the figure carries nothing while the caption says otherwise`, { element: domPath });
            }
            const self = noteLang(element, node('Figure', parent, { alt, ...langAttrs(element) }));
            ownerByElement.set(single, self.path);
            structPathByElement.set(single, self.path);
            pushImage({ path: self.path, element: single, kind: 'img', tag: 'Figure', src: currentSourceOf(single), alt, box: 'content', domPath });
            captionInto(element, self);
            return;
        }
        // A `<figure>` whose content is ONE page of another PDF is a Figure with its Caption inside, for the same 8.2.5.27 reason as one image (the validator folds a Div, so a Caption beside the Figure in a Div is a Caption in the middle of the Div's parent — measured on the embedded-PDF round's real print, `Sect` with the Caption as its fourth child).
        const content = [...element.children].filter((child) => child.tagName !== 'FIGCAPTION');
        if (content.length === 1 && facsimileOf(content[0])) {
            captionInto(element, facsimileFigure(content[0], parent, element));
            return;
        }
        // One drawing, a `<canvas>` or an `<svg>`, is a Figure like one image: its own branch tags it, and the Caption goes inside. A drawing that made no Figure (one declared decorative, a continuation) leaves its caption to the wrapper below.
        const drawing = content.length === 1 && (content[0].tagName === 'CANVAS' || content[0].tagName.toLowerCase() === 'svg') ? content[0] : null;
        if (drawing) {
            const before = parent.kids.length;
            visit(drawing, parent);
            const made = parent.kids.length > before ? parent.kids[parent.kids.length - 1] : null;
            if (made?.tag === 'Figure') {
                Object.assign(made.attrs, langAttrs(element));
                captionInto(element, noteLang(element, made));
                return;
            }
        }
        const figcaption = element.querySelector(':scope > figcaption');
        const self = noteLang(element, node(figcaption ? 'Aside' : 'Div', parent, langAttrs(element)));
        for (const child of element.children) if (child !== drawing) visit(child, self);
        const captions = self.kids.filter((k) => k.tag === 'Caption');
        self.kids = [...self.kids.filter((k) => k.tag !== 'Caption'), ...captions];
    };
    /**
     * Walk an element that means nothing of its own and is laid out inline: the `<span>` rule.
     *
     * @remarks
     * A `lang` makes it a `Span` that can carry the language. Without one it is a styling hook whose text belongs to whatever owns it, so it introduces no element; laid out as a block it is an anonymous block box (`visitGrouped`; *a child is a block by its computed display, not by its tag*, DESIGN.md S75). Shared by the `SPAN` branch and by an inferred custom element (*the printer guesses, says so, and withdraws the claim*, S90).
     *
     * @returns What the element became.
     */
    const visitAsSpan = (element: Element, parent: StructureNode): 'Span'|'P'|'transparent' => {
        const declared = langAttrs(element);
        if (declared.lang) {
            const self = noteLang(element, node('Span', parent, declared));
            ownerByElement.set(element, self.path);
            blockIfDisplayed(element, self);
            for (const child of element.children)
                visit(child, self);
            return 'Span';
        }
        if (isBlockLevel(element))
            return visitGrouped(element, parent) ? 'P' : 'transparent';
        for (const child of element.children)
            visit(child, parent);
        return 'transparent';
    };
    /**
     * Walk an element that means nothing of its own and is laid out as a block: the `<div>` rule.
     *
     * @remarks
     * It earns a `Div` only when it groups block-level children; otherwise it is transparent and its own inline content goes into an anonymous `P` (`visitGrouped`). E12F (`structure-tree.md`) adds the one exception: an element that declares a `lang` has something to say about its subtree, so it becomes an element that can carry it — a `Div` when it groups blocks and a `Span` when it does not, the same division a `span[lang]` has always made. Shared by the `DIV` branch and by an inferred custom element (*the printer guesses, says so, and withdraws the claim*, S90).
     *
     * @returns What the element became.
     */
    const visitAsDiv = (element: Element, parent: StructureNode): 'Div'|'Span'|'P'|'transparent' => {
        const grouping = [...element.children].some(isBlockLevel);
        const declared = langAttrs(element);
        const self = grouping
            ? noteLang(element, node('Div', parent, declared))
            : declared.lang
                ? noteLang(element, node('Span', parent, declared))
                : parent;
        const anonymous = visitGrouped(element, self);
        return self !== parent ? (self.tag as 'Div'|'Span') : anonymous ? 'P' : 'transparent';
    };
    /**
     * Paint what an artifact holds that is not text: every `<img>` and every outermost `<svg>` in it, the element itself included, owned by the artifact.
     *
     * @remarks
     * ponytail: images and drawings only. A raster background or a `<canvas>` inside an `aria-hidden` element is not collected and so not painted; collect them here when a document needs one.
     */
    const artifactInk = (element: Element, descriptor: ArtifactDescriptor) => {
        for (const inner of [element, ...element.querySelectorAll('img, svg')]) {
            const domPath = domPathOf(inner, container);
            if (inner.tagName === 'IMG') {
                pushImage({ path: descriptor.path, element: (inner as HTMLElement), kind: 'img', tag: 'Artifact', src: currentSourceOf((inner as HTMLImageElement)), box: 'content', domPath });
            } else if (inner.tagName.toLowerCase() === 'svg' && !inner.parentElement?.closest('svg')) {
                const root: SvgRoot = { element: ((inner as unknown) as SVGSVGElement), owner: descriptor.path, tag: 'Artifact', domPath };
                svgs.push(root);
                svgRootOf.set(inner, root);
            }
        }
    };
    /** The role an element declares that the walk honours: the first token of `role` that {@link ARIA_TAGS} names, else the first token, else `''`. */
    const roleOf = (element: Element): string => {
        const tokens = (element.getAttribute('role') ?? '').trim().toLowerCase().split(/\s+/u).filter(Boolean);
        return tokens.find((t) => t in ARIA_TAGS) ?? tokens[0] ?? '';
    };
    /**
     * Honour a declared ARIA role, in both modes and on every element (*the printer guesses, says so, and withdraws the claim*, S90).
     *
     * @returns True when the role decided the element; false leaves it to its own tag.
     * @throws {CasterError} A `heading` without an `aria-level` from 1 to 6, an `img` without an `aria-label`, a `listitem` outside a list.
     */
    const visitByRole = (element: Element, parent: StructureNode): boolean => {
        const tag = element.tagName;
        const role = roleOf(element);
        if (role === '' || ROLE_NOT_ASKED.has(tag) || NATIVE_ROLE[tag] === role) return false;
        const domPath = domPathOf(element, container);
        const name = `<${tag.toLowerCase()} role="${role}">`;
        const mapped = ARIA_TAGS[role];
        if (mapped === undefined || (mapped === 'transparent' && LIST_TAGS.has(tag))) {
            warnings.push(`caster: ${name} at ${domPath}: ${mapped === undefined ? 'the role has no PDF structure type' : 'a list made transparent would strand its items outside any list'}, so the element is printed by its own tag`);
            return false;
        }
        if (mapped === 'transparent') {
            visitGrouped(element, parent);
            return true;
        }
        if (mapped === 'P') {
            visitAsOwner(element, parent, 'P');
            return true;
        }
        if (mapped === 'H') {
            const level = (element.getAttribute('aria-level') ?? '').trim();
            if (!/^[1-6]$/u.test(level)) {
                throw new CasterError(`caster: ${name} at ${domPath} carries no aria-level from 1 to 6; a heading's level is what places it in the outline, and the printer does not guess one`, { element: domPath });
            }
            visitAsHeading(element, parent, Number(level));
            return true;
        }
        if (mapped === 'L') {
            // A list of plain boxes paints no marker, and `None` is the numbering of a list whose items carry no `Lbl`; a reified marker in an item says otherwise, and then the computed style names the numbering as it does for a `<ul>`.
            const labelled = [...element.children].some((child) => { const marker = child.querySelector('.marker'); return marker !== null && isLabelled(marker); });
            const listStyle = getComputedStyle(element).listStyleType;
            const listNumbering = labelled ? LIST_NUMBERING[listStyle] : 'None';
            if (!listNumbering) {
                throw new CasterError(`caster: list-style-type ${JSON.stringify(listStyle)} on ${name} at ${domPath} has no /ListNumbering name; a list whose items carry Lbl kids may not be None`, { element: domPath });
            }
            visitAsList(element, parent, listNumbering);
            return true;
        }
        if (mapped === 'LI') {
            if (parent.tag !== 'L') {
                throw new CasterError(`caster: ${name} at ${domPath} is outside a list; an LI belongs to an L, and the element's parent became a ${parent.tag}`, { element: domPath });
            }
            visitAsListItem(element, parent);
            return true;
        }
        if (role === 'figure') {
            visitAsFigure(element, parent);
            return true;
        }
        // `img`: a picture the document drew out of boxes. A raster background with a label was answered above, as a Figure with its pixels; this is the same claim with no pixels of its own, so the Figure owns what the element paints.
        const label = (element.getAttribute('aria-label') ?? '').trim();
        if (label === '') {
            if (options.standard !== 'none') throw new CasterError(`caster: ${name} at ${domPath} carries no aria-label; an image is either described or declared decorative with aria-hidden="true", and guessing is not one of the options`, { element: domPath });
            warnings.push(`caster: ${name} at ${domPath} carries no aria-label, so it printed as a Figure with no /Alt; the file does not claim PDF/UA-2`);
        }
        const self = noteLang(element, node('Figure', parent, { alt: label, ...langAttrs(element) }));
        ownerByElement.set(element, self.path);
        if ((element.textContent ?? '').trim() !== '')
            block((element as HTMLElement), self.tag, self.path);
        for (const child of element.children)
            visit(child, self);
        return true;
    };
    /**
     * Tag one element under `parent` by the v2 table, and walk what it holds.
     *
     * @throws {CasterError} As {@link walkStructure}, at the element that refuses.
     * @throws {UnknownElementError} An element the table does not name, and every custom element.
     */
    const visit = (element: Element, parent: StructureNode) => {
        // An element that is not displayed is on no page (*a box Cicero kept and did not display is on no page*, S67), so it has no place in the tree and nothing under it does. It was never asked before because nothing presented one inside content: since Cicero's *every branch gets a place* (2026-09-21) a box outside a fragment's interval is kept in the clone with the word `away` (`display: none`, an inline style until 2026-10-11), its text emptied, so that the author's structural selectors hold on every page — and visited, a kept anchor refused the export as a link with no rectangles and a kept heading as one that painted no text. Engine-blind on purpose: an author's own `display: none` box is no more on a page than the engine's.
        if (getComputedStyle(element).display === 'none') return;
        // R4: a continuation is the tail of a block that is already in the tree. It introduces no node; it takes its twin's, so its words are measured and their marked content belongs to the element the author wrote.
        const twin = options.twinOf?.(element) ?? null;
        if (twin) {
            continueAs(element, twin, parent);
            // A continuation whose words would land outside the tree is refused, once, at its top — the element whose own parent continues nothing. Since *a continuation mirrors its source element by element* (S29) every element under it was visited, so this cannot mean "the pairing missed a stamp": it means the twin produced no owner anywhere under it, which is a gap in the walk's own tag table rather than a host fact, and the message says so. Words are the operative term: Cicero emits a childless continuation for a block whose box carries past a cut with no content behind it (`applyCarriedRemainder`; measured on a container directive that broke over a page), and refusing that would refuse a document the printer renders perfectly.
            const parentTwin = element.parentElement ? options.twinOf?.(element.parentElement) ?? null : null;
            if (!parentTwin && (element.textContent ?? '').trim() !== '' && !ownerByElement.has(element) && ![...element.querySelectorAll('*')].some((el) => ownerByElement.has(el))) {
                throw new CasterError(`caster: the continuation at ${domPathOf(element, container)} could not be joined to ${domPathOf(twin, container)}, because nothing under that element owns a structure element. Its words would land outside the tree entirely.`, { element: domPathOf(twin, container) });
            }
            return;
        }
        // A repeated header or footer group (`data-pdf-repeat`, which the adapter stamps on every copy an engine repeated; *a table Paged.js cut across pages is one table in several fragments*, DESIGN.md S63): the group the table already holds once, drawn again on a page it does not begin on. It is ink and not structure, so each of its rows is painted as a pagination artifact, as `visitTable` paints a repeated row of a table it models, and nothing is added to the tree. It has no twin, so its words are the repeat's and never the block's.
        if ((element.tagName === 'THEAD' || element.tagName === 'TFOOT') && isRepeated((element as HTMLElement))) {
            const repeatKind = element.tagName === 'THEAD' ? 'header' : 'footer';
            for (const row of element.children) {
                if (row.tagName !== 'TR') continue;
                const descriptor = artifact((row as HTMLElement), repeatKind);
                if ((row.textContent ?? '').trim() !== '')
                    block((row as HTMLElement), `artifact:${repeatKind}`, descriptor.path);
            }
            return;
        }
        // R8: the engine's own marks are transparent — Cicero's `fill`, `break` and `shell` words inside content, Paged.js's page scaffolding and its bare content `<div>` around it. Each introduces no structure node and no owner, and whatever text it holds is measured like any other — which is what makes a continuation's words belong to the source element's structure element rather than to a wrapper the author never wrote. Asked before the artifact and background branches, because a mark is the engine's whatever it paints: Paged.js's `.pagedjs_marks-cross` carries its cross as a `data:` SVG background, and read as a background it was an image with no intrinsic size. Which elements those are is the adapter's answer (`transparentOf`); the walk names no class.
        if (options.transparentOf?.(element)) {
            visitGrouped(element, parent);
            return;
        }
        const kind = artifactKindOf(element);
        if (kind !== null) {
            const descriptor: ArtifactDescriptor = artifact((element as HTMLElement), kind);
            const style = getComputedStyle(element);
            if ((element.textContent ?? '').trim() !== '')
                block((element as HTMLElement), `artifact:${kind}`, descriptor.path);
            // A transparent box paints nothing; `parseRgb` reads it as black, which drops the alpha.
            if (kind === 'layout' && style.backgroundColor !== 'rgba(0, 0, 0, 0)')
                paints.push({ path: descriptor.path, element: (element as HTMLElement), rgb: parseRgb(style.backgroundColor) });
            // An artifact is outside the tree entirely, and so is everything in it — but it is still painted, so an image inside one is collected here and owned by the artifact. That is what a logo in a running header is: the same XObject on every page, never a Figure, never in the tree, and never asked for an /Alt it has no business carrying.
            for (const inner of element.querySelectorAll('img')) {
                pushImage({
                    path: descriptor.path,
                    element: inner,
                    kind: 'img',
                    tag: 'Artifact',
                    src: currentSourceOf(inner),
                    box: 'content',
                    domPath: domPathOf(inner, container),
                });
            }
            return;
        }
        // `aria-hidden="true"` is the author saying a reader is not to be told about this element, which is what an artifact is (*the printer guesses, says so, and withdraws the claim*, S90). Honoured on every element, where it was read on an `<svg>` alone although the refusal below has always offered it as the way to declare an element decorative. Asked after the twin, the engine's marks and the declared artifacts on purpose: Cicero hides every continuation and every repeated copy from assistive technology (`engine-cicero/src/root.js`), and each of those is already answered above. An `<svg>` keeps its own branch, which reads the same attribute and paints the drawing.
        if (element.getAttribute('aria-hidden') === 'true' && element.tagName.toLowerCase() !== 'svg') {
            const descriptor = artifact((element as HTMLElement), 'layout');
            if ((element.textContent ?? '').trim() !== '')
                block((element as HTMLElement), 'artifact:layout', descriptor.path);
            artifactInk(element, descriptor);
            return;
        }
        // A raster background is decoration by default: nothing in the document says what it depicts, so nothing in the tree can claim it means anything. The one exception is an element that says otherwise itself, with role="img" and a label, and then it is a Figure like any other image.
        const background = backgroundUrlOf(getComputedStyle(element));
        const backgroundLabel = element.getAttribute('role') === 'img' ? (element.getAttribute('aria-label') ?? '').trim() : '';
        if (background !== null) {
            if (backgroundLabel !== '') {
                const self = node('Figure', parent, { alt: backgroundLabel });
                ownerByElement.set(element, self.path);
                pushImage({
                    path: self.path,
                    element: (element as HTMLElement),
                    kind: 'background',
                    tag: 'Figure',
                    src: background,
                    alt: backgroundLabel,
                    box: 'padding',
                    domPath: domPathOf(element, container),
                });
                for (const child of element.children)
                    visit(child, self);
                return;
            }
            const descriptor: ArtifactDescriptor = {
                path: `artifact:background:${domPathOf(element, container)}`,
                kind: 'layout',
                ...ARTIFACT_KINDS.layout,
            };
            artifacts.push(descriptor);
            pushImage({
                path: descriptor.path,
                element: (element as HTMLElement),
                kind: 'background',
                tag: 'Artifact',
                src: background,
                box: 'padding',
                domPath: domPathOf(element, container),
            });
            // The background is an artifact; the element's own content is not, so the walk continues into it rather than swallowing a page of text.
            for (const child of element.children)
                visit(child, parent);
            return;
        }
        const tag = element.tagName;
        // The engine's and the editing tools' own elements are refused before anything is asked of them (*the printer guesses, says so, and withdraws the claim*, S90): a role on one does not make the host's defect a document.
        if (OWN_ELEMENT.test(tag)) {
            throw new UnknownElementError(`caster: <${tag.toLowerCase()}> at ${domPathOf(element, container)} is a custom element, and the printer has no tag for it; a custom element inside a printed document has to resolve to real markup before the print, or be declared decorative with aria-hidden="true"`, { element: domPathOf(element, container), tag: tag.toLowerCase() });
        }
        // A page of another PDF (`images/facsimile.js`, DESIGN.md S80), in either of its two forms ({@link facsimileOf}): the author's `<object type="application/pdf">` — the ORIGINAL, which under Cicero is parked and owns the structure, as an `<img>` original does — and the copy Cicero's presenter writes for every page that shows it, `<object is="beltype-facsimile" data-src data-page role="img" aria-label>`, whose `<canvas>` the preview drew. Neither is descended into: the original's fallback `<img>` is not a second picture and the copy's canvas is not an image the printer sees — the printer embeds the page itself as vectors. The element is a Figure whose /Alt is the fallback's `alt` (the copy carries it as `aria-label`); one with none is refused, as a canvas's is. Both forms name the page by the same key (`facsimile:<url>#<page>`), so the copy's record, pushed by `continueAs`, and the original's are one picture. It is asked before the declared role, since the copy carries `role="img"` for the preview and the role's generic Figure would walk into its canvas.
        if (facsimileOf(element)) {
            facsimileFigure(element, parent, element);
            return;
        }
        // A declared role decides the element on every tag, native ones included (*the printer guesses, says so, and withdraws the claim*, S90).
        if (visitByRole(element, parent)) return;

        // The belt's relocated footnote (`core/src/plugins/inline-footnotes.js` emits `<span class="footnote">`). PDF 2.0's `FENote` is exactly this: a note whose reference is elsewhere in the flow. It owns its own text.
        if (element.classList.contains('footnote')) {
            const self = noteLang(element, node('FENote', parent, langAttrs(element)));
            // The note's number, the way the `LI` branch below takes an item's: a paginator that lays the note out as `display: list-item` with a `::marker` reading its counter gets that marker reified into a leading `span.marker` (`adapters/reify.js`, its second moment), and the marker is the note's `Lbl`. An empty marker is no marker, for the reason the `LI` branch gives.
            const marker = (element.querySelector('.marker') as HTMLElement|null);
            if (marker && isLabelled(marker)) {
                const label = node('Lbl', self);
                ownerByElement.set(marker, label.path);
                if (marker.hasAttribute(SHAPE_ATTRIBUTE)) shapes.push({ element: (marker as HTMLElement), owner: label.path, domPath: domPathOf(marker, container) });
            }
            ownerByElement.set(element, self.path);
            // A note laid out as a block owns its own text and is measured as a block, the way an `<li>` is: the belt's relocated footnote is an inline span inside a paragraph and rides that paragraph's measurement, but a paginator's footnote area holds the note as a block of its own (Paged.js: `display: list-item` in `.pagedjs_footnote_area`), and a block nobody measures is a note with no content — its words absent from the file and its destination refused.
            if (isBlockLevel(element) && (element.textContent ?? '').trim() !== '')
                block((element as HTMLElement), self.tag, self.path);
            for (const child of element.children) {
                if (child === marker)
                    continue;
                visit(child, self);
            }
            return;
        }

        // KaTeX (`rehype-katex`). The rendered markup is a tree of positioned spans that says nothing a reader wants; what says something is the `<annotation encoding="application/x-tex">` KaTeX writes into the MathML half, which is the author's own source. So the whole span is one `Formula` whose `/Alt` is that TeX, and every descendant is transparent — the glyphs are measured and painted, and none of them owns a structure element of its own.
        if (element.classList.contains('katex')) {
            const domPath = domPathOf(element, container);
            const annotation = element.querySelector('annotation[encoding="application/x-tex"]');
            const alt = (annotation?.textContent ?? '').trim();
            if (alt === '') {
                if (options.standard !== 'none') throw new CasterError(`caster: the KaTeX formula at ${domPath} carries no <annotation encoding="application/x-tex">; a Formula without /Alt is a PDF/UA-2 failure and the TeX is the only description the document has`, { element: domPath });
                warnings.push(`caster: the KaTeX formula at ${domPath} carries no <annotation encoding="application/x-tex">, so it printed as a Formula with no /Alt; the file does not claim PDF/UA-2`);
            }
            const self = noteLang(element, node('Formula', parent, { alt, ...langAttrs(element) }));
            ownerByElement.set(element, self.path);
            structPathByElement.set(element, self.path);
            // Every descendant belongs to the one Formula: KaTeX's rendered markup is positioned spans that mean nothing on their own, and the MathML half is not painted at all.
            for (const descendant of element.querySelectorAll('*')) ownerByElement.set(descendant, self.path);
            // An inline formula inside a measured block rides that block's lines, its runs owned by the Formula as a link's are by the Link, so the paragraph's marked content divides around it and the formula stands where it stands in the sentence. Measured as a block of its own, it came after all of the paragraph's words, in the tree and in the stream. A formula with no measured block around it, or one laid out as a block, is measured as its own block.
            let measured = false;
            for (let up = element.parentElement; up && up !== container && !measured; up = up.parentElement) measured = describeByBlock.has(up);
            if (isBlockLevel(element) || !measured)
                block((element as HTMLElement), self.tag, self.path);
            return;
        }
        // E12F (`structure-tree.md`) asked whether an `<hr>` inside an article should become a `Div` with a role instead. It should not: a horizontal rule is a separator the engine paints and carries no text, so it is a Layout artifact, which is what E5 already decided and what E12 leaves alone.
        if (tag === 'HR') {
            // A rule with a drawn border style (the default `inset`, or `dashed`, `groove`...) is a decorated box like any other, so the border painter draws its sides; the flat rectangle below is the `solid` rule and nothing else.
            if (hasDrawnBorder(getComputedStyle(element)))
                return;
            const descriptor: ArtifactDescriptor = artifact((element as HTMLElement), 'layout');
            paints.push({ path: descriptor.path, element: (element as HTMLElement), rgb: parseRgb(getComputedStyle(element).borderTopColor) });
            return;
        }
        if (tag === 'BR')
            return;
        // `picture` and `source` are the resource-selection algorithm's own machinery. What the page painted is the `img` inside, and `currentSrc` is where that decision surfaces, so both elements are transparent.
        if (tag === 'SOURCE')
            return;
        if (tag === 'PICTURE') {
            for (const child of element.children)
                visit(child, parent);
            return;
        }
        // An inline <svg> is a picture the document drew rather than one it loaded, and the rule is that of E7 (`images.md`) for images, word for word: a title or a label makes it a Figure with an /Alt, an explicit aria-hidden or role="presentation" makes it an artifact, and neither is an export error. Its descendants are not walked — the Figure owns the whole drawing, and a <path> is not a structure element.
        if (tag.toLowerCase() === 'svg') {
            const domPath = domPathOf(element, container);
            const decorative = element.getAttribute('aria-hidden') === 'true' || element.getAttribute('role') === 'presentation';
            const title = (element.querySelector('title')?.textContent ?? '').trim();
            const label = (element.getAttribute('aria-label') ?? '').trim();
            // A <desc> is a description too (SVG 1.1 §5.4), and it is what the belt gives a Mermaid drawing whose author wrote no accTitle: the diagram's own source, which is a faithful account and never a guess (M6). A title outranks it because a title is what a reader is told first.
            const desc = (element.querySelector(':scope > desc')?.textContent ?? '').replace(/\s+/gu, ' ').trim();
            const alt = title || label || desc;
            if (decorative) {
                const descriptor: ArtifactDescriptor = {
                    path: `artifact:svg:${domPath}`,
                    kind: 'layout',
                    ...ARTIFACT_KINDS.layout,
                };
                artifacts.push(descriptor);
                ownerByElement.set(element, descriptor.path);
                const artifactRoot: SvgRoot = { element: ((element as unknown) as SVGSVGElement), owner: descriptor.path, tag: 'Artifact', domPath };
                svgs.push(artifactRoot);
                svgRootOf.set(element, artifactRoot);
                return;
            }
            if (alt === '') {
                if (options.standard !== 'none') throw new CasterError(`caster: the inline <svg> at ${domPath} carries neither a <title>, an aria-label nor a <desc>; an SVG is either described or declared decorative with aria-hidden="true", and guessing is not one of the options`);
                warnings.push(`caster: the inline <svg> at ${domPath} carries neither a <title>, an aria-label nor a <desc>, so it printed as a Figure with no /Alt; the file does not claim PDF/UA-2`);
            }
            const self = node('Figure', parent, { alt });
            ownerByElement.set(element, self.path);
            structPathByElement.set(element, self.path);
            const figureRoot: SvgRoot = { element: ((element as unknown) as SVGSVGElement), owner: self.path, tag: 'Figure', alt, domPath };
            svgs.push(figureRoot);
            svgRootOf.set(element, figureRoot);
            return;
        }
        if (tag === 'IMG') {
            const domPath = domPathOf(element, container);
            const image = element;
            const alt = image.getAttribute('alt');
            const named = `<img src="${image.getAttribute('src') ?? (image as HTMLImageElement).currentSrc}"> at ${domPath} has no alt attribute`;
            if (alt === null && options.standard !== 'none') {
                throw new CasterError(`caster: ${named}; every image is either described or declared decorative, and guessing is not one of the options`);
            }
            if (alt === null) warnings.push(`caster: ${named}, so it printed as a Figure with no /Alt; the file does not claim PDF/UA-2`);
            else if (alt.trim() === '') {
                // alt="" is a claim, not an omission: the author has said the image carries nothing a reader needs, and the only honest way to paint that is as an artifact outside the tree.
                const descriptor: ArtifactDescriptor = {
                    path: `artifact:image:${domPath}`,
                    kind: 'layout',
                    ...ARTIFACT_KINDS.layout,
                };
                artifacts.push(descriptor);
                pushImage({
                    path: descriptor.path,
                    element: (image as HTMLElement),
                    kind: 'img',
                    tag: 'Artifact',
                    src: currentSourceOf((image as HTMLImageElement)),
                    box: 'content',
                    domPath,
                });
                return;
            }
            const self = node('Figure', parent, alt === null ? {} : { alt });
            ownerByElement.set(image, self.path);
            structPathByElement.set(image, self.path);
            pushImage({ path: self.path, element: (image as HTMLElement), kind: 'img', tag: 'Figure', src: currentSourceOf((image as HTMLImageElement)), ...(alt === null ? {} : { alt }), box: 'content', domPath });
            return;
        }
        if (tag === 'CANVAS') {
            const domPath = domPathOf(element, container);
            const canvas = element;
            const label = (canvas.getAttribute('aria-label') ?? '').trim();
            if (label === '') {
                if (options.standard !== 'none') throw new CasterError(`caster: <canvas> at ${domPath} carries no aria-label; a canvas is pixels the document says nothing about, so nothing but the author can say what it depicts`);
                warnings.push(`caster: <canvas> at ${domPath} carries no aria-label, so it printed as a Figure with no /Alt; the file does not claim PDF/UA-2`);
            }
            const self = node('Figure', parent, { alt: label });
            ownerByElement.set(canvas, self.path);
            pushImage({ path: self.path, element: (canvas as HTMLElement), kind: 'canvas', tag: 'Figure', src: `canvas:${domPath}`, alt: label, box: 'content', domPath });
            return;
        }
        /**
         * `<figure>`, and the shape P7's correction settles on after veraPDF answered.
         *
         * v1 made every `<figure>` a `Figure` and threw when it held no `<img>`. P7 asks for a `Div` instead, because BelType's figure directive wraps a table, a code block or an SVG as readily as a raster and the rule of E7 (`images.md`) already makes an `<img>` a `Figure` on its own. Both halves of that are right, and taking only the second half is what this branch does — because taking the first one failed PDF/UA-2, measured.
         *
         * What veraPDF 1.30.2 said, on the specimen, with everything else passing (1726 rules, 30 717 checks): ISO 14289-2:2024 **8.2.5.27 t1**, *"When present, the Caption element shall be the first or the last child of the structure element"* — `Structure element 131 0 obj contains Caption as its 3 child instead of first or last one`, where 131 is a `Sect` whose own kids are `H3, Div, Div, P` and whose two `Div`s each hold `Figure, Caption`. The validator folds a `Div` when it computes a parent's kid types, so the effective list is `H3, Figure, Caption, Figure, Caption, P` and the first Caption is the third child — which is exactly the ordinal the message names. A grouping box does not shield a Caption from the rule.
         *
         * So: a `<figure>` whose content is one image is a `Figure`, with the `Caption` inside it where 8.2.5.27 wants it — v1's tag, kept. A `<figure>` holding anything else was a `Div`, which is what P7 opened the door for, until veraPDF failed the same rule through it (see CHANGELOG, Unreleased): now one canvas or SVG is a `Figure` like one image, and other content with a caption is an `Aside` (`visitAsFigure`). What is gone either way is v1's throw.
         */
        if (tag === 'FIGURE') {
            visitAsFigure(element, parent);
            return;
        }
        if (tag === 'FIGCAPTION') {
            if (!element.parentElement || (element.parentElement.tagName !== 'FIGURE' && roleOf(element.parentElement) !== 'figure')) {
                throw new CasterError(`caster: <figcaption> at ${domPathOf(element, container)} is outside a <figure>`, { element: domPathOf(element, container) });
            }
            const self = node('Caption', parent);
            ownerByElement.set(element, self.path);
            block((element as HTMLElement), self.tag, self.path);
            for (const child of element.children) visit(child, self);
            return;
        }
        if (tag === 'TABLE') {
            visitTable((element as HTMLElement), parent);
            return;
        }
        // Reached only inside a `role="presentation"` table, whose parts are styling boxes rather than structure: a cell that groups blocks is a Div like any other grouping box, and everything else is transparent.
        if (tag === 'COLGROUP' || tag === 'COL')
            return;
        if (tag === 'CAPTION' || tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT' || tag === 'TR') {
            for (const child of element.children)
                visit(child, parent);
            return;
        }
        if (tag === 'TH' || tag === 'TD') {
            const grouping = [...element.children].some(isBlockLevel);
            const self = grouping ? node('Div', parent) : parent;
            visitGrouped(element, self);
            return;
        }
        if (tag === 'SECTION' || tag === 'ARTICLE') {
            const self = noteLang(element, node('Sect', parent, langAttrs(element)));
            visitGrouped(element, self);
            return;
        }
        if (tag === 'DIV') {
            visitAsDiv(element, parent);
            return;
        }
        const heading = HEADING.exec(tag);
        if (heading) {
            visitAsHeading(element, parent, Number(heading[1]));
            return;
        }
        if (tag === 'P') {
            visitAsOwner(element, parent, 'P');
            return;
        }
        // `<menu>` is HTML's other unordered list.
        if (tag === 'UL' || tag === 'OL' || tag === 'MENU') {
            const listStyle = getComputedStyle(element).listStyleType;
            const listNumbering = LIST_NUMBERING[listStyle];
            if (!listNumbering) {
                throw new CasterError(`caster: list-style-type ${JSON.stringify(listStyle)} has no /ListNumbering name; a list whose items carry Lbl kids may not be None`);
            }
            visitAsList(element, parent, listNumbering);
            return;
        }
        if (tag === 'LI') {
            visitAsListItem(element, parent);
            return;
        }
        if (tag === 'A' && element.hasAttribute('href')) {
            const self = noteLang(element, node('Link', parent, langAttrs(element)));
            ownerByElement.set(element, self.path);
            blockIfDisplayed(element, self);
            // An anchor the engine rendered on no page has no rectangles at all, so there is nothing to annotate here (*the engine stopped showing the original*, S47). The `Link` node stands; the annotation is re-homed onto the fragment that renders it at the end of the walk, and an anchor no fragment renders on the page its block begins on is dropped — which is exactly what the page's own clip did to it before the first fragment was constructed.
            if (!options.renders || options.renders(element)) annots.push(linkRects((element as HTMLAnchorElement), self.path));
            else unrenderedAnchors.push({ element: (element as HTMLAnchorElement), path: self.path });
            for (const child of element.children)
                visit(child, self);
            return;
        }
        if (tag === 'EM' || tag === 'STRONG') {
            const self = noteLang(element, node(tag === 'EM' ? 'Em' : 'Strong', parent, langAttrs(element)));
            ownerByElement.set(element, self.path);
            blockIfDisplayed(element, self);
            for (const child of element.children)
                visit(child, self);
            return;
        }
        // E12F (`structure-tree.md`), four inline tags that all come out as a `Span` and differ only in what the Span carries.
        //
        // `<abbr title>` carries `/E`, the expansion text: a reader that meets "PDF" and is told "Portable Document Format" can say the words, which is the whole point of the entry, and it is still an allowed entry of a structure element in ISO 32000-2 — probed against veraPDF's PDF/UA-2 profile rather than assumed, and the probe passed with no rule touched.
        //
        // `<sub>` and `<sup>` carry the Layout attribute `/TextPosition`. The 2.0 standard namespace does have a `Sub` element, and it is not this: 32000-2 defines `Sub` as a *sub-division of a block*, so tagging a subscript with it would say the run is a section of the paragraph. `/TextPosition` is the attribute that means what CSS means, and both `/Sub` and `/Sup` passed the same probe.
        //
        // `<code>` and `<kbd>` carry nothing at all. `Code` exists in the PDF 1.7 namespace and was dropped from the 2.0 one, and veraPDF says so: a `Code` element under `http://iso.org/pdf2/ssn` fails ISO 14289-2:2024 8.2.4 t1 with "Non-standard structure type ... is not mapped to a standard type", and a `/RoleMap` on the StructTreeRoot does not rescue it because a 2.0 namespace maps through its own `/RoleMapNS`. A `Span` is what is left, and the monospaced face is what a sighted reader has.
        if (tag === 'ABBR') {
            const expansion = (element.getAttribute('title') ?? '').trim();
            const self = noteLang(element, node('Span', parent, { ...langAttrs(element), ...(expansion ? { expansion } : {}) }));
            ownerByElement.set(element, self.path);
            blockIfDisplayed(element, self);
            for (const child of element.children)
                visit(child, self);
            return;
        }
        if (tag === 'SUB' || tag === 'SUP') {
            const self = noteLang(element, node('Span', parent, { ...langAttrs(element), textPosition: tag === 'SUB' ? 'Sub' : 'Sup' }));
            ownerByElement.set(element, self.path);
            blockIfDisplayed(element, self);
            for (const child of element.children)
                visit(child, self);
            return;
        }
        if (tag === 'CODE' || tag === 'KBD') {
            const self = noteLang(element, node('Span', parent, langAttrs(element)));
            ownerByElement.set(element, self.path);
            blockIfDisplayed(element, self);
            for (const child of element.children)
                visit(child, self);
            return;
        }
        if (tag === 'SPAN') {
            visitAsSpan(element, parent);
            return;
        }
        // ---- v2: BelType's emitted vocabulary (P7) ----------------------------

        // `BlockQuote` is not in the PDF 2.0 standard namespace (`structure-tree.md` §"What is not in the PDF 2.0 standard namespace"), and a non-standard type under `http://iso.org/pdf2/ssn` fails ISO 14289-2:2024 8.2.4 t1 with no `/RoleMap` able to rescue it — the same finding that put `<code>` into a `Span`. A quotation is a group of blocks, so `Div` is what is left and it is honest.
        if (tag === 'BLOCKQUOTE') {
            const self = noteLang(element, node('Div', parent, langAttrs(element)));
            visitGrouped(element, self);
            return;
        }

        // A fenced code block. `<pre>` is a paragraph whose whitespace is significant — there is no PDF element for preformatted text, and `P` is what a reader is meant to read it as; the monospaced face is what a sighted reader has, exactly as for `<code>`.
        if (tag === 'PRE') {
            visitAsOwner(element, parent, 'P');
            return;
        }

        // A definition list is a list: `L` with one `LI` per term-plus-definition run, the `<dt>` as the `Lbl` and the `<dd>` as the `LBody`. `/ListNumbering` is `None`, because a `<dl>` paints no marker — and `None` is legal precisely where no item carries a `Lbl`… which is not this shape. So the value is `Unordered`, the 2.0 name for a list whose labels are not a counting sequence, and the terms are the labels.
        if (tag === 'DL') {
            const self = noteLang(element, node('L', parent, { listNumbering: 'Unordered', ...langAttrs(element) }));
            let item: StructureNode|null = null;
            for (const child of element.children) {
                const childTag = child.tagName;
                if (childTag === 'DT') {
                    item = node('LI', self);
                    const label = node('Lbl', item);
                    ownerByElement.set(child, label.path);
                    block((child as HTMLElement), label.tag, label.path);
                    for (const grandchild of child.children) visit(grandchild, label);
                    continue;
                }
                if (childTag === 'DD') {
                    if (!item) item = node('LI', self);
                    const body = node('LBody', item);
                    ownerByElement.set(child, body.path);
                    block((child as HTMLElement), body.tag, body.path);
                    for (const grandchild of child.children) visit(grandchild, body);
                    continue;
                }
                // A `<div>` wrapper around a term-and-definition pair is legal HTML and is transparent here.
                if (childTag === 'DIV') { for (const grandchild of child.children) visit(grandchild, self); continue; }
                visit(child, self);
            }
            return;
        }
        if (tag === 'DT' || tag === 'DD') {
            throw new CasterError(`caster: <${tag.toLowerCase()}> at ${domPathOf(element, container)} is outside a <dl>`, { element: domPathOf(element, container) });
        }

        // A disclosure widget groups blocks; its summary is the one that is always visible, and a `P` is what it reads as. Whether the engine painted the closed state is the engine's business — the walk tags what is in the DOM and the measurement finds no rectangle for what is not painted, which is the pruning rule everything else relies on.
        if (tag === 'DETAILS') {
            const self = noteLang(element, node('Div', parent, langAttrs(element)));
            visitGrouped(element, self);
            return;
        }
        if (tag === 'SUMMARY') {
            visitAsOwner(element, parent, 'P');
            return;
        }

        // The belt's `@toc` emits a `<nav>` of nested lists, and so does the site chrome. `Div` groups them; each `<ul>` inside becomes an `L` by its own branch. Tagging the `nav` itself an `L` would claim the wrapper is the list, which it is not when there are two.
        // `<address>`, `<hgroup>` and `<search>` are grouping elements of the same kind (codeberg.org/BelType/caster issue 19).
        if (tag === 'NAV' || tag === 'HEADER' || tag === 'FOOTER' || tag === 'ASIDE' || tag === 'MAIN' || tag === 'BODY' || tag === 'ADDRESS' || tag === 'HGROUP' || tag === 'SEARCH') {
            const self = noteLang(element, node('Div', parent, langAttrs(element)));
            visitGrouped(element, self);
            return;
        }

        // Every remaining inline that carries meaning a reader can be told about, and nothing else: a `Span`, with the language when the element declares one. `Em` and `Strong` have their own elements and are handled above; `<i>` and `<b>` deliberately do not get them, because CSS Fonts' italic is not emphasis and PDF's `Em` is.
        if (INLINE_SPANS.has(tag)) {
            const self = noteLang(element, node('Span', parent, langAttrs(element)));
            ownerByElement.set(element, self.path);
            blockIfDisplayed(element, self);
            for (const child of element.children) visit(child, self);
            return;
        }

        // Anything with a hyphen in its tag name is a custom element, and the printer has no way to know what it means. Under `unknownElements: 'refuse'` it is refused by name, and the panel shows the DOM path. Under `'infer'`, the default, it is walked as CSS laid it out, which the walk already trusts for a `<div>` and a `<span>` (S75): the `<span>` rule when inline, the `<div>` rule when a block. That is the whole guess, and it is written down (*the printer guesses, says so, and withdraws the claim*, S90). The host's own `bt-` and `beltype-` elements were refused above, under both modes.
        if (tag.includes('-')) {
            const name = tag.toLowerCase();
            const domPath = domPathOf(element, container);
            if (options.unknownElements !== 'infer') {
                throw new UnknownElementError(`caster: <${name}> at ${domPath} is a custom element, and the printer has no tag for it; a custom element inside a printed document has to resolve to real markup before the print, or be declared decorative with aria-hidden="true", or the print run with unknownElements: 'infer'`, { element: domPath, tag: name });
            }
            const display = getComputedStyle(element).display;
            const asBlock = isBlockLevel(element);
            const became = asBlock ? visitAsDiv(element, parent) : visitAsSpan(element, parent);
            inferred.push({ element: domPath, tag: became, display });
            warnings.push(`caster: <${name}> at ${domPath} was laid out ${asBlock ? 'as a block' : 'inline'} (display: ${display}) and printed ${became === 'transparent' ? 'transparent' : became === 'P' ? 'as an anonymous P' : `as a ${became}`}; the file does not claim PDF/UA-2`);
            return;
        }

        throw new UnknownElementError(`caster: no tag for <${tag.toLowerCase()}> at ${domPathOf(element, container)}; the walk's table is v2 (PLAN.md P7) and refuses what it does not name rather than guessing`, { element: domPathOf(element, container), tag: tag.toLowerCase() });
    };
    const tree: StructureNode = { tag: 'Document', path: 'Document', attrs: {}, kids: [] };
    for (const child of roots)
        visit(child, tree);
    /**
     * Ink comes from where the engine rendered it (*the engine stopped showing the original*, DESIGN.md S47).
     *
     * Since *the first fragment is constructed* a divided block's original is assigned to no page: it lives once in the light DOM and every page shows a fragment of it. The walk still reads the tree from it — that is I6, and it is what every fragment continues onto — but an element on no page has no rectangle, so every collector that names one has to look elsewhere.
     *
     * **Elsewhere is the earliest fragment that holds it.** For everything above the cut that is the first fragment, which stands exactly where the original used to stand: the page the block begins on, rendered, clipped by that page's own flow. For an element past the cut it is the continuation that first carries it, which is at worst the page after the one the original was attributed to and at best the right one — where the original's own rectangle was always the page the block began on and was clipped away there. Choosing which fragment actually shows such an element is the open half of *a drawing inside a continuation was painted on no page* (S40), and it wants the clip test rather than an order; this takes the earliest, which is what the report already assumed. `blocks` and `svgs` need no re-homing — `continueAs` already pushed every fragment's own — so they are only filtered; an image is re-homed only where `continueAs` pushed no record of it (*R5's head is the page box and its foot is the cut*, S69).
     */
    if (options.renders) {
        const renders = options.renders;
        const kept = blocks.filter((b) => renders(b));
        blocks.length = 0;
        blocks.push(...kept);
        const keptSvgs = svgs.filter((r) => renders(r.element));
        svgs.length = 0;
        svgs.push(...keptSvgs);
        // `any`: the two lists hold different records that share only `element`, and a union element type would refuse the push back into either.
        for (const list of ([images, paints, shapes] as any[][])) {
            const out = [];
            for (const item of list) {
                if (renders(item.element)) { out.push(item); continue; }
                const twin = twinsOf.get(item.element)?.[0];
                // An image's twin already holds its own record, pushed by `continueAs` (*the raster half of a continuation's drawing*, S42), so re-homing the source's would place the same picture twice on one rectangle — and a second seating of one SVG `<img>` is a drawing that never enters the document (*R5's head is the page box and its foot is the cut*, DESIGN.md S69). Paints have no such record and are re-homed.
                if (twin && !(list === images && list.some((other) => other.element === twin && other.src === item.src && other.kind === item.kind))) out.push({ ...item, element: twin });
            }
            list.length = 0;
            list.push(...out);
        }
        for (const { element, path } of unrenderedAnchors) {
            const twin = twinsOf.get(element)?.[0];
            if (twin) annots.push(linkRects((twin as HTMLAnchorElement), path));
        }
    }
    // Every internal destination, resolved now that every element exists: the nearest structure element at or above the target, because a link that points at a styling `div` still has to land somewhere a reader can name.
    for (const { annot, target } of internalTargets) {
        let path = '';
        let node: Element|null = target;
        for (; node && node !== container.parentElement; node = node.parentElement) {
            const found = structPathByElement.get(node);
            if (found !== undefined) {
                path = found;
                break;
            }
        }
        if (path === '') {
            const named = `the link to ${JSON.stringify(annot.href)} points at ${domPathOf(target, container)}, which produced no structure element and has no ancestor that did`;
            if (options.standard !== 'none') throw new CasterError(`caster: ${named}; PDF/UA-2 8.8 wants a structure destination`);
            // Under `'none'` the destination is the next element in document order that produced one, where the target's own content usually begins, and the whole document when nothing after it did.
            // ponytail: a scan of the container per such link, which only a document with many of them would feel.
            const next = [...container.querySelectorAll('*')].find((el) => (target.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 && structPathByElement.has(el));
            path = next ? structPathByElement.get(next) as string : tree.path;
            warnings.push(`caster: ${named}, so its structure destination is ${next ? `${domPathOf(next, container)}, the next element that did` : 'the document'}; the file does not claim PDF/UA-2`);
        }
        (annot.dest as { page: number, xPx: number, yPx: number, structPath: string }).structPath = path;
    }
    // Headings do not skip a level on the way down. No PDF/UA-2 rule says so — the walker asserts it because a tree whose levels jump is a document outline a reader cannot navigate, and the fixture is where that is caught.
    headings.forEach((h, i) => {
        if (i > 0 && h.level > headings[i - 1].level + 1) {
            throw new CasterError(`caster: heading level jumps from H${headings[i - 1].level} to H${h.level} at ${h.path}`);
        }
    });
    /**
     * The owner key of text found directly inside `parent`: the nearest registered owner at or above it.
     *
     * @throws {CasterError} Text with no owner anywhere above it — Document and Sect may not contain content items.
     */
    const ownerOf =( parent: Element): string => {
        let node: Element|null = parent;
        for (; node && node !== container.parentElement; node = node.parentElement) {
            const owner = ownerByElement.get(node);
            if (owner !== undefined)
                return owner;
        }
        throw new CasterError(`caster: text at ${domPathOf(parent, container)} has no owning element; Document and Sect may not contain content items`);
    };
    return {
        tree,
        lang,
        blocks,
        describe: (b) => {
            const named = describeByBlock.get(b);
            if (!named)
                throw new CasterError('caster: a block the walker did not register');
            return named;
        },
        ownerOf,
        paints,
        images,
        artifacts,
        annots,
        headings,
        outline,
        langs,
        langSource,
        decorated: decoratedElements(container),
        svgs,
        markerShapes: shapes,
        tables,
        tableWarnings,
        inferred,
        warnings,
    };
}
/** Whether any side of the box has a border style that is drawn rather than filled: neither `solid`, `none` nor `hidden`. */
function hasDrawnBorder(style: CSSStyleDeclaration): boolean {
    return [style.borderTopStyle, style.borderRightStyle, style.borderBottomStyle, style.borderLeftStyle].some((side) => side !== 'solid' && side !== 'none' && side !== 'hidden');
}
/**
 * Every element in the container whose computed style puts vector ink on its own box, in DOM order.
 *
 * @remarks
 * The walk is separate from the structure walk on purpose. A decorated box is decorated whether or not the tree has an element for it — a running header is an artifact and still has a background, an `<svg>`'s own box may have a border — so the set is "every element", filtered by what the engine computed, rather than "every element the tree kept". The one exclusion the harness has is anything inside an `<svg>`, whose painting is SVG's own model and is read by `vectors/svgGeometry.js`.
 *
 * The port adds a second exclusion, and it is a correctness rule rather than a convenience: an `<hr>` is already a paint of its own. v1's `HR` branch above turns a horizontal rule into a Layout artifact and pushes a filled rectangle for it (`paints`, from `borderTopColor`), which is how a rule is painted; collecting the same element here as a decorated box would paint it a second time, as a border on a zero-height box, over the rectangle that is already there. The harness never met it because the fixture of `vector-painting.md` (E9) has no `<hr>` — and the double-handling surfaced as a crash rather than as double ink, because `vectors/cssBoxes.js`'s `boundaryPieces` answers with three pieces for a square-cornered box of zero height where every other box gives eight, and `borderSidePath` then indexes past the end (measured 2026-09-07: `{w:100,h:0}` gives 3, `{w:0,h:20}` gives 8, and a rounded `{w:100,h:0}` gives 8). That gap is real and is recorded in DESIGN.md as *`boundaryPieces` answers three pieces for a zero-height box* (S21) whatever this exclusion does about it — a zero-height bordered box an author writes some other way still meets it.
 */
function decoratedElements(container: HTMLElement): HTMLElement[] {
    const out: HTMLElement[] = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
    const consider = (element: Element) => {
        if (element.closest('svg') !== null)
            return;
        if (element.tagName === 'HR' && !hasDrawnBorder(getComputedStyle(element)))
            return; // a solid rule is painted as its own rectangle by the HR branch above; see this function's note
        if (!(element instanceof HTMLElement))
            return;
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden')
            return;
        if (paintsDecoration(style))
            out.push(element);
    };
    consider(container);
    for (let node = walker.nextNode(); node; node = walker.nextNode())
        consider((node as Element));
    return out;
}
/** Whether a tag may own marked content in v1; the emitter checks its groups against it. */
export const ownsContent = (tag: string): boolean => CONTENT_OWNERS.has(tag);
/** Whether an element with no content of its own is still worth keeping. */
export const keepWhenEmpty = (tag: string): boolean => KEEP_WHEN_EMPTY.has(tag);
/** Re-exported so a caller that only imports the walker can name a repeated row. */
export { isRepeated };
