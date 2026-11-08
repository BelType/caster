/**
 * The report confesses where: every transform or guess the printer makes is a confession with its kind, its element and its region on the page, in the presented page's CSS px (*the printer guesses, says so, and withdraws the claim*, S90, amended 2026-11-08).
 *
 * @remarks
 * One page holds one of each kind the ruling named, the CLI's `--check` excusing a failing tile only inside such a region; a second page holds none of them and confesses nothing. Each region is held to the element's own box as the page presents it, read with `getBoundingClientRect` against the page box.
 *
 * @packageDocumentation
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentType } from '@beltype/common/mime';
import { WRITER } from './writer.ts';
import { launchBrowser } from './launch.ts';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const DIST = path.join(PACKAGE, 'dist');
const COMMON = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));
const ROADS = path.join(PACKAGE, 'fixtures', 'roads');
const FONTS = path.join(PACKAGE, 'fixtures', 'specimen', 'fonts');

const PAGE = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>
<style>@font-face { font-family: "Crimson Pro"; src: url("/fonts/CrimsonPro-Variable.ttf"); font-weight: 200 900; }
body { margin: 0; } .s { width: 140mm; height: 200mm; font: 12px "Crimson Pro"; color: #333; padding: 10px; box-sizing: border-box; } .b { width: 120px; height: 40px; margin: 12px 0; } img { display: block; width: 120px; }</style></head><body><div class="s">${body}</div></body></html>`;

const EVERY = [
  '<p data-k="black-text" style="color: #000">Set in one plate.</p>',
  '<p data-k="cmyk-text" style="color: #2a6">Converted by lcms.</p>',
  '<img data-k="cmyk-image" src="/roads/cmyk-adobe.jpg" alt="A CMYK photograph">',
  '<img data-k="undecodable-image" src="/roads/logo-arithmetic.jpg" alt="An arithmetic-coded logo">',
  '<div class="b" data-k="raster-shadow" style="background: #fff; box-shadow: 6px 6px 10px rgba(0, 0, 0, .5)"></div>',
  '<div class="b" style="background: #fc0; isolation: isolate"><div data-k="blend" style="width: 60px; height: 30px; margin-left: 30px; background: #09c; mix-blend-mode: multiply"></div></div>',
  '<div class="b" data-k="opacity" style="opacity: .5; background: #09c; border: 2px solid #234"></div>',
  '<div class="b" data-k="cmyk-shading" style="background: linear-gradient(90deg, rgb(255 51 0), rgb(0 204 153)); --pdf-background: linear-gradient(90deg, device-cmyk(0 0.8 1 0), device-cmyk(0.8 0 0.2 0.2))"></div>',
].join('');

const NONE = '<p>Nothing guessed, nothing set in another colour.</p><div class="b" style="background: #ddd; border: 1px solid #999"></div><div class="b" style="background: linear-gradient(90deg, rgb(255 51 0), rgb(0 204 153))"></div>';

function serve(): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/every') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE(EVERY));
    if (url.pathname === '/none') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE(NONE));
    const [root, rel] = url.pathname.startsWith('/common/') ? [COMMON, url.pathname.slice(8)] : url.pathname.startsWith('/fonts/') ? [FONTS, url.pathname.slice(7)] : url.pathname.startsWith('/roads/') ? [ROADS, url.pathname.slice(7)] : [DIST, url.pathname.slice(1)];
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': contentType(file) }).end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

type Rect = { x: number, y: number, width: number, height: number };
type Seen = { confessions: { page: number, kind: string, rect: Rect, element: string, note: string }[], boxes: Record<string, Rect>, page: Rect };

/** Print the page at `route` as one page of its own, and read each `data-k` element's box against the page box (for text, its text's box). */
async function printed(route: string, options: Record<string, unknown>): Promise<Seen> {
  const server = await serve();
  const port = (server.address() as { port: number }).port;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}${route}`);
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
    return JSON.parse(await page.evaluate(async ([writer, options]: [string, Record<string, unknown>]) => {
      const caster = await import('/src/index.js' as string);
      caster.prepare(document);
      const strip = document.querySelector('.s') as HTMLElement;
      const box = strip.getBoundingClientRect();
      const local = (r: DOMRect) => ({ x: r.left - box.left, y: r.top - box.top, width: r.width, height: r.height });
      const boxes: Record<string, unknown> = {};
      for (const element of strip.querySelectorAll('[data-k]')) {
        const range = document.createRange();
        range.selectNodeContents(element);
        boxes[(element as HTMLElement).dataset.k as string] = local(element.tagName === 'P' ? range.getBoundingClientRect() : element.getBoundingClientRect());
      }
      const pt = (px: number) => Math.round(((px * 72) / 96) * 1000) / 1000;
      const out = await caster.print({
        document,
        created: '2026-11-08T10:20:30.456Z',
        strip: {
          strip, probeRoot: strip, pageElements: [strip],
          pages: [{ element: strip, index: 0, flow: [...strip.children], flowBox: null, trimBox: null, nominal: { widthPt: pt(box.width), heightPt: pt(box.height) }, declaredPx: { widthPx: box.width, heightPx: box.height }, contentArea: strip, continuations: [] }],
          pageOfNode: new Map(), twinOf: () => null, transparent: () => false, lang: 'en', pageElementOf: () => strip, backgrounds: [],
        },
      }, { writer, ...options });
      return JSON.stringify({ confessions: out.report.confessions, boxes, page: { x: 0, y: 0, width: box.width, height: box.height } });
    }, [WRITER, options] as [string, Record<string, unknown>]));
  } finally {
    await browser.close();
    server.close();
  }
}

/** Whether `outer` holds `inner`, to a hundredth of a pixel. */
const holds = (outer: Rect, inner: Rect, slack = 0.01) => outer.x <= inner.x + slack && outer.y <= inner.y + slack && outer.x + outer.width >= inner.x + inner.width - slack && outer.y + outer.height >= inner.y + inner.height - slack;

test('in the page: each transform and guess is one confession of its kind, on its page, holding the element\'s own box in the page\'s CSS px', async () => {
  const seen = await printed('/every', { blackText: '100k', convertRgb: 'wasm' });
  const kinds = Object.keys(seen.boxes);
  assert.deepEqual(kinds.sort(), ['black-text', 'blend', 'cmyk-image', 'cmyk-shading', 'cmyk-text', 'opacity', 'raster-shadow', 'undecodable-image']);
  for (const kind of kinds) {
    const found = seen.confessions.filter((c) => c.kind === kind);
    assert.equal(found.length, 1, `one ${kind} confession (${JSON.stringify(seen.confessions.map((c) => `${c.kind} ${c.element}`))})`);
    const [confession] = found;
    assert.equal(confession.page, 1, `${kind} is on page 1, one-based`);
    assert.ok(confession.note.length > 0, `${kind} says what was done`);
    assert.match(confession.element, /^(p|img|div)\[\d+\]/u, `${kind} names its element by its DOM path, as the warnings do (${confession.element})`);
    assert.ok(holds(seen.page, confession.rect), `${kind}'s region ${JSON.stringify(confession.rect)} lies inside the page`);
    // A text's region is its runs joined: the glyphs, from a descender's depth to the tallest top, so it is held to the text's box with a pixel either way; every other region holds the element's border box.
    const slack = kind.endsWith('-text') ? 2 : 0.01;
    assert.ok(holds(confession.rect, seen.boxes[kind], slack), `${kind}'s region ${JSON.stringify(confession.rect)} holds the element's box ${JSON.stringify(seen.boxes[kind])}`);
    if (kind.endsWith('-text')) assert.ok(holds({ x: seen.boxes[kind].x - 2, y: seen.boxes[kind].y - 2, width: seen.boxes[kind].width + 4, height: seen.boxes[kind].height + 4 }, confession.rect), `${kind}'s region stays within its text`);
  }
  // The shadow's raster reaches past the border box by its offset and blur, and the region is what was drawn.
  const shadow = seen.confessions.find((c) => c.kind === 'raster-shadow') as Seen['confessions'][number];
  assert.ok(shadow.rect.width > seen.boxes['raster-shadow'].width + 6, 'the shadow\'s region is the raster, wider than the box');
});

test('in the page: a print with nothing transformed or guessed confesses nothing, a gradient in its own RGB stops included', async () => {
  const seen = await printed('/none', {});
  assert.deepEqual(seen.confessions, []);
});
