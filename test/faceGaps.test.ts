/**
 * What the screen fakes and the printer does not: a bold or an italic the family has no face for, and small capitals from a face without `smcp`.
 *
 * `prepare()` forbids synthesis in the frame the printer measures, so a family with one regular face prints `<strong>` at regular weight while the author's own screen showed a fake bold; the run warns, naming the family. A face without small capitals would print `font-variant: small-caps` as plain lowercase, which the screen never shows; the print refuses, naming the face. The page is a host strip of one box, so no engine is involved.
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

const pageWith = (css: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>
<style>
@font-face { font-family: "Solo"; src: url("/fonts/CrimsonText-Regular.ttf"); }
@font-face { font-family: "Pair"; src: url("/fonts/CrimsonText-Regular.ttf"); }
@font-face { font-family: "Pair"; src: url("/fonts/CrimsonText-Bold.ttf"); font-weight: 700; }
body { margin: 0; }
.s { width: 100mm; height: 30mm; padding: 4mm; box-sizing: border-box; font: 16px/1.4 "Solo"; }
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

/** Prints the strip and answers its warnings, or the refusal's message. */
async function printed(html: string): Promise<{ warnings?: string[]; refused?: string }> {
  const server = await serve(html);
  const port = (server.address() as { port: number }).port;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.evaluate(() => document.fonts.ready);
    return await page.evaluate(async (writer: string) => {
      const load = (p: string) => import(p);
      const caster = await load('/src/index.js');
      caster.prepare(document);
      const strip = document.querySelector('.s') as HTMLElement;
      const box = strip.getBoundingClientRect();
      const pt = (px: number) => Math.round(((px * 72) / 96) * 1000) / 1000;
      try {
        const out = await caster.print({
          document,
          strip: {
            strip, probeRoot: strip, pageElements: [strip],
            pages: [{ element: strip, index: 0, flow: [...strip.children], flowBox: null, trimBox: null, nominal: { widthPt: pt(box.width), heightPt: pt(box.height) }, declaredPx: { widthPx: box.width, heightPx: box.height }, contentArea: strip, continuations: [] }],
            pageOfNode: new Map(), twinOf: () => null, transparent: () => false, lang: 'en', pageElementOf: () => strip, backgrounds: [],
          },
        }, { writer });
        return { warnings: out.report.warnings as string[] };
      } catch (error) {
        return { refused: String((error as Error).message) };
      }
    }, WRITER);
  } finally {
    await browser.close();
    server.close();
  }
}

test('a bold the family has no face for warns, naming the family', async () => {
  const { warnings, refused } = await printed(pageWith('', '<p>Plain and <strong>strong</strong> and <em>leaning</em>.</p>'));
  assert.equal(refused, undefined);
  assert.ok(warnings!.some((w) => /"Solo" has no bold face/.test(w)), warnings!.join('\n'));
  assert.ok(warnings!.some((w) => /"Solo" has no italic face/.test(w)), warnings!.join('\n'));
});

test('a family with a bold face, or a document that forbids synthesis itself, does not warn', async () => {
  const paired = await printed(pageWith('.s { font-family: "Pair"; }', '<p>Plain and <strong>strong</strong>.</p>'));
  assert.ok(!paired.warnings!.some((w) => /has no bold face/.test(w)), paired.warnings!.join('\n'));
  const forbidden = await printed(pageWith(':root { font-synthesis: none; }', '<p>Plain and <strong>strong</strong>.</p>'));
  assert.ok(!forbidden.warnings!.some((w) => /has no bold face/.test(w)), forbidden.warnings!.join('\n'));
});

test('a font-synthesis: none below the root silences the warning for its own text, and only there', async () => {
  const below = await printed(pageWith('.s { font-synthesis: none; }', '<p>Plain and <strong>strong</strong> and <em>leaning</em>.</p>'));
  assert.ok(!below.warnings!.some((w) => /has no (bold|italic) face/.test(w)), below.warnings!.join('\n'));
  const weightOnly = await printed(pageWith('.s { font-synthesis-weight: none; }', '<p>Plain and <strong>strong</strong> and <em>leaning</em>.</p>'));
  assert.ok(!weightOnly.warnings!.some((w) => /has no bold face/.test(w)), weightOnly.warnings!.join('\n'));
  assert.ok(weightOnly.warnings!.some((w) => /has no italic face/.test(w)), 'the style synthesis is still on');
  const elsewhere = await printed(pageWith('.quiet { font-synthesis: none; }', '<p class="quiet">Plain and <strong>quiet</strong>.</p><p>Plain and <strong>loud</strong>.</p>'));
  assert.ok(elsewhere.warnings!.some((w) => /has no bold face/.test(w)), 'a sibling that asked for nothing still warns: ' + elsewhere.warnings!.join('\n'));
});

test('small capitals from a face without smcp refuse, naming the face', async () => {
  const { refused } = await printed(pageWith('p { font-variant: small-caps; }', '<p>Small capitals</p>'));
  assert.match(refused ?? '', /asks for small capitals \(smcp\) from the face .* of "Solo", which has none/);
});

test('small-caps text with no lowercase letter prints, since it is the same either way', async () => {
  const { refused } = await printed(pageWith('p { font-variant: small-caps; }', '<p>NATO 1949</p>'));
  assert.equal(refused, undefined);
});
