/**
 * A combining mark that its font leaves out of the GDEF glyph classes is shaped as Blink shapes it: no advance of its own.
 *
 * @remarks
 * Arial Unicode gives its Hebrew points a width in the width table and no GDEF class. HarfBuzz then falls back to the Unicode category, zeroes the mark and places it by its own rules; harfbuzzjs's `-DHB_TINY` build had that fallback compiled out (DESIGN.md S101), so Caster set each pointed letter late by the mark's width, 0.36 em a point. The font here is a five-glyph fixture with the same two properties. The page is a host strip of one span: the shaper's total for the word is read against the width Blink gave the span, which is the oracle (`test/hyphenation.test.ts` serves a page the same way).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './launch.ts';
import { contentType } from '@beltype/common/mime';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const DIST = path.join(PACKAGE, 'dist');
const COMMON = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));
const FONT = path.join(PACKAGE, 'test', 'assets', 'fonts', 'UnclassifiedMarks.ttf');

const PAGE = `<!doctype html><html lang="he"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>
<style>@font-face { font-family: "Marks"; src: url("/font.ttf"); } span { font: 1000px "Marks"; white-space: pre; }</style></head>
<body><span dir="rtl" id="word">בָל</span></body></html>`;

function serve(): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
    if (url.pathname === '/font.ttf') return void response.writeHead(200, { 'Content-Type': 'font/ttf' }).end(fs.readFileSync(FONT));
    const [root, rel] = url.pathname.startsWith('/common/') ? [COMMON, url.pathname.slice(8)] : [DIST, url.pathname.slice(1)];
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': contentType(file) }).end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('a mark with no GDEF class has no advance in the shaper, as in Blink', async (t) => {
  const server = await serve();
  const port = (server.address() as { port: number }).port;
  let browser;
  try {
    browser = await launchBrowser();
  } catch (error) {
    server.close();
    t.skip(`no Chromium available: ${(error as Error).message.split('\n')[0]}`);
    return;
  }
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.evaluate(() => document.fonts.load('1000px "Marks"', 'ב'));
    const found = await page.evaluate(async () => {
      const load = (p: string) => import(p);
      const capabilities = await load('/src/capabilities.js');
      await capabilities.load(['harfbuzz']);
      const shaper = await load('/src/fonts/hbShaper.js');
      shaper.loadFont('marks', new Uint8Array(await (await fetch('/font.ttf')).arrayBuffer()));
      const run = shaper.shapeWord('marks', 'בָל', 1000, []);
      return { blink: document.getElementById('word')!.getBoundingClientRect().width, caster: run.widthPx, advances: run.advances };
    });
    // Bet 600 + Lamed 700; the Qamats' 300 is the width table's, and Blink gave it none.
    assert.equal(found.blink, 1300, 'Blink: the span is the two letters');
    assert.equal(found.caster, found.blink, `the shaper's total is Blink's (advances ${JSON.stringify(found.advances)})`);
    assert.ok(found.advances.includes(0), 'the mark is among the glyphs, with no advance');
  } finally {
    await browser.close();
    server.close();
  }
});
