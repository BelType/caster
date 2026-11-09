/**
 * The colour profiles (*the output intent is sRGB until the operator passes a CMYK profile*): `profile` is the bytes of an ICC profile, the output intent's destination for CMYK. Without it the output intent carries the compact sRGB profile, and the two roads that convert to CMYK (`convertImages: 'cmyk'`, `convertRgb: 'wasm'`) refuse by naming the option.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, decodePDFRawStream } from 'pdf-lib';
import { createHash } from 'node:crypto';
import { resolveOptions } from '../src/options.ts';
import { CasterError } from '../src/errors.ts';
import { contentType } from '@beltype/common/mime';
import { launchBrowser } from './launch.ts';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const DIST = path.join(PACKAGE, 'dist');
const COMMON = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));
const FONTS = path.join(PACKAGE, 'fixtures', 'specimen', 'fonts');

const PAGE = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>
<style>@font-face { font-family: "Crimson Pro"; src: url("/fonts/CrimsonPro-Variable.ttf"); font-weight: 200 900; }
body { margin: 0; } .s { width: 120mm; height: 100mm; font: 12px "Crimson Pro"; }</style></head><body><div class="s">${body}</div></body></html>`;

async function printed(body: string, profile?: number[], writer: string = 'pdf-lib'): Promise<{ error?: string; bytes?: number[] }> {
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
    return await page.evaluate(async ({ writer, profile }: { writer: string; profile: number[] | undefined }) => {
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
        }, { writer, colour: 'on', ...(profile ? { profile: Uint8Array.from(profile) } : {}) });
        return { bytes: [...out.bytes] };
      } catch (e: any) {
        return { error: String(e.message) };
      }
    }, { writer, profile });
  } finally {
    await browser.close();
    server.close();
  }
}


const asset = (rel: string) => new Uint8Array(fs.readFileSync(path.join(PACKAGE, rel)));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const outputProfile = async (bytes: number[]) => {
  const pdf = await PDFDocument.load(Uint8Array.from(bytes), { updateMetadata: false });
  const intent = (pdf.catalog.lookup(PDFName.of('OutputIntents'), PDFArray)).lookup(0, PDFDict);
  return decodePDFRawStream(intent.lookup(PDFName.of('DestOutputProfile')) as any).decode();
};

test('a conversion to CMYK without a profile refuses naming the option', () => {
  for (const flags of [{ convertImages: 'cmyk' }, { convertRgb: 'wasm' }] as const) {
    assert.throws(() => resolveOptions(flags), (e: any) => e instanceof CasterError && e.flag === 'profile' && /`profile`/.test(e.message), JSON.stringify(flags));
    assert.doesNotThrow(() => resolveOptions({ ...flags, profile: asset('test/assets/default_cmyk.icc') }));
  }
});

test('a print with no profile carries the compact sRGB profile as its output intent', async () => {
  const seen = await printed('<p>Some words.</p>');
  assert.equal(seen.error, undefined);
  assert.equal(sha(await outputProfile(seen.bytes!)), sha(asset('profiles/srgb.icc')));
});

test('a print with a CMYK profile carries it as its output intent', async () => {
  const cmyk = asset('test/assets/default_cmyk.icc');
  const seen = await printed('<p>Some words.</p>', [...cmyk]);
  assert.equal(seen.error, undefined);
  assert.equal(sha(await outputProfile(seen.bytes!)), sha(cmyk));
});

test('the Rust writer refuses a colour print with no profile, naming the option, and writes the output intent from one', async () => {
  const none = await printed('<p>Some words.</p>', undefined, 'forme');
  assert.match(none.error ?? '', /`profile`/);
  const cmyk = asset('test/assets/default_cmyk.icc');
  const seen = await printed('<p>Some words.</p>', [...cmyk], 'forme');
  assert.equal(seen.error, undefined);
  assert.equal(sha(await outputProfile(seen.bytes!)), sha(cmyk));
});
