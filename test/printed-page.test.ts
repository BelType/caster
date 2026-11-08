/**
 * A page printed before is prepared and printed again as it was the first time: a host that keeps its print page between documents, as `beltype serve`'s mail merge does, prepares and cuts the same document twice, and the second file must be the first.
 *
 * @remarks
 * The document is the shape of the CLI's `provvedimento-imu` notice: a running footer written inside the one article, carrying the notice's number and a page number read from the engine (`counter(page)`, `target-counter()`), which the second moment of reification makes real. Measured 2026-11-08 through the CLI under Cicero 0.1.10: the second print read "Pagina 1/3" on every page and "N. 2" where the page shows "N. 4".
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


const BODY = '<article><footer class="piede"><p>N. <span class="n">4</span></p><p><a class="pagina" href="#fine">Pagina</a></p></footer><h1>Notice</h1><div class="fill"></div><p>Second page.</p><div class="fill"></div><p id="fine">Third page.</p></article>';
const CSS = '@font-face { font-family: F; src: url("/fonts/CrimsonText-Regular.ttf"); } html { font: 11pt/1.4 F; } @page { size: A5; margin: 20mm 15mm 30mm; @bottom-center { content: element(piede); } } .piede { position: running(piede); display: flex; gap: 10mm; } .pagina::after { content: " " counter(page) "/" target-counter(attr(href url), page); } .fill { height: 150mm; }';

/** Prepares, cuts and prints the document twice in one tab, and answers each print's page texts from the file, or the refusal. */
async function printTwice(): Promise<string[][] | { refused: string }> {
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
      const files: string[] = [];
      try {
        for (let i = 0; i < 2; i++) {
          await caster.prepare(document).ready;
          await (window as unknown as { __beltypeCicero: { run: (flags: object) => Promise<unknown> } }).__beltypeCicero.run({});
          await document.fonts.ready;
          const { bytes } = await caster.print({ document }, flags);
          let binary = '';
          for (const byte of bytes as Uint8Array) binary += String.fromCharCode(byte);
          files.push(btoa(binary));
        }
        return { files };
      } catch (error) {
        return { refused: `print ${files.length + 1}: ${String((error as Error).message)}` };
      }
    }, { writer: WRITER });
    if ('refused' in printed) return { refused: printed.refused as string };
    return (printed.files as string[]).map((base64) => {
      const doc = mupdf.Document.openDocument(Buffer.from(base64, 'base64'), 'application/pdf');
      return Array.from({ length: doc.countPages() }, (_, i) => doc.loadPage(i).toStructuredText('preserve-whitespace').asText().replace(/\s+/g, ' ').trim());
    });
  } finally {
    await browser.close();
    server.close();
  }
}

test('a page printed before prints the same file again: the footer\'s number and each page\'s own page number', async () => {
  const prints = await printTwice();
  assert.ok(Array.isArray(prints), `a print is refused: ${!Array.isArray(prints) && prints.refused}`);
  const [first, second] = prints;
  assert.equal(first!.length, 3, JSON.stringify(first));
  first!.forEach((text, i) => assert.ok(text.includes('N. 4') && text.includes(`Pagina ${i + 1}/3`), `the first print, page ${i + 1}: ${text}`));
  assert.deepEqual(second, first, 'the second print reads as the first');
});
