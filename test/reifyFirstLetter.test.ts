/**
 * An authored `::first-letter` is made a real span carrying its style, and the page does not move.
 *
 * The walk reads a text's style off the element that holds it, so a drop capital, `::first-letter` floated with its own size and colour, printed at the paragraph's size and colour (codeberg.org/BelType/caster issue 9). `prepare` now wraps the letter in a span with the pseudo's computed style; preparation must not change layout, so the letter's and the lines' rectangles are compared with the native ones.
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
body { margin: 0; width: 400px; font: 11pt serif }
.drop::first-letter { float: left; font-size: 30pt; line-height: 0.85; margin: 1mm 2mm 0 0; color: rgb(184, 137, 43) }
</style></head><body>
<p class="drop">«Nell’estate del 117 muore Traiano, e l’Impero che lascia non sarà mai più così grande.</p>
<p class="plain">Una riga qualsiasi.</p>
<div class="drop"><p>Dentro un blocco figlio.</p></div>
</body></html>`;

test('an authored ::first-letter becomes a span with its style, and no rectangle on the page moves', async () => {
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
      const { prepare } = await import('/src/adapters/prepare.js' as string);
      const p = document.querySelector('p.drop') as HTMLElement;
      // Every glyph's rectangle, read through a range over each character: the same before and after, or the page moved.
      const glyphs = () => {
        const out: number[][] = [];
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
          for (let i = 0; i < node.length; i++) {
            const range = document.createRange();
            range.setStart(node, i);
            range.setEnd(node, i + 1);
            const r = range.getBoundingClientRect();
            out.push([r.left, r.top, r.width, r.height]);
          }
        }
        return out;
      };
      const before = glyphs();
      prepare(document);
      const span = p.querySelector('.caster-first-letter') as HTMLElement | null;
      const after = glyphs();
      const drift = Math.max(...before.flatMap((r, i) => r.map((v, k) => Math.abs(v - after[i][k]))));
      const style = span ? getComputedStyle(span) : null;
      return {
        letter: span?.textContent, fontSize: style?.fontSize, color: style?.color, float: style?.cssFloat, drift, count: [before.length, after.length],
        plain: document.querySelectorAll('p.plain .caster-first-letter').length, nested: document.querySelectorAll('div.drop .caster-first-letter').length,
      };
    });
    assert.equal(seen.letter, '«N', 'the first letter with the punctuation before it');
    assert.deepEqual([seen.fontSize, seen.color, seen.float], ['40px', 'rgb(184, 137, 43)', 'left']);
    assert.deepEqual(seen.count[0], seen.count[1]);
    assert.ok(seen.drift < 0.05, `no glyph moved (largest drift ${seen.drift} px)`);
    assert.equal(seen.plain, 0, 'a paragraph whose first letter nobody styled is left alone');
    assert.equal(seen.nested, 0, 'a first letter inside a block child stays native');
  } finally {
    await browser.close();
    server.close();
  }
});
