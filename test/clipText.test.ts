/**
 * Text inside an element that hides its overflow is clipped to the element's padding box, as its boxes are.
 *
 * The trattato's contents leader, a long run of dots in an `overflow: hidden` flex item, ran to the page edge in print only. The page is a host strip of one box, so no engine is involved; the file is rendered with mupdf and the pixels beyond the box are counted.
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

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>
<style>
@font-face { font-family: "Crimson Text"; src: url("/fonts/CrimsonText-Regular.ttf"); }
body { margin: 0; }
.s { width: 100mm; height: 30mm; padding: 4mm; box-sizing: border-box; font: 16px/1.4 "Crimson Text"; }
.clip { width: 30mm; overflow: hidden; white-space: nowrap; }
</style></head><body><div class="s"><div class="clip">Decomposition temperature colonisation, a line far longer than its box.</div></div></body></html>`;

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

test('text in an overflow: hidden box is not painted beyond its padding box', async () => {
  const server = await serve();
  const port = (server.address() as { port: number }).port;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.evaluate(() => document.fonts.ready);
    const { base64, box } = await page.evaluate(async (writer: string) => {
      const load = (p: string) => import(p);
      const caster = await load('/src/index.js');
      caster.prepare(document);
      const strip = document.querySelector('.s') as HTMLElement;
      const stripBox = strip.getBoundingClientRect();
      const clip = document.querySelector('.clip')!.getBoundingClientRect();
      const pt = (px: number) => Math.round(((px * 72) / 96) * 1000) / 1000;
      const printed = await caster.print({
        document,
        strip: {
          strip, probeRoot: strip, pageElements: [strip],
          pages: [{ element: strip, index: 0, flow: [...strip.children], flowBox: null, trimBox: null, nominal: { widthPt: pt(stripBox.width), heightPt: pt(stripBox.height) }, declaredPx: { widthPx: stripBox.width, heightPx: stripBox.height }, contentArea: strip, continuations: [] }],
          pageOfNode: new Map(), twinOf: () => null, transparent: () => false, lang: 'en', pageElementOf: () => strip, backgrounds: [],
        },
      }, { writer });
      let binary = '';
      for (const byte of printed.bytes as Uint8Array) binary += String.fromCharCode(byte);
      return { base64: btoa(binary), box: { left: pt(clip.left - stripBox.left), right: pt(clip.right - stripBox.left), top: pt(clip.top - stripBox.top), bottom: pt(clip.bottom - stripBox.top) } };
    }, WRITER);
    const doc = mupdf.Document.openDocument(Buffer.from(base64, 'base64'), 'application/pdf');
    const pixmap = doc.loadPage(0).toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceGray, false, true);
    const { width, height } = { width: pixmap.getWidth(), height: pixmap.getHeight() };
    const samples = pixmap.getPixels();
    const ink = (x0: number, x1: number) => {
      let n = 0;
      for (let y = Math.floor(box.top * 2); y < Math.min(height, Math.ceil(box.bottom * 2)); y++)
        for (let x = Math.max(0, Math.floor(x0 * 2)); x < Math.min(width, Math.ceil(x1 * 2)); x++) if (samples[y * width + x]! < 128) n++;
      return n;
    };
    assert.ok(ink(box.left, box.right) > 50, 'the control: the text is painted inside its box');
    assert.equal(ink(box.right + 1, width), 0, 'no ink beyond the box that hides its overflow');
  } finally {
    await browser.close();
    server.close();
  }
});
