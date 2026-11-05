/**
 * Two cases from printing the `mostra` specimen (codeberg.org/BelType/specimens), each printed whole and read back with mupdf.
 *
 * @remarks
 * Two positioned `<tspan>` lines of one SVG `<text>` print on their own lines (issue 12); a pattern-filled shape drawn through `<use>` prints (issue 14). Each page is a host strip of one box, so no engine is involved. The third case of the round, a drop capital held by a block child (issue 13), is in `reifyFirstLetter.test.ts`.
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

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const DIST = path.join(PACKAGE, 'dist');
const COMMON = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));
const FONTS = path.join(PACKAGE, 'fixtures', 'specimen', 'fonts');

/** Prints `body` inside a strip of 120 mm by 60 mm, with `css` added and `files` served beside the page, and answers the file and the faces it embeds. */
async function printCase(css: string, body: string, files: Record<string, string> = {}): Promise<{ doc: mupdf.Document; faces: string[] }> {
  const page = `<!doctype html><html lang="it"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>
<style>
@font-face { font-family: "Crimson Text"; src: url("/fonts/CrimsonText-Regular.ttf"); }
body { margin: 0; }
.s { width: 120mm; height: 60mm; padding: 0; box-sizing: border-box; font: 14px/1.4 "Crimson Text"; }
svg, img { display: block }
p { margin: 0 }
${css}
</style></head><body><div class="s">${body}</div></body></html>`;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end(page);
    if (files[url.pathname]) return void response.writeHead(200, { 'Content-Type': contentType(url.pathname) }).end(files[url.pathname]);
    const [root, rel] = url.pathname.startsWith('/common/') ? [COMMON, url.pathname.slice(8)] : url.pathname.startsWith('/fonts/') ? [FONTS, url.pathname.slice(7)] : [DIST, url.pathname.slice(1)];
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': contentType(file) }).end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const browser = await launchBrowser();
  try {
    const tab = await browser.newPage();
    await tab.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    await tab.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map((i) => i.decode())); });
    const { base64, faces } = await tab.evaluate(async (writer: string) => {
      const caster = await import('/src/index.js' as string);
      caster.prepare(document);
      const strip = document.querySelector('.s') as HTMLElement;
      const box = strip.getBoundingClientRect();
      const pt = (px: number) => Math.round(((px * 72) / 96) * 1000) / 1000;
      const printed = await caster.print({
        document,
        strip: {
          strip, probeRoot: strip, pageElements: [strip],
          pages: [{ element: strip, index: 0, flow: [...strip.children], flowBox: null, trimBox: null, nominal: { widthPt: pt(box.width), heightPt: pt(box.height) }, declaredPx: { widthPx: box.width, heightPx: box.height }, contentArea: strip, continuations: [] }],
          pageOfNode: new Map(), twinOf: () => null, transparent: () => false, lang: 'it', pageElementOf: () => strip, backgrounds: [],
        },
      }, { writer });
      let binary = '';
      for (const byte of printed.bytes as Uint8Array) binary += String.fromCharCode(byte);
      return { base64: btoa(binary), faces: (printed.report.emission?.faces ?? []).map((f: { id: string }) => f.id) };
    }, WRITER);
    return { doc: mupdf.Document.openDocument(Buffer.from(base64, 'base64'), 'application/pdf'), faces };
  } finally {
    await browser.close();
    server.close();
  }
}

/** The lines mupdf reads off the first page, trimmed. */
const linesOf = (doc: mupdf.Document): string[] => JSON.parse(doc.loadPage(0).toStructuredText('preserve-whitespace').asJSON()).blocks.flatMap((b: { lines: { text: string }[] }) => b.lines.map((l) => l.text.trim())).filter(Boolean);

test('two positioned <tspan> lines of one <text> print each on its own line', async () => {
  const { doc } = await printCase('', '<svg viewBox="0 0 300 100" width="300" height="100" role="img" aria-label="A two-line title"><text x="150" y="40" font-family="Crimson Text" font-size="20" text-anchor="middle"><tspan x="150" y="40">Province dell’Impero romano</tspan><tspan x="150" y="70">Anno 117</tspan></text></svg>');
  const lines = linesOf(doc);
  assert.ok(lines.includes('Province dell’Impero romano') && lines.includes('Anno 117'), `each tspan is its own line: ${JSON.stringify(lines)}`);
});

test('a pattern-filled shape drawn through <use> prints', async () => {
  const { doc } = await printCase('p { height: 0; overflow: hidden }', '<p>Sopra.</p><svg viewBox="0 0 100 60" width="300" height="180" role="img" aria-label="A checked pattern"><defs><pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="#eee"/><rect width="5" height="5" fill="#4a1528"/></pattern><rect id="r" width="100" height="60" fill="url(#p)"/></defs><use href="#r"/></svg>');
  const pixmap = doc.loadPage(0).toPixmap(mupdf.Matrix.scale(1, 1), mupdf.ColorSpace.DeviceGray, false, true);
  const [width, samples] = [pixmap.getWidth(), pixmap.getPixels()];
  let ink = 0;
  // 300 × 180 px is 225 × 135 pt; a quarter of every cell is dark.
  for (let y = 0; y < 135; y++) for (let x = 0; x < 225; x++) if (samples[y * width + x] < 128) ink++;
  const share = ink / (225 * 135);
  assert.ok(share > 0.15 && share < 0.35, `the checks are drawn (${share.toFixed(3)} of the drawing is dark)`);
});
