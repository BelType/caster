/**
 * `emit/outline.js` — the document outline: `/Outlines` built from the headings the walker found.
 *
 * Ported from `harness/src/export/outline.ts` (E12F). Guide: `docs/guide/structure-tree.md`; the experiments are `browser-to-pdf-experiments`.
 *
 * WHAT THE PORT CHANGED (PLAN.md P2; DESIGN.md P12). pdf-lib arrives through `capability('pdf')`, so this module evaluates in node with no bundle present and its tree-shaping half is testable there. The harness's `SidecarOutlineItem` is `ReportOutlineItem` here, which carries the same seven fields under the report's name.
 *
 * The harness's own header follows.
 *
 * No PDF/UA rule asks for bookmarks. Every reader has a panel for them, and a twenty-page report with no outline is a document a reader can only scroll, so an exporter that has the heading levels and the page each heading landed on has no excuse for not writing them down.
 *
 * The nesting is the heading levels and nothing else: an `H2` after an `H1` is its child, a second `H1` closes it, and an `H3` that follows an `H1` with no `H2` between them is still one level down rather than two — a reader navigates the tree it is given and a hole in the numbering is not a level of the outline. The walker already refuses a document whose levels skip *on the way down*, so this only has to be right about the way back up.
 *
 * A destination is `[<the heading's structure element> /XYZ null y null]`: the left and the zoom are null so a reader keeps the horizontal position and magnification it already had, and only `y` — the top of the heading — is asked for. That is the destination a bookmark wants; `/Fit` would throw the reader's zoom away on every click.
 *
 * The first member is the *structure element*, not the page, and that is not a refinement: PDF/UA-2 8.8 t1 says "all destinations whose target lies within the current document shall be structure destinations", and veraPDF fails a page destination in an outline item by name. The E12 spec of `structure-tree.md` asked for `[page /XYZ null y null]`; the probe said otherwise and the file follows the probe. A reader resolves the page through the element's own `/Pg`.
 *
 * @packageDocumentation
 */

import { capability } from '../capabilities.ts';

import type { ReportOutlineItem } from '../report.ts';

/** One heading, with everything the bookmark needs, in document order. */
export type OutlineHeading = {
  /** Structure path of the heading element, which is what the destination names. */
  path: string;
  /** The structure element itself, as the emitter allocated it. */
  ref: PDFRef;
  title: string;
  /** 1 to 6. */
  level: number;
  page: number;
  /** The `y` of the destination, in points, measured up from the page bottom. */
  topPt: number;
};

/** A heading placed in the outline tree. */
export type OutlineNode = {
  heading: OutlineHeading;
  depth: number;
  kids: OutlineNode[];
  /** The outline item's own object, allocated before any item is written so `/Prev`, `/Next`, `/First` and `/Last` can name it. */
  ref?: PDFRef;
};

/**
 * The headings as a tree, nested by level.
 *
 * @remarks
 * A stack of the open ancestors: a heading whose level is above the top of the stack is that heading's child, and anything else pops until it is not.
 */
function treeOf(headings: readonly OutlineHeading[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const open: OutlineNode[] = [];
  for (const heading of headings) {
    while (open.length > 0 && heading.level <= open[open.length - 1].heading.level) open.pop();
    const node: OutlineNode = { heading, depth: open.length, kids: [] };
    if (open.length === 0) roots.push(node);
    else open[open.length - 1].kids.push(node);
    open.push(node);
  }
  return roots;
}

/** Every descendant of a node, which is what an open `/Count` counts. */
function descendants(node: OutlineNode): number {
  return node.kids.reduce((total, kid) => total + 1 + descendants(kid), 0);
}

/** The written outline and the report's record of it. */
export type OutlineResult = {
  /** The `/Outlines` dictionary, to be set on the catalog. */
  ref: PDFRef;
  items: ReportOutlineItem[];
};

/**
 * Write the outline and hand back both the object and the record of it.
 *
 * @remarks
 * Every item is written open — a positive `/Count` — because a document whose bookmarks all arrive collapsed is a panel a reader has to expand before it tells them anything. The root `/Count` is therefore the whole tree, which is what 12.3.3 asks of an outline whose items are all open.
 *
 * @returns Null for a document with no headings, which writes no `/Outlines` at all.
 */
export function buildOutline(context: PDFContext, headings: readonly OutlineHeading[]): OutlineResult|null {
  const { PDFHexString, PDFName, PDFString } = capability('pdf');
  if (headings.length === 0) return null;
  const roots = treeOf(headings);
  const items: ReportOutlineItem[] = [];

  const allocate = (node: OutlineNode) => {
    node.ref = context.nextRef();
    for (const kid of node.kids) allocate(kid);
  };
  for (const root of roots) allocate(root);

  const outlinesRef = context.nextRef();

  const fill = (node: OutlineNode, parentRef: PDFRef, previous: OutlineNode|null, next: OutlineNode|null) => {
    const count = descendants(node);
    items.push({
      path: node.heading.path,
      title: node.heading.title,
      level: node.heading.level,
      depth: node.depth,
      page: node.heading.page,
      topPt: node.heading.topPt,
      count,
    });
    context.assign(
      (node.ref as PDFRef),
      context.obj({
        // A bookmark title is a text string, and a title with a `(` or a character above U+00FF in it cannot be a literal one: pdf-lib writes a literal by `charCodeAt` and escapes nothing.
        Title: /^[\x20-\x7e]*$/.test(node.heading.title) && !/[()\\]/.test(node.heading.title)
          ? PDFString.of(node.heading.title)
          : PDFHexString.fromText(node.heading.title),
        Parent: parentRef,
        ...(previous ? { Prev: (previous.ref as PDFRef) } : {}),
        ...(next ? { Next: (next.ref as PDFRef) } : {}),
        ...(node.kids.length > 0
          ? { First: (node.kids[0].ref as PDFRef), Last: (node.kids[node.kids.length - 1].ref as PDFRef) }
          : {}),
        ...(count > 0 ? { Count: count } : {}),
        // `null` is a real PDF object here rather than an omission: the array has five members and the reader keeps its own left and zoom.
        Dest: [node.heading.ref, PDFName.of('XYZ'), null, node.heading.topPt, null],
      }),
    );
    node.kids.forEach((kid, index) => fill(kid, (node.ref as PDFRef), node.kids[index - 1] ?? null, node.kids[index + 1] ?? null));
  };
  roots.forEach((root, index) => fill(root, outlinesRef, roots[index - 1] ?? null, roots[index + 1] ?? null));

  const total = roots.reduce((sum, root) => sum + 1 + descendants(root), 0);
  context.assign(
    outlinesRef,
    context.obj({
      Type: 'Outlines',
      First: (roots[0].ref as PDFRef),
      Last: (roots[roots.length - 1].ref as PDFRef),
      Count: total,
    }),
  );

  return { ref: outlinesRef, items };
}
