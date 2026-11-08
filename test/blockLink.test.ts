/**
 * A link laid out as a block (*a child is a block by its computed display, not by its tag*, S75): `<a href style="display: block">` around a paragraph. The tag names the role and the computed display says it is a block, so the anchor owns no text of its own and its content keeps its own tags; the file's `Link` structure element must wrap that content, and the annotation must still be written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef } from 'pdf-lib';
import { contentType } from '@beltype/common/mime';
import { WRITER } from './writer.ts';
import { launchBrowser } from './launch.ts';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const DIST = path.join(PACKAGE, 'dist');
const COMMON = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));
const FONTS = path.join(PACKAGE, 'fixtures', 'specimen', 'fonts');

const PAGE = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>
<style>@font-face { font-family: "Crimson Pro"; src: url("/fonts/CrimsonPro-Variable.ttf"); font-weight: 200 900; }
body { margin: 0; } .s { width: 120mm; height: 100mm; font: 12px "Crimson Pro"; }</style></head><body><div class="s">${body}</div></body></html>`;

async function printed(body: string): Promise<{ error?: string; bytes?: number[] }> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE(body));
    const [root, rel] = url.pathname.startsWith('/common/') ? [COMMON, url.pathname.slice(8)] : url.pathname.startsWith('/fonts/') ? [FONTS, url.pathname.slice(7)] : [DIST, url.pathname.slice(1)];
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': contentType(file) }).end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
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
        const out = await caster.print({
          document,
          created: '2026-11-04T10:20:30.456Z',
          strip: {
            strip, probeRoot: strip, pageElements: [strip],
            pages: [{ element: strip, index: 0, flow: [...strip.children], flowBox: null, trimBox: null, nominal: { widthPt: pt(box.width), heightPt: pt(box.height) }, declaredPx: { widthPx: box.width, heightPx: box.height }, contentArea: strip, continuations: [] }],
            pageOfNode: new Map(), twinOf: () => null, transparent: () => false, lang: 'en', pageElementOf: () => strip, backgrounds: [],
          },
        }, { writer });
        return { bytes: [...out.bytes] };
      } catch (e: any) {
        return { error: String(e.message) };
      }
    }, WRITER);
  } finally {
    await browser.close();
    server.close();
  }
}

/** The structure tree as nested `Type[children]` text, leaving out what is not a structure element. */
async function tree(bytes: number[]): Promise<string> {
  const pdf = await PDFDocument.load(Uint8Array.from(bytes), { updateMetadata: false });
  const root = pdf.catalog.lookup(PDFName.of('StructTreeRoot'), PDFDict);
  const show = (node: PDFDict): string => {
    const kids = node.lookup(PDFName.of('K'));
    const list = kids instanceof PDFArray ? kids.asArray() : kids ? [kids] : [];
    const inner = list.map((k) => (k instanceof PDFRef ? pdf.context.lookup(k) : k)).filter((k): k is PDFDict => k instanceof PDFDict && k.has(PDFName.of('S'))).map(show).join(',');
    return `${String(node.get(PDFName.of('S'))).slice(1)}${inner ? `[${inner}]` : ''}`;
  };
  return show(root);
}

test('a block-level link wrapping a paragraph is a Link around the paragraph, and the link is still annotated', async () => {
  const seen = await printed('<a href="https://example.org/" style="display: block"><p>Read the whole story.</p></a><p>After it.</p>');
  assert.equal(seen.error, undefined);
  const shape = await tree(seen.bytes!);
  assert.match(shape, /Link\[P\]/, shape);
  const pdf = await PDFDocument.load(Uint8Array.from(seen.bytes!), { updateMetadata: false });
  const uris = pdf.getPages()[0].node.Annots()?.asArray().filter((a) => (pdf.context.lookup(a, PDFDict)).get(PDFName.of('Subtype')) === PDFName.of('Link')).length;
  assert.equal(uris, 1);
});

test('a block-level link holding bare text owns the text as a Link', async () => {
  const seen = await printed('<a href="https://example.org/" style="display: block">Bare words in a block link.</a>');
  assert.equal(seen.error, undefined);
  assert.match(await tree(seen.bytes!), /Link/);
});
