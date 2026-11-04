/**
 * A shape filled with an SVG `<pattern>` is drawn, as a raster the report names, and never printed as nothing.
 *
 * @remarks
 * `paintOf` deferred a pattern server and painted nothing, so a checked fill left an empty box (codeberg.org/BelType/caster issue 1). A PDF tiling pattern is not built; the shape takes the raster road a filter takes.
 *
 * @packageDocumentation
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentType } from '@beltype/common/mime';
import { WRITER } from './writer.ts';
import { launchBrowser } from './launch.ts';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const DIST = path.join(PACKAGE, 'dist');
const COMMON = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));
const ROADS = path.join(PACKAGE, 'fixtures', 'roads');
const FONTS = path.join(PACKAGE, 'fixtures', 'specimen', 'fonts');

const PAGE = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>
<style>@font-face { font-family: "Crimson Pro"; src: url("/fonts/CrimsonPro-Variable.ttf"); font-weight: 200 900; }
body { margin: 0; } .s { width: 120mm; height: 170mm; font: 12px "Crimson Pro"; } svg { display: block; }</style></head><body><div class="s"><p>Patterns.</p>${body}</div></body></html>`;

function serve(body: string): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE(body));
    const [root, rel] = url.pathname.startsWith('/common/') ? [COMMON, url.pathname.slice(8)] : url.pathname.startsWith('/fonts/') ? [FONTS, url.pathname.slice(7)] : url.pathname.startsWith('/roads/') ? [ROADS, url.pathname.slice(7)] : [DIST, url.pathname.slice(1)];
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': contentType(file) }).end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const CHECKS = '<svg viewBox="0 0 100 60" width="300" height="180" role="img" aria-label="A checked pattern"><defs><pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="#eee"/><rect width="5" height="5" fill="#4a1528"/></pattern></defs><rect width="100" height="60" fill="url(#p)"/></svg>';

test('in the page: a pattern fill is painted as a raster and listed as one', async () => {
  const server = await serve(CHECKS);
  const port = (server.address() as { port: number }).port;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    const seen = await page.evaluate(async ([writer]: [string]) => {
      const caster = await import('/src/index.js' as string);
      caster.prepare(document);
      const strip = document.querySelector('.s') as HTMLElement;
      const box = strip.getBoundingClientRect();
      const pt = (px: number) => Math.round(((px * 72) / 96) * 1000) / 1000;
      const out = await caster.print({
        document,
        created: '2026-11-04T10:20:30.456Z',
        strip: {
          strip, probeRoot: strip, pageElements: [strip],
          pages: [{ element: strip, index: 0, flow: [...strip.children], flowBox: null, trimBox: null, nominal: { widthPt: pt(box.width), heightPt: pt(box.height) }, declaredPx: { widthPx: box.width, heightPx: box.height }, contentArea: strip, continuations: [] }],
          pageOfNode: new Map(), twinOf: () => null, transparent: () => false, lang: 'en', pageElementOf: () => strip, backgrounds: [],
        },
      }, { writer });
      return JSON.stringify(out.report);
    }, [WRITER] as [string]);
    const report = JSON.parse(seen);
    const deferred = JSON.stringify(report).match(/\{[^{}]*"feature":"<pattern> paint server"[^{}]*\}/)?.[0] ?? '';
    assert.match(deferred, /"paintedAs":"raster at \d+ dpi"/, `the pattern is listed as a raster (${deferred || 'not listed'})`);
  } finally {
    await browser.close();
    server.close();
  }
});
