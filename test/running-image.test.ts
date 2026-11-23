/**
 * A running element that is itself an `<img>` prints on every page it runs on, as one wrapped in another element always did.
 *
 * @remarks
 * Found in the ADM2 editor on 2026-11-20: a deliberation's crest, `.header-logo { position: running(header-logo) }` placed by `@top-center { content: element(header-logo) }`, was presented by Cicero on each of three pages and was missing from the file. The walk's artifact branch painted the images under an artifact and never the artifact itself.
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

/** A 16 × 16 PNG, red. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGP4z8BAEmIY1TCqYfhqAAC9Iv8BTJBn8gAAAABJRU5ErkJggg==';
/** A 16 × 16 PNG, red on its left half and transparent on its right: its alpha is a soft mask, so its samples are decoded. */
const ALPHA_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVR4nGM4wcDwnwBmwIcZRg0YNWDUgOFiAADMP0eQ/u4zjgAAAABJRU5ErkJggg==';
const CSS = '@font-face { font-family: F; src: url("/fonts/CrimsonText-Regular.ttf"); } html { font: 11pt/1.4 F; } @page { size: A5; margin: 30mm 15mm 20mm; @top-center { content: element(logo); } } .logo { position: running(logo); width: 20mm; } .fill { height: 150mm; }';

/** Cuts `body` with Cicero, prints it, and answers how many images each page of the file draws, or the refusal. */
async function imagesPerPage(body: string): Promise<number[] | { refused: string }> {
  const engine = ciceroEngine.vendorAssets();
  const dirs: Record<string, string> = { ...engine.dirs, caster: path.join(PACKAGE, 'dist'), common: COMMON };
  const imports = Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/_beltype/common/${m}.js`]));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>case</title><script type="importmap">${JSON.stringify({ imports })}</script>${ciceroEngine.headHtml('/')}<style>${CSS}</style></head><body>${body}</body></html>`;
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
      // An image marked `data-blob` is moved behind a `blob:` address first, as a host that fetches its images behind a login hands them over.
      for (const img of document.querySelectorAll<HTMLImageElement>('img[data-blob]')) {
        img.src = URL.createObjectURL(await (await fetch(img.src)).blob());
        await img.decode();
      }
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
    return Array.from({ length: doc.countPages() }, (_, i) => {
      const text = JSON.parse(doc.loadPage(i).toStructuredText('preserve-images').asJSON()) as { blocks: { type: string }[] };
      return text.blocks.filter((block) => block.type === 'image').length;
    });
  } finally {
    await browser.close();
    server.close();
  }
}

const FLOW = '<h1>First</h1><div class="fill"></div><p>Second page.</p>';

test('a running element that is an <img> prints on every page', async () => {
  const pages = await imagesPerPage(`<img class="logo" alt="Crest" src="${PNG}">${FLOW}`);
  assert.ok(Array.isArray(pages), `the print is refused: ${!Array.isArray(pages) && pages.refused}`);
  assert.deepEqual(pages, [1, 1]);
});

test('a running element that holds an <img> prints on every page', async () => {
  const pages = await imagesPerPage(`<span class="logo"><img alt="Crest" src="${PNG}"></span>${FLOW}`);
  assert.ok(Array.isArray(pages), `the print is refused: ${!Array.isArray(pages) && pages.refused}`);
  assert.deepEqual(pages, [1, 1]);
});

// Found in the ADM2 editor on 2026-11-23, once the crest printed: the crest has an alpha channel and reaches the page behind a `blob:` address, and the print was refused because `surveyNeeds` loads the PNG decoder only for an address ending in `.png`.
test('a running PNG with alpha behind a data: address prints', async () => {
  const pages = await imagesPerPage(`<img class="logo" alt="Crest" src="${ALPHA_PNG}">${FLOW}`);
  assert.ok(Array.isArray(pages), `the print is refused: ${!Array.isArray(pages) && pages.refused}`);
  assert.deepEqual(pages, [1, 1]);
});

test('a running PNG with alpha behind a blob: address prints', async () => {
  const pages = await imagesPerPage(`<img class="logo" alt="Crest" data-blob src="${ALPHA_PNG}">${FLOW}`);
  assert.ok(Array.isArray(pages), `the print is refused: ${!Array.isArray(pages) && pages.refused}`);
  assert.deepEqual(pages, [1, 1]);
});
