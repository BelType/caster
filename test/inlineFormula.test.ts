/**
 * An inline formula is read where it stands in its sentence (`fixtures/cast-inline-formula/`).
 *
 * @remarks
 * The paragraph's text was one marked-content sequence and the KaTeX span a block of its own measured after it, so the structure tree read "Inline , and on its own line:" and then the formula, and the content stream drew it so too. The page is a host strip of the body, so no engine is involved; the fixture is its `index.md` as the belt renders it.
 *
 * @packageDocumentation
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
import { WRITER } from './writer.ts';

import type { StructElement } from '../src/displayList.ts';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const DIST = path.join(PACKAGE, 'dist');
const COMMON = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));
const FIXTURES = path.join(PACKAGE, 'fixtures');
const IMPORTS = `<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>`;

test('an inline formula stands between the words it stands between, in the tree and in the stream', async () => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end(fs.readFileSync(path.join(FIXTURES, 'cast-inline-formula', 'index.html'), 'utf8').replace('<head>', `<head>${IMPORTS}<base href="/fixtures/cast-inline-formula/">`));
    const [root, rel] = url.pathname.startsWith('/common/') ? [COMMON, url.pathname.slice(8)] : url.pathname.startsWith('/fixtures/') ? [FIXTURES, url.pathname.slice(10)] : [DIST, url.pathname.slice(1)];
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': contentType(file) }).end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const browser = await launchBrowser();
  try {
    const tab = await browser.newPage();
    await tab.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    await tab.evaluate(() => document.fonts.ready);
    const { base64, elements } = await tab.evaluate(async (writer: string) => {
      const caster = await import('/src/index.js' as string);
      caster.prepare(document);
      const strip = document.body;
      const box = strip.getBoundingClientRect();
      const pt = (px: number) => Math.round(((px * 72) / 96) * 1000) / 1000;
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
      return { base64: btoa(binary), elements: printed.displayList.structure.elements };
    }, WRITER);
    const list = elements as StructElement[];
    const paragraph = list.find((e) => e.type === 'P') as StructElement;
    const kinds = paragraph.children.map((c) => typeof c === 'number' ? list[c].type : 'content');
    assert.deepEqual(kinds, ['content', 'Formula', 'content'], 'the paragraph reads its words, the formula, then its words');
    assert.equal(list.filter((e) => e.type === 'Formula').length, 2, 'the display formula is a Formula too');
    const text = mupdf.Document.openDocument(Buffer.from(base64, 'base64'), 'application/pdf').loadPage(0).toStructuredText('preserve-whitespace').asText().replace(/\s+/g, ' ');
    assert.match(text, /^Inline \S.*c.*, and on its own line:/, `the stream draws the formula inside the sentence: ${text}`);
  } finally {
    await browser.close();
    server.close();
  }
});
