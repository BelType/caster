/**
 * The display list is all the writer is handed: the same list prints the same bytes, in node, with no page.
 *
 * @remarks
 * The node half reads the committed fixtures (`fixtures/lists/`, recorded by `npm run identity -- record --list-out`) and hands each list to `emitStructure` with nothing beside it but the report's `originOf`, answered by a dummy. The browser half prints one small page and asks HarfBuzz in the page, through the very module the print used, whether the list's widths are its own.
 *
 * @see /Users/egildo/Privata/dev/beltype/.claude/plans/the-rust-writer/plan-close-the-list.md (stage 1)
 * @packageDocumentation
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as mupdf from 'mupdf';
import { contentType } from '@beltype/common/mime';
import { load } from '../src/capabilities.ts';
import { loadSubsetter } from '../src/fonts/hbSubset.ts';
import { emitStructure } from '../src/emit/structureEmit.ts';
import { absoluteUri } from '../src/displayList/build.ts';
import { resolveStructure } from '../src/displayList/structure.ts';
import { CasterError } from '../src/errors.ts';
import { launchBrowser } from './launch.ts';

import type { DisplayList, LinkItem, StructElement, TextItem } from '../src/displayList.ts';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const LISTS = path.join(PACKAGE, 'fixtures', 'lists');
const DIST = path.join(PACKAGE, 'dist');
const COMMON = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));
const FONTS = path.join(PACKAGE, 'fixtures', 'specimen', 'fonts');

/** The documents whose images take the browser's decoders inside the writer, which node does not have until stage 3 moves them before the list. */
const DECODED_IN_THE_WRITER = new Set(['webp', 'photo']);

type Entry = { name: string; list: { blobs: string[] } };
const corpus: Entry[] = JSON.parse(fs.readFileSync(path.join(LISTS, 'corpus.json'), 'utf8')).documents;

/** A committed list with its blobs, each checked against its name. */
function listOf(name: string): DisplayList {
  const list = JSON.parse(fs.readFileSync(path.join(LISTS, `${name}.json`), 'utf8'));
  list.resources.blobs = {};
  for (const hash of corpus.find((e) => e.name === name)!.list.blobs) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(LISTS, 'blobs', hash)));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), hash, `the blob ${hash} is what its name says`);
    list.resources.blobs[hash] = bytes;
  }
  return list;
}

/** The report's join to the walk's text origins, which reaches no byte. */
const originOf = (page: number, index: number) => ({ run: index, paragraph: 0, path: `test:${page}:${index}`, color: '', rectPt: [0, 0, 0, 0] as [number, number, number, number] });

const textItems = (list: DisplayList) => list.pages.flatMap((page) => page.items.filter((item): item is TextItem => item.kind === 'text'));

before(async () => {
  await load(['pdf', 'fontkit', 'hbSubset', 'fastPng']);
  await loadSubsetter();
});

test('the same list prints the same bytes: every committed list the writer can write in node gives the committed file', async () => {
  const replayed = corpus.filter((e) => !DECODED_IN_THE_WRITER.has(e.name));
  assert.ok(replayed.length >= 6, 'the six documents that take no browser decoder');
  for (const { name } of replayed) {
    const list = listOf(name);
    assert.equal(list.version, 3, `${name}: a version 3 list`);
    const emitted = await emitStructure(list, { originOf });
    assert.ok(Buffer.from(emitted.bytes).equals(fs.readFileSync(path.join(LISTS, `${name}.pdf`))), `${name}: the file is byte for byte the committed one`);
  }
});

/** The list's tree resolved beside the writer's own: what the builder decides from the walk's tree and the pages' tags and links. */
function resolvedOf(list: any) {
  const contents: { page: number; item: number; owner: string; seq: number }[] = [];
  const links: { order: number; owner: string; dest?: string }[] = [];
  const linkAt: { page: number; item: LinkItem }[] = [];
  list.pages.forEach((page: any, p: number) => page.items.forEach((item: any, i: number) => {
    if (item.kind === 'tag' && item.start && 'struct' in item.start) contents.push({ page: p, item: i, owner: item.start.struct, seq: item.start.seq });
    if (item.kind === 'link') { links.push({ order: item.order, owner: item.struct, ...(item.target.dest ? { dest: item.target.dest.struct } : {}) }); linkAt.push({ page: p, item }); }
  }));
  const resolved = resolveStructure(list.structure, contents, links, list.figureBoxes, list.outline.map((h: any) => h.path));
  return { elements: resolved.structure.elements, links: linkAt.map(({ page, item }, i) => ({ page, order: item.order, element: resolved.linkElement[i], dest: resolved.destElement[i] })) };
}

/**
 * Read the file's structure tree back and hold it to the resolved one: element for element in allocation order, every `/K` entry in order, every entry and attribute object, every `/Dest`.
 *
 * @returns How many elements were compared.
 */
function assertTreeIsWritten(name: string, list: DisplayList, tree: { elements: StructElement[]; links: { page: number; order: number; element: number; dest?: number }[] }, bytes: Uint8Array): number {
  const doc = mupdf.Document.openDocument(Buffer.from(bytes), 'application/pdf') as mupdf.PDFDocument;
  const pageRefs = list.pages.map((_, i) => doc.findPage(i).asIndirect());
  // The MCID of a content start is its place among its page's content starts.
  const mcidAt = list.pages.map((page) => {
    const at = new Map<number, number>();
    page.items.forEach((item, i) => { if (item.kind === 'tag' && 'start' in item && !('artifact' in item.start)) at.set(i, at.size); });
    return at;
  });
  const text = (obj: mupdf.PDFObject) => (obj.isNull() ? undefined : obj.asString());
  const plainOf = (obj: mupdf.PDFObject): unknown => {
    if (obj.isName()) return obj.asName();
    if (obj.isNumber()) return Math.round(obj.asNumber() * 1000) / 1000; // mupdf reads a real as a float
    if (obj.isString()) return obj.asString();
    if (obj.isArray()) { const out: unknown[] = []; for (let i = 0; i < obj.length; i++) out.push(plainOf(obj.get(i))); return out; }
    const out: Record<string, unknown> = {};
    obj.forEach((value, key) => { out[String(key)] = plainOf(value); });
    return out;
  };
  const objects: number[] = [];
  const visit = (index: number, obj: mupdf.PDFObject, parent: number) => {
    const element = tree.elements[index];
    const where = `${name}: element ${index} (${element.path})`;
    objects[index] = obj.asIndirect();
    assert.equal(obj.get('S').asName(), element.type, `${where}: /S`);
    assert.equal(obj.get('P').asIndirect(), parent, `${where}: /P`);
    for (const [key, member] of [['Lang', 'lang'], ['Alt', 'alt'], ['E', 'expansion'], ['ID', 'id']] as const) assert.equal(text(obj.get(key)), element[member], `${where}: /${key}`);
    const a = obj.get('A');
    assert.deepEqual(a.isNull() ? undefined : a.isArray() ? plainOf(a) : [plainOf(a)], element.attributes, `${where}: /A`);
    const k = obj.get('K');
    assert.equal(k.length, element.children.length, `${where}: /K length`);
    element.children.forEach((child, j) => {
      const entry = k.get(j);
      if (typeof child === 'number') return visit(child, entry, obj.asIndirect());
      if ('link' in child) {
        assert.equal(entry.get('Type').asName(), 'OBJR', `${where}: /K[${j}] an /OBJR`);
        return assert.equal(entry.get('Obj').get('StructParent').asNumber(), list.info.pageCount + child.link, `${where}: /K[${j}] the link of order ${child.link}`);
      }
      const mcid = mcidAt[child.page].get(child.item);
      assert.notEqual(mcid, undefined, `${where}: /K[${j}] names a content start`);
      if (entry.isNumber()) {
        assert.equal(entry.asNumber(), mcid, `${where}: /K[${j}] the MCID`);
        assert.equal(obj.get('Pg').asIndirect(), pageRefs[child.page], `${where}: /Pg`);
      } else {
        assert.equal(entry.get('MCID').asNumber(), mcid, `${where}: /K[${j}] the /MCR's MCID`);
        assert.equal(entry.get('Pg').asIndirect(), pageRefs[child.page], `${where}: /K[${j}] the /MCR's page`);
      }
    });
  };
  const root = doc.getTrailer().get('Root').get('StructTreeRoot');
  assert.equal(root.get('K').length, 1, `${name}: one root element`);
  visit(0, root.get('K').get(0), doc.getTrailer().get('Root').get('StructTreeRoot').asIndirect());
  assert.equal(objects.filter((n) => n !== undefined).length, tree.elements.length, `${name}: every element is written once`);
  assert.ok(objects.every((n, i) => i === 0 || n > objects[i - 1]), `${name}: the elements are allocated in the array's order`);
  for (const link of tree.links) {
    const annots = doc.findPage(link.page).get('Annots');
    let annot: mupdf.PDFObject | null = null;
    for (let i = 0; i < annots.length; i++) if (annots.get(i).get('StructParent').asNumber() === list.info.pageCount + link.order) annot = annots.get(i);
    assert.ok(annot, `${name}: the link of order ${link.order} is an annotation on page ${link.page + 1}`);
    const dest = annot.get('Dest');
    assert.equal(dest.isNull() ? undefined : objects.indexOf(dest.get(0).asIndirect()), link.dest, `${name}: the link of order ${link.order} names the element its destination resolved to`);
  }
  return tree.elements.length;
}

test('the resolved tree is the tree the writer writes: every element, every /K in order, every attribute, every destination', async () => {
  let compared = 0;
  for (const { name } of corpus.filter((e) => !DECODED_IN_THE_WRITER.has(e.name))) {
    const list = listOf(name);
    compared += assertTreeIsWritten(name, list, resolvedOf(list), (await emitStructure(list, { originOf })).bytes);
  }
  assert.ok(compared > 150, `${compared} elements compared`);
});

// --- the resolver's rules, one by one, on a tree made by hand ----------------------------------------------

/** A walk node. */
const n = (tag: string, path: string, kids: any[] = [], attrs: Record<string, unknown> = {}) => ({ tag, path, attrs, kids });

test('the resolver prunes an element that owns nothing, and keeps an empty cell and the row around it', () => {
  const tree = n('Document', 'D', [n('P', 'D/P0'), n('Sect', 'D/S0', [n('P', 'D/S0/P0')]), n('Table', 'D/T0', [n('TR', 'D/T0/TR0', [n('TD', 'D/T0/TR0/TD0'), n('TD', 'D/T0/TR0/TD1')])])]);
  const { structure } = resolveStructure(tree, [{ page: 0, item: 0, owner: 'D/T0/TR0/TD1', seq: 5 }], [], {}, []);
  assert.deepEqual(structure.elements.map((e) => e.path), ['D', 'D/T0', 'D/T0/TR0', 'D/T0/TR0/TD0', 'D/T0/TR0/TD1'], 'the empty P and the Sect around an empty P are gone; the empty TD stays, in DOM order');
});

test('the resolver orders /K by reading key: content and children by the earliest content under them, an empty child after the sibling before it, the annotation last', () => {
  const tree = n('Document', 'D', [n('P', 'D/P0', [n('Link', 'D/P0/Link0')]), n('TD', 'D/TD0'), n('P', 'D/P1'), n('TD', 'D/TD1')]);
  const contents = [
    { page: 0, item: 1, owner: 'D/P1', seq: 1 },
    { page: 0, item: 4, owner: 'D/P0', seq: 3 },
    { page: 0, item: 7, owner: 'D/P0/Link0', seq: 2 },
    { page: 1, item: 0, owner: 'D/P0', seq: 1e6 },
  ];
  const { structure } = resolveStructure(tree, contents, [{ order: 0, owner: 'D/P0/Link0' }], {}, []);
  const [root, p0, link, td0, p1, td1] = structure.elements;
  assert.deepEqual(structure.elements.map((e) => e.path), ['D', 'D/P0', 'D/P0/Link0', 'D/TD0', 'D/P1', 'D/TD1'], 'allocation is DOM order');
  assert.deepEqual(root.children, [4, 5, 1, 3], 'P1 reads first and P0 second; an empty TD has no key of its own and takes that of the sibling declared before it, so TD1 follows P1 and TD0 follows P0');
  assert.deepEqual(p0.children, [2, { page: 0, item: 4 }, { page: 1, item: 0 }], 'the Link (key 2) before P0\'s own content (3, then the next page)');
  assert.deepEqual(link.children, [{ page: 0, item: 7 }, { link: 0 }], 'the /OBJR after the content');
  assert.deepEqual([td0.children, p1.children, td1.children], [[], [{ page: 0, item: 1 }], []]);
});

test('the resolver points a destination at the first element under its target with content of its own, and refuses one with none', () => {
  const tree = n('Document', 'D', [n('Sect', 'D/S0', [n('Div', 'D/S0/Div0', [n('P', 'D/S0/Div0/P0')]), n('H2', 'D/S0/H0'), n('Div', 'D/S0/Div1')]), n('Link', 'D/L0'), n('Sect', 'D/S1', [n('TD', 'D/S1/TD0')])]);
  const contents = [{ page: 0, item: 0, owner: 'D/S0/H0', seq: 1 }, { page: 0, item: 2, owner: 'D/S0/Div0/P0', seq: 2 }, { page: 0, item: 4, owner: 'D/L0', seq: 3 }];
  const resolved = resolveStructure(tree, contents, [{ order: 0, owner: 'D/L0', dest: 'D/S0' }, { order: 1, owner: 'D/L0' }], {}, ['D/S0/H0']);
  const at = (path: string) => resolved.structure.elements.findIndex((e) => e.path === path);
  assert.deepEqual(resolved.destElement, [at('D/S0/H0'), undefined], 'the Sect has no /Pg; its first child in reading order, the heading, does');
  assert.deepEqual(resolved.linkElement, [at('D/L0'), at('D/L0')]);
  assert.deepEqual(resolved.structure.elements[at('D/L0')].children, [{ page: 0, item: 4 }, { link: 1 }], 'one element, two links: the later one is its /OBJR, as the writer always kept it');
  assert.deepEqual(resolved.headingElement, [at('D/S0/H0')]);
  assert.throws(() => resolveStructure(tree, contents, [{ order: 0, owner: 'D/L0', dest: 'D/S1' }], {}, []), /the destination at D\/S1 has no content anywhere under it/);
  assert.throws(() => resolveStructure(tree, contents, [], {}, ['D/S0/Div1']), /the heading at D\/S0\/Div1 was pruned/);
  assert.throws(() => resolveStructure(tree, contents, [{ order: 0, owner: 'D/Nowhere' }], {}, []), /the link at D\/Nowhere has no structure element/);
  assert.throws(() => resolveStructure(tree, [{ page: 0, item: 9, owner: 'D/Nowhere', seq: 0 }], [], {}, []), (error: unknown) => error instanceof CasterError && error.listItem?.item === 9);
});

test('the resolver writes the attribute objects /A carries, in order, and leaves out an empty entry', () => {
  const tree = n('Document', 'D', [
    n('Figure', 'D/F0', [], { alt: 'A chart', lang: 'it' }),
    n('L', 'D/L0', [n('LI', 'D/L0/LI0', [n('LBody', 'D/L0/LI0/LBody0')])], { listNumbering: 'Decimal' }),
    n('TH', 'D/TH0', [], { scope: 'Column', id: 'h1', rowSpan: 1, colSpan: 2 }),
    n('TD', 'D/TD0', [], { headers: ['h1'], rowSpan: 3 }),
    n('TD', 'D/TD1', [], { headers: [] }),
    n('Span', 'D/Span0', [], { textPosition: 'Sup', alt: '', expansion: 'Portable Document Format' }),
  ]);
  const contents = ['D/F0', 'D/L0/LI0/LBody0', 'D/TH0', 'D/TD0', 'D/Span0'].map((owner, item) => ({ page: 0, item, owner, seq: item }));
  const byPath = Object.fromEntries(resolveStructure(tree, contents, [], { 'D/F0': [10, 20, 30.0004, 40] }, []).structure.elements.map((e) => [e.path, e]));
  assert.deepEqual(byPath['D/F0'], { type: 'Figure', path: 'D/F0', lang: 'it', alt: 'A chart', attributes: [{ O: 'Layout', BBox: [10, 20, 40, 60] }], children: [{ page: 0, item: 0 }] }, 'the box as a PDF rectangle, to thousandths');
  assert.deepEqual(byPath['D/L0'].attributes, [{ O: 'List', ListNumbering: 'Decimal' }]);
  assert.deepEqual(byPath['D/TH0'].attributes, [{ O: 'Table', Scope: 'Column', ColSpan: 2 }], 'a span of one is not written');
  assert.equal(byPath['D/TH0'].id, 'h1');
  assert.deepEqual(byPath['D/TD0'].attributes, [{ O: 'Table', Headers: ['h1'], RowSpan: 3 }]);
  assert.equal(byPath['D/TD1'].attributes, undefined, 'a cell with nothing to say has no /A');
  assert.deepEqual(byPath['D/Span0'], { type: 'Span', path: 'D/Span0', expansion: 'Portable Document Format', attributes: [{ O: 'Layout', TextPosition: 'Sup' }], children: [{ page: 0, item: 4 }] }, 'an empty /Alt is left out');
});

test('the widths cover every glyph a text item shows and every space glyph it names, and the writer refuses one that is missing', async () => {
  for (const { name } of corpus) {
    const list = listOf(name);
    for (const item of textItems(list)) {
      const instance = list.resources.fonts.find((f) => f.key === item.font)!;
      const have = new Set(instance.widths.gids);
      for (const gid of [...item.glyphs.ids, item.space]) assert.ok(have.has(gid), `${name}: ${item.font} holds a width for glyph ${gid}`);
      assert.deepEqual(instance.widths.gids, [...instance.widths.gids].sort((a, b) => a - b), `${name}: ${item.font}'s widths are sorted by glyph id`);
    }
  }
  const list = listOf('cast');
  const instance = list.resources.fonts.find((f) => textItems(list).some((item) => item.font === f.key))!;
  const dropped = instance.widths.gids.pop()!;
  instance.widths.units.pop();
  await assert.rejects(emitStructure(list, { originOf }), (error: unknown) => error instanceof CasterError && error.message.includes(`glyph ${dropped} of ${instance.key}`));
});

test('the fonts array order is the resource order: the writer embeds and names F0, F1, … in it, whatever the order', async () => {
  for (const reversed of [false, true]) {
    const list = listOf('paper');
    if (reversed) list.resources.fonts.reverse();
    const emitted = await emitStructure(list, { originOf });
    const faces = emitted.report.emission!.faces;
    assert.deepEqual(faces.map((f) => f.id), list.resources.fonts.map((f) => f.key), 'the faces are recorded in the array order');
    const doc = mupdf.Document.openDocument(Buffer.from(emitted.bytes), 'application/pdf') as mupdf.PDFDocument;
    const fonts = doc.loadPage(0).getObject().get('Resources').get('Font');
    // The subset tag is a hash of face, coordinates and glyph set, so each instance's `/BaseFont` is its own.
    faces.forEach((face, i) => assert.equal(fonts.get(`F${i}`).get('BaseFont').asName(), `${face.subsetTag}+${face.postScriptName}`, `F${i} is the array's instance ${i}${reversed ? ', reversed' : ''}`));
    assert.equal(new Set(faces.map((f) => f.subsetTag)).size, faces.length, 'no two instances share a /BaseFont');
  }
});

test('a link\'s URI is percent-encoded once: a space, a %20, a non-ASCII path and a query each arrive in one encoding', () => {
  const base = 'https://example.org/book/';
  assert.equal(absoluteUri('https://example.org/a path', base), 'https://example.org/a%20path', 'a space is %20, not %2520');
  assert.equal(absoluteUri('https://example.org/a%20path', base), 'https://example.org/a%20path', 'a %20 the author wrote stays %20');
  assert.equal(absoluteUri('chapter two.html#x', base), 'https://example.org/book/chapter%20two.html#x', 'a relative href, resolved and encoded once');
  assert.equal(absoluteUri('https://example.org/café/über', base), 'https://example.org/caf%C3%A9/%C3%BCber', 'a non-ASCII path is its UTF-8, encoded once');
  assert.equal(absoluteUri('https://example.org/s?q=a b&x=é#frag ment', base), 'https://example.org/s?q=a%20b&x=%C3%A9#frag%20ment', 'a query and a fragment, encoded once, their reserved characters kept');
  assert.equal(absoluteUri('https://example.org/a%2541', base), 'https://example.org/a%2541', 'an encoded percent sign stays one encoding deep');
  assert.equal(absoluteUri('https://example.org/100%', base), 'https://example.org/100%25', 'a bare percent sign is encoded');
  assert.equal(absoluteUri('https://example.org/p|q^r', base), 'https://example.org/p%7Cq%5Er', 'what the parser leaves raw and RFC 3986 refuses is encoded');
  for (const link of listOf('roads').pages.flatMap((page) => page.items.filter((item): item is LinkItem => item.kind === 'link')))
    if (link.target.uri !== undefined) assert.ok(!/%25[0-9A-Fa-f]{2}/u.test(link.target.uri), `roads: ${link.target.uri} is encoded once`);
});

test('a link that leaves the file carries its URI resolved: a relative href is absolute in the list', () => {
  const links = listOf('roads').pages.flatMap((page) => page.items.filter((item): item is LinkItem => item.kind === 'link'));
  const relative = links.find((link) => link.target.href === '../cast/index.html')!;
  assert.equal(relative.target.uri, 'https://print.invalid/cast/index.html');
  assert.ok(links.every((link) => (link.target.dest === undefined) === (link.target.uri !== undefined)), 'every link has a destination or a URI, never both');
  assert.equal(absoluteUri('http://[not a host', 'https://example.org/'), 'http://[not a host', 'an href the parser refuses is kept as written');
});

test('the writer reads the creation date from the list, and refuses one that is not an instant in UTC', async () => {
  const list = listOf('cast');
  list.info.created = '2026-11-02T10:20:30.456Z';
  const text = Buffer.from((await emitStructure(list, { originOf })).bytes).toString('latin1');
  assert.ok(text.includes('/CreationDate (D:20261102102030Z)') && text.includes('/ModDate (D:20261102102030Z)'), 'both dates, at whole seconds');
  list.info.created = '2026-11-02 10:20';
  await assert.rejects(emitStructure(list, { originOf }), CasterError);
});

test('the writer refuses a list of another version', async () => {
  const list = listOf('cast');
  (list as { version: number }).version = 2;
  await assert.rejects(emitStructure(list, { originOf }), (error: unknown) => error instanceof CasterError && /version 2/.test(error.message));
});

// --- in the page ------------------------------------------------------------

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>
<style>
@font-face { font-family: "Crimson Pro"; src: url("/fonts/CrimsonPro-Variable.ttf"); font-weight: 200 900; }
body { margin: 0; }
.s { width: 90mm; height: 50mm; padding: 4mm; box-sizing: border-box; font: 15px/1.4 "Crimson Pro"; }
p { margin: 0; } b { font-weight: 650; }
</style></head><body><div class="s"><p>Light <b>heavier</b> words, and <a href="sub/other page.html">a relative link</a>.</p></div></body></html>`;

function serve(): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
    const [root, rel] = url.pathname.startsWith('/common/') ? [COMMON, url.pathname.slice(8)] : url.pathname.startsWith('/fonts/') ? [FONTS, url.pathname.slice(7)] : [DIST, url.pathname.slice(1)];
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': contentType(file) }).end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('in the page: the list\'s widths are HarfBuzz\'s for every glyph it holds, its links are resolved against the document, and its date is the host\'s', async () => {
  const server = await serve();
  const port = (server.address() as { port: number }).port;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.evaluate(() => document.fonts.ready);
    /** What the page answers. */
    type Seen = { version: number; created: string; fonts: { key: string; coords: Record<string, number>; gids: number[]; units: number[]; harfbuzz: number[] }[]; used: { font: string; gids: number[] }[]; links: { href: string; uri?: string }[]; file: string };
    const seen: Seen = await page.evaluate(async () => {
      const load = (p: string) => import(p);
      const caster = await load('/src/index.js');
      // The module the print shaped with: one URL, one instance, one registry of fonts.
      const hb = await load('/src/fonts/hbShaper.js');
      const axis = await load('/src/fonts/axisMap.js');
      caster.prepare(document);
      const strip = document.querySelector('.s') as HTMLElement;
      const box = strip.getBoundingClientRect();
      const pt = (px: number) => Math.round(((px * 72) / 96) * 1000) / 1000;
      const printed = await caster.print({
        document,
        created: '2026-11-02T10:20:30.456Z',
        strip: {
          strip, probeRoot: strip, pageElements: [strip],
          pages: [{ element: strip, index: 0, flow: [...strip.children], flowBox: null, trimBox: null, nominal: { widthPt: pt(box.width), heightPt: pt(box.height) }, declaredPx: { widthPx: box.width, heightPx: box.height }, contentArea: strip, continuations: [] }],
          pageOfNode: new Map(), twinOf: () => null, transparent: () => false, lang: 'en', pageElementOf: () => strip, backgrounds: [],
        },
      });
      const list = printed.displayList;
      const fonts = list.resources.fonts.map((f: any) => ({
        key: f.key,
        coords: f.coords,
        gids: f.widths.gids,
        units: f.widths.units,
        harfbuzz: f.widths.gids.map((gid: number) => hb.glyphAdvance(f.url, gid, axis.shaperVariations(f.coords))),
      }));
      const items = list.pages.flatMap((p: any) => p.items);
      return {
        version: list.version,
        created: list.info.created,
        fonts,
        used: items.filter((i: any) => i.kind === 'text').map((i: any) => ({ font: i.font, gids: [...i.glyphs.ids, i.space] })),
        links: items.filter((i: any) => i.kind === 'link').map((i: any) => i.target),
        file: new TextDecoder('latin1').decode(printed.bytes),
      };
    });
    assert.equal(seen.version, 3);
    assert.ok(seen.fonts.length >= 2 && seen.fonts.every((f) => Object.keys(f.coords).length > 0), `two instances of the variable face, each pinned: ${JSON.stringify(seen.fonts.map((f) => f.key))}`);
    for (const font of seen.fonts) assert.deepEqual(font.units, font.harfbuzz, `${font.key}: the list's widths are HarfBuzz's at the instance's coordinates`);
    for (const { font, gids } of seen.used) {
      const held = new Set(seen.fonts.find((f) => f.key === font)!.gids);
      assert.ok(gids.every((gid) => held.has(gid)), `${font}: every glyph the item shows has its width`);
    }
    assert.equal(seen.links.length, 1);
    assert.equal(seen.links[0].href, 'sub/other page.html', 'the href stays as written, for the report');
    assert.equal(seen.links[0].uri, `http://127.0.0.1:${port}/sub/other%20page.html`, 'the URI is absolute, resolved against the document');
    assert.equal(seen.created, '2026-11-02T10:20:30.456Z', 'the host\'s date is the list\'s');
    assert.ok(seen.file.includes('/CreationDate (D:20261102102030Z)'), 'and the file\'s');
  } finally {
    await browser.close();
    server.close();
  }
});
