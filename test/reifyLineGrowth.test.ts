/**
 * Reifying a pseudo moves no line at any size: a guard for `reified-pseudo-line-growth`.
 *
 * @remarks
 * The row said a reified `::before` grew its line by 1/64 px on the manual (21.6875 to 21.703125). Not reproduced on 0.2.7: three pseudo shapes (`::after`, `::before`, `::first-letter`) over eleven font sizes and twelve line heights, 396 paragraphs of two, each paragraph's height and top identical before and after `reify` (`test/roundedLineHeight.test.ts` holds the first fix, codeberg.org/BelType/caster issue 21).
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

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script><style>@font-face { font-family: "Crimson Text"; src: url("/fonts/CrimsonText-Regular.ttf"); } body { margin: 0 } p { margin: 0 } #strip { width: 120mm; font-family: "Crimson Text" } .after::after { content: "1"; } .before::before { content: "1 "; } .letter::first-letter { color: #a00; }</style></head><body><div id="strip"></div></body></html>`;

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


test('reifying a pseudo moves no paragraph, at 11 sizes and 12 line heights', async () => {
  const out = await onPage((tab) => tab.evaluate(async () => {
    const { reify } = await import('/src/adapters/reify.js' as string);
    const strip = document.getElementById('strip')!;
    const grown: string[] = [];
    let n = 0;
    for (const size of ['9pt', '10pt', '10.5pt', '11pt', '11.5pt', '12pt', '13pt', '14pt', '15px', '16px', '17.3px'])
      for (const lh of ['1.3', '1.4', '1.45', '1.5', '1.55', '1.6', '1.65', '1.7', '1.75', '1.8', '1.35', '1.25'])
        for (const kind of ['after', 'before', 'letter']) {
          strip.innerHTML = `<div style="font-size:${size};line-height:${lh}"><p class="${kind}">Page text that is long enough to be a paragraph of several words and a few more </p><p class="${kind}">Second</p></div>`;
          const ps = [...strip.querySelectorAll('p')];
          const before = ps.map((p) => p.getBoundingClientRect().height);
          const top = ps.map((p) => p.getBoundingClientRect().top);
          reify(document);
          const after = ps.map((p) => p.getBoundingClientRect().height);
          const top2 = ps.map((p) => p.getBoundingClientRect().top);
          n++;
          if (before.some((h, i) => h !== after[i]) || top.some((t, i) => t !== top2[i])) grown.push(`${size}/${lh} ${kind}: ${before} -> ${after}`);
        }
    return { n, grown };
  }));
  assert.equal(out.n, 396);
  assert.deepEqual(out.grown, []);
});
