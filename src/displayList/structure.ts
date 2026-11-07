/**
 * `displayList/structure.js` — the walk's structure tree resolved into the list's: pruned, ordered, every reference an index.
 *
 * @remarks
 * The rules are the ones the writer's `buildStructure` ran until stage 2 of `.claude/plans/the-rust-writer/plan-close-the-list.md` (the builder resolves the structure tree, Egildo's ruling of 2026-11-02), moved and not rewritten, so the file the writer makes from the result is byte for byte the one it made before. In the order they run: an element with no content, no annotation and no surviving child is pruned, a `TH` or `TD` never (`keepWhenEmpty`, an empty cell is what makes a row rectangular); the survivors are numbered in DOM order, which is the order the writer allocates their objects in; each element's `/K` is its content, its children and its annotation, sorted by reading key (the earliest content anywhere under a child, an empty child taking the key of the sibling before it), except a `TR`'s cells, which keep the column order the walk declared; an internal link's destination names the first element at or under its target, in reading order, that has content of its own, because a structure destination finds its page through that element's `/Pg`. A foreign writer inherits none of these rules: it writes the tree it is given.
 *
 * @packageDocumentation
 */

import { CasterError } from '../errors.ts';
import { keepWhenEmpty } from '../walk/structure.ts';
import { round3 } from '../coordinates/units.ts';

import type { Structure, StructAttribute, StructChild, StructElement } from '../displayList.ts';
import type { StructureNode } from '../walk/structure.ts';

/** One marked-content sequence a page opens for a structure element: where its `tag` item is, whose it is, and its reading key. */
export type ContentRef = {
  page: number;
  /** The index of its `tag` start in the page's items. */
  item: number;
  /** The owning element's structure path. */
  owner: string;
  /** Page-major, then the DOM rank of the item the sequence came from: the only ordering key the tree has. */
  seq: number;
};

/** One link annotation: its place among the document's links, the `Link` element that owns it, and the element an internal link's fragment named. */
export type LinkRef = {
  order: number;
  owner: string;
  dest?: string;
};

/** The resolved tree, and for each input the element it became. */
export type ResolvedStructure = {
  structure: Structure;
  /** By the index of the content in the input. */
  contentElement: number[];
  /** By the index of the link in the input: the element that owns its `/OBJR`. */
  linkElement: number[];
  /** By the index of the link in the input: the element its `/Dest` names, for an internal link. */
  destElement: (number | undefined)[];
  /** By the index of the heading in the input. */
  headingElement: number[];
};

/** One node as the resolver holds it: its kept kids, the content it owns, and its annotation. */
type Entry = {
  node: StructureNode;
  kids: Entry[];
  contents: { page: number, item: number, seq: number }[];
  /** The `order` of the link whose `/OBJR` it ends with; where one element owns two links, the later one, as the writer always kept it. */
  objr?: number;
  index?: number;
  /** The earliest content anywhere under it, once asked. */
  seq?: number;
};

/** No content anywhere under an element: such an element has no place in reading order of its own. */
const NO_CONTENT = Number.MAX_SAFE_INTEGER;

/**
 * Resolve the walk's tree against the content and the links a list's pages hold.
 *
 * @param tree - The walk's tree; not changed.
 * @param contents - Every content start on every page, in page order and item order.
 * @param links - Every link annotation, in any order; they are taken in `order`.
 * @param figureBoxes - Each Figure's Layout box `[x y w h]` in page points, by structure path.
 * @param headings - The structure path of each heading a bookmark names.
 * @throws {CasterError} Content or a link owned by a path no element has; a destination with no content anywhere under it; a bookmark to a heading that was pruned.
 */
export function resolveStructure(tree: StructureNode, contents: ContentRef[], links: LinkRef[], figureBoxes: Record<string, [number, number, number, number]>, headings: string[]): ResolvedStructure {
  const byPath = new Map<string, Entry>();
  const attach = (node: StructureNode): Entry => {
    const entry: Entry = { node, kids: node.kids.map(attach), contents: [] };
    byPath.set(node.path, entry);
    return entry;
  };
  const root = attach(tree);
  const owners: Entry[] = contents.map(({ page, item, owner, seq }) => {
    const entry = byPath.get(owner);
    if (!entry)
      throw new CasterError(`caster: the marked content at item ${item} of page ${page + 1} names ${owner}, and no structure element has that path`, { listItem: { page, item } });
    entry.contents.push({ page, item, seq });
    return entry;
  });
  const linkOwners: Entry[] = [];
  for (const at of links.map((_, i) => i).sort((a, b) => links[a].order - links[b].order)) {
    const owner = byPath.get(links[at].owner);
    if (!owner)
      throw new CasterError(`caster: the link at ${links[at].owner} has no structure element`);
    owner.objr = links[at].order;
    linkOwners[at] = owner;
  }
  // E11 (`tables.md`): an empty `TD` is the one element that earns its place by existing. The rest of the rule is that of E5 (`structure-tree.md`): an element the engine painted nothing for is a hole in the reading order, not an element.
  const prune = (entry: Entry): boolean => {
    entry.kids = entry.kids.filter(prune);
    if (keepWhenEmpty(entry.node.tag))
      return true;
    return entry.contents.length > 0 || entry.objr !== undefined || entry.kids.length > 0;
  };
  prune(root);
  const kept: Entry[] = [];
  const allocate = (entry: Entry) => {
    entry.index = kept.length;
    kept.push(entry);
    entry.kids.forEach(allocate);
  };
  allocate(root);
  const seqOf = (entry: Entry): number => {
    entry.seq ??= Math.min(...entry.contents.map((c) => c.seq), ...entry.kids.map(seqOf), NO_CONTENT);
    return entry.seq;
  };
  const elements: StructElement[] = kept.map((entry) => {
    // Kids are ordered by the earliest content anywhere under them, which is content order and therefore reading order. An element with no content anywhere under it (an empty `TD`, E11, `tables.md`) has no place in content order at all, so it takes the place of the last sibling that had one and keeps the position it was declared in.
    const kidSeqs = entry.kids.map(seqOf);
    let previous = Number.MIN_SAFE_INTEGER;
    for (let i = 0; i < kidSeqs.length; i++) {
      if (kidSeqs[i] === NO_CONTENT)
        kidSeqs[i] = previous;
      else
        previous = kidSeqs[i];
    }
    // A row's cells stand side by side, so reading order is column order, which is the order the walk declared them in. A row divided across pages starts its long cell on the earlier page, and content order would read that cell first.
    const declared = entry.node.tag === 'TR';
    const kidOrder = entry.kids.map((kid, index) => ({ kid, seq: kidSeqs[index], index })).sort((a, b) => declared ? a.index - b.index : a.seq - b.seq || a.index - b.index);
    entry.kids = kidOrder.map((k) => k.kid);
    const ordered: { seq: number, child: StructChild }[] = [
      ...entry.contents.map((c) => ({ seq: c.seq, child: { page: c.page, item: c.item } })),
      ...kidOrder.map(({ kid, seq }) => ({ seq, child: kid.index as number })),
      ...(entry.objr !== undefined ? [{ seq: NO_CONTENT, child: { link: entry.objr } }] : []),
    ].sort((a, b) => declared ? 0 : a.seq - b.seq);
    const { attrs, tag, path } = entry.node;
    const attributes = attributesOf(entry.node, figureBoxes[path]);
    return {
      type: tag,
      path,
      ...(attrs.lang ? { lang: attrs.lang } : {}),
      ...(attrs.alt ? { alt: attrs.alt } : {}),
      ...(attrs.expansion ? { expansion: attrs.expansion } : {}),
      ...(attrs.id ? { id: attrs.id } : {}),
      ...(attributes.length > 0 ? { attributes } : {}),
      children: ordered.map((o) => o.child),
    };
  });
  // Every kept element by its path, its kids now in reading order: a destination walks down them.
  const keptByPath = new Map<string, Entry>();
  const collect = (entry: Entry) => {
    keptByPath.set(entry.node.path, entry);
    entry.kids.forEach(collect);
  };
  collect(root);
  /** The element a destination names: the first at or under `entry`, in reading order, with content of its own. A grouping element has no `/Pg`, and a structure destination finds its page through the element's own. */
  const pageBearing = (entry: Entry): Entry | null => {
    if (entry.contents.length > 0)
      return entry;
    for (const kid of entry.kids) {
      const found = pageBearing(kid);
      if (found)
        return found;
    }
    return null;
  };
  const destElement = links.map(({ dest }) => {
    if (dest === undefined)
      return undefined;
    const target = keptByPath.get(dest);
    const found = target ? pageBearing(target) : null;
    if (!found)
      throw new CasterError(`caster: the destination at ${dest} has no content anywhere under it, so no structure destination can name a page`);
    return found.index as number;
  });
  const headingElement = headings.map((path) => {
    const entry = keptByPath.get(path);
    if (!entry)
      throw new CasterError(`caster: the heading at ${path} was pruned, so no bookmark can name it`);
    return entry.index as number;
  });
  return {
    structure: { elements },
    contentElement: owners.map((entry) => entry.index as number),
    linkElement: linkOwners.map((entry) => entry.index as number),
    destElement,
    headingElement,
  };
}

/**
 * An element's attribute objects, in the order `/A` lists them.
 *
 * @remarks
 * Attributes are a list rather than a field per owner: E5 (`structure-tree.md`) had exactly one case (`/ListNumbering`), E7 (`images.md`) added the Layout `/BBox` beside it, E11 (`tables.md`) a Table dictionary a `TD` can carry at the same time as neither, and E12F (`structure-tree.md`) `/TextPosition` for `<sub>` and `<sup>`, the one thing in the standard that means what CSS means by them (the `Sub` element is a sub-division of a block and would say something else). The Layout `/BBox` is a PDF rectangle, `[llx lly urx ury]`, not the `[x y w h]` the measurement records, because 14.8.5.4.3 says a rectangle and a reader that met four numbers meaning something else would place the figure where the page has no ink.
 *
 * @param box - The element's Figure box `[x y w h]`, when it has one.
 */
function attributesOf(node: StructureNode, box: [number, number, number, number] | undefined): StructAttribute[] {
  const attributes: StructAttribute[] = [];
  if (node.attrs.listNumbering)
    attributes.push({ O: 'List', ListNumbering: node.attrs.listNumbering });
  if (box)
    attributes.push({ O: 'Layout', BBox: [round3(box[0]), round3(box[1]), round3(box[0] + box[2]), round3(box[1] + box[3])] });
  const table = tableAttributes(node);
  if (table)
    attributes.push(table);
  if (node.attrs.textPosition)
    attributes.push({ O: 'Layout', TextPosition: node.attrs.textPosition });
  return attributes;
}

/**
 * The Table attributes of one cell.
 *
 * @remarks
 * `/Scope` on a `TH`, `/Headers` on any cell whose header set is not empty, and `/RowSpan`/`/ColSpan` only where they are above 1: a span of one is the default and writing it would be noise a reader has to skip. `/Headers` is written even where `/Scope` alone would satisfy a checker, because a `/Scope` tells a reader which axis a header claims and a `/Headers` tells it which cells; the group scopes have no PDF name at all and only `/Headers` carries their extent.
 *
 * @returns Null for a node that is not a cell, or a cell with nothing to say.
 */
function tableAttributes(node: StructureNode): StructAttribute | null {
  if (node.tag !== 'TH' && node.tag !== 'TD')
    return null;
  const { scope, headers, rowSpan, colSpan } = node.attrs;
  const dict: { Scope?: 'Column' | 'Row' | 'Both', Headers?: string[], RowSpan?: number, ColSpan?: number } = {};
  if (scope)
    dict.Scope = scope;
  if (headers && headers.length > 0)
    dict.Headers = [...headers];
  if (rowSpan && rowSpan > 1)
    dict.RowSpan = rowSpan;
  if (colSpan && colSpan > 1)
    dict.ColSpan = colSpan;
  if (Object.keys(dict).length === 0)
    return null;
  return { O: 'Table', ...dict };
}
