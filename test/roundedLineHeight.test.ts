/**
 * A span made of a pseudo leaves its line the height it was, and a print whose pages are replaced under it says so.
 *
 * @remarks
 * A computed `line-height` is a rounded reading: at a root of 10 pt under a line height of 1.65 the browser lays out 21.98 px and answers `22px`, and written back on the span that number made the line a pixel taller (codeberg.org/BelType/caster issue 21). Before the cut that moved the page; after it Cicero answered the paragraph's new height by cutting again under the printer, whose first complaint was that the document's first heading "painted no text". Each page is a host strip of one box, so no engine is involved: the second test takes the page away as a re-cut does.
 *
 * @packageDocumentation
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

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>
<style>
@font-face { font-family: "Crimson Text"; src: url("/fonts/CrimsonText-Regular.ttf"); }
html { font: 10pt/1.65 "Crimson Text"; }
body { margin: 0; }
#strip { width: 120mm; height: 60mm; }
p { margin: 0; }
.after::after { content: "1"; }
.before::before { content: "1 "; }
.letter::first-letter { color: #a00; }
.tall::after { content: "1"; line-height: 3; }
</style></head><body><div id="strip"><p class="after">Page </p><p class="before">Page</p><p class="letter">Page</p><p class="tall">Page </p></div></body></html>`;

async function onPage<T>(run: (tab: import('playwright-core').Page) => Promise<T>): Promise<T> {
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
    return await run(tab);
  } finally {
    await browser.close();
    server.close();
  }
}

test('a span made of a pseudo leaves its line the height it was, and keeps a line height of its own', async () => {
  const { before, after, tall } = await onPage((tab) => tab.evaluate(async () => {
    const { reify } = await import('/src/adapters/reify.js' as string);
    const heights = () => Object.fromEntries([...document.querySelectorAll('p')].map((p) => [p.classList[0], p.getBoundingClientRect().height]));
    const before = heights();
    reify(document);
    return { before, after: heights(), tall: getComputedStyle(document.querySelector('.tall span')!).lineHeight };
  }));
  for (const name of ['after', 'before', 'letter']) assert.equal(after[name], before[name], `the line of .${name} did not grow`);
  // ponytail: a line height the pseudo sets itself is still the rounded reading, since the specified value cannot be read. A rounding that moved the line by a pixel would reach the refusal below.
  assert.ok(Math.abs(after['tall']! - before['tall']!) < 0.05, `a pseudo with its own line height lays out as it did (${before['tall']} then ${after['tall']})`);
  assert.equal(parseFloat(tall), 40, 'the line height the pseudo set is carried');
});

for (const stage of ['capabilities', 'measure', 'images']) {
  test(`pages replaced during the print refuse by name (at the end of ${stage})`, async () => {
    const message = await onPage((tab) => tab.evaluate(async ({ writer, stage }) => {
      const caster = await import('/src/index.js' as string);
      caster.prepare(document);
      const strip = document.querySelector('#strip') as HTMLElement;
      const box = strip.getBoundingClientRect();
      const pt = (px: number) => Math.round(((px * 72) / 96) * 1000) / 1000;
      try {
        await caster.print({
          document,
          onStage: (name: string) => { if (name === stage) strip.remove(); },
          strip: {
            strip, probeRoot: strip, pageElements: [strip],
            pages: [{ element: strip, index: 0, flow: [...strip.children], flowBox: null, trimBox: null, nominal: { widthPt: pt(box.width), heightPt: pt(box.height) }, declaredPx: { widthPx: box.width, heightPx: box.height }, contentArea: strip, continuations: [] }],
            pageOfNode: new Map(), twinOf: () => null, transparent: () => false, lang: 'en', pageElementOf: () => strip, backgrounds: [],
          },
        }, { writer });
        return 'printed';
      } catch (error) {
        return (error as Error).message;
      }
    }, { writer: WRITER, stage }));
    assert.match(message, /pages were replaced/, message);
  });
}
