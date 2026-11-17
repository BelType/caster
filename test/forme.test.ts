/**
 * The Rust writer's door in node, whatever writer the run prints with: forme's vendored module writes every committed list, the same bytes twice, and a refusal that names an item crosses as a `CasterError` carrying it, as the oracle's does.
 *
 * @remarks
 * forme is held to the oracle's files by the readers of `npm run identity -- compare`, and to its own bytes in the page by `npm run identity -- check --writer forme`; this is the part of both a suite can afford. `CASTER_WRITER=forme npm test` runs every other suite with forme too (`test/writer.ts`).
 *
 * The browser half holds the page's road, a dedicated worker (*the writer pauses after 50 ms of work*, S93, amended): the worker writes node's bytes, a refusal crosses it with node's sentence and `listItem`, and a page whose policy forbids the worker (`worker-src 'none'`) is refused by name, with nothing written on the main thread. It serves `dist/`, so run `npm run build` first.
 *
 * @see /Users/egildo/Privata/dev/beltype/.claude/plans/the-rust-writer/plan-rust-writer.md (stage 9, and ruling 6 of 2026-11-03)
 * @packageDocumentation
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from '../src/capabilities.ts';
import { writeWithForme } from '../src/emit/forme.ts';
import { recordsOf } from '../src/displayList/records.ts';
import { CasterError } from '../src/errors.ts';
import { contentType } from '@beltype/common/mime';
import { launchBrowser } from './launch.ts';
import { loadWriters } from './writer.ts';
import { emitStructure } from '../src/emit/structureEmit.ts';
import { validateList } from '../src/displayList/validate.ts';
import * as mupdf from 'mupdf';

import type { DisplayList } from '../src/displayList.ts';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const LISTS = path.join(PACKAGE, 'fixtures', 'lists');
const DIST = path.join(PACKAGE, 'dist');
const COMMON = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));
const corpus: { name: string; list: { blobs: string[] } }[] = JSON.parse(fs.readFileSync(path.join(LISTS, 'corpus.json'), 'utf8')).documents;

function listOf(name: string): DisplayList {
  const list = JSON.parse(fs.readFileSync(path.join(LISTS, `${name}.json`), 'utf8'));
  list.resources.blobs = Object.fromEntries(corpus.find((e) => e.name === name)!.list.blobs.map((hash) => [hash, new Uint8Array(fs.readFileSync(path.join(LISTS, 'blobs', hash)))]));
  return list;
}

before(async () => { await load(['forme']); });

test('forme writes every committed list in node, the CFF2 face the oracle refuses among them, the same bytes twice, with records recordsOf reads', async () => {
  for (const { name } of corpus) {
    const first = await writeWithForme(listOf(name));
    const second = await writeWithForme(listOf(name));
    assert.ok(Buffer.from(first.bytes).equals(Buffer.from(second.bytes)), `${name}: the second write is the first`);
    assert.equal(Buffer.from(first.bytes).subarray(0, 8).toString('latin1'), '%PDF-2.0', `${name}: a PDF 2.0 file`);
    assert.equal(recordsOf(listOf(name), first.records).runs.length, first.records.pens.length, `${name}: one run per pen`);
  }
});

/** The cast list with one width dropped, which forme refuses naming the glyph and the item that shows it. */
function brokenCast(): { list: DisplayList, dropped: number, key: string } {
  const list = listOf('cast');
  const instance = list.resources.fonts.find((f) => list.pages.some((page) => page.items.some((item) => item.kind === 'text' && item.font === f.key)))!;
  const dropped = instance.widths.gids.pop()!;
  instance.widths.units.pop();
  return { list, dropped, key: instance.key };
}

test('a refusal of forme\'s that names an item crosses as a CasterError carrying it', async () => {
  const { list, dropped, key } = brokenCast();
  await assert.rejects(writeWithForme(list), (error: unknown) => error instanceof CasterError && error.message.includes(`glyph ${dropped} of ${key}`) && error.listItem !== undefined && Number.isInteger(error.listItem.page) && Number.isInteger(error.listItem.item));
});

/** What a file's structure tree says of its namespaces and references: the root's `/Namespaces` in order, and each element's `/S`, `/NS` URI and `/Ref` as the `/S` of what it names, depth first. */
function namesOf(bytes: Uint8Array): { namespaces: string[]; elements: string[] } {
  const doc = mupdf.Document.openDocument(Buffer.from(bytes), 'application/pdf') as mupdf.PDFDocument;
  const root = doc.getTrailer().get('Root').get('StructTreeRoot');
  const namespaces: string[] = [];
  root.get('Namespaces').forEach((ns: mupdf.PDFObject) => { namespaces.push(ns.get('NS').asString()); });
  const elements: string[] = [];
  const visit = (e: mupdf.PDFObject) => {
    if (!e.isDictionary() || e.get('Type').asName() !== 'StructElem') return;
    const refs: string[] = [];
    if (e.get('Ref').isArray()) e.get('Ref').forEach((r: mupdf.PDFObject) => { refs.push(r.get('S').asName()); });
    elements.push(`${e.get('S').asName()} ${e.get('NS').get('NS').asString()}${refs.length ? ` -> ${refs.join(',')}` : ''}`);
    const kids = e.get('K');
    if (kids.isArray()) kids.forEach((k: mupdf.PDFObject) => visit(k)); else visit(kids);
  };
  root.get('K').forEach((k: mupdf.PDFObject) => visit(k));
  return { namespaces, elements };
}

test('forme writes a list\'s older namespace and its /Ref as the oracle does, and a list without them as it was; it refuses a bad namespace or ref in the oracle\'s sentence', async () => {
  await loadWriters();
  const plain = listOf('cast');
  const before = namesOf((await writeWithForme(plain)).bytes);
  assert.deepEqual(before.namespaces, ['http://iso.org/pdf2/ssn'], 'a list without an older type: one namespace');
  const older = () => {
    const list = listOf('cast');
    const [a, b] = [1, 2];
    list.structure.elements[a].namespace = 'http://iso.org/pdf/ssn';
    list.structure.elements[a].refs = [b];
    list.structure.elements[b].refs = [a, 0];
    return list;
  };
  const ours = namesOf((await writeWithForme(older())).bytes);
  const oracle = namesOf((await emitStructure(older())).bytes);
  assert.deepEqual(ours, oracle, 'the two writers write the same namespaces and references');
  assert.deepEqual(ours.namespaces, ['http://iso.org/pdf2/ssn', 'http://iso.org/pdf/ssn']);
  assert.equal(ours.elements.filter((e) => e.includes('http://iso.org/pdf/ssn')).length, 1);
  assert.equal(ours.elements.filter((e) => e.includes(' -> ')).length, 2);
  for (const change of [(l: DisplayList) => { l.structure.elements[1].namespace = 'urn:x'; }, (l: DisplayList) => { l.structure.elements[1].refs = []; }, (l: DisplayList) => { l.structure.elements[1].refs = [999]; }]) {
    const list = listOf('cast');
    change(list);
    let sentence = '';
    try { validateList(list); } catch (error) { sentence = (error as Error).message; }
    assert.ok(sentence !== '', 'the oracle refuses it');
    await assert.rejects(writeWithForme(list), (error: unknown) => error instanceof CasterError && error.message === sentence, sentence);
  }
});

/** A static server over `dist/`, `@beltype/common` and the committed lists, the page sent with `policy` as its Content-Security-Policy. */
function serve(policy?: string): Promise<http.Server> {
  const page = `<!doctype html><meta charset="utf-8"><script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script><title>forme in a worker</title>`;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return void response.writeHead(200, { 'Content-Type': 'text/html', ...(policy ? { 'Content-Security-Policy': policy } : {}) }).end(page);
    const [root, rel] = url.pathname.startsWith('/common/') ? [COMMON, url.pathname.slice(8)] : url.pathname.startsWith('/lists/') ? [LISTS, url.pathname.slice(7)] : [DIST, url.pathname.slice(1)];
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': contentType(file) }).end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/**
 * Write `list` in a page served under `policy`: the file's bytes as an array, or the refusal's name, sentence, `listItem`, `capability` and `flag`, and whether the main thread instantiated the glue.
 */
async function writeInPage(list: DisplayList, policy?: string) {
  const server = await serve(policy);
  const port = (server.address() as { port: number }).port;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    const blobs = Object.fromEntries(Object.entries(list.resources.blobs).map(([key, bytes]) => [key, Array.from(bytes)]));
    return await page.evaluate(async ({ json, blobs }) => {
      const load = (p: string) => import(/* webpackIgnore: true */ p);
      const capabilities = await load('/src/capabilities.js');
      const forme = await load('/src/emit/forme.js');
      await capabilities.load(['forme']);
      const list = JSON.parse(json);
      list.resources.blobs = Object.fromEntries(Object.entries(blobs as Record<string, number[]>).map(([key, bytes]) => [key, new Uint8Array(bytes)]));
      const main = () => { try { return capabilities.capability('forme').module.Writer !== undefined && Boolean(new capabilities.capability('forme').module.Writer()); } catch { return false; } };
      try {
        const written = await forme.writeWithForme(list);
        return { bytes: Array.from(written.bytes as Uint8Array), runs: written.records.pens.length, mainThread: main() };
      } catch (error) {
        const e = error as { name: string, message: string, listItem?: unknown, capability?: string, flag?: string };
        return { refused: { name: e.name, message: e.message, listItem: e.listItem, capability: e.capability, flag: e.flag }, mainThread: main() };
      }
    }, { json: JSON.stringify({ ...list, resources: { ...list.resources, blobs: {} } }), blobs });
  } finally {
    await browser.close();
    server.close();
  }
}

test('in a page forme writes in a dedicated worker, node\'s bytes, and the main thread never instantiates the module', async () => {
  const answer = await writeInPage(listOf('cast'));
  assert.ok('bytes' in answer, `the worker wrote: ${JSON.stringify(answer)}`);
  const here = await writeWithForme(listOf('cast'));
  assert.ok(Buffer.from(answer.bytes!).equals(Buffer.from(here.bytes)), 'the worker\'s file is node\'s, byte for byte');
  assert.equal(answer.runs, here.records.pens.length, 'the records crossed');
  assert.equal(answer.mainThread, false, 'the glue was never initialised on the main thread');
});

test('a page whose policy forbids WebAssembly is refused by name before any worker', async () => {
  const answer = await writeInPage(listOf('cast'), "default-src 'self'; script-src 'self' 'unsafe-inline'");
  assert.ok('refused' in answer, `the page refused: ${JSON.stringify(answer)}`);
  assert.equal(answer.refused!.name, 'CapabilityError');
  assert.equal(answer.refused!.capability, 'forme');
  assert.match(answer.refused!.message, /'forme' capability could not be compiled in this page .*'wasm-unsafe-eval'/);
});

test('a refusal crosses the worker as node\'s refusal: the same sentence and the same listItem', async () => {
  const { list } = brokenCast();
  const inNode = await writeWithForme(brokenCast().list).then(() => null, (error: CasterError) => error);
  assert.ok(inNode instanceof CasterError, 'node refuses the list');
  const answer = await writeInPage(list);
  assert.ok('refused' in answer, `the page refused: ${JSON.stringify(answer)}`);
  assert.equal(answer.refused!.name, 'CasterError');
  assert.equal(answer.refused!.message, inNode.message);
  assert.deepEqual(answer.refused!.listItem, inNode.listItem);
});

test('a page whose policy forbids the worker is refused by name, and nothing is written on the main thread', async () => {
  const answer = await writeInPage(listOf('cast'), "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'none'");
  assert.ok('refused' in answer, `the page refused: ${JSON.stringify(answer)}`);
  assert.equal(answer.refused!.name, 'CapabilityError');
  assert.equal(answer.refused!.capability, 'forme');
  assert.equal(answer.refused!.flag, 'writer');
  assert.match(answer.refused!.message, /'forme' capability writes in a dedicated worker, and the worker could not start/);
  assert.match(answer.refused!.message, /no fallback to the main thread/);
  assert.equal(answer.mainThread, false, 'the glue was never initialised on the main thread');
});

test('a shared writer worker kept by a holder page writes node\'s bytes for three document pages in turn, refuses as node does, and the second and third writes take under half the first\'s time', async () => {
  const paper = listOf('paper');
  const inNode = await writeWithForme(listOf('paper'));
  const { list: broken } = brokenCast();
  const refusedInNode = await writeWithForme(brokenCast().list).then(() => null, (error: CasterError) => error);
  assert.ok(refusedInNode instanceof CasterError);
  const server = await serve();
  const port = (server.address() as { port: number }).port;
  const browser = await launchBrowser();
  const wire = (list: DisplayList) => ({ json: JSON.stringify({ ...list, resources: { ...list.resources, blobs: {} } }), blobs: Object.fromEntries(Object.entries(list.resources.blobs).map(([key, bytes]) => [key, Array.from(bytes)])) });
  try {
    const context = await browser.newContext();
    const holder = await context.newPage();
    await holder.goto(`http://127.0.0.1:${port}/`);
    await holder.evaluate(async () => {
      const caster = await (0, eval)('import("/src/index.js")');
      (globalThis as unknown as { keep: SharedWorker }).keep = new SharedWorker(caster.formeSharedWorkerUrl(), { type: 'module', name: 'forme' });
    });
    const times: number[] = [];
    for (let n = 0; n < 3; n++) {
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      const answer = await page.evaluate(async ({ paper, broken }) => {
        const load = (p: string) => import(/* webpackIgnore: true */ p);
        const capabilities = await load('/src/capabilities.js');
        const forme = await load('/src/emit/forme.js');
        const caster = await load('/src/index.js');
        await capabilities.load(['forme']);
        const revive = ({ json, blobs }: { json: string, blobs: Record<string, number[]> }) => {
          const list = JSON.parse(json);
          list.resources.blobs = Object.fromEntries(Object.entries(blobs).map(([key, bytes]) => [key, new Uint8Array(bytes)]));
          return list;
        };
        const worker = new SharedWorker(caster.formeSharedWorkerUrl(), { type: 'module', name: 'forme' });
        const list = revive(paper);
        const start = performance.now();
        const written = await forme.writeWithForme(list, worker.port);
        const ms = performance.now() - start;
        const out: { ms: number, bytes: number[], refused?: { name: string, message: string, listItem?: unknown } } = { ms, bytes: Array.from(written.bytes as Uint8Array) };
        try { await forme.writeWithForme(revive(broken), worker.port); }
        catch (error) { const e = error as { name: string, message: string, listItem?: unknown }; out.refused = { name: e.name, message: e.message, listItem: e.listItem }; }
        return out;
      }, { paper: wire(paper), broken: wire(broken) });
      assert.ok(Buffer.from(answer.bytes).equals(Buffer.from(inNode.bytes)), `page ${n + 1}: the file is node's, byte for byte`);
      assert.equal(answer.refused?.name, 'CasterError', `page ${n + 1}: the refusal`);
      assert.equal(answer.refused?.message, refusedInNode.message);
      assert.deepEqual(answer.refused?.listItem, refusedInNode.listItem);
      times.push(answer.ms);
      await page.close();
    }
    console.log(`# shared writer, paper write per page in the page (ms): ${times.map((t) => t.toFixed(1)).join(', ')}`);
    assert.ok(times[1]! < times[0]! / 2 && times[2]! < times[0]! / 2, `warm writes under half the first: ${times.join(', ')}`);
  } finally {
    await browser.close();
    server.close();
  }
});

test('a shared writer worker that keeps blobs refuses a blob that is not its name on its first arrival, writes node\'s bytes with no blob sent once it holds them, and asks again for what it forgot', async () => {
  const cast = await writeWithForme(listOf('cast'));
  const paper = await writeWithForme(listOf('paper'));
  const flipped = listOf('cast');
  const font = flipped.resources.fonts[0]!.blob;
  flipped.resources.blobs[font] = Uint8Array.from(flipped.resources.blobs[font]!, (byte, at) => at === 0 ? byte ^ 1 : byte);
  const refusedInNode = await writeWithForme(flipped).then(() => null, (error: CasterError) => error);
  assert.ok(refusedInNode instanceof CasterError && refusedInNode.message.startsWith(`forme: the blob ${font} holds bytes whose SHA-256 is `));
  const server = await serve();
  const browser = await launchBrowser();
  const wire = (list: DisplayList) => ({ json: JSON.stringify({ ...list, resources: { ...list.resources, blobs: {} } }), blobs: Object.fromEntries(Object.entries(list.resources.blobs).map(([key, bytes]) => [key, Array.from(bytes)])) });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    const steps = await page.evaluate(async (lists) => {
      const load = (p: string) => import(/* webpackIgnore: true */ p);
      const capabilities = await load('/src/capabilities.js');
      const forme = await load('/src/emit/forme.js');
      const caster = await load('/src/index.js');
      await capabilities.load(['forme']);
      const revive = ({ json, blobs }: { json: string, blobs: Record<string, number[]> }) => {
        const list = JSON.parse(json);
        list.resources.blobs = Object.fromEntries(Object.entries(blobs).map(([key, bytes]) => [key, new Uint8Array(bytes)]));
        return list;
      };
      const worker = new SharedWorker(caster.formeSharedWorkerUrl(), { type: 'module', name: 'forme-kept' });
      const sent: { blobs: number, module: boolean }[] = [];
      const post = worker.port.postMessage.bind(worker.port);
      worker.port.postMessage = (message: { blobs: unknown[], wasm?: unknown }) => { sent.push({ blobs: message.blobs.length, module: 'wasm' in message }); post(message); };
      // A blob of 33 MiB the list names nowhere, under its own SHA-256: more than the worker keeps, so the write that hands it over leaves the worker holding nothing.
      const big = new Uint8Array(33 * 1024 * 1024);
      const bigKey = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', big)), (b) => b.toString(16).padStart(2, '0')).join('');
      const withBig = () => { const list = revive(lists.cast); list.resources.blobs[bigKey] = big; return list; };
      const steps: { name: string, sent: { blobs: number, module: boolean }[], bytes?: number[], refused?: { name: string, message: string } }[] = [];
      for (const [name, list] of [['flipped', () => revive(lists.flipped)], ['cast', () => revive(lists.cast)], ['cast kept', () => revive(lists.cast)], ['paper', () => revive(lists.paper)], ['cast after paper', () => revive(lists.cast)], ['cast and the big blob', withBig], ['cast forgotten', () => revive(lists.cast)]] as const) {
        sent.length = 0;
        try { steps.push({ name, sent: [...sent], bytes: Array.from((await forme.writeWithForme(list(), worker.port, true)).bytes as Uint8Array) }); }
        catch (error) { const e = error as { name: string, message: string }; steps.push({ name, sent: [], refused: { name: e.name, message: e.message } }); }
        steps.at(-1)!.sent = [...sent];
      }
      return steps;
    }, { flipped: wire(flipped), cast: wire(listOf('cast')), paper: wire(listOf('paper')) });
    const at = (name: string) => steps.find((s) => s.name === name)!;
    const same = (name: string, file: Uint8Array) => assert.ok(at(name).bytes && Buffer.from(at(name).bytes!).equals(Buffer.from(file)), `${name}: node's bytes (${JSON.stringify(at(name).refused)})`);
    const castBlobs = Object.keys(listOf('cast').resources.blobs).length;
    const paperBlobs = Object.keys(listOf('paper').resources.blobs).length;
    assert.deepEqual(at('flipped').refused, { name: 'CasterError', message: refusedInNode.message }, 'the flipped blob is refused on its first arrival, with node\'s sentence');
    assert.deepEqual(at('flipped').sent, [{ blobs: 0, module: false }, { blobs: castBlobs, module: true }], 'the keys first; the module and every blob when the worker says it lacks them');
    same('cast', cast.bytes);
    assert.deepEqual(at('cast').sent, [{ blobs: 0, module: false }, { blobs: castBlobs, module: false }], 'a refused write keeps no blob it had not hashed before');
    same('cast kept', cast.bytes);
    assert.deepEqual(at('cast kept').sent, [{ blobs: 0, module: false }], 'nothing crosses but the list');
    same('paper', paper.bytes);
    assert.deepEqual(at('paper').sent, [{ blobs: 0, module: false }, { blobs: paperBlobs - Object.keys(listOf('paper').resources.blobs).filter((k) => k in listOf('cast').resources.blobs).length, module: false }]);
    same('cast after paper', cast.bytes);
    assert.deepEqual(at('cast after paper').sent, [{ blobs: 0, module: false }]);
    same('cast and the big blob', cast.bytes);
    same('cast forgotten', cast.bytes);
    assert.deepEqual(at('cast forgotten').sent, [{ blobs: 0, module: false }, { blobs: castBlobs, module: false }], 'the worker forgot past its bound, asked, and the print succeeded');
  } finally {
    await browser.close();
    server.close();
  }
});
