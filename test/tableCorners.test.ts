/**
 * A collapsed table's horizontal edge grows over the widest vertical edge that meets its corner, and neighbours merge only where they match.
 *
 * The merge and the corners find a unit edge by its place in the grid (`unitAt`, `vectors/tableBorders.ts`). A vertical edge touching a corner stands in the row above it or the row below it, and each is here: the wider one on a different side at each of the two inner corners.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './launch.ts';
import { contentType } from '@beltype/common/mime';
import { WRITER } from './writer.ts';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const DIST = path.join(PACKAGE, 'dist');
const COMMON = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));
const FONTS = path.join(PACKAGE, 'fixtures', 'specimen', 'fonts');

const PAGE = `<!doctype html><html lang="it"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>
<style>
@font-face { font-family: "Crimson Text"; src: url("/fonts/CrimsonText-Regular.ttf"); }
body { margin: 0 }
.s { width: 120mm; height: 60mm; padding: 6mm; box-sizing: border-box; font: 14px/1.4 "Crimson Text" }
table { border-collapse: collapse; width: 100mm }
td { border: 2px solid rgb(0, 0, 0); width: 33mm }
/* Row 0's bottom differs across the columns, so row line 1 is three segments, and each has corners of its own. */
tr:first-child td:nth-child(1) { border-bottom: 4px solid rgb(10, 0, 0) }
tr:first-child td:nth-child(2) { border-bottom: 4px solid rgb(20, 0, 0) }
tr:first-child td:nth-child(3) { border-bottom: 4px solid rgb(30, 0, 0) }
/* The first inner corner: the wider vertical edge is in the row above it. The second: in the row below it. */
tr:first-child td:nth-child(1) { border-right: 10px solid rgb(0, 10, 0) }
tr:last-child td:nth-child(2) { border-right: 16px solid rgb(0, 20, 0) }
</style></head><body><div class="s"><table><tr><td>a</td><td>b</td><td>c</td></tr><tr><td>d</td><td>e</td><td>f</td></tr></table></div></body></html>`;

test('a horizontal edge grows by half the widest vertical edge at its corner, in the row above or the row below', async () => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
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
    const edges = await tab.evaluate(async (writer: string) => {
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
      return printed.report.tables[0].collapsedEdges as { edge: string; from: number; to: number; rectPx: number[]; widthPx: number }[];
    }, WRITER);
    const named = new Map(edges.map((e) => [e.edge, e]));
    const part = (edge: string) => {
      const found = named.get(edge);
      assert.ok(found, `${edge} among ${[...named.keys()].join(', ')}`);
      return found;
    };
    const first = part('row-line-1[0..1]');
    const second = part('row-line-1[1..2]');
    const third = part('row-line-1[2..3]');
    const inner1 = part('column-line-1[0..1]');
    const inner2 = part('column-line-2[1..2]');
    assert.equal(inner1.widthPx, 10);
    assert.equal(inner2.widthPx, 16);
    const right = (e: { rectPx: number[] }) => e.rectPx[0] + e.rectPx[2];
    const lineOf = (e: { rectPx: number[]; widthPx: number }) => e.rectPx[0] + e.widthPx / 2;
    assert.ok(Math.abs(right(first) - (lineOf(inner1) + 5)) < 0.01, `the first segment ends half of 10 past the first inner line: ${right(first)} against ${lineOf(inner1)}`);
    assert.ok(Math.abs(second.rectPx[0] - (lineOf(inner1) - 5)) < 0.01, `the second begins half of 10 before it: ${second.rectPx[0]}`);
    assert.ok(Math.abs(right(second) - (lineOf(inner2) + 8)) < 0.01, `the second ends half of 16 past the second inner line: ${right(second)} against ${lineOf(inner2)}`);
    assert.ok(Math.abs(third.rectPx[0] - (lineOf(inner2) - 8)) < 0.01, `the third begins half of 16 before it: ${third.rectPx[0]}`);
  } finally {
    await browser.close();
    server.close();
  }
});
