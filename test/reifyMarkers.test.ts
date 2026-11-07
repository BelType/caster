/**
 * A list marker prints as the page shows it: in its own paint, not at all where it is hidden, and refused where it is an image.
 *
 * A `::marker` number set in its own colour and size printed in the item's, because the text marker span took no paint of the marker's own, while a shape marker's did. A list hidden with `visibility: hidden` whose paragraphs are shown printed bullets the page does not have. And `list-style-image` printed a disc where the browser draws the image: the printer never falls back, so it refuses by name.
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

const pageWith = (css: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>
<style>
@font-face { font-family: "Crimson Text"; src: url("/fonts/CrimsonText-Regular.ttf"); }
body { margin: 0; }
.s { width: 100mm; height: 40mm; padding: 4mm; box-sizing: border-box; font: 16px/1.4 "Crimson Text"; }
ul, ol { margin: 0; padding-left: 10mm; }
p { margin: 0; }
${css}
</style></head><body><div class="s">${body}</div></body></html>`;

function serve(html: string): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end(html);
    const [root, rel] = url.pathname.startsWith('/common/') ? [COMMON, url.pathname.slice(8)] : url.pathname.startsWith('/fonts/') ? [FONTS, url.pathname.slice(7)] : [DIST, url.pathname.slice(1)];
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': contentType(file) }).end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Opens `html` in a fresh browser, waits for its faces, and hands the page to `body`. */
async function withPage<T>(html: string, body: (page: import('playwright-core').Page) => Promise<T>): Promise<T> {
  const server = await serve(html);
  const port = (server.address() as { port: number }).port;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.evaluate(() => document.fonts.ready);
    return await body(page);
  } finally {
    await browser.close();
    server.close();
  }
}

/** Each item's box and its text's first rectangle, which preparation must leave where the native marker put them (*preparation runs in no author preview*, DESIGN.md S81). */
const GEOMETRY = () => [...document.querySelectorAll('li')].map((li) => {
  const range = document.createRange();
  range.selectNodeContents(li.lastChild!);
  const text = range.getClientRects()[0]!;
  const box = li.getBoundingClientRect();
  return { top: box.top, height: box.height, textLeft: text.left, textTop: text.top };
});

test('a ::marker number set in its own colour and size prints in them, and nothing moves', async () => {
  const html = pageWith('li::marker { color: rgb(255, 0, 0); font-size: 28px; font-family: monospace; font-weight: 700; }', '<ol><li>Alfa, an item set in the item\'s own face.</li><li>Beta</li></ol>');
  const seen = await withPage(html, (page) => page.evaluate(async (geometry: string) => {
    const measure = (0, eval)(geometry) as () => unknown;
    const caster = await import('/src/index.js' as string);
    const before = measure();
    caster.prepare(document);
    const after = measure();
    const style = getComputedStyle(document.querySelector('li > .marker')!);
    return { before, after, paint: { color: style.color, fontSize: style.fontSize, fontWeight: style.fontWeight, monospace: /monospace/.test(style.fontFamily) } };
  }, GEOMETRY.toString()));
  assert.deepEqual(seen.paint, { color: 'rgb(255, 0, 0)', fontSize: '28px', fontWeight: '700', monospace: true }, 'the marker span takes the marker\'s own paint');
  assert.deepEqual(seen.after, seen.before, 'each item and its text stand where the native marker left them');
});

// Blink's outside marker sets its baseline on the line's and overhangs below it, so a larger marker pushes the line down and does not lengthen the item; a smaller one, or one with its own line height, the same rule. A loose item is not here: its marker span is out of the flow, so a marker larger than the first block's line does not push that block down as Blink's does, which this round did not change.
const SIZED = [
  'li::marker { font-size: 28px; }',
  'li::marker { font-size: 10px; }',
  'li::marker { font: 28px/3 "Crimson Text"; }',
  'li::marker { font: 700 28px monospace; } li { list-style-position: inside; }',
];
for (const css of SIZED) test(`a sized marker leaves every item where it stood: ${css}`, async () => {
  const html = pageWith(css, '<ol><li>Alfa, a tight item long enough to wrap onto a second line of the strip, so the marker stands beside the first.</li><li>Beta</li></ol>');
  const seen = await withPage(html, (page) => page.evaluate(async (geometry: string) => {
    const measure = (0, eval)(geometry) as () => unknown;
    const caster = await import('/src/index.js' as string);
    const before = measure();
    caster.prepare(document);
    return { before, after: measure() };
  }, GEOMETRY.toString()));
  assert.deepEqual(seen.after, seen.before);
});

/** Prints the strip and counts dark ink in the band left of each item's content box, where its marker stands. */
async function markerInk(html: string): Promise<number[]> {
  return withPage(html, async (page) => {
    const { base64, bands } = await page.evaluate(async (writer: string) => {
      const caster = await import('/src/index.js' as string);
      caster.prepare(document);
      const strip = document.querySelector('.s') as HTMLElement;
      const stripBox = strip.getBoundingClientRect();
      const pt = (px: number) => ((px * 72) / 96);
      const bands = [...document.querySelectorAll('li')].map((li) => { const r = li.getBoundingClientRect(); return { left: pt(r.left - 30 - stripBox.left), right: pt(r.left - stripBox.left), top: pt(r.top - stripBox.top), bottom: pt(r.bottom - stripBox.top) }; });
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
      return { base64: btoa(binary), bands };
    }, WRITER);
    const doc = mupdf.Document.openDocument(Buffer.from(base64, 'base64'), 'application/pdf');
    const pixmap = doc.loadPage(0).toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceGray, false, true);
    const width = pixmap.getWidth();
    const samples = pixmap.getPixels();
    return bands.map((b) => {
      let n = 0;
      for (let y = Math.floor(b.top * 2); y < Math.ceil(b.bottom * 2); y++) for (let x = Math.max(0, Math.floor(b.left * 2)); x < Math.ceil(b.right * 2); x++) if (samples[y * width + x]! < 128) n++;
      return n;
    });
  });
}

test('a list hidden with visibility: hidden prints no bullet beside the paragraph it shows', async () => {
  const html = pageWith('.hidden { visibility: hidden; } .hidden p { visibility: visible; }', '<ul><li><p>Shown, with its bullet.</p></li></ul><ul class="hidden"><li><p>Shown, in a hidden list.</p></li></ul>');
  const [shown, hidden] = await markerInk(html);
  assert.ok(shown! > 4, `the control: a visible list prints its bullet (${shown})`);
  assert.equal(hidden, 0, 'a hidden list prints no bullet');
});

test('list-style-image is refused by name, never printed as a disc', async () => {
  const image = 'url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%228%22 height=%228%22%3E%3Crect width=%228%22 height=%228%22/%3E%3C/svg%3E")';
  const html = pageWith(`ul { list-style-image: ${image}; }`, '<ul><li>An item with an image for a marker.</li></ul>');
  const answer = await withPage(html, (page) => page.evaluate(async () => {
    const caster = await import('/src/index.js' as string);
    try { caster.prepare(document); return { refused: false, message: '', name: '' }; } catch (error) { return { refused: true, message: String((error as Error).message), name: (error as Error).constructor.name }; }
  }));
  assert.equal(answer.refused, true, 'the print refuses');
  assert.equal(answer.name, 'CasterError');
  assert.match(answer.message, /list-style-image/);
});
