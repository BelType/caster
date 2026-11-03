/**
 * `npm run identity -- compare <dir> [--only text,tags,images,rects,marks]`: the readers of the Rust writer's gate, holding forme's files to the oracle's on the committed lists.
 *
 * @remarks
 * `<dir>` holds what forme wrote from each list of `fixtures/lists/`: `<name>.pdf` and `<name>.records.json` (`forme write <list> --blobs <blobs> -o <name>.pdf --records <name>.records.json`). For every corpus document with a file there, the readers ask both files the same question and print the first disagreement of each (*the same list prints the same bytes*, DESIGN.md S102; the gate of `.claude/plans/the-rust-writer/plan-rust-writer.md` in the BelType monorepo):
 *
 * - **The content streams.** Each page's content, inflated by mupdf, tokenised as ISO 32000-2 §7.2 does and compared operator for operator, operands as written. A font's resource name is mapped through the page's resources to its `/BaseFont`, and a glyph string under it to the list's glyph ids: the oracle's CIDs are the glyph ids, and forme's are each glyph's place in its subset, `.notdef` first, read back through forme's `faces` record. `--only` keeps the operator families a stage has built: `tags` is `BDC`, `BMC`, `EMC`; `text` is every operator from `BT` to `ET`, and the `q`, `cm`, clip and `Q` of a `q … Q` that holds a text object; `images` is a `q … Q` that holds no text object and paints an image XObject with `Do`, whose name is mapped through the page's resources to what it names; `rects` is a `q … Q` that holds neither and paints a rectangle with `re`; `marks` is one that strokes in a colour space set with `CS` other than `/Pattern`, which only the print marks do. Every other resource name, a colour space (`cs`, `CS`), a graphics state (`gs`), a shading (`sh`), a pattern (`scn`, `SCN`) and an XObject (`Do`), is mapped through the stream's resources to what it names, and a Form XObject's content is read in its `Do`'s place, indented, through the form's own resources, so a form is compared operator for operator too. A `q … Q` that holds none of the families asked for is another family's and is dropped; every other operator is kept, so one no family names is a disagreement.
 * - **The records.** The oracle's records are its own, made by replaying the list through `emitStructure` in node and read through JSON, as forme's cross; `mcids` and `pens` must be equal exactly, and `kernAdjustments`, `actualTextSpans`, `xobjects` and each image use but its sizes and timings equal, and the report's image notes `recordsOf` derives from either; the paint rows equal but their resource names and `vectorResources` equal; the colour record equal but its resource names.
 * - **The images.** Per page, each image XObject its resources name, every dictionary entry but `/Length` resolved, each stream as the hash of its bytes (a `/DCTDecode` stream as written, any other inflated), so the colour space, an `/ICCBased` profile, an `/Indexed` lookup and the `/SMask` are compared with the samples (`describe`); under `--only`, only the XObjects a kept `Do` paints.
 * - **The words.** mupdf's structured text of each page: the same characters, in order, at origins within 0.01 pt. Under any `--only`, only the characters shown in a font the page's own resources name are read, since a facsimile's words are drawn by its Form XObject, which no family names.
 * - **The tree.** mupdf reads both files' structure trees element by element in allocation order and everything that points into them: every element's entries and `/K`, the ParentTree, the IDTree, `/MarkInfo`, each page's `/Tabs`, `/StructParents` and link annotations with their destinations, the outline item by item, `/PageLabels` (`treeOf`). Beside it, `recordsOf` over forme's records gives the `structure`, `links`, `outline` and `idTree` members of the committed report snapshot. The tree's families are not content, so `--only` does not restrict them.
 *
 * - **The pixels.** With no `--only`, mupdf renders each page of both files at 144 dpi, RGB, 8 bits; per page the largest channel difference and the share of pixels more than 8 of 255 apart are printed; a page with a pixel more than 64 apart, or more than 0.2 per cent of its pixels past 8, is a disagreement.
 * - **yapr**, the second reader (*a second reader is asked the same question*, S83), with no `--only`: its glyphs of each page, the text and pen origin of every glyph in content order, within 0.01 pt; and its renders of each page at 144 dpi, held to the pixel lines above. On a list with no oracle file, its glyphs are held to the list as mupdf's are. The module is `test/vendor/yapr/`.
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
import { openYapr, pageGlyphs } from '../test/read-back-yapr.ts';
import type { Yapr } from '../test/read-back-yapr.ts';

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
    // A font forme subset has its CIDs mapped back to glyph ids; any other (a facsimile's own, inside its Form XObject) is read as it is.
    const face = faces?.find((f) => base.startsWith(`${f.subsetTag}+`));
    if (face) {
      const set = [...new Set([0, ...face.glyphsUsed])].sort((a, b) => a - b);
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
  return compareChars(words(oracle, own), words(forme, own));
}

/** yapr's glyphs of each page, the second reader's words (*a second reader is asked the same question*, S83): every glyph's text and pen origin, in content order. */
function yaprWords(viewer: Yapr): Char[][] {
  return Array.from({ length: viewer.page_count() }, (_, p) => pageGlyphs(viewer, p));
}

/** Two files' characters, page by page, in order: the same character at origins within {@link TOLERANCE}. */
function compareChars(a: Char[][], b: Char[][]): { first: string | null; chars: number; worst: number } {
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
function wordsAgainstList(list: any, pages: Char[][]): { first: string | null; segments: number } {
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
 * The records the two writers share by rule: `mcids` and `pens` exactly, `kernAdjustments`, `actualTextSpans`, each image use but its sizes and timings (`bytesOut` is the deflate's, `decodeMs` and `encodeMs` clocks), `xobjects`, the paint rows but their resource names (`unnamedPaint`), `vectorResources`, and the colour record but its resource names (`unnamed`).
 */
function compareRecords(oracle: Records, forme: Records): string | null {
  const shared = (uses: ImageUse[]) => uses.map(({ info: { bytesOut, decodeMs, encodeMs, ...info }, ...use }) => ({ ...use, info }));
  oracle = { ...oracle, images: shared(oracle.images), paint: unnamedPaint(oracle.paint) as any, colour: unnamed(oracle.colour) };
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
  return pixelLines(oracle.countPages(), (p) => [oracle, forme].map((doc) => {
    const pixmap = doc.loadPage(p).toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false);
    // Copied out: `getPixels()` is a view of the module's memory, which the second render can grow, and a grown memory detaches the first view to length 0, which read as a page with no pixel apart.
    return { pixels: pixmap.getPixels().slice(), width: pixmap.getWidth(), height: pixmap.getHeight(), channels: 3 };
  }) as [Raster, Raster]);
}

/** The same reader on yapr's renderer: each page of both files at 2 device pixels a point, 144 dpi, RGBA, its alpha left out, held to the same lines. */
function compareYaprPixels(oracle: Yapr, forme: Yapr): { first: string | null; pages: { max: number; share: number; at: [number, number] }[] } {
  return pixelLines(oracle.page_count(), (p) => [oracle, forme].map((viewer) => {
    const pixels = viewer.render(p, 2).slice();
    return { pixels, width: viewer.width(), height: viewer.height(), channels: 4 };
  }) as [Raster, Raster]);
}

type Raster = { pixels: Uint8Array | Uint8ClampedArray; width: number; height: number; channels: number };

/** Every page's two numbers of the pixels reader, the rasters made by `render`, and the first page past either line. */
function pixelLines(count: number, render: (page: number) => [Raster, Raster]): { first: string | null; pages: { max: number; share: number; at: [number, number] }[] } {
  const pages: { max: number; share: number; at: [number, number] }[] = [];
  let first: string | null = null;
  for (let p = 0; p < count; p += 1) {
    const [a, b] = render(p);
    if (a.width !== b.width || a.height !== b.height || a.pixels.length === 0) {
      first ??= `page ${p + 1}: ${a.width} by ${a.height} pixels against ${b.width} by ${b.height}`;
      pages.push({ max: 255, share: 1, at: [0, 0] });
      continue;
    }
    const [x, y, n] = [a.pixels, b.pixels, a.channels];
    const width = a.width;
    let max = 0;
    let worst = 0;
    let near = 0;
    for (let i = 0; i < x.length; i += n) {
      const d = Math.max(Math.abs(x[i] - y[i]), Math.abs(x[i + 1] - y[i + 1]), Math.abs(x[i + 2] - y[i + 2]));
      if (d > max) { max = d; worst = i / n; }
      if (d > PIXEL_NEAR) near += 1;
    }
    const share = near / (x.length / n);
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
      const held = wordsAgainstList(list, words(forme));
      const second = wordsAgainstList(list, yaprWords(await openYapr(fs.readFileSync(mine))));
      if (held.first || second.first) failed += 1;
      line(`no oracle file (the oracle refuses it); words held to the list: ${held.first ?? `${held.segments} segments at their x and baseline`}; by yapr: ${second.first ?? `${second.segments} segments`}`);
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
    const records = compareRecords(oracleRecords, formeRecords);
    // A facsimile's words are drawn by its Form XObject, which no family names: under any `--only`, only the characters in a font the page's own resources name are read.
    const text = compareWords(oracle, forme, families !== null);
    const images = compareImages(oracle, forme, [oracleRecords, formeRecords], families);
    const colour = list.writing.colour ? compareColour(oracle, forme, families) : null;
    const tree = compareTrees(oracle, forme);
    // A partial gate leaves families out of the content, so the page cannot be drawn whole: the pixels are read with no `--only`.
    const pixels = families ? { first: null, pages: [] } : comparePixels(oracle, forme);
    // The second reader, with no `--only`: yapr's glyphs and yapr's pixels, the questions mupdf was asked (S83).
    const viewers = families ? null : await Promise.all([path.join(lists, `${entry.name}.pdf`), mine].map((file) => openYapr(fs.readFileSync(file))));
    const yaprText = viewers ? compareChars(yaprWords(viewers[0]), yaprWords(viewers[1])) : null;
    const yaprPixels = viewers ? compareYaprPixels(viewers[0], viewers[1]) : null;
    for (const viewer of viewers ?? []) viewer.free();
    const report = JSON.parse(fs.readFileSync(path.join(lists, `${entry.name}.report.json`), 'utf8'));
    const members = compareTreeMembers(recordsOf(list, formeRecords as any), report);
    // The report's note on each image, which `recordsOf` derives from the list and the writer's road: forme's road gives the oracle's notes.
    const notes = (r: Records) => recordsOf(list, r as any).images;
    const imageNotes = isDeepStrictEqual(notes(oracleRecords), notes(formeRecords)) ? null : `oracle ${JSON.stringify(notes(oracleRecords)).slice(0, 300)}, forme ${JSON.stringify(notes(formeRecords)).slice(0, 300)}`;
    if (streams.first || records || text.first || tree.first || members.first || images.first || imageNotes || colour?.first || pixels.first || yaprText?.first || yaprPixels?.first) failed += 1;
    line([
      `content${families ? ` (${[...families].join(',')})` : ''}: ${streams.first ?? `equal, ${streams.ops} operators`}`,
      `records: ${records ?? `equal, ${oracleRecords.pens.length} pens, ${oracleRecords.kernAdjustments} kerns, ${oracleRecords.actualTextSpans} spans, ${formeRecords.images.length} image uses, ${formeRecords.xobjects} XObjects, ${formeRecords.paint.length} paint rows, vectorResources ${JSON.stringify(formeRecords.vectorResources)}`}`,
      `images: ${images.first ?? `equal, ${images.images} XObjects page by page`}; notes: ${imageNotes ?? 'equal'}`,
      ...(colour ? [`colour: ${colour.first ?? `equal, ${colour.objects} colour spaces, graphics states and intents; record equal but names, ${formeRecords.colour.elements.length} rows, ${formeRecords.colour.blackTextRuns} black-text runs, ${formeRecords.colour.worklist.length} work-list entries`}`] : []),
      `words: ${text.first ?? `equal, ${text.chars} characters, worst ${text.worst.toFixed(4)} pt`}`,
      ...(families ? [] : [`pixels: ${pixels.first ?? 'within the lines'}; per page, largest difference and share past ${PIXEL_NEAR}: ${pixels.pages.map((q, i) => `${i + 1}: ${q.max} ${(q.share * 100).toFixed(4)} %${q.max > 0 ? ` at ${q.at[0]},${q.at[1]}` : ''}`).join('; ')}`]),
      ...(yaprText && yaprPixels ? [`yapr words: ${yaprText.first ?? `equal, ${yaprText.chars} glyphs, worst ${yaprText.worst.toFixed(4)} pt`}`, `yapr pixels: ${yaprPixels.first ?? 'within the lines'}; ${yaprPixels.pages.map((q, i) => `${i + 1}: ${q.max} ${(q.share * 100).toFixed(4)} %${q.max > 0 ? ` at ${q.at[0]},${q.at[1]}` : ''}`).join('; ')}`] : []),
      `tree: ${tree.first ?? `equal, ${tree.elements} elements, ${tree.lines} lines`}`,
      `records of the tree: ${members.first ?? `equal to the report snapshot, ${members.compared}`}`,
    ].join('\n                   '));
  }
  console.log(`${compared} compared with the oracle, ${failed} with a disagreement`);
  return failed === 0 ? 0 : 1;
}

/** One drawing as the browser presented it: its name, the page it is on, and its rectangle in CSS px from that page's top left. */
export type Drawing = { name: string; page: number; rect: [number, number, number, number] };

/** A page as the browser presented it, `scale` device pixels a CSS px, decoded to RGB or RGBA. */
export type Shot = Raster & { scale: number };

/** The two numbers of the pixels reader; the shift, in device pixels, that best registers the second raster on the first; and the two numbers again after that shift, with every pixel forgiven what an edge's antialiasing can make of it. */
type Region = { max: number; share: number; shift: [number, number]; nearMax: number; nearShare: number };


/**
 * Two rasters of one page compared over one rectangle of device pixels.
 *
 * @remarks
 * `max` and `share` are the pixels reader's: the largest channel difference, and the share of the region's pixels past {@link PIXEL_NEAR}. Then the second raster is registered on the first: of every shift up to `search` device pixels each way, the one with the least mean difference over the region, which says where the drawing landed apart from what it looks like. After that shift, `nearMax` and `nearShare` forgive antialiasing: a pixel's difference is how far each of its channels lies outside the range that channel takes over the 3 × 3 neighbourhood of the same place in the other raster, taken both ways and the larger kept. Where the neighbourhood is flat the range is one value and the number is the plain difference, so a wrong colour, alpha or blend in an area still counts in full; where an edge crosses it the range spans both sides, so a coverage that two rasterisers round differently is forgiven, while a shape out by more than a pixel is not.
 */
function region(a: Raster, b: Raster, [x0, y0, x1, y1]: [number, number, number, number], search = 0): Region {
  const at = (r: Raster, x: number, y: number) => (Math.min(Math.max(y, 0), r.height - 1) * r.width + Math.min(Math.max(x, 0), r.width - 1)) * r.channels;
  const plain = (i: number, j: number) => Math.max(Math.abs(a.pixels[i] - b.pixels[j]), Math.abs(a.pixels[i + 1] - b.pixels[j + 1]), Math.abs(a.pixels[i + 2] - b.pixels[j + 2]));
  let max = 0;
  let over = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const d = plain(at(a, x, y), at(b, x, y)); if (d > max) max = d; if (d > PIXEL_NEAR) over++; }
  let shift: [number, number] = [0, 0];
  let least = Infinity;
  for (let dy = -search; dy <= search; dy++) {
    for (let dx = -search; dx <= search; dx++) {
      let sum = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = at(a, x, y); const j = at(b, x + dx, y + dy); sum += Math.abs(a.pixels[i] - b.pixels[j]) + Math.abs(a.pixels[i + 1] - b.pixels[j + 1]) + Math.abs(a.pixels[i + 2] - b.pixels[j + 2]); }
      // The nearer shift wins a tie, so two rasters that agree read as registered where they are.
      if (sum < least || (sum === least && Math.abs(dx) + Math.abs(dy) < Math.abs(shift[0]) + Math.abs(shift[1]))) { least = sum; shift = [dx, dy]; }
    }
  }
  const [sx, sy] = shift;
  const outside = (p: Raster, px: number, py: number, q: Raster, qx: number, qy: number) => {
    const i = at(p, px, py);
    let worst = 0;
    for (let c = 0; c < 3; c++) {
      let low = 255;
      let high = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const v = q.pixels[at(q, qx + dx, qy + dy) + c]; if (v < low) low = v; if (v > high) high = v; }
      const v = p.pixels[i + c];
      worst = Math.max(worst, v < low ? low - v : v > high ? v - high : 0);
    }
    return worst;
  };
  let nearMax = 0;
  let nearOver = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (plain(at(a, x, y), at(b, x + sx, y + sy)) === 0) continue;
      const n = Math.max(outside(a, x, y, b, x + sx, y + sy), outside(b, x + sx, y + sy, a, x, y));
      if (n > nearMax) nearMax = n;
      if (n > PIXEL_NEAR) nearOver++;
    }
  }
  const count = Math.max(1, (x1 - x0) * (y1 - y0));
  return { max, share: over / count, shift, nearMax, nearShare: nearOver / count };
}

/** The line a drawing is held to against the browser: registered within one CSS px each way, and on the forgiving numbers no pixel more than {@link PIXEL_MAX} apart and no more than {@link BROWSER_SHARE} of the region past {@link PIXEL_NEAR}. */
const BROWSER_SHARE = 0.005;

/**
 * The browser's gate: each drawing of a document, as Chromium presented its page to the author, against the same region of both writers' files rendered by mupdf and by yapr at the browser's resolution, and the two writers against each other.
 *
 * @remarks
 * Two writers can agree and both be wrong; the browser is the authority both answer to (Egildo's ruling 13 of the Rust writer). The page is rendered at the shot's own scale, so a region is the drawing's CSS rectangle times the scale, grown by two device pixels on each side and clipped to the page. A drawing past the line on any reader is a disagreement and is named; writer against writer is held to the pixels reader's own lines.
 *
 * @param out - Where to write each drawing's four crops as PNG (browser, oracle, forme, and yapr's of forme), for a reader to look at; nothing is written without it.
 */
export async function againstBrowser(name: string, shots: Shot[], drawings: Drawing[], oracleFile: string, formeFile: string, out: string | null): Promise<number> {
  // Chromium writes a CSS or SVG colour's sRGB numbers into the page as they are; mupdf with ICC on maps a page's `/DefaultRGB` and its output intent through lcms, and black comes out 8, 7, 6. That is a colour-management question, not a drawing's, so mupdf renders device colour here, as yapr does.
  mupdf.disableICC();
  const docs = [open(oracleFile), open(formeFile)];
  const viewers = await Promise.all([oracleFile, formeFile].map((file) => openYapr(fs.readFileSync(file))));
  const { encode } = await import('fast-png');
  const renders = new Map<string, Raster>();
  const render = (who: 0 | 1, reader: 'mupdf' | 'yapr', p: number): Raster => {
    const key = `${who} ${reader} ${p}`;
    const held = renders.get(key);
    if (held) return held;
    // A CSS px is 72/96 of a point, so the browser's device pixels a CSS px are this many a point.
    const perPoint = (shots[p].scale * 96) / 72;
    let made: Raster;
    if (reader === 'mupdf') {
      const pixmap = docs[who].loadPage(p).toPixmap(mupdf.Matrix.scale(perPoint, perPoint), mupdf.ColorSpace.DeviceRGB, false);
      // Copied out of the module's memory, which the next render reuses.
      made = { pixels: pixmap.getPixels().slice(), width: pixmap.getWidth(), height: pixmap.getHeight(), channels: 3 };
      pixmap.destroy();
    } else {
      const pixels = viewers[who].render(p, perPoint).slice();
      made = { pixels, width: viewers[who].width(), height: viewers[who].height(), channels: 4 };
    }
    // Cicero's presented page is a CSS px short of the page box in height (measured on A4: 1121.52 px against 1122.52), so the sizes are held to a CSS px and one device pixel, and every region lies inside both.
    const slack = shots[p].scale + 1;
    if (Math.abs(made.width - shots[p].width) > slack || Math.abs(made.height - shots[p].height) > slack) throw new Error(`browser gate: ${name} page ${p + 1}: ${reader} renders ${made.width} by ${made.height} pixels, the browser's page is ${shots[p].width} by ${shots[p].height}`);
    renders.set(key, made);
    return made;
  };
  const crop = (r: Raster, [x0, y0, x1, y1]: [number, number, number, number]) => {
    const data = new Uint8Array((x1 - x0) * (y1 - y0) * 3);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) for (let c = 0; c < 3; c++) data[((y - y0) * (x1 - x0) + (x - x0)) * 3 + c] = r.pixels[(y * r.width + x) * r.channels + c];
    return encode({ width: x1 - x0, height: y1 - y0, data, channels: 3, depth: 8 });
  };
  const fmt = (r: Region) => `${String(r.max).padStart(3)} ${(r.share * 100).toFixed(2).padStart(6)} % | ${`${r.shift[0]},${r.shift[1]}`.padStart(5)} ${String(r.nearMax).padStart(3)} ${(r.nearShare * 100).toFixed(2).padStart(6)} %`;
  // Chromium snaps an inline `<svg>`'s and a transformed box's paint offset to a whole CSS px, so on screen a drawing lands up to half a CSS px from where layout put it, and further under a chain of transforms, where a PDF renderer paints where the file says (measured at 4 device pixels a CSS px: up to 0.5 px for a plain SVG and 0.75 px under a transform). A drawing may be registered by one CSS px each way; the search looks twice as far, so that a drawing out by more is named with its shift.
  const past = (r: Region, scale: number) => Math.abs(r.shift[0]) > scale || Math.abs(r.shift[1]) > scale || r.nearMax > PIXEL_MAX || r.nearShare > BROWSER_SHARE;
  if (out) fs.mkdirSync(out, { recursive: true });
  console.log(`${name}: ${drawings.length} drawings on ${shots.length} pages at ${shots[0]?.scale} device pixels a CSS px; per reader the largest channel difference and the share past ${PIXEL_NEAR} of 255, raw | the shift that registers the reader on the browser, then the two numbers forgiving a pixel's antialiasing; held to a shift of one CSS px and to ${PIXEL_MAX} and ${BROWSER_SHARE * 100} % on the forgiving numbers; writer against writer to ${PIXEL_MAX} and ${PIXEL_SHARE * 100} % raw`);
  console.log(`${'drawing'.padEnd(24)} ${'oracle (mupdf)'.padEnd(32)} ${'forme (mupdf)'.padEnd(32)} ${'oracle (yapr)'.padEnd(32)} ${'forme (yapr)'.padEnd(32)} forme against oracle (mupdf, yapr)`);
  let failed = 0;
  for (const d of drawings) {
    const shot = shots[d.page];
    const s = shot.scale;
    const inside = [shot, render(0, 'mupdf', d.page), render(1, 'mupdf', d.page), render(0, 'yapr', d.page), render(1, 'yapr', d.page)];
    const box: [number, number, number, number] = [Math.max(0, Math.floor(d.rect[0] * s) - 2), Math.max(0, Math.floor(d.rect[1] * s) - 2), Math.min(...inside.map((r) => r.width), Math.ceil((d.rect[0] + d.rect[2]) * s) + 2), Math.min(...inside.map((r) => r.height), Math.ceil((d.rect[1] + d.rect[3]) * s) + 2)];
    const rows = ([[0, 'mupdf'], [1, 'mupdf'], [0, 'yapr'], [1, 'yapr']] as const).map(([who, reader]) => region(shot, render(who, reader, d.page), box, 2 * s));
    const writers = [region(render(0, 'mupdf', d.page), render(1, 'mupdf', d.page), box), region(render(0, 'yapr', d.page), render(1, 'yapr', d.page), box)];
    const named = [...rows.map((r, i) => (past(r, s) ? ['oracle (mupdf)', 'forme (mupdf)', 'oracle (yapr)', 'forme (yapr)'][i] : null)), ...writers.map((w, i) => (w.max > PIXEL_MAX || w.share > PIXEL_SHARE ? `writers (${i ? 'yapr' : 'mupdf'})` : null))].filter(Boolean);
    if (named.length) failed++;
    console.log(`${d.name.padEnd(24)} ${rows.map(fmt).join('   ')}   ${writers.map((w) => `${w.max} ${(w.share * 100).toFixed(2)} %`).join(', ')}${named.length ? `  PAST THE LINE: ${named.join(', ')}` : ''}`);
    if (out) {
      const crops: [string, Raster][] = [['browser', shot], ['oracle', render(0, 'mupdf', d.page)], ['forme', render(1, 'mupdf', d.page)], ['forme-yapr', render(1, 'yapr', d.page)]];
      for (const [who, r] of crops) fs.writeFileSync(path.join(out, `${name}.${d.name}.${who}.png`), crop(r, box));
    }
  }
  for (const viewer of viewers) viewer.free();
  mupdf.enableICC();
  console.log(`${name}: ${drawings.length} drawings, ${failed} past the line`);
  return failed;
}
