/**
 * A letter-spaced word Blink hyphenates prints, and the trailing-spacing vote counts the hyphen: the same fixture as `hyphenation.test.ts` under `letter-spacing`.
 *
 * Blink's own hyphenation (`hyphens: auto`) draws a hyphen that is in no text node and reports its box inside the rects of the characters on both sides of the break. Before 0.1.2 the printer filed the first character after the break on the line before it, drew no hyphen, and set the rest of the word one character's width in. The page is a host strip of one box, so no engine is involved; the file is read back with mupdf.
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
.s { width: 60mm; height: 40mm; padding: 4mm; box-sizing: border-box; font: 16px/1.4 "Crimson Text"; }
p { margin: 0; hyphens: auto; letter-spacing: 0.08em; }
</style></head><body><div class="s"><p>Decomposition temperature colonisation.</p></div></body></html>`;

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

test('a letter-spaced word Blink hyphenates prints with its hyphen and the rest flush with the next line', async () => {
  const server = await serve();
  const port = (server.address() as { port: number }).port;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.evaluate(() => document.fonts.ready);
    // The column is narrowed a pixel at a time until Blink divides "temperature", so the fixture does not depend on one face's widths.
    const laid = await page.evaluate(() => {
      const p = document.querySelector('p')!;
      const text = p.firstChild as Text;
      const at = text.data.indexOf('temperature');
      const range = document.createRange();
      range.setStart(text, at);
      range.setEnd(text, at + 'temperature'.length);
      const lines = () => new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
      for (let width = 200; width > 60 && lines() < 2; width--) p.style.width = `${width}px`;
      return [...range.getClientRects()].map((r) => ({ left: r.left, top: r.top }));
    });
    assert.ok(new Set(laid.map((r) => Math.round(r.top))).size === 2, `the fixture's precondition: Blink divides "temperature" across two lines (${JSON.stringify(laid)})`);
    const base64 = await page.evaluate(async (writer: string) => {
      const load = (p: string) => import(p);
      const caster = await load('/src/index.js');
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
    const doc = mupdf.Document.openDocument(Buffer.from(base64, 'base64'), 'application/pdf');
    const lines: { x: number; text: string }[] = JSON.parse(doc.loadPage(0).toStructuredText('preserve-whitespace').asJSON()).blocks.flatMap((b: { lines: { bbox: { x: number }; text: string }[] }) => b.lines.map((l) => ({ x: l.bbox.x, text: l.text })));
    const first = lines.findIndex((l) => /tem/.test(l.text) && !/temperature/.test(l.text));
    assert.ok(first >= 0, `"temperature" is divided in the file: ${JSON.stringify(lines)}`);
    const before = lines[first]!;
    const after = lines[first + 1]!;
    // The piece before the break ends in the hyphen, which stands for a soft hyphen so an extraction rejoins the word.
    assert.match(before.text, /­$/, `the line before the break ends with the hyphen: ${JSON.stringify(before.text)}`);
    const head = before.text.slice(before.text.lastIndexOf(' ') + 1, -1);
    const tail = after.text.split(' ')[0]!;
    assert.equal(head + tail, 'temperature', `the word divides where Blink divided it: ${JSON.stringify([head, tail])}`);
    // The rest of the word is flush with the line's start, as every other line is.
    assert.ok(Math.abs(after.x - lines[0]!.x) < 0.5, `the line after the break starts at the margin (${after.x} against ${lines[0]!.x})`);
  } finally {
    await browser.close();
    server.close();
  }
});
