/**
 * *Transparent text is invisible text* (Egildo's ruling of 2026-11-18, DESIGN.md S110): a run whose paint alpha is 0 is written in text render mode 3 with its words in the text layer and the structure tree, a run between 0 and 1 is painted under a `/ca` state, the paint colour is `-webkit-text-fill-color`, a declared ink keeps its colour and takes the alpha, and a rule in a transparent colour paints nothing.
 *
 * @remarks
 * The three fixtures of `fixtures/text-alpha/` are printed as one host-strip page, as `pdfa.test.ts` prints its own, under the writer the run names (`test/writer.ts`), and the content stream is read back by mupdf. The page's list is then written in node by both writers and held by the readers of `npm run identity -- compare` (*the same list prints the same bytes*, S102): the content streams operator for operator, the colour objects, the words, the tree and the pixels. veraPDF judges the files under `-f ua2` and `-f 4`, where it is on the path. It serves `dist/`, so run `npm run build` first.
 *
 * @packageDocumentation
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as mupdf from 'mupdf';
import { launchBrowser } from './launch.ts';
import { contentType } from '@beltype/common/mime';
import { WRITER, loadWriters } from './writer.ts';
import { emitStructure } from '../src/emit/structureEmit.ts';
import { writeWithForme } from '../src/emit/forme.ts';
import { recordsOf } from '../src/displayList/records.ts';
import { validateList } from '../src/displayList/validate.ts';
import { compare } from '../scripts/compare.ts';
import { CasterError } from '../src/errors.ts';

import type { DisplayList } from '../src/displayList.ts';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const DIST = path.join(PACKAGE, 'dist');
const COMMON = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));
const FIXTURES = path.join(PACKAGE, 'fixtures');
const IMPORTS = `<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>`;
const CMYK_PROFILE = fs.readFileSync(path.join(PACKAGE, 'test', 'assets', 'default_cmyk.icc'));

type Printed = { bytes: Buffer; list: DisplayList };

/** Print a fixture file, a path under `fixtures/`, as one host-strip page, and hand back the file and the list with its blobs. */
async function printDoc(file: string, options: Record<string, unknown>, profile = false): Promise<Printed> {
  const dir = path.posix.dirname(file);
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end(fs.readFileSync(path.join(FIXTURES, file), 'utf8').replace('<head>', `<head>${IMPORTS}<base href="/fixtures/${dir}/">`));
    const [root, rel] = url.pathname.startsWith('/common/') ? [COMMON, url.pathname.slice(8)] : url.pathname.startsWith('/fixtures/') ? [FIXTURES, url.pathname.slice(10)] : [DIST, url.pathname.slice(1)];
    const found = path.join(root, rel);
    if (!found.startsWith(root) || !fs.existsSync(found) || fs.statSync(found).isDirectory()) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': contentType(found) }).end(fs.readFileSync(found));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const browser = await launchBrowser();
  try {
    const tab = await browser.newPage();
    await tab.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    await tab.evaluate(() => document.fonts.ready);
    const out = await tab.evaluate(async ({ writer, options, profile }) => {
      const caster = await import('/src/index.js' as string);
      caster.prepare(document);
      const strip = document.body;
      const box = strip.getBoundingClientRect();
      const pt = (px: number) => Math.round(((px * 72) / 96) * 1000) / 1000;
      const base64 = (bytes: Uint8Array) => { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); };
      const printed = await caster.print({
        document,
        strip: {
          strip, probeRoot: strip, pageElements: [strip],
          pages: [{ element: strip, index: 0, flow: [...strip.children], flowBox: null, trimBox: null, nominal: { widthPt: pt(box.width), heightPt: pt(box.height) }, declaredPx: { widthPx: box.width, heightPx: box.height }, contentArea: strip, continuations: [] }],
          pageOfNode: new Map(), twinOf: () => null, transparent: () => false, lang: 'en', pageElementOf: () => strip, backgrounds: [],
        },
      }, { writer, ...options, ...(profile ? { profile: Uint8Array.from(atob(profile), (c) => c.charCodeAt(0)) } : {}) });
      const { blobs, ...resources } = printed.displayList.resources;
      return { bytes: base64(printed.bytes), list: JSON.stringify({ ...printed.displayList, resources }), blobs: Object.fromEntries(Object.entries(blobs as Record<string, Uint8Array>).map(([k, v]) => [k, base64(v)])) };
    }, { writer: WRITER, options, profile: profile ? CMYK_PROFILE.toString('base64') : '' });
    const list = JSON.parse(out.list);
    list.resources.blobs = Object.fromEntries(Object.entries(out.blobs).map(([k, v]) => [k, new Uint8Array(Buffer.from(v, 'base64'))]));
    return { bytes: Buffer.from(out.bytes, 'base64'), list };
  } finally {
    await browser.close();
    server.close();
  }
}

/** Page 1's content stream, inflated, one operator a line, and the file's `/ExtGState` objects by their page resource name. */
function read(bytes: Buffer) {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf') as mupdf.PDFDocument;
  const page = doc.findPage(0);
  const contents = page.get('Contents');
  const parts: string[] = [];
  if (contents.isArray()) contents.forEach((ref) => parts.push(ref.readStream().asString()));
  else parts.push(contents.readStream().asString());
  const states = new Map<string, Record<string, string>>();
  const dict = page.get('Resources').get('ExtGState');
  if (dict.isDictionary()) dict.forEach((obj, key) => {
    const entries: Record<string, string> = {};
    obj.forEach((value, k) => { entries[String(k)] = String(value); });
    states.set(String(key), entries);
  });
  const text = doc.loadPage(0).toStructuredText('preserve-whitespace').asText().replace(/\s+/gu, ' ');
  return { doc, ops: parts.join('\n').split('\n').map((l) => l.trim()).filter(Boolean), states, text };
}

/** The index of the first line at or after `from` that `match` accepts. */
const next = (ops: string[], from: number, match: (line: string) => boolean): number => {
  const at = ops.slice(from).findIndex(match);
  return at < 0 ? -1 : from + at;
};

/** The `/ca` of the graphics state a `gs` line sets, or NaN. */
const caOf = (states: Map<string, Record<string, string>>, line: string) => Number(states.get(line.split(' ')[0].slice(1))?.ca);

/** Write the list with both writers in node and hold forme's file to the oracle's with the readers of `identity -- compare`. */
async function parity(name: string, list: DisplayList): Promise<void> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'caster-alpha-'));
  const lists = path.join(work, 'lists');
  const dir = path.join(work, 'forme');
  fs.mkdirSync(path.join(lists, 'blobs'), { recursive: true });
  fs.mkdirSync(dir);
  for (const [hash, bytes] of Object.entries(list.resources.blobs)) fs.writeFileSync(path.join(lists, 'blobs', hash), bytes);
  const { blobs: _, ...resources } = list.resources;
  fs.writeFileSync(path.join(lists, `${name}.json`), JSON.stringify({ ...list, resources }));
  const oracle = await emitStructure(list);
  const forme = await writeWithForme(list);
  fs.writeFileSync(path.join(lists, `${name}.pdf`), oracle.bytes);
  fs.writeFileSync(path.join(dir, `${name}.pdf`), forme.bytes);
  fs.writeFileSync(path.join(dir, `${name}.records.json`), JSON.stringify(forme.records));
  // The report snapshot's members of the tree, derived from the oracle's own records, as `record` keeps them.
  const derived = recordsOf(list, JSON.parse(JSON.stringify(oracle.records)));
  fs.writeFileSync(path.join(lists, `${name}.report.json`), JSON.stringify({ structure: derived.structure, links: derived.links.length > 0 ? derived.links : undefined, outline: derived.outline, idTree: derived.idTree }));
  fs.writeFileSync(path.join(lists, 'corpus.json'), JSON.stringify({ documents: [{ name, list: { blobs: Object.keys(list.resources.blobs) } }] }));
  const log = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  let status: number;
  try {
    status = await compare(lists, dir, null);
  } finally {
    console.log = log;
  }
  assert.equal(status, 0, `the readers hold forme's ${name} to the oracle's:\n${lines.join('\n')}`);
  assert.match(lines.join('\n'), /^1 compared with the oracle, 0 with a disagreement$/mu, 'one document compared');
  console.log(`ℹ ${lines.join('\n').split('\n').map((l) => l.trim()).filter((l) => /^(alpha-|content|records|colour|words|pixels|tree)/u.test(l)).join('; ').slice(0, 1200)}`);
  fs.rmSync(work, { recursive: true, force: true });
}

/** veraPDF's failed rules on a file under one flavour, or null where veraPDF is not on the path. */
function verapdf(flavour: string, bytes: Buffer, name: string): string[] | null {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'caster-alpha-')), `${name}.pdf`);
  fs.writeFileSync(file, bytes);
  const run = spawnSync('verapdf', ['--flavour', flavour, '--format', 'json', file], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (run.error || !run.stdout) return null;
  return JSON.parse(run.stdout).report.jobs.flatMap((job: any) => (job.validationResult ?? [{ details: { ruleSummaries: [{ clause: 'not validated', testNumber: 0, failedChecks: 0 }] } }])
    .flatMap((result: any) => result.details.ruleSummaries.map((rule: any) => `${rule.clause}-${rule.testNumber} (${rule.failedChecks})`)));
}

before(async () => { await loadWriters(); });

const PASSES: string[] = [];

test('a transparent run is invisible text: 3 Tr around its TJ, its words in the text layer and under its P, and the run after it visible', async () => {
  const { bytes, list } = await printDoc('text-alpha/index.html', {});
  const { ops, text } = read(bytes);
  const modes = ops.filter((l) => l.endsWith(' Tr'));
  assert.deepEqual(modes, ['3 Tr', '0 Tr', '3 Tr', '0 Tr'], 'two invisible runs, the mode put back after each');
  for (let from = 0, three; (three = next(ops, from, (l) => l === '3 Tr')) >= 0; from = three + 1) {
    const tj = next(ops, three, (l) => l.endsWith('TJ'));
    const zero = next(ops, three, (l) => l === '0 Tr');
    assert.ok(tj > three && zero > tj && next(ops, three + 1, (l) => l.endsWith(' Tf')) < tj, 'the mode is set before the run\'s Tf and put back after its last TJ');
    const opened = ops.slice(0, three).findLast((l) => l.endsWith('BDC'));
    assert.match(opened ?? '', /^\/P <<\/MCID \d+>> BDC$/u, 'the invisible words are marked content of their paragraph, not an artifact');
  }
  assert.match(text, /Hidden words stay searchable\./u, 'the transparent words are extracted');
  assert.match(text, /Filled clear\./u, 'and the words whose fill colour is transparent');
  const alphas = list.pages[0].items.filter((i) => i.kind === 'text').map((i) => i.kind === 'text' ? i.fill.alpha : undefined);
  assert.deepEqual(alphas.filter((a) => a !== undefined), [0, 0.5, 0], 'the list carries the three alphas and nothing else');
  assert.equal(list.version, 8);
});

test('nothing on an invisible page is painted, and every word of it is extracted', async () => {
  const { bytes } = await printDoc('text-alpha/invisible.html', {});
  const { doc, ops, text } = read(bytes);
  assert.ok(!ops.some((l) => l.endsWith(' re')), 'the transparent rule paints no rectangle');
  assert.match(text, /Nothing to see Hidden words stay searchable\. Filled clear\./u);
  const pixmap = doc.loadPage(0).toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false);
  const pixels = pixmap.getPixels();
  let dark = 0;
  for (const v of pixels) if (v < 250) dark += 1;
  assert.equal(dark, 0, 'every pixel is white');
});

test('a translucent run is painted under /ca, in its rgb, and the opaque run beside it on the line inherits neither the alpha nor the mode', async () => {
  const { bytes } = await printDoc('text-alpha/index.html', {});
  const { ops, states } = read(bytes);
  const set = ops.findIndex((l) => l.endsWith(' gs') && caOf(states, l) === 0.5);
  assert.ok(set >= 0, 'a gs that sets /ca 0.5');
  const tf = next(ops, set, (l) => l.endsWith(' Tf'));
  assert.equal(ops[tf + 1], '0 0.4 0.8 rg', 'the colour operands are the rgb');
  const tj = next(ops, tf, (l) => l.endsWith('TJ'));
  const reset = next(ops, tj, (l) => l.endsWith(' gs'));
  assert.equal(caOf(states, ops[reset]), 1, 'the state is put back to /ca 1 after the run');
  const opaque = next(ops, reset, (l) => l.endsWith(' Tf'));
  assert.ok(opaque > reset && ops[opaque + 1] !== '0 0.4 0.8 rg', 'the next run opens after the reset, in its own colour');
  assert.equal(states.get(ops[set].split(' ')[0].slice(1))?.SMask, '/None');
});

test('a solid rule in a transparent colour paints no rectangle, and one at a quarter paints its rectangle under /ca inside its own q … Q', async () => {
  const { bytes, list } = await printDoc('text-alpha/index.html', {});
  const { ops, states } = read(bytes);
  const rects = list.pages[0].items.filter((i) => i.kind === 'shape' && 'rect' in i);
  assert.deepEqual(rects.map((r) => 'rect' in r ? r.fill.alpha : null), [0.25], 'one rectangle, the translucent rule\'s');
  const re = ops.findIndex((l) => l.endsWith(' re'));
  assert.deepEqual([ops[re - 3], caOf(states, ops[re - 2]), ops[re - 1], ops[re + 1], ops[re + 2]], ['q', 0.25, '0.8 0 0.2 rg', 'f', 'Q']);
});

test('the paint colour is -webkit-text-fill-color: red over a blue color is red', async () => {
  const { bytes } = await printDoc('text-alpha/index.html', {});
  const { ops } = read(bytes);
  assert.ok(ops.includes('1 0 0 rg'), 'red');
  assert.ok(!ops.includes('0 0 1 rg'), 'not blue');
});

test('a transparent run in a CMYK ink is invisible, and a translucent ink that overprints is set under its overprint state and then its alpha, put back in turn', async () => {
  const { bytes, list } = await printDoc('text-alpha/cmyk.html', {}, true);
  const { ops, states } = read(bytes);
  const three = ops.indexOf('3 Tr');
  assert.ok(three >= 0);
  assert.equal(ops[next(ops, three, (l) => l.endsWith(' Tf')) + 1], '0 1 0.65 0.15 k', 'the invisible run keeps its ink');
  assert.equal(ops[next(ops, three, (l) => l.endsWith(' Tr') && l !== '3 Tr')], '0 Tr');
  const alpha = ops.findIndex((l) => l.endsWith(' gs') && caOf(states, l) === 0.5);
  const overprint = ops[alpha - 1];
  assert.equal(states.get(overprint.split(' ')[0].slice(1))?.op, 'true', 'the overprint state is set first');
  assert.equal(ops[next(ops, alpha, (l) => l.endsWith(' Tf')) + 1], '1 0 0 0 k', 'the ink, at the run\'s alpha');
  const tj = next(ops, alpha, (l) => l.endsWith('TJ'));
  const [r1, r2] = [next(ops, tj, (l) => l.endsWith(' gs')), next(ops, tj, (l) => l.endsWith(' gs')) + 1];
  assert.equal(caOf(states, ops[r1]), 1, 'the alpha is put back first');
  assert.equal(states.get(ops[r2].split(' ')[0].slice(1))?.op, 'false', 'then the overprint');
  const fills = list.pages[0].items.flatMap((i) => i.kind === 'text' && i.fill.ink ? [i.fill] : []);
  assert.deepEqual(fills.map((f) => [f.alpha, f.overprint]), [[0, undefined], [0.5, 'fill']]);
});

test('veraPDF passes the alpha fixtures under ua-2 and under ua-2 with a-4', async (t) => {
  for (const [file, standard, profile] of [['index', ['ua-2'], false], ['invisible', ['ua-2'], false], ['index', ['ua-2', 'a-4'], false], ['cmyk', ['ua-2'], true], ['cmyk', ['ua-2', 'a-4'], true]] as [string, string[], boolean][]) {
    const { bytes } = await printDoc(`text-alpha/${file}.html`, { standard }, profile);
    for (const flavour of standard.includes('a-4') ? ['ua2', '4'] : ['ua2']) {
      const failed = verapdf(flavour, bytes, `alpha-${file}`);
      if (failed === null) { t.diagnostic('verapdf is not on the path'); return; }
      assert.deepEqual(failed, [], `${file} under ${standard.join(',')}: veraPDF -f ${flavour}`);
      PASSES.push(`${file} ${standard.join(',')} -f ${flavour}`);
    }
  }
});

test('both writers write the alpha fixtures alike, by the readers of identity -- compare', async () => {
  for (const [file, profile] of [['index', false], ['invisible', false], ['cmyk', true]] as const) {
    const { list } = await printDoc(`text-alpha/${file}.html`, {}, profile);
    await parity(`alpha-${file}`, list);
  }
});

test('an alpha of 1 or outside 0 to 1 is refused by the validator, naming the item', async () => {
  const { list } = await printDoc('text-alpha/index.html', {});
  const at = list.pages[0].items.findIndex((i) => i.kind === 'text' && i.fill.alpha === 0.5);
  for (const bad of [1, -0.1, 2]) {
    const copy: DisplayList = { ...list, pages: list.pages.map((p, n) => n === 0 ? { ...p, items: p.items.map((i, k) => k === at && i.kind === 'text' ? { ...i, fill: { ...i.fill, alpha: bad } } : i) } : p) };
    assert.throws(() => validateList(copy), (e: any) => e instanceof CasterError && e.message === `caster: the fill at item ${at} of page 1 has alpha ${bad}; an alpha is a number from 0 up to but not including 1, and absent where the paint is opaque` && e.listItem?.item === at);
  }
});

test.after(() => { if (PASSES.length) console.log(`ℹ veraPDF passed ${WRITER}'s files: ${PASSES.join('; ')}`); });
