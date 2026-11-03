/**
 * `npm run identity -- compare <dir> [--only text,tags]`: the readers of the Rust writer's gate, holding forme's files to the oracle's on the committed lists.
 *
 * @remarks
 * `<dir>` holds what forme wrote from each list of `fixtures/lists/`: `<name>.pdf` and `<name>.records.json` (`forme write <list> --blobs <blobs> -o <name>.pdf --records <name>.records.json`). For every corpus document with a file there, four readers ask both files the same question and print the first disagreement of each (*the same list prints the same bytes*, DESIGN.md S102; the gate of `.claude/plans/the-rust-writer/plan-rust-writer.md` in the BelType monorepo):
 *
 * - **The content streams.** Each page's content, inflated by mupdf, tokenised as ISO 32000-2 §7.2 does and compared operator for operator, operands as written. A font's resource name is mapped through the page's resources to its `/BaseFont`, and a glyph string under it to the list's glyph ids: the oracle's CIDs are the glyph ids, and forme's are each glyph's place in its subset, `.notdef` first, read back through forme's `faces` record. `--only` keeps the operator families a stage has built: `tags` is `BDC`, `BMC`, `EMC`; `text` is every operator from `BT` to `ET`, and the `q`, `cm`, clip and `Q` of a `q … Q` that holds a text object. A `q … Q` that holds none is another family's and is dropped; every other operator is kept, so one no family names is a disagreement.
 * - **The records.** The oracle's records are its own, made by replaying the list through `emitStructure` in node and read through JSON, as forme's cross; `mcids` and `pens` must be equal exactly, and `kernAdjustments` and `actualTextSpans` equal.
 * - **The words.** mupdf's structured text of each page: the same characters, in order, at origins within 0.01 pt. Under an `--only` without `images`, only the characters shown in a font the page's own resources name are read, since a facsimile's words are drawn by its image.
 * - **The tree.** mupdf reads both files' structure trees element by element in allocation order and everything that points into them: every element's entries and `/K`, the ParentTree, the IDTree, `/MarkInfo`, each page's `/Tabs`, `/StructParents` and link annotations with their destinations, the outline item by item, `/PageLabels` (`treeOf`). Beside it, `recordsOf` over forme's records gives the `structure`, `links`, `outline` and `idTree` members of the committed report snapshot. The tree's families are not content, so `--only` does not restrict them.
 *
 * A list with a colour story has its content, records and words skipped by name until stage 6 writes it, and its tree read, and a list the oracle refuses (the CFF2 face) has no oracle file: its words are held to the list instead, each segment's first glyph at the segment's `x` on the run's baseline, within 0.01 pt. Reads only.
 *
 * @packageDocumentation
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as mupdf from 'mupdf';

type Token = { t: 'num' | 'name' | 'op' | 'bool' | 'null'; v: string } | { t: 'hex' | 'str'; v: Uint8Array } | { t: 'array'; v: Token[] } | { t: 'dict'; v: [string, Token][] };
type Op = { op: string; args: Token[] };
type Face = { subsetTag: string; glyphsUsed: number[] };
type Records = { mcids: number[][]; pens: unknown[]; kernAdjustments: number; actualTextSpans: number; faces: Face[] };

const WHITE = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)));
const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)$/u;
const FAMILIES = ['text', 'tags'];

/** One decoded content stream as operators, each with its operands. */
function tokenise(bytes: Uint8Array): Op[] {
  let at = 0;
  const skip = () => {
    for (;;) {
      while (at < bytes.length && WHITE.has(bytes[at])) at += 1;
      if (bytes[at] !== 37) return;
      while (at < bytes.length && bytes[at] !== 10 && bytes[at] !== 13) at += 1;
    }
  };
  const bare = () => {
    const from = at;
    while (at < bytes.length && !WHITE.has(bytes[at]) && !DELIM.has(bytes[at])) at += 1;
    return Buffer.from(bytes.subarray(from, at)).toString('latin1');
  };
  const value = (): Token | null => {
    skip();
    if (at >= bytes.length) return null;
    const c = bytes[at];
    if (c === 47) { at += 1; return { t: 'name', v: bare().replace(/#([0-9a-fA-F]{2})/gu, (_, h) => String.fromCharCode(parseInt(h, 16))) }; }
    if (c === 60 && bytes[at + 1] === 60) {
      at += 2;
      const entries: [string, Token][] = [];
      for (;;) {
        skip();
        if (bytes[at] === 62 && bytes[at + 1] === 62) { at += 2; return { t: 'dict', v: entries }; }
        const key = value() as Token;
        entries.push([String(key.v), value() as Token]);
      }
    }
    if (c === 60) {
      const end = bytes.indexOf(62, at);
      const hex = Buffer.from(bytes.subarray(at + 1, end)).toString('latin1').replace(/\s/gu, '');
      at = end + 1;
      return { t: 'hex', v: new Uint8Array(Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex')) };
    }
    if (c === 91) {
      at += 1;
      const items: Token[] = [];
      for (;;) {
        skip();
        if (bytes[at] === 93) { at += 1; return { t: 'array', v: items }; }
        items.push(value() as Token);
      }
    }
    if (c === 40) {
      const out: number[] = [];
      let depth = 0;
      for (at += 1; at < bytes.length; at += 1) {
        const b = bytes[at];
        if (b === 92) { at += 1; out.push(bytes[at]); continue; }
        if (b === 40) depth += 1;
        if (b === 41 && depth-- === 0) break;
        out.push(b);
      }
      at += 1;
      return { t: 'str', v: new Uint8Array(out) };
    }
    const word = bare() || String.fromCharCode(bytes[at++]);
    if (NUMBER.test(word)) return { t: 'num', v: word };
    if (word === 'true' || word === 'false') return { t: 'bool', v: word };
    if (word === 'null') return { t: 'null', v: word };
    return { t: 'op', v: word };
  };
  const ops: Op[] = [];
  let args: Token[] = [];
  for (let token = value(); token; token = value()) {
    if (token.t === 'op') { ops.push({ op: token.v, args }); args = []; } else args.push(token);
  }
  return ops;
}

/** The operators of the families asked for; with none asked, all of them. */
function only(ops: Op[], families: Set<string> | null): Op[] {
  if (!families) return ops;
  // Each `q`'s block, and whether it holds a text object.
  const holdsText = new Map<number, boolean>();
  const blockOf: number[] = [];
  const stack: number[] = [];
  ops.forEach((o, i) => {
    if (o.op === 'q') { stack.push(i); holdsText.set(i, false); }
    blockOf[i] = stack.length ? stack[stack.length - 1] : -1;
    if (o.op === 'BT') for (const q of stack) holdsText.set(q, true);
    if (o.op === 'Q') stack.pop();
  });
  let inText = false;
  return ops.filter((o, i) => {
    if (o.op === 'BT') inText = true;
    const text = inText;
    if (o.op === 'ET') inText = false;
    if (['BDC', 'BMC', 'EMC'].includes(o.op)) return families.has('tags');
    if (text) return families.has('text');
    const block = blockOf[i];
    if (block >= 0) return holdsText.get(block) === true ? families.has('text') : false;
    return true;
  });
}

/** A font's `/BaseFont`, and for forme's file the glyph id each CID stands for. */
type FontMap = Map<string, { base: string; gidOf: (cid: number) => number }>;

function pageFonts(page: mupdf.PDFObject, faces: Face[] | null): FontMap {
  const map: FontMap = new Map();
  const fonts = page.get('Resources').get('Font');
  if (!fonts.isDictionary()) return map;
  fonts.forEach((font, key) => {
    const base = font.get('BaseFont').asName();
    let gidOf = (cid: number) => cid;
    if (faces) {
      const face = faces.find((f) => base.startsWith(`${f.subsetTag}+`));
      const set = [...new Set([0, ...(face?.glyphsUsed ?? [])])].sort((a, b) => a - b);
      gidOf = (cid) => set[cid] ?? -1;
    }
    map.set(String(key), { base, gidOf });
  });
  return map;
}

/** Glyph strings as the list's glyph ids, font names as their `/BaseFont`, and every token as text a reader can compare. */
function mapped(ops: Op[], fonts: FontMap): string[] {
  let font: { base: string; gidOf: (cid: number) => number } | undefined;
  const show = (t: Token, glyphs: boolean): string => {
    if (t.t === 'hex' || t.t === 'str') {
      if (!glyphs || !font) return `<${Buffer.from(t.v).toString('hex')}>`;
      const gids: number[] = [];
      for (let i = 0; i + 1 < t.v.length; i += 2) gids.push(font.gidOf((t.v[i] << 8) | t.v[i + 1]));
      return `gids(${gids.join(',')})`;
    }
    if (t.t === 'array') return `[${t.v.map((x) => show(x, glyphs)).join(' ')}]`;
    if (t.t === 'dict') return `<<${t.v.map(([k, x]) => `/${k} ${show(x, false)}`).join(' ')}>>`;
    if (t.t === 'name') return `/${t.v}`;
    return String(t.v);
  };
  return ops.map((o) => {
    if (o.op === 'Tf' && o.args[0]?.t === 'name') {
      font = fonts.get(o.args[0].v);
      return `/${font?.base ?? `?${o.args[0].v}`} ${o.args.slice(1).map((a) => show(a, false)).join(' ')} Tf`;
    }
    const glyphs = o.op === 'TJ' || o.op === 'Tj' || o.op === "'" || o.op === '"';
    return [...o.args.map((a) => show(a, glyphs)), o.op].join(' ');
  });
}

function open(file: string): mupdf.PDFDocument {
  return mupdf.Document.openDocument(fs.readFileSync(file), 'application/pdf') as mupdf.PDFDocument;
}

function contentOf(page: mupdf.PDFObject): Uint8Array {
  const value = page.get('Contents');
  const parts: Uint8Array[] = [];
  if (value.isArray()) value.forEach((ref) => parts.push(new Uint8Array(ref.readStream().asUint8Array())));
  else if (value.isStream()) parts.push(new Uint8Array(value.readStream().asUint8Array()));
  return Buffer.concat(parts.flatMap((p) => [p, Buffer.from('\n')]));
}

/** The first disagreement of the content streams, or null; and how many operators were compared. */
function compareStreams(oracle: mupdf.PDFDocument, forme: mupdf.PDFDocument, faces: Face[], families: Set<string> | null): { first: string | null; ops: number } {
  if (oracle.countPages() !== forme.countPages()) return { first: `${oracle.countPages()} pages against ${forme.countPages()}`, ops: 0 };
  let count = 0;
  for (let p = 0; p < oracle.countPages(); p += 1) {
    const sides = [[oracle, null], [forme, faces]] as const;
    const [a, b] = sides.map(([doc, f]) => {
      const page = doc.findPage(p);
      return mapped(only(tokenise(contentOf(page)), families), pageFonts(page, f));
    });
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) return { first: `page ${p + 1}, operator ${i}: oracle ${JSON.stringify(a[i] ?? '(end)')}, forme ${JSON.stringify(b[i] ?? '(end)')}`, ops: count };
      count += 1;
    }
  }
  return { first: null, ops: count };
}

type Char = { c: string; x: number; y: number };

/** Each page's characters with their origins; with `own`, only those shown in a font the page's own resources name, so the text of a page drawn as an image (a facsimile) is left to the stage that writes images. */
function words(doc: mupdf.PDFDocument, own = false): Char[][] {
  const pages: Char[][] = [];
  for (let p = 0; p < doc.countPages(); p += 1) {
    const chars: Char[] = [];
    // mupdf cuts a font's name at 31 characters, so a font is known by its name's start.
    const names = [...pageFonts(doc.findPage(p), null).values()].map((f) => f.base);
    doc.loadPage(p).toStructuredText('').walk({ onChar: (c, origin, font) => { if (!own || names.some((n) => n.startsWith(font.getName()))) chars.push({ c, x: origin[0], y: origin[1] }); } });
    pages.push(chars);
  }
  return pages;
}

const TOLERANCE = 0.01;

function compareWords(oracle: mupdf.PDFDocument, forme: mupdf.PDFDocument, own: boolean): { first: string | null; chars: number; worst: number } {
  const [a, b] = [words(oracle, own), words(forme, own)];
  let chars = 0;
  let worst = 0;
  for (let p = 0; p < a.length; p += 1) {
    const [x, y] = [a[p], b[p] ?? []];
    for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
      const [u, v] = [x[i], y[i]];
      const off = u && v ? Math.max(Math.abs(u.x - v.x), Math.abs(u.y - v.y)) : Infinity;
      if (!u || !v || u.c !== v.c || off > TOLERANCE) return { first: `page ${p + 1}, character ${i}: oracle ${JSON.stringify(u ?? null)}, forme ${JSON.stringify(v ?? null)}`, chars, worst };
      worst = Math.max(worst, off);
      chars += 1;
    }
  }
  return { first: null, chars, worst };
}

/** forme's words held to the list where no oracle file exists: each segment's first glyph is a character at the segment's `x` on the run's baseline. */
function wordsAgainstList(list: any, forme: mupdf.PDFDocument): { first: string | null; segments: number } {
  const pages = words(forme);
  let segments = 0;
  for (const [p, page] of list.pages.entries()) {
    const top = page.boxes.media[3];
    for (const [at, item] of page.items.entries()) {
      if (item.kind !== 'text') continue;
      for (const x of item.segments.x) {
        const y = top - item.baseline;
        if (!pages[p].some((c) => Math.abs(c.x - x) <= TOLERANCE && Math.abs(c.y - y) <= TOLERANCE)) return { first: `page ${p + 1}, item ${at}: no character at ${x}, ${y}`, segments };
        segments += 1;
      }
    }
  }
  return { first: null, segments };
}

/**
 * The tree reader: the file's structure tree and everything that points into it, as lines a reader can compare, every reference named by what it points at.
 *
 * @remarks
 * An element is named by its place in allocation order, the rank of its object number among the tree's elements, so two files agree only if both allocate in the list's order; a page by its index; an annotation by its `/StructParent`. Per element: `/S`, the namespace's `/NS`, `/P`, `/Pg`, `/Lang`, `/Alt`, `/E`, `/ID`, `/A` and every `/K` in order (an element, a bare MCID, an `/MCR` with its page, an `/OBJR` by its annotation's `/StructParent` and its page). Then the root's `/Namespaces`, `/ParentTreeNextKey`, the ParentTree's every key and value, the IDTree, `/MarkInfo`; each page's `/Tabs`, `/StructParents` and every link annotation, its `/Dest` included; the outline item by item with its depth, and whether its `/Parent`, `/Prev`, `/Next`, `/First`, `/Last` agree with where it was reached; `/PageLabels`. Numbers are compared as mupdf reads them, a real as a float, which is the precision a reader has.
 */
function treeOf(doc: mupdf.PDFDocument): string[] {
  const lines: string[] = [];
  const catalog = doc.getTrailer().get('Root');
  const pageOf = new Map<number, number>();
  for (let p = 0; p < doc.countPages(); p += 1) pageOf.set(doc.findPage(p).asIndirect(), p);
  const page = (obj: mupdf.PDFObject) => (obj.isNull() ? null : `page ${pageOf.get(obj.asIndirect()) ?? `?${obj.asIndirect()}`}`);
  const root = catalog.get('StructTreeRoot');
  if (root.isNull()) return ['no /StructTreeRoot'];
  // Every element reachable from the root, by object number, then ranked: the rank is the element's place in allocation order.
  const found = new Map<number, mupdf.PDFObject>();
  const collect = (obj: mupdf.PDFObject) => {
    const kids = obj.get('K');
    const each = kids.isArray() ? Array.from({ length: kids.length }, (_, i) => kids.get(i)) : kids.isNull() ? [] : [kids];
    for (const kid of each) if (kid.isIndirect() && kid.isDictionary() && !kid.get('S').isNull() && !found.has(kid.asIndirect())) { found.set(kid.asIndirect(), kid); collect(kid); }
  };
  collect(root);
  const order = [...found.keys()].sort((a, b) => a - b);
  const rank = new Map(order.map((n, i) => [n, i]));
  const el = (obj: mupdf.PDFObject) => (obj.isIndirect() && rank.has(obj.asIndirect()) ? `element ${rank.get(obj.asIndirect())}` : obj.isIndirect() && obj.asIndirect() === root.asIndirect() ? 'root' : `?${obj.toString()}`);
  const plain = (obj: mupdf.PDFObject): unknown => {
    if (obj.isNull()) return null;
    if (obj.isIndirect() && rank.has(obj.asIndirect())) return el(obj);
    if (obj.isIndirect() && pageOf.has(obj.asIndirect())) return page(obj);
    if (obj.isName()) return `/${obj.asName()}`;
    if (obj.isNumber()) return obj.asNumber();
    if (obj.isBoolean()) return obj.asBoolean();
    if (obj.isString()) return obj.asString();
    if (obj.isArray()) return Array.from({ length: obj.length }, (_, i) => plain(obj.get(i)));
    const out: [string, unknown][] = [];
    obj.forEach((value, key) => { out.push([String(key), plain(value)]); });
    return Object.fromEntries(out.sort(([a], [b]) => (a < b ? -1 : 1)));
  };
  const str = (obj: mupdf.PDFObject) => (obj.isNull() ? null : obj.asString());
  order.forEach((n, i) => {
    const e = found.get(n) as mupdf.PDFObject;
    const kids = e.get('K');
    const each = kids.isArray() ? Array.from({ length: kids.length }, (_, j) => kids.get(j)) : kids.isNull() ? [] : [kids];
    const k = each.map((kid) => {
      if (kid.isNumber()) return `mcid ${kid.asNumber()}`;
      if (kid.isIndirect() && rank.has(kid.asIndirect())) return el(kid);
      const type = kid.get('Type').isNull() ? null : kid.get('Type').asName();
      if (type === 'MCR') return `mcr ${kid.get('MCID').asNumber()} on ${page(kid.get('Pg'))}`;
      if (type === 'OBJR') return `objr ${kid.get('Obj').get('StructParent').asNumber()} on ${page(kid.get('Pg'))}`;
      return `? ${kid.toString()}`;
    });
    const a = e.get('A');
    lines.push(`element ${i}: ${JSON.stringify({ S: e.get('S').asName(), NS: str(e.get('NS').get('NS')), P: el(e.get('P')), Pg: page(e.get('Pg')), Lang: str(e.get('Lang')), Alt: str(e.get('Alt')), E: str(e.get('E')), ID: str(e.get('ID')), A: a.isNull() ? null : plain(a), K: k })}`);
  });
  const namespaces = root.get('Namespaces');
  lines.push(`root: ${JSON.stringify({ K: plain(root.get('K')), Namespaces: Array.from({ length: namespaces.length }, (_, i) => str(namespaces.get(i).get('NS'))), ParentTreeNextKey: plain(root.get('ParentTreeNextKey')), MarkInfo: plain(catalog.get('MarkInfo')) })}`);
  const nums = root.get('ParentTree').get('Nums');
  for (let i = 0; i + 1 < nums.length; i += 2) lines.push(`parent tree ${nums.get(i).asNumber()}: ${JSON.stringify(plain(nums.get(i + 1)))}`);
  const idTree = root.get('IDTree');
  const ids = idTree.isNull() ? idTree : idTree.get('Names');
  for (let i = 0; !ids.isNull() && i + 1 < ids.length; i += 2) lines.push(`id tree ${JSON.stringify(ids.get(i).asString())}: ${el(ids.get(i + 1))}`);
  for (let p = 0; p < doc.countPages(); p += 1) {
    const node = doc.findPage(p);
    lines.push(`page ${p}: ${JSON.stringify({ Tabs: plain(node.get('Tabs')), StructParents: plain(node.get('StructParents')) })}`);
    const annots = node.get('Annots');
    for (let i = 0; !annots.isNull() && i < annots.length; i += 1) {
      const annot = annots.get(i);
      const { Type, Subtype, Rect, QuadPoints, F, Border, Contents, StructParent, P, A, Dest, ...rest } = plain(annot) as Record<string, unknown>;
      lines.push(`page ${p} annotation ${i}: ${JSON.stringify({ Type, Subtype, Rect, QuadPoints, F, Border, Contents, StructParent, P, A, Dest, rest })}`);
    }
  }
  const outlines = catalog.get('Outlines');
  if (!outlines.isNull()) {
    lines.push(`outline: ${JSON.stringify({ Type: plain(outlines.get('Type')), Count: plain(outlines.get('Count')) })}`);
    const visit = (parent: mupdf.PDFObject, depth: number) => {
      let previous: mupdf.PDFObject | null = null;
      let last: mupdf.PDFObject | null = null;
      for (let item = parent.get('First'); !item.isNull(); item = item.get('Next')) {
        const linked = item.get('Parent').asIndirect() === parent.asIndirect() && (previous ? item.get('Prev').asIndirect() === previous.asIndirect() : item.get('Prev').isNull());
        lines.push(`outline item: ${JSON.stringify({ depth, Title: str(item.get('Title')), Count: plain(item.get('Count')), Dest: plain(item.get('Dest')), linked })}`);
        visit(item, depth + 1);
        previous = item;
        last = item;
      }
      if (last && parent.get('Last').asIndirect() !== last.asIndirect()) lines.push(`outline: /Last of a node at depth ${depth} is not its last kid`);
    };
    visit(outlines, 0);
  }
  const labels = catalog.get('PageLabels');
  if (!labels.isNull()) lines.push(`page labels: ${JSON.stringify(plain(labels.get('Nums')))}`);
  return lines;
}

/** The first line the two trees disagree on, or null; and how many elements were compared. */
function compareTrees(oracle: mupdf.PDFDocument, forme: mupdf.PDFDocument): { first: string | null; elements: number; lines: number } {
  const [a, b] = [treeOf(oracle), treeOf(forme)];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return { first: `line ${i}: oracle ${a[i] ?? '(end)'}, forme ${b[i] ?? '(end)'}`, elements: 0, lines: i };
  }
  return { first: null, elements: a.filter((l) => l.startsWith('element ')).length, lines: a.length };
}

function compareRecords(oracle: Records, forme: Records): string | null {
  for (const key of ['mcids', 'pens', 'kernAdjustments', 'actualTextSpans'] as const) {
    if (!isDeepStrictEqual(oracle[key], forme[key])) {
      if (Array.isArray(oracle[key])) {
        const [a, b] = [oracle[key] as unknown[], forme[key] as unknown[]];
        const at = a.findIndex((v, i) => !isDeepStrictEqual(v, b[i]));
        return `${key}[${at < 0 ? b.length : at}]: oracle ${JSON.stringify(a[at])}, forme ${JSON.stringify(b[at])}`;
      }
      return `${key}: oracle ${JSON.stringify(oracle[key])}, forme ${JSON.stringify(forme[key])}`;
    }
  }
  return null;
}

/**
 * The records of the tree through `recordsOf`: the `structure`, `links`, `outline` and `idTree` members it makes of the list and forme's records, held to the committed report snapshot, as Caster's records test holds the oracle's (`test/displayList.test.ts`).
 */
function compareTreeMembers(derived: any, report: any): { first: string | null; compared: string } {
  const pairs: [string, unknown, unknown][] = [
    ['structure', derived.structure, (({ headings, ...rest }) => rest)(report.structure)],
    ['links', derived.links.length > 0 ? derived.links : undefined, report.links],
    ['outline', derived.outline, report.outline],
    ['idTree', report.idTree === undefined ? undefined : derived.idTree, report.idTree],
  ];
  for (const [key, a, b] of pairs) {
    if (!isDeepStrictEqual(JSON.parse(JSON.stringify(a ?? null)), JSON.parse(JSON.stringify(b ?? null)))) return { first: `${key}: recordsOf ${JSON.stringify(a)?.slice(0, 200)}, the snapshot ${JSON.stringify(b)?.slice(0, 200)}`, compared: '' };
  }
  const tree = (node: any): number => 1 + node.kids.reduce((n: number, k: any) => n + tree(k), 0);
  return { first: null, compared: `${tree(derived.structure.expectedTree)} nodes, ${derived.structure.annots.length} annotations, ${derived.links.length} links, ${derived.outline?.length ?? 0} outline items, ${derived.idTree.length} ids` };
}

/** The verb: every corpus document forme wrote a file for, through every reader. */
export async function compare(lists: string, dir: string, onlyArg: string | null): Promise<number> {
  const families = onlyArg ? new Set(onlyArg.split(',').filter(Boolean)) : null;
  for (const f of families ?? []) if (!FAMILIES.includes(f)) { console.error(`compare: no family ${f}; the families built are ${FAMILIES.join(', ')}`); return 2; }
  const { load } = await import('../src/capabilities.ts');
  const { loadSubsetter } = await import('../src/fonts/hbSubset.ts');
  const { emitStructure } = await import('../src/emit/structureEmit.ts');
  const { recordsOf } = await import('../src/displayList/records.ts');
  await load(['pdf', 'fontkit', 'hbSubset', 'fastPng']);
  await loadSubsetter();
  const corpus: { documents: { name: string; list?: { blobs: string[] }; refused?: string }[] } = JSON.parse(fs.readFileSync(path.join(lists, 'corpus.json'), 'utf8'));
  let failed = 0;
  let compared = 0;
  for (const entry of corpus.documents) {
    const mine = path.join(dir, `${entry.name}.pdf`);
    const line = (verdict: string) => console.log(`${entry.name.padEnd(18)} ${verdict}`);
    if (!fs.existsSync(mine)) { line('no file of forme\'s'); continue; }
    const list = JSON.parse(fs.readFileSync(path.join(lists, `${entry.name}.json`), 'utf8'));
    if (list.writing.colour) {
      // The content and the records wait on stage 6, which writes the colour story; the tree does not depend on it, so it is read now.
      const tree = compareTrees(open(path.join(lists, `${entry.name}.pdf`)), open(mine));
      const report = JSON.parse(fs.readFileSync(path.join(lists, `${entry.name}.report.json`), 'utf8'));
      const formeRecords = JSON.parse(fs.readFileSync(path.join(dir, `${entry.name}.records.json`), 'utf8'));
      const members = compareTreeMembers(recordsOf(list, { images: [], ...formeRecords }), report);
      if (tree.first || members.first) failed += 1;
      line([
        'content, records and words skipped: a colour story, which stage 6 writes',
        `tree: ${tree.first ?? `equal, ${tree.elements} elements, ${tree.lines} lines`}`,
        `records of the tree: ${members.first ?? `equal to the report snapshot, ${members.compared}`}`,
      ].join('\n                   '));
      continue;
    }
    const forme = open(mine);
    if (entry.refused !== undefined) {
      const held = wordsAgainstList(list, forme);
      if (held.first) failed += 1;
      line(`no oracle file (the oracle refuses it); words held to the list: ${held.first ?? `${held.segments} segments at their x and baseline`}`);
      continue;
    }
    compared += 1;
    list.resources.blobs = {};
    for (const hash of entry.list?.blobs ?? []) {
      const bytes = new Uint8Array(fs.readFileSync(path.join(lists, 'blobs', hash)));
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error(`compare: the blob ${hash} is not what its name says`);
      list.resources.blobs[hash] = bytes;
    }
    // Through JSON, as forme's records cross and as `recordsOf` reads a writer's records: JSON has no -0, and the oracle's pens hold one wherever `round3` rounds a small negative adjustment to zero.
    const oracleRecords: Records = JSON.parse(JSON.stringify((await emitStructure(list)).records));
    const formeRecords: Records = JSON.parse(fs.readFileSync(path.join(dir, `${entry.name}.records.json`), 'utf8'));
    const oracle = open(path.join(lists, `${entry.name}.pdf`));
    const streams = compareStreams(oracle, forme, formeRecords.faces, families);
    const records = compareRecords(oracleRecords, formeRecords);
    const text = compareWords(oracle, forme, families !== null && !families.has('images'));
    const tree = compareTrees(oracle, forme);
    // forme's records have no `images` before stage 5 writes images; `recordsOf` reads it only for the report's image notes, which the tree's members do not hold.
    const report = JSON.parse(fs.readFileSync(path.join(lists, `${entry.name}.report.json`), 'utf8'));
    const members = compareTreeMembers(recordsOf(list, { images: [], ...formeRecords } as any), report);
    if (streams.first || records || text.first || tree.first || members.first) failed += 1;
    line([
      `content${families ? ` (${[...families].join(',')})` : ''}: ${streams.first ?? `equal, ${streams.ops} operators`}`,
      `records: ${records ?? `equal, ${oracleRecords.pens.length} pens, ${oracleRecords.kernAdjustments} kerns, ${oracleRecords.actualTextSpans} spans`}`,
      `words: ${text.first ?? `equal, ${text.chars} characters, worst ${text.worst.toFixed(4)} pt`}`,
      `tree: ${tree.first ?? `equal, ${tree.elements} elements, ${tree.lines} lines`}`,
      `records of the tree: ${members.first ?? `equal to the report snapshot, ${members.compared}`}`,
    ].join('\n                   '));
  }
  console.log(`${compared} compared with the oracle, ${failed} with a disagreement`);
  return failed === 0 ? 0 : 1;
}
