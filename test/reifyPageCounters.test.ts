/**
 * A pseudo that reads the page number waits for the pages, and then reads the page it stands on.
 *
 * `counter(page)` and `counter(pages)` have no value before an engine cuts. `prepare` used to make such a pseudo a real span anyway, resolving both to 0, so a running footer "Pagina 2 di 3" printed "Pagina 0 di 0" on every page, under either printer, and a "3 pagine" in the flow printed "0 pagine" (the tester's administrative documents, 2026-11-03). And Cicero resets the two on the page host, inside the root's shadow, while a running element's copy and a fragment stand in the root's light DOM, slotted into the page: the second moment's walk, which follows the light tree, found no `page` counter there either. The page below is that shape, without Cicero: a host in a shadow tree resets `page 2 pages 3`, and the light element slotted into it reads both.
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

const PAGE = `<!doctype html><html lang="it"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>
<style>
.pc::after { content: counter(page); }
.pt::after { content: counter(pages); }
.n { counter-reset: n 4; }
.n::after { content: counter(n); }
</style></head><body><div id="strip"><div class="piede">Pagina <span class="pc"></span> di <span class="pt"></span></div><p class="n">Nota </p></div></body></html>`;

// A merged batch: each letter resets the page counter, so a letter stands before the running footer in the light tree. Under Cicero the two are slotted into different pages, and the footer's page host, not the letter, is the reset Chromium reads (Codeberg Caster issue 22: "Pagina 1/4" on all four pages).
const MERGED = PAGE.replace('<div id="strip">', '<div id="strip"><section class="avviso" slot="one">Lettera</section>').replace('<div class="piede">', '<div class="piede" slot="two">').replace('</style>', '.avviso { counter-reset: page 1; }\n</style>');

function serve(html = PAGE): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end(html);
    const [root, rel] = url.pathname.startsWith('/common/') ? [COMMON, url.pathname.slice(8)] : [DIST, url.pathname.slice(1)];
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': contentType(file) }).end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('counter(page) and counter(pages) wait for the pages, then read the page host the element is slotted into', async () => {
  const server = await serve();
  const port = (server.address() as { port: number }).port;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    const { first, prepared, second } = await page.evaluate(async () => {
      const load = (p: string) => import(p);
      const { prepare } = await load('/src/adapters/prepare.js');
      const { reify } = await load('/src/adapters/reify.js');
      const text = () => document.querySelector('.piede')!.textContent;
      const first = prepare(document);
      const prepared = text();
      // The pages, as Cicero builds them: the strip's light DOM slotted into a page whose host resets the page's own two counters.
      const strip = document.getElementById('strip')!;
      const pageHost = strip.attachShadow({ mode: 'open' }).appendChild(document.createElement('div'));
      pageHost.style.counterReset = 'page 2 pages 3';
      pageHost.appendChild(document.createElement('slot'));
      reify(document);
      return { first: { deferred: first.deferred, generated: first.generated.map((g: { text: string }) => g.text) }, prepared, second: text() };
    });
    assert.equal(first.deferred.length, 2, `both page counters are left for the second moment (${JSON.stringify(first.deferred)})`);
    assert.match(first.deferred[0]!, /pc::after$/);
    assert.match(first.deferred[1]!, /pt::after$/);
    assert.deepEqual(first.generated, ['4'], 'an author counter is still made real before the cut');
    assert.equal(prepared, 'Pagina  di ', 'no number is frozen before the pages exist');
    assert.equal(second, 'Pagina 2 di 3', 'the second moment reads the page host');
  } finally {
    await browser.close();
    server.close();
  }
});

test('a page counter reset by an earlier sibling, on another page, reads the footer\'s own page host', async () => {
  const server = await serve(MERGED);
  const port = (server.address() as { port: number }).port;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    const footer = await page.evaluate(async () => {
      const load = (p: string) => import(p);
      const { prepare } = await load('/src/adapters/prepare.js');
      const { reify } = await load('/src/adapters/reify.js');
      prepare(document);
      // Two pages: the letter on the first, the footer on the second.
      const root = document.getElementById('strip')!.attachShadow({ mode: 'open' });
      for (const [slot, reset] of [['one', 'page 1 pages 4'], ['two', 'page 2 pages 4']]) {
        const host = root.appendChild(document.createElement('div'));
        host.style.counterReset = reset;
        host.appendChild(Object.assign(document.createElement('slot'), { name: slot }));
      }
      reify(document);
      return document.querySelector('.piede')!.textContent;
    });
    assert.equal(footer, 'Pagina 2 di 4', 'the footer reads its own page, not the letter that reset the counter before it');
  } finally {
    await browser.close();
    server.close();
  }
});

test('a generated span the page delivered, in a clone whose original reads nothing, leaves the pairing', async () => {
  const server = await serve();
  const port = (server.address() as { port: number }).port;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    const seen = await page.evaluate(async () => {
      const { pairTrees } = await import('/src/adapters/cicero.js' as string);
      const html = (text: string) => Object.assign(document.createElement('section'), { innerHTML: text });
      // `span::before { content: string(family) }`: an original stands on no page and reads nothing, and its clone reads the family's name.
      const source = html('<p><span class="s"><em>a</em></span></p>');
      const clone = html('<p><span class="s"><span class="caster-generated">Family</span><em>a</em></span></p>');
      const twins = new Map<Element, Element>();
      pairTrees(clone, source, twins, () => '', false);
      const generated = clone.querySelector('.caster-generated')!;
      return { generatedHasTwin: twins.has(generated), emPaired: twins.get(clone.querySelector('em')!) === source.querySelector('em') };
    });
    assert.deepEqual(seen, { generatedHasTwin: false, emPaired: true });
  } finally {
    await browser.close();
    server.close();
  }
});
