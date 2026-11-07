/**
 * A font is shaped with the bytes it was last handed, not the first bytes handed under its URL.
 *
 * A kept page prints document after document in one module, and two documents may serve different files at one URL (codeberg.org/BelType/cli, serve-font-cached-by-url). The shaper's caches were keyed by the URL alone, so the second document was shaped with the first one's face: its hyphen drew as another glyph, its spacing was the other face's, and its text extracted correctly.
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
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script></head><body></body></html>`;

test('bytes changed under one URL are shaped as the new bytes, by the plain and the instanced shaper', async () => {
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
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    const seen = await page.evaluate(async () => {
      const load = (p: string) => import(p);
      await (await load('/src/capabilities.js')).load(['harfbuzz']);
      const hb = await load('/src/fonts/hbShaper.js');
      const vs = await load('/src/fonts/varShaper.js');
      const bytes = async (name: string) => new Uint8Array(await (await fetch(`/fonts/${name}`)).arrayBuffer());
      const a = await bytes('CrimsonText-Regular.ttf');
      const b = await bytes('JetBrainsMono-Regular.ttf');
      const axes = [{ tag: 'wght', value: 400 }];
      const shape = (url: string) => ({ plain: hb.shapeWord(url, 'a-b.', 10, []).advances, instanced: vs.shapeAt(url, axes, 'a-b.', 10).gids, upem: hb.upemOf(url) });
      for (const [url, font] of [['/warm.ttf', a], ['/fresh.ttf', b]] as const) { hb.loadFont(url, font); vs.registerBytes(url, font); }
      const first = shape('/warm.ttf');
      hb.loadFont('/warm.ttf', b);
      vs.registerBytes('/warm.ttf', b);
      return { first, again: shape('/warm.ttf'), fresh: shape('/fresh.ttf') };
    });
    assert.notDeepEqual(seen.first, seen.fresh, 'the two fonts shape the sample differently');
    assert.deepEqual(seen.again, seen.fresh);
  } finally {
    await browser.close();
    server.close();
  }
});
