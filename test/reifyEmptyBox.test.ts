/**
 * A pseudo with empty content that paints a box waits for the pages, and is then made real at the box the page gave it.
 *
 * `content: ""` with a border, positioned by `inset`, is the usual frame inside a panel. `reify` dropped it for having no text, so the box painter never saw it and the frame did not print (codeberg.org/BelType/caster issue 8). Made real before the cut, it would freeze the unpaginated page's used width; so it waits, and the second moment takes it. The page below narrows the panel between the two moments, as a cut does.
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

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>
<style>
body { margin: 0 }
.box { position: relative; height: 100px; background: #4a1528 }
.box::before { content: ""; position: absolute; inset: 10px; border: 1px solid #e2c37a }
.bare::before { content: ""; position: absolute; inset: 0 }
</style></head><body><div class="box"></div><div class="bare"></div></body></html>`;

test('an empty pseudo that paints a box waits for the pages, then is made real at the box the page gave it', async () => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
    const [root, rel] = url.pathname.startsWith('/common/') ? [COMMON, url.pathname.slice(8)] : [DIST, url.pathname.slice(1)];
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': contentType(file) }).end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    const seen = await page.evaluate(async () => {
      const load = (p: string) => import(p);
      const { prepare } = await load('/src/adapters/prepare.js');
      const { reify } = await load('/src/adapters/reify.js');
      const first = prepare(document);
      const spansBefore = document.querySelectorAll('.box > span').length;
      // The cut: the panel is narrower on its page than in the unpaginated document.
      (document.querySelector('.box') as HTMLElement).style.width = '300px';
      const second = reify(document);
      const span = document.querySelector('.box > span') as HTMLElement | null;
      const r = span?.getBoundingClientRect();
      return { deferred: first.deferred, spansBefore, generated: second.generated.map((g: { element: string }) => g.element), rect: r ? [r.left, r.top, r.width, r.height] : null, bare: document.querySelectorAll('.bare > span').length };
    });
    assert.deepEqual(seen.deferred, ['div.box::before'], 'the frame waits for the pages; a pseudo that paints nothing is not one');
    assert.equal(seen.spansBefore, 0);
    assert.equal(seen.generated.length, 1, 'the second moment makes it');
    assert.deepEqual(seen.rect, [10, 10, 280, 80], 'at the box the narrowed panel gives it, border included');
    assert.equal(seen.bare, 0, 'an empty pseudo that paints nothing stays as it was');
  } finally {
    await browser.close();
    server.close();
  }
});
