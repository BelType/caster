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
import { CasterError } from '../src/errors.ts';
import { launchBrowser } from './launch.ts';

import type { DisplayList, LinkItem, TextItem } from '../src/displayList.ts';

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

test('a link that leaves the file carries its URI resolved: a relative href is absolute in the list', () => {
  const links = listOf('roads').pages.flatMap((page) => page.items.filter((item): item is LinkItem => item.kind === 'link'));
  const relative = links.find((link) => link.target.href === '../cast/index.html')!;
  assert.equal(relative.target.uri, 'https://print.invalid/cast/index.html');
  assert.ok(links.every((link) => (link.target.dest === undefined) === (link.target.uri !== undefined)), 'every link has a destination or a URI, never both');
  assert.equal(absoluteUri('chapter two.html#x', 'https://example.org/book/'), 'https://example.org/book/chapter%2520two.html#x', 'the parser\'s own percent-encoding is encoded again, as the writer always wrote it');
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
    assert.equal(seen.links[0].uri, `http://127.0.0.1:${port}/sub/other%2520page.html`, 'the URI is absolute, resolved against the document');
    assert.equal(seen.created, '2026-11-02T10:20:30.456Z', 'the host\'s date is the list\'s');
    assert.ok(seen.file.includes('/CreationDate (D:20261102102030Z)'), 'and the file\'s');
  } finally {
    await browser.close();
    server.close();
  }
});
