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
