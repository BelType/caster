/**
 * `font-kerning: none` and `text-rendering: optimizeSpeed` reach the shaper (DESIGN.md S100): per cluster, the advances Caster shapes a word with, from the features its computed style names, agree with the boxes Blink gives the same characters, to the 2/64 px Blink's rects sit on.
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
const FONTS = path.join(PACKAGE, 'fixtures', 'specimen', 'fonts');

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>
<style>
@font-face { font-family: "Crimson Pro"; src: url("/fonts/CrimsonPro-Variable.ttf"); font-weight: 200 900; }
p { font: 400 40px "Crimson Pro"; margin: 0; white-space: nowrap; }
</style></head><body></body></html>`;

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

type Case = { css: string; words: string[] };
type Cluster = { word: string; text: string; blink: number; caster: number };

/** Every cluster of every word of one style, with Blink's width (the Range boxes of its characters, summed) and Caster's (its glyphs' advances). Each style gets a browser of its own: Blink's word cache carries the shapes of one style into the next, and a measurement taken after another would be that one's. */
async function clusters(port: number, one: Case): Promise<Cluster[]> {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.evaluate(() => document.fonts.load('40px "Crimson Pro"'));
    return await page.evaluate(async ({ css, words }) => {
      const load = (p: string) => import(p);
      const capabilities = await load('/src/capabilities.js');
      await capabilities.load(['harfbuzz']);
      const shaper = await load('/src/fonts/hbShaper.js');
      const { featureTagsFor } = await load('/src/measure/textMeasure.js');
      const url = '/fonts/CrimsonPro-Variable.ttf';
      shaper.loadFont(url, new Uint8Array(await (await fetch(url)).arrayBuffer()));
      const found: Cluster[] = [];
      for (const word of words) {
        const p = document.createElement('p');
        p.style.cssText = css;
        p.textContent = word;
        document.body.append(p);
        const sizePx = parseFloat(getComputedStyle(p).fontSize);
        const tags: string[] = featureTagsFor(getComputedStyle(p), 0);
        const run = shaper.shapeWord(url, word, sizePx, tags);
        const range = document.createRange();
        const blinkOf = (from: number, to: number) => {
          let sum = 0;
          for (let u = from; u < to; u++) {
            range.setStart(p.firstChild as Text, u);
            range.setEnd(p.firstChild as Text, u + 1);
            sum += range.getBoundingClientRect().width;
          }
          return sum;
        };
        const starts = [...new Set<number>(run.clusters)].sort((a, b) => a - b);
        const upem = shaper.upemOf(url);
        starts.forEach((start, i) => {
          const end = i + 1 < starts.length ? starts[i + 1] : word.length;
          const units = run.advances.reduce((t: number, a: number, g: number) => t + (run.clusters[g] === start ? a : 0), 0);
          found.push({ word: `${css} | ${word} | ${tags.join(' ')}`, text: word.slice(start, end), blink: blinkOf(start, end), caster: (units / upem) * sizePx });
        });
        p.remove();
      }
      return found;
    }, one);
  } finally {
    await browser.close();
  }
}

const KERNING = ['AVATAR', 'WAVE', 'To', 'Ty'];
const LIGATURES = ['official', 'ffl', 'fi'];
const GRID = 2 / 64;

async function agrees(cases: Case[]) {
  const server = await serve();
  const port = (server.address() as { port: number }).port;
  try {
    const found: Cluster[] = [];
    for (const one of cases) found.push(...await clusters(port, one));
    assert.ok(found.length > 15, `${found.length} clusters`);
    for (const c of found) {
      assert.ok(Math.abs(c.blink - c.caster) <= GRID, `${c.word} [${c.text}]: Blink ${c.blink.toFixed(3)}, Caster ${c.caster.toFixed(3)}`);
    }
  } finally {
    server.close();
  }
}

test('font-kerning: none shapes without kerning, and an author\'s "kern" 1 still turns it on', () => agrees([
  { css: 'font-kerning: none', words: KERNING },
  { css: '', words: KERNING },
  { css: 'font-kerning: none; font-feature-settings: "kern" 1', words: KERNING },
]));

test('text-rendering: optimizeSpeed shapes without ligatures and keeps kerning, and the author can put the ligatures back', () => agrees([
  { css: 'text-rendering: optimizeSpeed', words: LIGATURES },
  { css: 'text-rendering: optimizeSpeed', words: KERNING },
  { css: '', words: LIGATURES },
  { css: 'text-rendering: optimizeSpeed; font-variant-ligatures: common-ligatures', words: LIGATURES },
  { css: 'text-rendering: optimizeSpeed; font-feature-settings: "liga" 1', words: LIGATURES },
]));
