/**
 * A bare `<hr>` is a rule with Chromium's default `inset` border, two tones on screen (*the six border styles, drawn*, `vectors/borderStyles.ts`). The rule's own branch used to fill its whole box with the top colour whatever the style, so the default rule printed flat grey with `styledBorders` on; a drawn style goes through the border painter now, and a `solid` rule keeps its one rectangle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef } from 'pdf-lib';
import { contentType } from '@beltype/common/mime';
import { WRITER } from './writer.ts';
import { launchBrowser } from './launch.ts';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const DIST = path.join(PACKAGE, 'dist');
const COMMON = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));
const FONTS = path.join(PACKAGE, 'fixtures', 'specimen', 'fonts');

const PAGE = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>
<style>@font-face { font-family: "Crimson Pro"; src: url("/fonts/CrimsonPro-Variable.ttf"); font-weight: 200 900; }
body { margin: 0; } .s { width: 120mm; height: 100mm; font: 12px "Crimson Pro"; }</style></head><body><div class="s">${body}</div></body></html>`;

async function printed(body: string): Promise<{ error?: string; items?: any[] }> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE(body));
    const [root, rel] = url.pathname.startsWith('/common/') ? [COMMON, url.pathname.slice(8)] : url.pathname.startsWith('/fonts/') ? [FONTS, url.pathname.slice(7)] : [DIST, url.pathname.slice(1)];
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': contentType(file) }).end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
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
          created: '2026-11-04T10:20:30.456Z',
          strip: {
            strip, probeRoot: strip, pageElements: [strip],
            pages: [{ element: strip, index: 0, flow: [...strip.children], flowBox: null, trimBox: null, nominal: { widthPt: pt(box.width), heightPt: pt(box.height) }, declaredPx: { widthPx: box.width, heightPx: box.height }, contentArea: strip, continuations: [] }],
            pageOfNode: new Map(), twinOf: () => null, transparent: () => false, lang: 'en', pageElementOf: () => strip, backgrounds: [],
          },
        }, { writer });
        return { items: JSON.parse(JSON.stringify(out.displayList.pages.flatMap((p: any) => p.items))) };
      } catch (e: any) {
        return { error: String(e.message) };
      }
    }, WRITER);
  } finally {
    await browser.close();
    server.close();
  }
}


const inkOf = (items: any[]): any[] => items.flatMap((i) => (i.kind === 'group' ? inkOf(i.items) : i.kind === 'shape' ? [i] : []));
const colours = (items: any[]) => new Set(inkOf(items).flatMap((i) => [i.fill, i.stroke?.paint ?? i.stroke].filter(Boolean).map((c) => JSON.stringify(c.rgb ?? c))));

test('a bare hr prints its two inset tones, not one flat grey rectangle', async () => {
  const seen = await printed('<p>Above.</p><hr><p>Below.</p>');
  assert.equal(seen.error, undefined);
  assert.ok(colours(seen.items!).size >= 2, JSON.stringify(seen.items!.filter((i) => i.kind !== 'text')));
});

test('a solid hr is still its one filled rectangle', async () => {
  const seen = await printed('<p>Above.</p><hr style="border: 0; border-top: 1px solid #333"><p>Below.</p>');
  assert.equal(seen.error, undefined);
  assert.equal(inkOf(seen.items!).length, 1, JSON.stringify(inkOf(seen.items!)));
});
