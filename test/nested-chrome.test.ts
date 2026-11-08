/**
 * A fixed box and a running element written inside a block that divides across pages print: every flow word on one page, the fixed box's copy and the running head on every page (Egildo's ruling of 2026-11-08, *the adapter leaves out what the engine copies per page*).
 *
 * @remarks
 * The document is the shape of Cicero's own `test/browser/nested-chrome.browser.ts`: two chapter sections, each holding its own running head, the first also holding a fixed box, three pages. Since the engine stopped lifting such a box out of its block at intake, the original block holds the fixed box's words and no flow fragment does; the partition check refused the print until the adapter left them out.
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

const BODY = '<section><div class="rh">Head Alpha</div><h1>Chapter Alpha</h1><div class="stamp">Stamp words</div><div class="fill"></div><p>Second page.</p><div class="fill"></div></section><section><div class="rh">Head Beta</div><h1>Chapter Beta</h1><p>Third page.</p></section>';
const CSS = '@font-face { font-family: F; src: url("/fonts/CrimsonText-Regular.ttf"); } html { font: 11pt/1.4 F; } @page { size: A5; margin: 20mm 15mm; @top-center { content: element(head); } } section { break-before: page; } .rh { position: running(head); } .stamp { position: fixed; bottom: 5mm; left: 5mm; } .fill { height: 150mm; }';

/** Cuts the document with Cicero, prints it, and answers each page's text from the file, or the refusal. */
async function printPages(): Promise<string[] | { refused: string }> {
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
    const printed = await tab.evaluate(async (flags: Record<string, unknown>) => {
      const caster = await import('/_beltype/caster/src/index.js' as string);
      await caster.prepare(document).ready;
      await (window as unknown as { __beltypeCicero: { run: (flags: object) => Promise<unknown> } }).__beltypeCicero.run({});
      await document.fonts.ready;
      try {
        const { bytes } = await caster.print({ document }, flags);
        let binary = '';
        for (const byte of bytes as Uint8Array) binary += String.fromCharCode(byte);
        return { base64: btoa(binary) };
      } catch (error) {
        return { refused: String((error as Error).message) };
      }
    }, { writer: WRITER });
    if ('refused' in printed) return { refused: printed.refused as string };
    const doc = mupdf.Document.openDocument(Buffer.from(printed.base64 as string, 'base64'), 'application/pdf');
    return Array.from({ length: doc.countPages() }, (_, i) => doc.loadPage(i).toStructuredText('preserve-whitespace').asText().replace(/\s+/g, ' ').trim());
  } finally {
    await browser.close();
    server.close();
  }
}

test('a fixed box and a running head nested in a divided block print: flow words once, the copies on every page', async () => {
  const pages = await printPages();
  assert.ok(Array.isArray(pages), `the print is refused: ${!Array.isArray(pages) && pages.refused}`);
  assert.equal(pages.length, 3);
  const onPages = (words: string) => pages.flatMap((text, i) => text.includes(words) ? [i + 1] : []);
  for (const [words, where] of [['Chapter Alpha', [1]], ['Second page.', [2]], ['Chapter Beta', [3]], ['Third page.', [3]]] as const) assert.deepEqual(onPages(words), where, `${words}: ${JSON.stringify(pages)}`);
  assert.deepEqual(onPages('Stamp words'), [1, 2, 3], `the fixed box on every page: ${JSON.stringify(pages)}`);
  assert.deepEqual(onPages('Head Alpha'), [1, 2]);
  assert.deepEqual(onPages('Head Beta'), [3]);
});
