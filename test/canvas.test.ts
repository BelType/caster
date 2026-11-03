/**
 * A `<canvas>` figure: the image pass reads its pixels off the element, so the list holds them as an image and the file carries it with its description; a canvas the browser will not let the printer read is refused naming its element.
 *
 * The page cases print a strip holding canvases (a plain one, a large one far above 450 ppi and, in the refusal's case, one tainted by an image from another origin) and read the report and the written file back. The file is read with pdf-lib: an image XObject of the canvas's size, and a Figure whose `/Alt` is the `aria-label`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, PDFDict, PDFRawStream, PDFHexString, PDFString } from 'pdf-lib';
import { contentType } from '@beltype/common/mime';
import { WRITER } from './writer.ts';
import { launchBrowser } from './launch.ts';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const DIST = path.join(PACKAGE, 'dist');
const COMMON = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));
const ROADS = path.join(PACKAGE, 'fixtures', 'roads');
const FONTS = path.join(PACKAGE, 'fixtures', 'specimen', 'fonts');

const PAGE = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>
<style>@font-face { font-family: "Crimson Pro"; src: url("/fonts/CrimsonPro-Variable.ttf"); font-weight: 200 900; }
body { margin: 0; } .s { width: 120mm; height: 170mm; font: 12px "Crimson Pro"; } canvas { display: block; margin: 0 0 3mm; }</style></head><body><div class="s"><p>Canvases.</p>${body}</div></body></html>`;

/** A canvas painted by a script: the same gradient, circle and square for any size. */
const PAINTED = (id: string, width: number, height: number, style: string, label: string) => `<canvas id="${id}" width="${width}" height="${height}" style="${style}" aria-label="${label}"></canvas>
<script>{ const c = document.getElementById('${id}').getContext('2d', { willReadFrequently: true }); const g = c.createLinearGradient(0, 0, ${width}, ${height}); g.addColorStop(0, '#1f4e9c'); g.addColorStop(1, '#f08a24'); c.fillStyle = g; c.fillRect(0, 0, ${width}, ${height}); c.fillStyle = '#1b1b2a'; c.beginPath(); c.arc(${width * 0.3}, ${height * 0.5}, ${height * 0.28}, 0, 7); c.fill(); c.fillStyle = '#f4efe2'; c.fillRect(${width * 0.6}, ${height * 0.18}, ${width * 0.25}, ${height * 0.4}); }</script>`;

function serve(body: string, other: number): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE(body.replaceAll('OTHER', String(other))));
    const [root, rel] = url.pathname.startsWith('/common/') ? [COMMON, url.pathname.slice(8)] : url.pathname.startsWith('/fonts/') ? [FONTS, url.pathname.slice(7)] : url.pathname.startsWith('/roads/') ? [ROADS, url.pathname.slice(7)] : [DIST, url.pathname.slice(1)];
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': contentType(file) }).end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

type Seen = { error?: { message: string; element?: string }; bytes?: number[]; images?: { domPath: string; format: string; alt?: string; intrinsic: number[]; effectiveDpi: number; resampled?: { from: number[]; to: number[] }; reason: string }[]; warnings?: string[] };

/** The strip printed in a page, and what came back: the file and the report, or the refusal. */
async function printed(body: string): Promise<Seen> {
  // A second server stands for another origin: a canvas that draws its image is tainted.
  const foreign = http.createServer((_, response) => response.writeHead(200, { 'Content-Type': 'image/png' }).end(fs.readFileSync(path.join(ROADS, 'large.png'))));
  await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', () => resolve()));
  const server = await serve(body, (foreign.address() as { port: number }).port);
  const port = (server.address() as { port: number }).port;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.evaluate(async () => { await Promise.all([...document.images].map((image) => image.decode())); });
    // A canvas that draws a foreign image does it once the image has decoded.
    await page.waitForFunction(() => !document.querySelector('canvas[data-draws]') || document.title === 'drawn');
    return await page.evaluate(async ([writer]: [string]) => {
      const load = (p: string) => import(p);
      const caster = await load('/src/index.js');
      caster.prepare(document);
      const strip = document.querySelector('.s') as HTMLElement;
      const box = strip.getBoundingClientRect();
      const pt = (px: number) => Math.round(((px * 72) / 96) * 1000) / 1000;
      try {
        const out = await caster.print({
          document,
          created: '2026-11-04T10:20:30.456Z',
          strip: {
            strip, probeRoot: strip, pageElements: [strip],
            pages: [{ element: strip, index: 0, flow: [...strip.children], flowBox: null, trimBox: null, nominal: { widthPt: pt(box.width), heightPt: pt(box.height) }, declaredPx: { widthPx: box.width, heightPx: box.height }, contentArea: strip, continuations: [] }],
            pageOfNode: new Map(), twinOf: () => null, transparent: () => false, lang: 'en', pageElementOf: () => strip, backgrounds: [],
          },
        }, { writer });
        return { bytes: [...out.bytes], images: out.report.images.map((i: any) => ({ domPath: i.domPath, format: i.format, alt: i.alt, intrinsic: i.intrinsic, effectiveDpi: i.effectiveDpi, resampled: i.resampled, reason: i.reason })), warnings: out.report.warnings };
      } catch (e: any) {
        return { error: { message: String(e.message), element: e.element } };
      }
    }, [WRITER] as [string]);
  } finally {
    await browser.close();
    server.close();
    foreign.close();
  }
}

/** The file's image XObjects (width, height) and the `/Alt` of its Figures. */
async function readBack(bytes: number[]) {
  const pdf = await PDFDocument.load(Uint8Array.from(bytes), { updateMetadata: false });
  const images: number[][] = [];
  const alts: string[] = [];
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    const dict = object instanceof PDFRawStream ? object.dict : object instanceof PDFDict ? object : undefined;
    if (!dict) continue;
    if (dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) images.push([Number(String(dict.get(PDFName.of('Width')))), Number(String(dict.get(PDFName.of('Height'))))]);
    const alt = dict.get(PDFName.of('Alt'));
    if (dict.get(PDFName.of('S')) === PDFName.of('Figure') && (alt instanceof PDFHexString || alt instanceof PDFString)) alts.push(alt.decodeText());
  }
  return { images, alts };
}

test('in the page: a canvas is carried as an image, with its aria-label as the figure\'s /Alt, and a large one is reduced like any image', async () => {
  const label = 'A painted figure: a gradient with a dark circle and a pale square';
  const big = 'A large painted figure printed in a small box';
  const seen = await printed(`${PAINTED('a', 800, 500, 'width: 100mm', label)}${PAINTED('b', 3000, 2000, 'width: 50mm', big)}`);
  assert.equal(seen.error, undefined);
  const [plain, large] = seen.images!;
  assert.deepEqual([plain.format, plain.alt, plain.intrinsic, plain.resampled], ['canvas', label, [800, 500], undefined], 'the pixels as painted: about 200 ppi is not above 450');
  assert.match(plain.reason, /^a <canvas>, read as pixels/);
  assert.deepEqual([large.format, large.alt, large.resampled?.from], ['canvas', big, [3000, 2000]], 'the canvas goes past downsampling as any decoded image does');
  assert.ok(large.intrinsic[0] < 700 && large.intrinsic[0] > 500, `reduced to about 300 ppi for a 50 mm box, not ${large.intrinsic}`);
  const file = await readBack(seen.bytes!);
  assert.ok(file.images.some(([w, h]) => w === 800 && h === 500), `an image XObject of 800 by 500 in ${JSON.stringify(file.images)}`);
  assert.ok(file.images.some(([w, h]) => w === large.intrinsic[0] && h === large.intrinsic[1]), 'and one of the reduced size');
  assert.deepEqual([...file.alts].sort(), [big, label].sort(), 'the labels are the figures\' /Alt');
});

test('in the page: a tainted canvas is refused naming its element', async () => {
  const seen = await printed(`<canvas id="t" data-draws width="200" height="100" aria-label="Tainted"></canvas>
<script>{ const img = new Image(); img.src = 'http://127.0.0.1:OTHER/x.png'; img.decode().then(() => { document.getElementById('t').getContext('2d').drawImage(img, 0, 0, 200, 100); document.title = 'drawn'; }); }</script>`);
  assert.ok(seen.error, 'the print refused');
  assert.match(seen.error.message, /<canvas> at .*canvas\[0\]/);
  assert.match(seen.error.message, /tainted/);
  assert.match(seen.error.element ?? '', /canvas\[0\]/);
});
