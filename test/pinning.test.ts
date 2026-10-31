/**
 * A variable face is pinned once, at `finish()`, over the glyphs it used (DESIGN.md S98): one document with a variable face at three weights prints in a real page, each weight is its own embedded instance, and the check of the program's `hmtx` against the advances layout used passes.
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
const FONTS = path.join(PACKAGE, 'fixtures', 'specimen', 'fonts');

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>
<style>
@font-face { font-family: "Crimson Pro"; src: url("/fonts/CrimsonPro-Variable.ttf"); font-weight: 200 900; }
body { margin: 0; }
.s { width: 120mm; height: 80mm; padding: 4mm; box-sizing: border-box; font: 16px/1.4 "Crimson Pro"; }
p { margin: 0; }
</style></head><body><div class="s"><p style="font-weight:300">Light decomposition.</p><p style="font-weight:500">Medium temperature.</p><p style="font-weight:700">Bold colonisation.</p></div></body></html>`;

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

async function printStrip(port: number) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.evaluate(() => document.fonts.ready);
    return await page.evaluate(async () => {
      const load = (p: string) => import(p);
      const caster = await load('/src/index.js');
      caster.prepare(document);
      const strip = document.querySelector('.s') as HTMLElement;
      const box = strip.getBoundingClientRect();
      const pt = (px: number) => Math.round(((px * 72) / 96) * 1000) / 1000;
      try {
        const printed = await caster.print({
          document,
          strip: {
            strip, probeRoot: strip, pageElements: [strip],
            pages: [{ element: strip, index: 0, flow: [...strip.children], flowBox: null, trimBox: null, nominal: { widthPt: pt(box.width), heightPt: pt(box.height) }, declaredPx: { widthPx: box.width, heightPx: box.height }, contentArea: strip, continuations: [] }],
            pageOfNode: new Map(), twinOf: () => null, transparent: () => false, lang: 'en', pageElementOf: () => strip, backgrounds: [],
          },
        }, {});
        return { faces: (printed.report.emission?.faces ?? []).map((f: any) => ({ coords: f.coords, outlineType: f.outlineType, used: f.usedGlyphs, stale: f.staleAdvances })) };
      } catch (error) {
        return { refused: String((error as Error).message) };
      }
    });
  } finally {
    await browser.close();
  }
}

test('each weight of a variable face is one pinned instance, and its hmtx agrees with layout', async () => {
  const server = await serve();
  const port = (server.address() as { port: number }).port;
  try {
    const printed = await printStrip(port);
    assert.ok('faces' in printed, JSON.stringify(printed).slice(0, 400));
    assert.ok(printed.faces.length >= 3, `an instance for each weight (${printed.faces.length})`);
    for (const face of printed.faces) {
      assert.equal(face.outlineType, 'glyf');
      assert.ok(face.used > 0);
      assert.equal(face.stale, 0);
    }
    assert.equal(new Set(printed.faces.map((f: { coords: unknown }) => JSON.stringify(f.coords))).size, printed.faces.length, 'one instance per coordinate');
  } finally {
    server.close();
  }
});
