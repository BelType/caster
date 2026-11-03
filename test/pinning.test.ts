/**
 * A variable face is pinned once, at `finish()`, over the glyphs it used (DESIGN.md S98): one document with a variable face at three weights prints in a real page, each weight is its own embedded instance, and the check of the program's `hmtx` against the advances layout used passes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { launchBrowser } from './launch.ts';
import { contentType } from '@beltype/common/mime';
import { WRITER } from './writer.ts';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const DIST = path.join(PACKAGE, 'dist');
const COMMON = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));
const FONTS = path.join(PACKAGE, 'fixtures', 'specimen', 'fonts');

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>
<style>
@font-face { font-family: "Crimson Pro"; src: url("/fonts/CrimsonPro-Variable.ttf"); font-weight: 200 900; }
body { margin: 0; }
.s { width: 120mm; height: 80mm; padding: 4mm; box-sizing: border-box; font: 16px/1.4 "Crimson Pro"; }
p { margin: 0; }
</style></head><body><div class="s"><p style="font-weight:300">Light decomposition.</p><p style="font-weight:500">Medium temperature.</p><p style="font-weight:700">Bold colonisation.</p></div></body></html>`;

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

async function printStrip(port: number) {
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
        const printed = await caster.print({
          document,
          strip: {
            strip, probeRoot: strip, pageElements: [strip],
            pages: [{ element: strip, index: 0, flow: [...strip.children], flowBox: null, trimBox: null, nominal: { widthPt: pt(box.width), heightPt: pt(box.height) }, declaredPx: { widthPx: box.width, heightPx: box.height }, contentArea: strip, continuations: [] }],
            pageOfNode: new Map(), twinOf: () => null, transparent: () => false, lang: 'en', pageElementOf: () => strip, backgrounds: [],
          },
        }, { writer });
        let binary = '';
        for (const byte of printed.bytes as Uint8Array) binary += String.fromCharCode(byte);
        return { base64: btoa(binary), faces: (printed.report.emission?.faces ?? []).map((f: any) => ({ coords: f.coords, outlineType: f.outlineType, used: f.usedGlyphs, stale: f.staleAdvances })) };
      } catch (error) {
        return { refused: String((error as Error).message) };
      }
    }, WRITER);
  } finally {
    await browser.close();
  }
}

test('each weight of a variable face is one pinned instance, and its hmtx agrees with layout', async () => {
  const server = await serve();
  const port = (server.address() as { port: number }).port;
  try {
    const printed = await printStrip(port);
    assert.ok('faces' in printed, JSON.stringify(printed).slice(0, 400));
    assert.ok(printed.faces.length >= 3, `an instance for each weight (${printed.faces.length})`);
    for (const face of printed.faces) {
      assert.equal(face.outlineType, 'glyf');
      assert.ok(face.used > 0);
      assert.equal(face.stale, 0);
    }
    assert.equal(new Set(printed.faces.map((f: { coords: unknown }) => JSON.stringify(f.coords))).size, printed.faces.length, 'one instance per coordinate');
  } finally {
    server.close();
  }
});

/** Every `/W` entry of every CID font in the file against the `hmtx` of the program embedded for it: `[gid, /W width, hmtx width in thousandths]`. */
function widthsAgainstHmtx(file: Buffer): [number, number, number][] {
  const text = file.toString('latin1');
  const objects = new Map<number, { body: string; at: number }>();
  for (const match of text.matchAll(/(\d+) 0 obj([\s\S]*?)endobj/g)) objects.set(Number(match[1]), { body: match[2]!, at: match.index! + match[0].indexOf(match[2]!) });
  const rows: [number, number, number][] = [];
  for (const { body } of objects.values()) {
    if (!body.includes('/CIDFontType2')) continue;
    const start = body.indexOf('/W [') + 3;
    let depth = 0, end = start;
    for (; end < body.length; end++) { if (body[end] === '[') depth++; else if (body[end] === ']' && --depth === 0) break; }
    const tokens = body.slice(start + 1, end).match(/\[|\]|-?[\d.]+/g) ?? [];
    const descriptor = objects.get(Number(/\/FontDescriptor (\d+) 0 R/.exec(body)![1]))!;
    const fileObject = objects.get(Number(/\/FontFile2 (\d+) 0 R/.exec(descriptor.body)![1]))!;
    const length = Number(/\/Length (\d+)/.exec(fileObject.body)![1]);
    const begin = fileObject.at + fileObject.body.indexOf('stream') + 'stream'.length + (fileObject.body[fileObject.body.indexOf('stream') + 6] === '\r' ? 2 : 1);
    const font = zlib.inflateSync(file.subarray(begin, begin + length));
    const table = (tag: string) => { for (let i = 0; i < font.readUInt16BE(4); i++) if (font.toString('latin1', 12 + 16 * i, 16 + 16 * i) === tag) return font.readUInt32BE(20 + 16 * i); throw new Error(`no ${tag}`); };
    const upem = font.readUInt16BE(table('head') + 18);
    const metrics = font.readUInt16BE(table('hhea') + 34);
    const hmtx = table('hmtx');
    const advance = (gid: number) => font.readUInt16BE(hmtx + Math.min(gid, metrics - 1) * 4);
    for (let i = 0; i < tokens.length;) {
      const gid = Number(tokens[i++]);
      i++; // [
      for (let g = gid; tokens[i] !== ']'; g++, i++) rows.push([g, Number(tokens[i]), (advance(g) * 1000) / upem]);
      i++; // ]
    }
  }
  return rows;
}

test('under the harfbuzz shaper /W is the cut program’s hmtx, to the thousandth, for every pinned weight', async () => {
  const server = await serve();
  const port = (server.address() as { port: number }).port;
  try {
    const printed = await printStrip(port);
    assert.ok('base64' in printed, JSON.stringify(printed).slice(0, 400));
    const rows = widthsAgainstHmtx(Buffer.from((printed as { base64: string }).base64, 'base64'));
    assert.ok(rows.length >= 30, `the three weights use some glyphs (${rows.length})`);
    const apart = rows.filter(([, width, carried]) => Math.abs(width - carried) > 0.0005);
    assert.deepEqual(apart, [], 'every /W width equals the program’s own hmtx');
  } finally {
    server.close();
  }
});
