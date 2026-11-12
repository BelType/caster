/**
 * SVG text under a rotating `transform` is turned with it, its words on one line along the turned baseline.
 *
 * @remarks
 * Every word of an SVG `<text>` was placed at its mapped start point and set upright, so `rotate(-30)` printed "label" above "Rotated", both level, and `rotate(90)` printed horizontal text (batch 8, `caster-rotated-svg-text`). The run now carries the turn as the line's chain, as a rotated HTML line does.
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


const svg = (text: string) => `<svg viewBox="0 0 200 80" width="300" height="120" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A turned label">${text}</svg>`;

/** The direction, in degrees on the page (y down), from the first letter to the last of the page's text, and the extracted words. */
async function turn(text: string) {
  const doc = await printCase(svg(text));
  const chars: { c: string; x: number; y: number }[] = [];
  doc.loadPage(0).toStructuredText('preserve-whitespace').walk({ onChar(c: string, origin: [number, number]) { if (c.trim()) chars.push({ c, x: origin[0], y: origin[1] }); } });
  const [a, b] = [chars[0], chars[chars.length - 1]];
  return { degrees: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI, letters: chars.map((k) => k.c).join(''), chars };
}

test('rotate(-30) turns a two-word label with its transform, the words on one line', async () => {
  const { degrees, letters, chars } = await turn('<text transform="translate(40 60) rotate(-30)" font-size="20" font-family="Crimson Text">Rotated label</text>');
  assert.equal(letters, 'Rotatedlabel');
  assert.ok(Math.abs(degrees + 30) < 1, `the baseline runs up at 30 degrees (${degrees.toFixed(1)})`);
  // Every letter lies on the baseline: the perpendicular distance from the line through the first letter stays under a pixel.
  const [a] = chars;
  const worst = Math.max(...chars.map((k) => Math.abs(-(k.x - a.x) * Math.sin(-Math.PI / 6) + (k.y - a.y) * Math.cos(-Math.PI / 6))));
  assert.ok(worst < 1, `all letters share the turned baseline (worst ${worst.toFixed(2)} pt off)`);
});

test('rotate(90) sets the text running down the page', async () => {
  const { degrees } = await turn('<text transform="translate(60 10) rotate(90)" font-size="20" font-family="Crimson Text">Vertical</text>');
  assert.ok(Math.abs(degrees - 90) < 1, `the baseline runs down (${degrees.toFixed(1)})`);
});

test('an untransformed label stays level', async () => {
  const { degrees } = await turn('<text x="10" y="40" font-size="20" font-family="Crimson Text">Level label</text>');
  assert.ok(Math.abs(degrees) < 0.5, `level (${degrees.toFixed(1)})`);
});
