/**
 * Text inside an SVG `<mask>` or `<clipPath>` is paint, drawn as the outlines of its glyphs, and no word of the page.
 *
 * @remarks
 * A mask's text, the usual way to show an image through a word, was refused by *the conservation of words* (DESIGN.md S61) as rendered and never measured (codeberg.org/BelType/caster issue 10); and past the census the mask builder dropped the `<text>` child, having no shape for it, so the mask cut away everything. A `<clipPath>`'s text was dropped the same way and the shape printed unclipped. Each page is a host strip of one box and is read back with mupdf: the drawing's ink must cover the letters' share of its box, and the word must not be extractable text.
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

/** Prints `body` inside a strip of 120 mm by 60 mm and answers the file. */
async function printCase(body: string): Promise<mupdf.Document> {
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>
<style>
@font-face { font-family: "Crimson Text"; src: url("/fonts/CrimsonText-Regular.ttf"); }
body { margin: 0; }
.s { width: 120mm; height: 60mm; padding: 0; box-sizing: border-box; font: 14px/1.4 "Crimson Text"; }
svg { display: block }
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
    const base64 = await tab.evaluate(async (writer: string) => {
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
          pageOfNode: new Map(), twinOf: () => null, transparent: () => false, lang: 'en', pageElementOf: () => strip, backgrounds: [],
        },
      }, { writer });
      let binary = '';
      for (const byte of printed.bytes as Uint8Array) binary += String.fromCharCode(byte);
      return btoa(binary);
    }, WRITER);
    return mupdf.Document.openDocument(Buffer.from(base64, 'base64'), 'application/pdf');
  } finally {
    await browser.close();
    server.close();
  }
}

/** The share of the drawing's box, 300 by 120 px at the strip's top left, that carries ink. */
function inkShare(doc: mupdf.Document): number {
  const scale = 1;
  const pixmap = doc.loadPage(0).toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceGray, false, true);
  const [width, samples] = [pixmap.getWidth(), pixmap.getPixels()];
  let ink = 0;
  let all = 0;
  // 300 × 120 px is 225 × 90 pt.
  for (let y = 0; y < 90; y++) for (let x = 0; x < 225; x++, all++) if (samples[y * width + x] < 230) ink++;
  return ink / all;
}

const svg = (defs: string, use: string) => `<svg viewBox="0 0 200 80" width="300" height="120" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A colour seen through the word ROMA"><defs>${defs}</defs>${use}</svg>`;

test('text inside a <mask> is drawn as the mask, the colour seen through its letters', async () => {
  const doc = await printCase(svg(
    '<mask id="m"><rect width="200" height="80" fill="#000"/><text x="100" y="60" font-size="50" font-family="Crimson Text" text-anchor="middle" fill="#fff">ROMA</text></mask>',
    '<rect width="200" height="80" fill="#6b1d3f" mask="url(#m)"/>',
  ));
  const share = inkShare(doc);
  assert.ok(share > 0.05 && share < 0.5, `the colour shows through the letters and nowhere else (${share.toFixed(3)} of the box is ink)`);
  assert.doesNotMatch(doc.loadPage(0).toStructuredText('preserve-whitespace').asText(), /ROMA/, 'the mask\'s word is paint, not text');
});

test('text inside a <clipPath> clips the shape to its letters', async () => {
  const doc = await printCase(svg(
    '<clipPath id="c"><text x="100" y="60" font-size="50" font-family="Crimson Text" text-anchor="middle">ROMA</text></clipPath>',
    '<rect width="200" height="80" fill="#6b1d3f" clip-path="url(#c)"/>',
  ));
  const share = inkShare(doc);
  assert.ok(share > 0.05 && share < 0.5, `the shape is clipped to the letters (${share.toFixed(3)} of the box is ink)`);
  assert.doesNotMatch(doc.loadPage(0).toStructuredText('preserve-whitespace').asText(), /ROMA/, 'the clip path\'s word is paint, not text');
});
