/**
 * An image set as an `@page` background prints where the page shows it, under the content, as an artifact (codeberg.org/BelType/caster issue 20).
 *
 * @remarks
 * Each document is cut by Cicero and printed through `print()`, since the case is the page box Cicero dresses. The page is looked at before the print, so the browser is the oracle: the ink's box in the screenshot of the page and in the file rendered by mupdf at the same resolution are one box, to a pixel and a half.
 *
 * @packageDocumentation
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as mupdf from 'mupdf';
import { ciceroEngine } from '@beltype/cicero/engine';
import { launchBrowser } from './launch.ts';
import { contentType } from '@beltype/common/mime';
import { WRITER } from './writer.ts';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const COMMON = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));
const FONTS = path.join(PACKAGE, 'fixtures', 'specimen', 'fonts');
const MM = 96 / 25.4;

/** An opaque blue PNG, the raster case's whole picture. */
function bluePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, Buffer.from([0x1f, 0x3f, 0x8f]))]);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

const SQUARE = '<svg xmlns="http://www.w3.org/2000/svg" width="148mm" height="210mm" viewBox="0 0 148 210"><rect x="10" y="10" width="20" height="20" fill="#1f3f8f"/></svg>';
const FILES: Record<string, string | Buffer> = { '/bg.svg': SQUARE, '/bg.png': bluePng(40, 20), '/viewbox.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#1f3f8f"/></svg>' };

type Printed = { doc: mupdf.Document; shots: Buffer[]; svgImages: unknown[]; tags: string[]; items: { kind: string; start?: { artifact?: { type: string } } }[] };

/** Cuts and prints a two-page A5 document whose first page is the named page `prima`, and answers the file, what the page showed, and what the print recorded. */
async function printCase(css: string, options: Record<string, unknown> = {}): Promise<Printed> {
  const body = '<div class="a"><p>Testo.</p></div><div class="b"><p>Seguito.</p></div>';
  const engine = ciceroEngine.vendorAssets();
  const dirs: Record<string, string> = { ...engine.dirs, caster: path.join(PACKAGE, 'dist'), common: COMMON };
  const imports = Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/_beltype/common/${m}.js`]));
  const html = `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>case</title><script type="importmap">${JSON.stringify({ imports })}</script>${ciceroEngine.headHtml('/')}
<style>@font-face { font-family: F; src: url("/fonts/CrimsonText-Regular.ttf"); } html { font: 11pt/1.4 F; } p { margin: 0; } img, div { border: 3px solid red; padding: 2mm; } @page { size: A5; margin: 15mm; } .a { page: prima; border: 0; padding: 0; } .b { page: seguito; border: 0; padding: 0; } ${css}</style></head><body>${body}</body></html>`;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end(html);
    if (FILES[url.pathname]) return void response.writeHead(200, { 'Content-Type': contentType(url.pathname) }).end(FILES[url.pathname]);
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
    await tab.evaluate(async () => {
      const caster = await import('/_beltype/caster/src/index.js' as string);
      await caster.prepare(document).ready;
      await (window as unknown as { __beltypeCicero: { run: (flags: object) => Promise<unknown> } }).__beltypeCicero.run({});
      await document.fonts.ready;
    });
    const pages = tab.locator('beltype-page');
    const shots: Buffer[] = [];
    for (let i = 0; i < await pages.count(); i++) shots.push(await pages.nth(i).screenshot());
    const printed = await tab.evaluate(async (flags: Record<string, unknown>) => {
      const caster = await import('/_beltype/caster/src/index.js' as string);
      try {
        const { bytes, report, displayList } = await caster.print({ document }, flags);
        let binary = '';
        for (const byte of bytes as Uint8Array) binary += String.fromCharCode(byte);
        return { base64: btoa(binary), svgImages: report.svgImages, tree: report.structure.expectedTree, items: displayList.pages[0].items.map((item: { kind: string; start?: unknown }) => ({ kind: item.kind, start: item.start })) };
      } catch (error) {
        return { refused: String((error as Error).message) };
      }
    }, { writer: WRITER, ...options });
    if ('refused' in printed) throw new Error(printed.refused);
    type Node = { tag: string; kids: Node[] };
    const tagsOf = (node: Node): string[] => [node.tag, ...node.kids.flatMap(tagsOf)];
    return { doc: mupdf.Document.openDocument(Buffer.from(printed.base64 as string, 'base64'), 'application/pdf'), shots, svgImages: printed.svgImages as unknown[], tags: tagsOf(printed.tree as Node), items: printed.items };
  } finally {
    await browser.close();
    server.close();
  }
}

/** The file's page at the browser's own resolution, as RGB. */
const renderPage = (doc: mupdf.Document, index: number) => doc.loadPage(index).toPixmap(mupdf.Matrix.scale(96 / 72, 96 / 72), mupdf.ColorSpace.DeviceRGB, false, true);
const isBlue = (r: number, g: number, b: number) => b > 110 && r < 100 && g < 110;
const rgbAt = (pixmap: mupdf.Pixmap, x: number, y: number) => { const at = (Math.round(y) * pixmap.getWidth() + Math.round(x)) * pixmap.getNumberOfComponents(); return [...pixmap.getPixels().slice(at, at + 3)] as [number, number, number]; };

/** The box of the blue ink, `[left, top, right, bottom]` in pixels, or null where there is none. */
function blueBox(pixmap: mupdf.Pixmap): [number, number, number, number] | null {
  const [w, h, n, s] = [pixmap.getWidth(), pixmap.getHeight(), pixmap.getNumberOfComponents(), pixmap.getPixels()];
  let box: [number, number, number, number] | null = null;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const at = (y * w + x) * n;
    if (!isBlue(s[at]!, s[at + 1]!, s[at + 2]!)) continue;
    box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x + 1), Math.max(box[3], y + 1)] : [x, y, x + 1, y + 1];
  }
  return box;
}

/** What the browser showed on the page against what the file carries: one box, to a pixel and a half. */
function assertOracle(printed: Printed, index = 0) {
  const shown = blueBox(new mupdf.Image(printed.shots[index]!).toPixmap().convertToColorSpace(mupdf.ColorSpace.DeviceRGB));
  const drawn = blueBox(renderPage(printed.doc, index));
  assert.ok(shown, 'the control: the browser shows the image on the page');
  assert.ok(drawn, 'the file carries the image');
  shown.forEach((edge, i) => assert.ok(Math.abs(edge - drawn[i]!) <= 1.5, `the page shows ${JSON.stringify(shown)} and the file draws ${JSON.stringify(drawn)}`));
  return drawn;
}

test('an SVG on a named page lands where the page shows it, as vectors, and on no other page', async () => {
  const printed = await printCase('@page prima { background: url(/bg.svg) no-repeat 0 0 / 148mm 210mm; }');
  const box = assertOracle(printed);
  [10, 10, 30, 30].forEach((mm, i) => assert.ok(Math.abs(box[i]! - mm * MM) <= 1.5, `the square is at 10 mm to 30 mm (${JSON.stringify(box)})`));
  assert.deepEqual(rgbAt(renderPage(printed.doc, 0), 70 * MM, 150 * MM), [255, 255, 255], 'the rest of the page is the sheet: the box that holds the drawing paints nothing');
  assert.equal(printed.svgImages.length, 1, 'one drawing was seated, and no raster of it was made');
  assert.equal(printed.doc.countPages(), 2);
  assert.equal(blueBox(renderPage(printed.doc, 1)), null, 'the page that is not `prima` has no letterhead');
  assert.equal(printed.doc.loadPage(0).toStructuredText('preserve-whitespace').asText().trim(), 'Testo.');
});

test('the image paints behind the content, and is an artifact rather than reading content', async () => {
  const printed = await printCase('@page prima { background: url(/bg.svg) no-repeat 0 0 / 148mm 210mm; } .a { background: #d00; height: 30mm; }');
  const page = renderPage(printed.doc, 0);
  assert.ok(isBlue(...rgbAt(page, 12 * MM, 12 * MM)), 'the square shows in the margin, where nothing covers it');
  const [r, g] = rgbAt(page, 20 * MM, 20 * MM);
  assert.ok(r > 180 && g < 60, 'the box of the page\'s content is painted over the square');
  assert.ok(!printed.tags.includes('Figure'), `the structure tree has no figure for it (${printed.tags})`);
  assert.equal(printed.items[0]!.start?.artifact?.type, 'Layout', 'the page\'s stream begins with it, in an artifact');
});

for (const [name, background] of [
  ['its own size at a position', 'url(/bg.png) no-repeat 10mm 20mm'],
  ['a length and auto, from the far edges', 'url(/bg.png) no-repeat right 5mm bottom 7mm / 30mm auto'],
  ['contain, centred', 'url(/bg.png) no-repeat 50% 50% / contain'],
  ['cover, in the default repeat, where one tile covers the page', 'url(/bg.png) 0 0 / cover'],
  ['an SVG at its own size', 'url(/bg.svg) no-repeat 5mm 5mm'],
  ['an SVG with no size of its own, sized by the rule', 'url(/viewbox.svg) no-repeat 5mm 5mm / 20mm 20mm'],
]) test(`a page image placed by ${name} lands where the page shows it`, async () => {
  assertOracle(await printCase(`@page prima { background: ${background}; }`));
});

test('the control: a page rule with no image prints no image', async () => {
  const printed = await printCase('@page prima { margin: 20mm; }');
  assert.equal(blueBox(renderPage(printed.doc, 0)), null);
  assert.equal(printed.svgImages.length, 0);
  assert.ok(!printed.items.some((item) => item.kind === 'image'));
  assert.ok(!printed.items.some((item) => item.kind === 'shape'), 'and nothing else is drawn for it');
});

for (const [name, background, refusal] of [
  ['a tile that repeats inside the page', 'url(/bg.png) 0 0 / 10mm 10mm', /background-repeat: repeat/],
  ['a gradient', 'linear-gradient(red, blue)', /linear-gradient/],
  ['two layers', 'url(/bg.png) no-repeat, url(/bg.svg) no-repeat', /url\("[^"]*bg\.png"\), url/],
  ['an SVG with no size of its own at its own size', 'url(/viewbox.svg) no-repeat', /no width and height/],
] as [string, string, RegExp][]) test(`${name} on a page refuses by name, and is never dropped`, async () => {
  await assert.rejects(printCase(`@page prima { background: ${background}; }`), refusal);
});

test('under Paged.js a page image refuses by name, where it used to be dropped', async () => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><html lang="it"><head><script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script></head><body><div class="pagedjs_pages"><div class="pagedjs_page" style="background: url(/bg.png)"></div></div></body></html>`);
    const [root, rel] = url.pathname.startsWith('/common/') ? [COMMON, url.pathname.slice(8)] : [path.join(PACKAGE, 'dist'), url.pathname.slice(1)];
    const file = path.join(root, rel);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': contentType(file) }).end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const browser = await launchBrowser();
  try {
    const tab = await browser.newPage();
    await tab.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    const refused = await tab.evaluate(async () => {
      const { adaptPagedjs } = await import('/src/adapters/pagedjs.js' as string);
      try { adaptPagedjs(document); return null; } catch (error) { return String((error as Error).message); }
    });
    assert.match(refused ?? '', /@page background on page 1 is url\(/);
  } finally {
    await browser.close();
    server.close();
  }
});

test('a page image under paintOrder: dom, which would paint it over the page, refuses by name', async () => {
  await assert.rejects(printCase('@page prima { background: url(/bg.png) no-repeat; }', { paintOrder: 'dom' }), /paintOrder: 'dom'/);
});

test('a page image with a background-origin this printer does not model refuses by name', async () => {
  await assert.rejects(printCase('@page prima { background: url(/bg.png) no-repeat content-box; }'), /background-origin: content-box/);
});
