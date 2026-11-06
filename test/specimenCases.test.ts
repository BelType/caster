/**
 * Four cases from printing the `provvedimento-imu` specimen (codeberg.org/BelType/specimens), each printed whole and read back with mupdf.
 *
 * @remarks
 * A word that is not shown is neither drawn nor counted (issues 16 and 17); an outer shadow is painted only outside the box (issue 18); `<address>` and its siblings among the grouping elements are tagged rather than refused (issue 19). Each page is a host strip of one box, so no engine is involved.
 *
 * @packageDocumentation
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as mupdf from 'mupdf';
import { launchBrowser } from './launch.ts';
import { contentType } from '@beltype/common/mime';
import { WRITER } from './writer.ts';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const DIST = path.join(PACKAGE, 'dist');
const COMMON = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));
const FONTS = path.join(PACKAGE, 'fixtures', 'specimen', 'fonts');

type Node = { tag: string; kids: Node[] };

/** Prints `body` inside a strip of 120 mm by 60 mm, with `css` added, and answers the file and the tree the walk intended. */
async function printCase(css: string, body: string): Promise<{ doc: mupdf.Document; tree: Node; warnings: string[] }> {
  const page = `<!doctype html><html lang="it"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>
<style>
@font-face { font-family: "Crimson Text"; src: url("/fonts/CrimsonText-Regular.ttf"); }
body { margin: 0; }
.s { width: 120mm; height: 60mm; padding: 6mm; box-sizing: border-box; font: 14px/1.4 "Crimson Text"; }
p, address { margin: 0 }
${css}
</style></head><body><div class="s">${body}</div></body></html>`;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end(page);
    const [root, rel] = url.pathname.startsWith('/common/') ? [COMMON, url.pathname.slice(8)] : url.pathname.startsWith('/fonts/') ? [FONTS, url.pathname.slice(7)] : [DIST, url.pathname.slice(1)];
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': contentType(file) }).end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const browser = await launchBrowser();
  try {
    const tab = await browser.newPage();
    await tab.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    await tab.evaluate(() => document.fonts.ready);
    const { base64, tree, warnings } = await tab.evaluate(async (writer: string) => {
      const caster = await import('/src/index.js' as string);
      caster.prepare(document);
      const strip = document.querySelector('.s') as HTMLElement;
      const box = strip.getBoundingClientRect();
      const pt = (px: number) => Math.round(((px * 72) / 96) * 1000) / 1000;
      const printed = await caster.print({
        document,
        strip: {
          strip, probeRoot: strip, pageElements: [strip],
          pages: [{ element: strip, index: 0, flow: [...strip.children], flowBox: null, trimBox: null, nominal: { widthPt: pt(box.width), heightPt: pt(box.height) }, declaredPx: { widthPx: box.width, heightPx: box.height }, contentArea: strip, continuations: [] }],
          pageOfNode: new Map(), twinOf: () => null, transparent: () => false, lang: 'it', pageElementOf: () => strip, backgrounds: [],
        },
      }, { writer });
      let binary = '';
      for (const byte of printed.bytes as Uint8Array) binary += String.fromCharCode(byte);
      return { base64: btoa(binary), tree: printed.report.structure.expectedTree, warnings: printed.report.warnings };
    }, WRITER);
    return { doc: mupdf.Document.openDocument(Buffer.from(base64, 'base64'), 'application/pdf'), tree, warnings };
  } finally {
    await browser.close();
    server.close();
  }
}

const textOf = (doc: mupdf.Document) => doc.loadPage(0).toStructuredText('preserve-whitespace').asText();
const tagsOf = (node: Node): string[] => [node.tag, ...node.kids.flatMap(tagsOf)];

test('a family no @font-face declares, passed over for a declared one, is said once; one after the chosen family and a generic are not', async () => {
  const { warnings } = await printCase('', [
    '<p style="font-family: Helvetica, \'Crimson Text\'">Uno.</p>',
    '<p style="font-family: Helvetica, \'Crimson Text\'">Due.</p>',
    '<p style="font-family: \'Crimson Text\', Georgia, serif">Tre.</p>',
    '<p style="font-family: sans-serif, \'Crimson Text\'">Quattro.</p>',
  ].join(''));
  const said = warnings.filter((w) => w.includes('@font-face declares'));
  assert.equal(said.length, 1, JSON.stringify(said));
  assert.match(said[0]!, /names "Helvetica" before "Crimson Text"/);
});

test('a word that is not shown is neither drawn nor counted, and a shown word inside a hidden one is drawn', async () => {
  const { doc } = await printCase('.n { display: none } .v { visibility: hidden } .v b { visibility: visible; font-weight: normal }', [
    '<h1>Uno <span class="n">Nascosto</span> due</h1>',
    '<p>Riga <span hidden>nascosta</span> fine.</p>',
    '<p>Prima <span class="v">invisibile <b>vista</b></span> dopo.</p>',
  ].join(''));
  const text = textOf(doc);
  for (const word of ['Uno', 'due', 'Riga', 'fine.', 'Prima', 'vista', 'dopo.']) assert.match(text, new RegExp(word), `${word} is drawn`);
  for (const word of ['Nascosto', 'nascosta', 'invisibile']) assert.doesNotMatch(text, new RegExp(word), `${word} is not drawn`);
});

test('an outer box-shadow is painted outside the box and not under it', async () => {
  const { doc } = await printCase('.box { width: 60mm; height: 20mm; padding: 4mm; border: 0.5pt solid #000; box-shadow: 3mm 3mm 0 #999 }', '<div class="box">Testo nel riquadro.</div>');
  const scale = 2;
  const pixmap = doc.loadPage(0).toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceGray, false, true);
  const [width, samples] = [pixmap.getWidth(), pixmap.getPixels()];
  const at = (mm: [number, number]) => samples[Math.round((mm[1] * 72) / 25.4 * scale) * width + Math.round((mm[0] * 72) / 25.4 * scale)];
  // The box's border box runs from 6 mm to 74 mm across and 6 mm to 34 mm down (60 + 2 × 4 wide, 20 + 2 × 4 tall, a half-point border aside); the shadow is the same box moved 3 mm right and down.
  assert.equal(at([60, 31]), 255, 'inside the box, where the shadow lies under it, the page shows');
  assert.ok(at([75.5, 25]) < 200, `the band right of the box is the shadow (${at([75.5, 25])})`);
  assert.ok(at([50, 35.5]) < 200, `the band under the box is the shadow (${at([50, 35.5])})`);
});

test('<address>, <hgroup> and <search> are grouped as a Div, and <menu> is a list', async () => {
  const { doc, tree } = await printCase('', [
    '<hgroup><h1>Avviso</h1><p>di accertamento</p></hgroup>',
    '<address>Via dei Tigli 8<br>00010 Borgo Esempio</address>',
    '<search><p>Cerca</p></search>',
    '<menu><li>Uno</li><li>Due</li></menu>',
  ].join(''));
  assert.match(textOf(doc), /Via dei Tigli 8/);
  const tags = tagsOf(tree);
  assert.ok(tags.includes('L') && tags.filter((t) => t === 'LI').length === 2, `the menu is a list of two items: ${tags.join(' ')}`);
  assert.ok(tags.filter((t) => t === 'Div').length >= 3, `hgroup, address and search are each a Div: ${tags.join(' ')}`);
});
