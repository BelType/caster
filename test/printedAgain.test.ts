/**
 * The pages an engine presented are printed, and stand after it as the engine presented them: a second print of the same pages is the same file.
 *
 * @remarks
 * The adapter lifts a margin's text into the light DOM and seats a page's background box, and takes both back after the export (`PageStrip.restore`). A host that keeps the pages and prints them again is a mail merge on a kept page (`@beltype/cli`'s `beltype serve`), where Cicero cuts some pages again and keeps the rest: a lift left standing was a stranger the engine parked, and the kept page printed with empty margins (measured 2026-11-18 by that package's soak, 1 bill in 20). Here the same pages are printed twice with no cut between, which a lift left standing refused outright, as a `<span>` in a margin box the engine never marked.
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
import { ciceroEngine } from '@beltype/cicero/engine';
import { launchBrowser } from './launch.ts';
import { contentType } from '@beltype/common/mime';
import { WRITER } from './writer.ts';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const COMMON = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));
const FONTS = path.join(PACKAGE, 'fixtures', 'specimen', 'fonts');

const BODY = '<div class="rh">Running head</div><h1>Chapter</h1><div class="fill"></div><p>Second page.</p>';
const CSS = '@font-face { font-family: F; src: url("/fonts/CrimsonText-Regular.ttf"); } html { font: 11pt/1.4 F; } @page { size: A5; margin: 20mm 15mm; background-image: linear-gradient(#eef, #fff); @top-center { content: element(head); } @bottom-left { content: "A literal foot"; } @bottom-right { content: "page " counter(page) " of " counter(pages); } } .rh { position: running(head); } .fill { height: 150mm; }';

test('the same pages printed twice are the same file, and stand between the prints as the engine presented them', async () => {
  const engine = ciceroEngine.vendorAssets();
  const dirs: Record<string, string> = { ...engine.dirs, caster: path.join(PACKAGE, 'dist'), common: COMMON };
  const imports = Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/_beltype/common/${m}.js`]));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>case</title><script type="importmap">${JSON.stringify({ imports })}</script>${ciceroEngine.headHtml('/')}<style>${CSS}</style></head><body>${BODY}</body></html>`;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end(html);
    let file: string | null = null;
    if (url.pathname.startsWith('/fonts/')) file = path.join(FONTS, url.pathname.slice(7));
    if (url.pathname.startsWith('/_beltype/')) {
      const rel = url.pathname.slice(10);
      file = (engine.files as Record<string, string>)[rel] ?? null;
      for (const [prefix, dir] of Object.entries(dirs)) if (!file && rel.startsWith(`${prefix}/`)) file = path.join(dir, rel.slice(prefix.length + 1));
    }
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': contentType(file) }).end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const browser = await launchBrowser();
  try {
    const tab = await browser.newPage({ viewport: { width: 1000, height: 1000 }, deviceScaleFactor: 1 });
    await tab.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    const out = await tab.evaluate(async (flags: Record<string, unknown>) => {
      const caster = await import('/_beltype/caster/src/index.js' as string);
      await caster.prepare(document).ready;
      await (window as unknown as { __beltypeCicero: { run: (flags: object) => Promise<unknown> } }).__beltypeCicero.run({});
      await document.fonts.ready;
      /** What the adapter writes into: the root's light children, each page's light children and its shadow's, and whether the folio's cell still spells itself. */
      const standing = () => {
        const root = document.querySelector('beltype-root')!;
        const pages = [...root.shadowRoot!.querySelectorAll('beltype-page')];
        return JSON.stringify({ light: [...root.children].map((c) => `${c.localName}[${[...c.attributes].map((a) => a.name).sort().join(' ')}]`), pages: pages.map((p) => [p.children.length, p.shadowRoot!.children.length, [...p.shadowRoot!.querySelectorAll('.margin-cell')].map((cell) => `${cell.childNodes.length}:${getComputedStyle(cell, '::before').content}`)]) });
      };
      const print = async () => {
        try {
          const { bytes } = await caster.print({ document, created: '2026-11-18T00:00:00.000Z' }, flags);
          let binary = '';
          for (const byte of bytes as Uint8Array) binary += String.fromCharCode(byte);
          return btoa(binary);
        } catch (error) {
          return `refused: ${String((error as Error).message)}`;
        }
      };
      const before = standing();
      const first = await print();
      const between = standing();
      const second = await print();
      return { before, first, between, second, after: standing() };
    }, { writer: WRITER });
    assert.ok(!out.first.startsWith('refused'), out.first);
    assert.ok(!out.second.startsWith('refused'), out.second);
    assert.equal(out.between, out.before, 'after a print the pages stand as the engine presented them');
    assert.equal(out.after, out.before);
    assert.equal(out.second, out.first, 'the second print is the first, byte for byte');
    const doc = mupdf.Document.openDocument(Buffer.from(out.second, 'base64'), 'application/pdf');
    assert.equal(doc.countPages(), 2);
    for (const [i, folio] of ['page 1 of 2', 'page 2 of 2'].entries()) {
      const text = doc.loadPage(i).toStructuredText('preserve-whitespace').asText().replace(/\s+/g, ' ');
      for (const words of ['Running head', 'A literal foot', folio]) assert.ok(text.includes(words), `page ${i + 1} holds "${words}": ${text}`);
    }
  } finally {
    await browser.close();
    server.close();
  }
});
