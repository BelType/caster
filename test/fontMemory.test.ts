/**
 * A face's bytes are decoded once a realm, by their content: the same bytes at any URL answer from memory, and other bytes at a known URL are decoded again.
 *
 * A host that re-seats its kept page for each print (`document.open()`, as `beltype serve` does) gives the next document new `FontFace` objects, so the font table fetches every face again (`readByFace`, `host/fonts.ts`, keeps nothing across a re-seat). What it must not do is decode them again when the bytes are the ones it already read (`readOnce`).
 *
 * The WOFF decode is counted by its calls: `decodeWoff` inflates each compressed table through the realm's `DecompressionStream`, which the page wraps and counts. The WOFF2 decoder is a wasm module with no door to count through, so its absence is shown by the answer: a decode always makes a new array, and the remembered SFNT is the same array print after print.
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
const FIXTURES = path.join(PACKAGE, 'fixtures');
const IMPORT_MAP = `<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>`;

const KATEX = 'cast-inline-formula/katex/fonts';
const RULES = '@font-face { font-family: A; src: url("/fonts/a.woff") format("woff"); } @font-face { font-family: B; src: url("/fonts/b.woff") format("woff"); } @font-face { font-family: C; src: url("/fonts/c.woff2") format("woff2"); font-weight: 200 900; }';
const PAGE = `<!doctype html><html lang="it"><head><meta charset="utf-8">${IMPORT_MAP}<style>${RULES}</style></head><body><p style="font-family: A">Una</p><p style="font-family: B">riga</p><p style="font-family: C">sola.</p></body></html>`;

test('a face is decoded once by its bytes, at any URL, and again when its URL serves other bytes', async () => {
  // What each font URL serves; the test changes it between prints. `b.woff` serves the same bytes as `a.woff` at first.
  const serves: Record<string, string> = { 'a.woff': `${KATEX}/KaTeX_Main-Regular.woff`, 'b.woff': `${KATEX}/KaTeX_Main-Regular.woff`, 'c.woff2': 'cast/SourceSans3-Variable.woff2' };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
    if (url.pathname === '/swap') {
      serves['a.woff'] = `${KATEX}/KaTeX_Typewriter-Regular.woff`;
      serves['c.woff2'] = 'cast/SourceSans3-Italic-Variable.woff2';
      return void response.writeHead(204).end();
    }
    const font = url.pathname.startsWith('/fonts/') ? serves[url.pathname.slice(7)] : undefined;
    if (font) return void response.writeHead(200, { 'Content-Type': contentType(font), 'Cache-Control': 'no-store' }).end(fs.readFileSync(path.join(FIXTURES, font)));
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
      const capabilities = await import('/src/capabilities.js' as string);
      await capabilities.load(['fontkit', 'woff2']);
      const { buildFontTable } = await import('/src/host/fonts.js' as string);
      const { createGateway } = await import('/src/host/gateway.js' as string);
      const Inflate = globalThis.DecompressionStream;
      let inflates = 0;
      globalThis.DecompressionStream = class extends Inflate { constructor(format: CompressionFormat) { super(format); inflates += 1; } };
      const real = createGateway(new Map());
      let reads = 0;
      const gateway = { ...real, getBytes: (url: string) => { reads += 1; return real.getBytes(url); } };
      const reseat = () => {
        const html = document.documentElement.outerHTML;
        document.open();
        document.write(`<!doctype html>${html}`);
        document.close();
      };
      const sfnts: Uint8Array[][] = [];
      const print = async () => {
        await Promise.all(['16px A', '16px B', '16px C'].map((f) => document.fonts.load(f)));
        await document.fonts.ready;
        const before = { inflates, reads };
        const table = await buildFontTable(document, gateway);
        const at = (name: string) => [...table.bytesByUrl].find(([url]) => url.endsWith(name))?.[1] as Uint8Array;
        sfnts.push([at('a.woff'), at('b.woff'), at('c.woff2')]);
        return { inflates: inflates - before.inflates, reads: reads - before.reads, faces: table.descriptors.length, warnings: table.warnings.length };
      };
      const first = await print();
      reseat();
      const second = await print();
      await fetch('/swap');
      reseat();
      const third = await print();
      const [one, two, three] = sfnts;
      return {
        first, second, third,
        aBesideB: one[0] === one[1],
        keptA: two[0] === one[0], keptB: two[1] === one[1], keptC: two[2] === one[2],
        renewedA: three[0] !== one[0] && three[0].length !== one[0].length, keptBAfterSwap: three[1] === one[1], renewedC: three[2] !== one[2] && three[2].length !== one[2].length
      };
    });
    assert.equal(seen.first.faces, 3);
    assert.equal(seen.first.warnings, 0);
    assert.equal(seen.first.reads, 3, 'the first print fetches the three faces');
    assert.ok(seen.first.inflates > 0, 'and decodes the WOFF');
    assert.ok(seen.aBesideB, 'the same bytes at a second URL are the same program, decoded once');
    assert.equal(seen.second.reads, 3, 'a re-seated page has new faces, so the second print fetches them again');
    assert.equal(seen.second.inflates, 0, 'and decodes no WOFF again');
    assert.ok(seen.keptA && seen.keptB && seen.keptC, 'every program is the one the first print decoded, the WOFF2 among them');
    assert.equal(seen.third.reads, 3);
    assert.ok(seen.third.inflates > 0, 'the WOFF whose URL now serves other bytes is decoded again');
    assert.ok(seen.renewedA, 'and is the new program');
    assert.ok(seen.keptBAfterSwap, 'the URL whose bytes did not change answers from memory');
    assert.ok(seen.renewedC, 'and the WOFF2 whose URL serves other bytes is decoded again');
  } finally {
    await browser.close();
    server.close();
  }
});
