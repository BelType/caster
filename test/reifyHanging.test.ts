/**
 * A generated hanging number keeps its place when it is made real.
 *
 * `prepare` replaces a `::before` that paints with a real span, and used not to copy `float`, `position` or the offsets: a number hung by `float: left` or `position: absolute` became a block of its own above the clause text (the delibera's clauses, 2026-11-02). The paragraph must be as tall after as before, and the span must keep the property that hung it.
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

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const DIST = path.join(PACKAGE, 'dist');
const COMMON = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));
const FONTS = path.join(PACKAGE, 'fixtures', 'specimen', 'fonts');

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>
<style>
@font-face { font-family: "Crimson Text"; src: url("/fonts/CrimsonText-Regular.ttf"); }
body { margin: 0; }
.s { width: 100mm; height: 60mm; padding: 4mm; box-sizing: border-box; font: 16px/1.4 "Crimson Text"; counter-reset: c; }
p { margin: 0 0 2mm; padding-left: 8mm; counter-increment: c; }
p.f::before { content: counter(c) "."; float: left; margin-left: -8mm; width: 8mm; }
p.a { position: relative; }
p.a::before { content: counter(c) "."; position: absolute; left: 0; width: 8mm; }
</style></head><body><div class="s"><p class="f">A clause long enough to wrap onto a second line, so the number hung beside it shows where it stands.</p><p class="a">A second clause, numbered by an absolutely positioned pseudo-element, as long as the first one is.</p></div></body></html>`;

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

test('a number hung by float or position stays beside the clause text once prepared', async () => {
  const server = await serve();
  const port = (server.address() as { port: number }).port;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.evaluate(() => document.fonts.ready);
    const { before, after, hung } = await page.evaluate(async () => {
      const load = (p: string) => import(p);
      const caster = await load('/src/index.js');
      const paragraphs = [...document.querySelectorAll('p')];
      const heights = () => paragraphs.map((p) => p.getBoundingClientRect().height);
      const before = heights();
      caster.prepare(document);
      const after = heights();
      const hung = paragraphs.map((p) => { const span = p.querySelector('.caster-generated')!; const style = getComputedStyle(span); return { float: style.float, position: style.position, top: span.getBoundingClientRect().top - p.getBoundingClientRect().top }; });
      return { before, after, hung };
    });
    assert.deepEqual(after, before, 'a paragraph is as tall once its number is a real span');
    assert.equal(hung[0]!.float, 'left', 'the float that hung the first number is kept');
    assert.equal(hung[1]!.position, 'absolute', 'the position that hung the second number is kept');
    for (const { top } of hung) assert.ok(Math.abs(top) < 4, `the number stands on the first line, at the paragraph's top (${top})`);
  } finally {
    await browser.close();
    server.close();
  }
});
