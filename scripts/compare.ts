/**
 * `npm run identity -- compare <dir> [--only text,tags,images,rects,marks]`: the readers of the Rust writer's gate, holding forme's files to the oracle's on the committed lists.
 *
 * @remarks
 * `<dir>` holds what forme wrote from each list of `fixtures/lists/`: `<name>.pdf` and `<name>.records.json` (`forme write <list> --blobs <blobs> -o <name>.pdf --records <name>.records.json`). For every corpus document with a file there, the readers ask both files the same question and print the first disagreement of each (*the same list prints the same bytes*, DESIGN.md S102; the gate of `.claude/plans/the-rust-writer/plan-rust-writer.md` in the BelType monorepo):
 *
 * - **The content streams.** Each page's content, inflated by mupdf, tokenised as ISO 32000-2 §7.2 does and compared operator for operator, operands as written. A font's resource name is mapped through the page's resources to its `/BaseFont`, and a glyph string under it to the list's glyph ids: the oracle's CIDs are the glyph ids, and forme's are each glyph's place in its subset, `.notdef` first, read back through forme's `faces` record. `--only` keeps the operator families a stage has built: `tags` is `BDC`, `BMC`, `EMC`; `text` is every operator from `BT` to `ET`, and the `q`, `cm`, clip and `Q` of a `q … Q` that holds a text object; `images` is a `q … Q` that holds no text object and paints an image XObject with `Do`, whose name is mapped through the page's resources to what it names; `rects` is a `q … Q` that holds neither and paints a rectangle with `re`; `marks` is one that strokes in a colour space set with `CS` other than `/Pattern`, which only the print marks do. Every other resource name, a colour space (`cs`, `CS`), a graphics state (`gs`), a shading (`sh`), a pattern (`scn`, `SCN`) and an XObject (`Do`), is mapped through the stream's resources to what it names, and a Form XObject's content is read in its `Do`'s place, indented, through the form's own resources, so a form is compared operator for operator too. A `q … Q` that holds none of the families asked for is another family's and is dropped; every other operator is kept, so one no family names is a disagreement.
 * - **The records.** The oracle's records are its own, made by replaying the list through `emitStructure` in node and read through JSON, as forme's cross; `mcids` and `pens` must be equal exactly, and `kernAdjustments`, `actualTextSpans`, `xobjects` and each image use but its sizes and timings equal, and the report's image notes `recordsOf` derives from either; the paint rows equal but their resource names and `vectorResources` equal; the colour record equal but its resource names.
 * - **The images.** Per page, each image XObject its resources name, every dictionary entry but `/Length` resolved, each stream as the hash of its bytes (a `/DCTDecode` stream as written, any other inflated), so the colour space, an `/ICCBased` profile, an `/Indexed` lookup and the `/SMask` are compared with the samples (`describe`); under `--only`, only the XObjects a kept `Do` paints. Until stage 8 a facsimile, which forme leaves out, is left out of the oracle's records too.
 * - **The words.** mupdf's structured text of each page: the same characters, in order, at origins within 0.01 pt. Under any `--only`, only the characters shown in a font the page's own resources name are read, since a facsimile's words are drawn by its Form XObject, which stage 8 writes.
 * - **The tree.** mupdf reads both files' structure trees element by element in allocation order and everything that points into them: every element's entries and `/K`, the ParentTree, the IDTree, `/MarkInfo`, each page's `/Tabs`, `/StructParents` and link annotations with their destinations, the outline item by item, `/PageLabels` (`treeOf`). Beside it, `recordsOf` over forme's records gives the `structure`, `links`, `outline` and `idTree` members of the committed report snapshot. The tree's families are not content, so `--only` does not restrict them.
 *
 * - **The pixels.** With no `--only`, mupdf renders each page of both files at 144 dpi, RGB, 8 bits; per page the largest channel difference and the share of pixels more than 8 of 255 apart are printed; a page with a pixel more than 64 apart, or more than 0.2 per cent of its pixels past 8, is a disagreement.
 * - **The colour objects**, for a list with a colour story: per page every `/ColorSpace` and `/ExtGState` entry, `/DefaultRGB` by name and the rest by what they are, and the catalog's `/OutputIntents`, each described as the images are.
 *
 * A list the oracle refuses (the CFF2 face) has no oracle file: its words are held to the list instead, each segment's first glyph at the segment's `x` on the run's baseline, within 0.01 pt. Reads only.
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
type ImageUse = { page: number; item: number; source: number; name: string; hash: string; info: Record<string, unknown> };
type Records = { mcids: number[][]; pens: unknown[]; kernAdjustments: number; actualTextSpans: number; faces: Face[]; images: ImageUse[]; xobjects: number; paint: Record<string, any>[]; vectorResources: unknown; colour?: any };

const WHITE = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)));
const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)$/u;
const FAMILIES = ['text', 'tags', 'images', 'rects', 'marks'];

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

/** The operators of the families asked for; with none asked, all of them. `images` names the XObjects the page's image items paint, by each writer's records, so a `q … Q` that paints one with `Do` is the `images` family's; a `q … Q` that holds neither paints a rectangle with `re` (`rects`), or strokes in a colour space it sets with `CS` that is not `/Pattern`, which only the print marks do (`marks`). */
function only(ops: Op[], families: Set<string> | null, images: Set<string> = new Set()): Op[] {
  if (!families) return ops;
  // Each `q`'s block and what it holds: a text object, an image, a rectangle, the marks' stroking colour space.
  const holds = new Map<number, Set<string>>();
  const blockOf: number[] = [];
  const stack: number[] = [];
  ops.forEach((o, i) => {
    if (o.op === 'q') { stack.push(i); holds.set(i, new Set()); }
    blockOf[i] = stack.length ? stack[stack.length - 1] : -1;
    const kind = o.op === 'BT' ? 'text'
      : o.op === 'Do' && o.args[0]?.t === 'name' && images.has(o.args[0].v) ? 'images'
      : o.op === 're' ? 'rects'
      : o.op === 'CS' && !(o.args[0]?.t === 'name' && o.args[0].v === 'Pattern') ? 'marks'
      : null;
    if (kind) for (const q of stack) holds.get(q)!.add(kind);
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
    if (block >= 0) {
      const held = holds.get(block)!;
      const family = ['text', 'images', 'rects', 'marks'].find((f) => held.has(f));
      return family ? families.has(family) : false;
    }
    return true;
  });
}

/** The image XObjects the image items of page `p` paint, by the writer's own records, so a raster fallback a vector item paints is not the `images` family's, nor a facsimile's Form XObject. */
function painted(records: Records, p: number, page: mupdf.PDFObject): Set<string> {
  const images = pageImages(page);
  return new Set(records.images.filter((u) => u.page === p && images.has(u.name)).map((u) => u.name));
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

/** A page's image XObjects, each named by what it is: the hash of its description (`describe`), so two files' names agree when their images do. */
function pageImages(page: mupdf.PDFObject): Map<string, string> {
  const map = new Map<string, string>();
  const xobjects = page.get('Resources').get('XObject');
  if (!xobjects.isDictionary()) return map;
  xobjects.forEach((obj, key) => { if (obj.get('Subtype').asName() === 'Image') map.set(String(key), `image(${sha(describe(obj)).slice(0, 12)})`); });
  return map;
}

/** The names a stream's resources give (a page's or a Form XObject's), each mapped to what it names, the hash of its description: colour spaces, graphics states, shadings and patterns, and every XObject, an image as `image(…)` and a form as `form(…)` with the object itself, so a form's content can be read in its place. */
type Names = { spaces: Map<string, string>; states: Map<string, string>; shadings: Map<string, string>; patterns: Map<string, string>; xobjects: Map<string, string>; forms: Map<string, mupdf.PDFObject> };
function resourceNames(owner: mupdf.PDFObject): Names {
  const resources = owner.get('Resources');
  const of = (kind: string, label: string) => {
    const map = new Map<string, string>();
    const dict = resources.isDictionary() ? resources.get(kind) : resources;
    if (dict.isDictionary()) dict.forEach((obj, key) => { map.set(String(key), `${label}(${sha(describe(obj)).slice(0, 12)})`); });
    return map;
  };
  const forms = new Map<string, mupdf.PDFObject>();
  const xobjects = new Map<string, string>();
  const dict = resources.isDictionary() ? resources.get('XObject') : resources;
  if (dict.isDictionary()) dict.forEach((obj, key) => {
    const form = obj.get('Subtype').asName() === 'Form';
    xobjects.set(String(key), `${form ? 'form' : 'image'}(${sha(describe(obj)).slice(0, 12)})`);
    if (form) forms.set(String(key), obj);
  });
  return { spaces: of('ColorSpace', 'space'), states: of('ExtGState', 'gstate'), shadings: of('Shading', 'shading'), patterns: of('Pattern', 'pattern'), xobjects, forms };
}

const sha = (data: Uint8Array | string) => crypto.createHash('sha256').update(data).digest('hex');

/**
 * One object as a reader sees it (an image XObject, a colour space, a graphics state, an output intent): every dictionary entry but `/Length`, resolved, with each stream as the hash of its bytes: a `/DCTDecode` stream's as written (a passthrough is the file itself), any other's inflated, and the `/SMask`, an `/ICCBased` profile and an `/Indexed` lookup the same way.
 */
function describe(obj: mupdf.PDFObject): string {
  const plain = (o: mupdf.PDFObject): unknown => {
    if (o.isNull()) return null;
    if (o.isStream()) {
      const raw = o.get('Filter').isName() && o.get('Filter').asName() === 'DCTDecode';
      // A Form XObject is its content as the content reader reads it, every name mapped through its own resources, so it is described by what it draws and not by its names or its bytes.
      const form = o.get('Subtype').isName() && o.get('Subtype').asName() === 'Form';
      const entries: [string, unknown][] = [];
      o.forEach((value, key) => { if (String(key) !== 'Length' && !(form && String(key) === 'Resources')) entries.push([String(key), plain(value)]); });
      const bytes = form ? sha(formContent(o).join('\n')) : sha(new Uint8Array((raw ? o.readRawStream() : o.readStream()).asUint8Array()));
      return { ...Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : 1))), bytes };
    }
    if (o.isName()) return `/${o.asName()}`;
    if (o.isNumber()) return o.asNumber();
    if (o.isBoolean()) return o.asBoolean();
    if (o.isString()) return `<${Buffer.from(o.asByteString()).toString('hex')}>`;
    if (o.isArray()) return Array.from({ length: o.length }, (_, i) => plain(o.get(i)));
    const entries: [string, unknown][] = [];
    o.forEach((value, key) => { entries.push([String(key), plain(value)]); });
    return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : 1)));
  };
  return JSON.stringify(plain(obj));
}

/** The first disagreement of the images reader, or null; and how many XObjects were compared: per page, each image XObject its resources name, described by `describe`, the two files' descriptions sorted and compared. Under `--only`, only those a `Do` the families keep paints, and `images` only an image item's, so a raster fallback a vector item paints waits for the vectors' stage. */
function compareImages(oracle: mupdf.PDFDocument, forme: mupdf.PDFDocument, records: [Records, Records], families: Set<string> | null): { first: string | null; images: number } {
  let count = 0;
  for (let p = 0; p < oracle.countPages(); p += 1) {
    const [a, b] = ([[oracle, records[0]], [forme, records[1]]] as const).map(([doc, r]) => {
      const out: string[] = [];
      const page = doc.findPage(p);
      const xobjects = page.get('Resources').get('XObject');
      const kept = families && new Set(only(tokenise(contentOf(page)), families, painted(r, p, page)).filter((o) => o.op === 'Do').map((o) => String(o.args[0]?.v)));
      if (xobjects.isDictionary()) xobjects.forEach((obj, key) => { if (obj.get('Subtype').asName() === 'Image' && (!kept || kept.has(String(key)))) out.push(describe(obj)); });
      return out.sort();
    });
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) return { first: `page ${p + 1}, image ${i}: oracle ${a[i]?.slice(0, 400) ?? '(none)'}, forme ${b[i]?.slice(0, 400) ?? '(none)'}`, images: count };
      count += 1;
    }
  }
  return { first: null, images: count };
}

/** A Form XObject's content as the content reader reads it, through its own resources, its own forms read in their place. */
function formContent(form: mupdf.PDFObject, faces: Face[] | null = null): string[] {
  return mapped(tokenise(new Uint8Array(form.readStream().asUint8Array())), pageFonts(form, faces), resourceNames(form), faces);
}

/** Glyph strings as the list's glyph ids, font names as their `/BaseFont`, every other resource name as what it names, a Form XObject's content read in its place after its `Do`, indented, and every token as text a reader can compare. */
function mapped(ops: Op[], fonts: FontMap, names: Names, faces: Face[] | null = null): string[] {
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
  const name = (o: Op, map: Map<string, string>) => (o.args[0]?.t === 'name' ? map.get(o.args[0].v) : undefined);
  return ops.flatMap((o) => {
    if (o.op === 'Tf' && o.args[0]?.t === 'name') {
      font = fonts.get(o.args[0].v);
      return [`/${font?.base ?? `?${o.args[0].v}`} ${o.args.slice(1).map((a) => show(a, false)).join(' ')} Tf`];
    }
    const to = o.op === 'Do' ? name(o, names.xobjects) : o.op === 'cs' || o.op === 'CS' ? name(o, names.spaces) : o.op === 'gs' ? name(o, names.states) : o.op === 'sh' ? name(o, names.shadings) : (o.op === 'scn' || o.op === 'SCN') && o.args.length === 1 ? name(o, names.patterns) : undefined;
    if (to !== undefined) {
      const form = o.op === 'Do' ? names.forms.get(String(o.args[0].v)) : undefined;
      return [`${to} ${o.op}`, ...(form ? formContent(form, faces).map((line) => `  ${line}`) : [])];
    }
    const glyphs = o.op === 'TJ' || o.op === 'Tj' || o.op === "'" || o.op === '"';
    return [[...o.args.map((a) => show(a, glyphs)), o.op].join(' ')];
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
function compareStreams(oracle: mupdf.PDFDocument, forme: mupdf.PDFDocument, records: [Records, Records], families: Set<string> | null): { first: string | null; ops: number } {
  const faces = records[1].faces;
  if (oracle.countPages() !== forme.countPages()) return { first: `${oracle.countPages()} pages against ${forme.countPages()}`, ops: 0 };
  let count = 0;
  for (let p = 0; p < oracle.countPages(); p += 1) {
    const sides = [[oracle, null, records[0]], [forme, faces, records[1]]] as const;
    const [a, b] = sides.map(([doc, f, r]) => {
      const page = doc.findPage(p);
      return mapped(only(tokenise(contentOf(page)), families, painted(r, p, page)), pageFonts(page, f), resourceNames(page), f);
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

/** The colour objects a reader sees: per page, every `/ColorSpace` and `/ExtGState` entry described by `describe` and sorted (under `--only`, the overprint states alone), and the catalog's `/OutputIntents`; the first disagreement, and how many objects were compared. */
function compareColour(oracle: mupdf.PDFDocument, forme: mupdf.PDFDocument, families: Set<string> | null): { first: string | null; objects: number } {
  const lines = (doc: mupdf.PDFDocument) => {
    const out: string[] = [];
    for (let p = 0; p < doc.countPages(); p += 1) {
      const resources = doc.findPage(p).get('Resources');
      for (const kind of ['ColorSpace', 'ExtGState']) {
        const dict = resources.get(kind);
        const described: string[] = [];
        // Under `--only`, a graphics state is the colour story's when it sets overprint; a vector item's (alpha, a blend mode, a soft mask) waits for the vectors' stage.
        if (dict.isDictionary()) dict.forEach((obj, key) => { if (families && kind === 'ExtGState' && obj.get('OP').isNull()) return; described.push(String(key) === 'DefaultRGB' ? `DefaultRGB ${describe(obj)}` : describe(obj)); });
        out.push(...described.sort().map((d) => `page ${p + 1} ${kind} ${d}`));
      }
    }
    const intents = doc.getTrailer().get('Root').get('OutputIntents');
    if (intents.isArray()) intents.forEach((intent) => out.push(`OutputIntent ${describe(intent)}`));
    return out;
  };
  const [a, b] = [lines(oracle), lines(forme)];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return { first: `${a[i]?.slice(0, 300) ?? '(none)'} against ${b[i]?.slice(0, 300) ?? '(none)'}`, objects: i };
  }
  return { first: null, objects: a.length };
}

/** The colour record but its resource names: a row's `resource` as the colourant it names, and the spaces and states without their names. */
function unnamed(colour: any): unknown {
  if (!colour) return colour;
  const colorant = (name: string) => colour.colorSpaces.find((s: any) => s.name === name)?.colorant;
  return {
    ...colour,
    elements: colour.elements.map(({ resource, ...row }: any) => (resource === undefined ? row : { ...row, resource: colorant(resource) })),
    colorSpaces: colour.colorSpaces.map(({ name, ...space }: any) => (name === 'DefaultRGB' ? { name, ...space } : space)),
    extGStates: colour.extGStates.map(({ name, ...state }: any) => state),
  };
}

/** The paint rows but their resource names: a row's `extGState`, `form` and `xobject`, and its params' `shading` and `pattern`. */
function unnamedPaint(paint: Record<string, any>[]): unknown {
  return paint.map(({ extGState, form, xobject, params, ...row }) => {
    if (params === undefined) return row;
    const { shading, pattern, ...rest } = params;
    return { ...row, params: rest };
  });
}

/**
 * The records the two writers share by rule: `mcids` and `pens` exactly, `kernAdjustments`, `actualTextSpans`, each image use but its sizes and timings (`bytesOut` is the deflate's, `decodeMs` and `encodeMs` clocks), `xobjects`, the paint rows but their resource names (`unnamedPaint`), `vectorResources`, and the colour record but its resource names (`unnamed`). A facsimile forme left out (stage 8) is left out of the oracle's side too: its uses, and its XObjects from the count.
 */
function compareRecords(oracle: Records, forme: Records, facsimiles: Set<number>): string | null {
  const shared = (uses: ImageUse[]) => uses.filter((u) => !facsimiles.has(u.source)).map(({ info: { bytesOut, decodeMs, encodeMs, ...info }, ...use }) => ({ ...use, info }));
  const formHashes = new Set(oracle.images.filter((u) => facsimiles.has(u.source)).map((u) => u.hash));
  oracle = { ...oracle, images: shared(oracle.images), xobjects: oracle.xobjects - formHashes.size, paint: unnamedPaint(oracle.paint) as any, colour: unnamed(oracle.colour) };
  forme = { ...forme, images: shared(forme.images), paint: unnamedPaint(forme.paint) as any, colour: unnamed(forme.colour) };
  for (const key of ['mcids', 'pens', 'kernAdjustments', 'actualTextSpans', 'images', 'xobjects', 'paint', 'vectorResources', 'colour'] as const) {
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

/** The pixel lines: no pixel more than 64 of 255 apart in any channel, and no page with more than 0.2 per cent of its pixels more than 8 apart. */
const PIXEL_MAX = 64;
const PIXEL_NEAR = 8;
const PIXEL_SHARE = 0.002;

/**
 * The pixels reader: mupdf renders each page of both files at 144 dpi, RGB, 8 bits; per page, the largest channel difference, where it is (in points from the page's top left), and the share of pixels differing by more than 8 of 255. A page past either line is the first disagreement; every page's numbers are returned for the record.
 */
function comparePixels(oracle: mupdf.PDFDocument, forme: mupdf.PDFDocument): { first: string | null; pages: { max: number; share: number; at: [number, number] }[] } {
  const pages: { max: number; share: number; at: [number, number] }[] = [];
  let first: string | null = null;
  for (let p = 0; p < oracle.countPages(); p += 1) {
    const [a, b] = [oracle, forme].map((doc) => doc.loadPage(p).toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false));
    if (a.getWidth() !== b.getWidth() || a.getHeight() !== b.getHeight()) {
      first ??= `page ${p + 1}: ${a.getWidth()} by ${a.getHeight()} pixels against ${b.getWidth()} by ${b.getHeight()}`;
      pages.push({ max: 255, share: 1, at: [0, 0] });
      continue;
    }
    const [x, y] = [a.getPixels(), b.getPixels()];
    const width = a.getWidth();
    let max = 0;
    let worst = 0;
    let near = 0;
    for (let i = 0; i < x.length; i += 3) {
      const d = Math.max(Math.abs(x[i] - y[i]), Math.abs(x[i + 1] - y[i + 1]), Math.abs(x[i + 2] - y[i + 2]));
      if (d > max) { max = d; worst = i / 3; }
      if (d > PIXEL_NEAR) near += 1;
    }
    const share = near / (x.length / 3);
    const at: [number, number] = [(worst % width) / 2, Math.floor(worst / width) / 2];
    pages.push({ max, share, at });
    if (max > PIXEL_MAX || share > PIXEL_SHARE) first ??= `page ${p + 1}: largest difference ${max} of 255 at ${at[0]}, ${at[1]} pt from the top left, ${(share * 100).toFixed(4)} % of pixels past ${PIXEL_NEAR}`;
  }
  return { first, pages };
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
    const streams = compareStreams(oracle, forme, [oracleRecords, formeRecords], families);
    const facsimiles = new Set(Object.entries(list.resources.images).filter(([, source]: [string, any]) => source.kind === 'facsimile').map(([key]) => Number(key)));
    const records = compareRecords(oracleRecords, formeRecords, facsimiles);
    // A facsimile's words are drawn by its Form XObject, which stage 8 writes: under any `--only`, only the characters in a font the page's own resources name are read.
    const text = compareWords(oracle, forme, families !== null);
    const images = compareImages(oracle, forme, [oracleRecords, formeRecords], families);
    const colour = list.writing.colour ? compareColour(oracle, forme, families) : null;
    const tree = compareTrees(oracle, forme);
    // A partial gate leaves families out of the content, so the page cannot be drawn whole: the pixels are read with no `--only`.
    const pixels = families ? { first: null, pages: [] } : comparePixels(oracle, forme);
    const report = JSON.parse(fs.readFileSync(path.join(lists, `${entry.name}.report.json`), 'utf8'));
    const members = compareTreeMembers(recordsOf(list, formeRecords as any), report);
    // The report's note on each image, which `recordsOf` derives from the list and the writer's road: forme's road gives the oracle's notes.
    const notes = (r: Records) => recordsOf(list, { ...r, images: r.images.filter((u) => !facsimiles.has(u.source)) } as any).images;
    const imageNotes = isDeepStrictEqual(notes(oracleRecords), notes(formeRecords)) ? null : `oracle ${JSON.stringify(notes(oracleRecords)).slice(0, 300)}, forme ${JSON.stringify(notes(formeRecords)).slice(0, 300)}`;
    if (streams.first || records || text.first || tree.first || members.first || images.first || imageNotes || colour?.first || pixels.first) failed += 1;
    line([
      `content${families ? ` (${[...families].join(',')})` : ''}: ${streams.first ?? `equal, ${streams.ops} operators`}`,
      `records: ${records ?? `equal, ${oracleRecords.pens.length} pens, ${oracleRecords.kernAdjustments} kerns, ${oracleRecords.actualTextSpans} spans, ${formeRecords.images.length} image uses, ${formeRecords.xobjects} XObjects, ${formeRecords.paint.length} paint rows, vectorResources ${JSON.stringify(formeRecords.vectorResources)}`}`,
      `images: ${images.first ?? `equal, ${images.images} XObjects page by page`}; notes: ${imageNotes ?? 'equal'}`,
      ...(colour ? [`colour: ${colour.first ?? `equal, ${colour.objects} colour spaces, graphics states and intents; record equal but names, ${formeRecords.colour.elements.length} rows, ${formeRecords.colour.blackTextRuns} black-text runs, ${formeRecords.colour.worklist.length} work-list entries`}`] : []),
      `words: ${text.first ?? `equal, ${text.chars} characters, worst ${text.worst.toFixed(4)} pt`}`,
      ...(families ? [] : [`pixels: ${pixels.first ?? 'within the lines'}; per page, largest difference and share past ${PIXEL_NEAR}: ${pixels.pages.map((q, i) => `${i + 1}: ${q.max} ${(q.share * 100).toFixed(4)} %${q.max > 0 ? ` at ${q.at[0]},${q.at[1]}` : ''}`).join('; ')}`]),
      `tree: ${tree.first ?? `equal, ${tree.elements} elements, ${tree.lines} lines`}`,
      `records of the tree: ${members.first ?? `equal to the report snapshot, ${members.compared}`}`,
    ].join('\n                   '));
  }
  console.log(`${compared} compared with the oracle, ${failed} with a disagreement`);
  return failed === 0 ? 0 : 1;
}
