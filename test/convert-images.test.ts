/**
 * Images converted to CMYK (brief 4 of the image round): the image converter against the text transform and against hand cases, the flag's refusals, the display list at version 7, the recorded `convert-images` document read back (its images are `/DeviceCMYK` XObjects, their alpha an `/SMask`), and the pass in a page with the conversion's milliseconds per image.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, PDFRawStream, PDFNumber } from 'pdf-lib';
import { contentType } from '@beltype/common/mime';
import { lcmsImageConverter, lcmsTransform } from '../src/colour/rgbToCmyk.ts';
import { resolveOptions, colourOn } from '../src/options.ts';
import { validateList } from '../src/displayList.ts';
import type { DisplayList } from '../src/displayList.ts';
import { CasterError } from '../src/errors.ts';
import { WRITER } from './writer.ts';
import { launchBrowser } from './launch.ts';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const LISTS = path.join(PACKAGE, 'fixtures', 'lists');
const DIST = path.join(PACKAGE, 'dist');
const COMMON = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));
const ROADS = path.join(PACKAGE, 'fixtures', 'roads');
const FONTS = path.join(PACKAGE, 'fixtures', 'specimen', 'fonts');
const profile = (name: string) => new Uint8Array(fs.readFileSync(path.join(PACKAGE, 'profiles', name)));

async function lcms() {
  // By a variable, because the bundle carries no declarations (types/vendor.d.ts).
  const name = 'lcms-wasm';
  return { module: await import(name), wasm: new Uint8Array(fs.readFileSync(path.join(PACKAGE, 'node_modules', 'lcms-wasm', 'dist', 'lcms.wasm'))) };
}
const converter = async () => lcmsImageConverter(await lcms(), profile('srgb.icc'), profile('default_cmyk.icc'));

test('the image converter agrees with the text transform to one level of eight bits, and the alpha rides beside the colour untouched', async () => {
  const text = await lcmsTransform(await lcms(), profile('srgb.icc'), profile('default_cmyk.icc'));
  const colours: [number, number, number][] = [[20, 90, 200], [200, 32, 32], [42, 127, 59], [119, 119, 119], [0, 0, 0], [255, 255, 255]];
  const asked = text.convert(colours);
  const { convert } = await converter();
  const rgba = Uint8Array.from(colours.flatMap(([r, g, b], i) => [r, g, b, 10 + i]));
  const out = convert({ width: 6, height: 1, data: rgba, colorSpace: 'DeviceRGB', bitsPerComponent: 8, alpha: true });
  assert.equal(out.data.length, 6 * 5);
  assert.equal(out.profile, 'sRGB');
  colours.forEach((_, i) => {
    for (let c = 0; c < 4; c++) assert.ok(Math.abs(out.data[i * 5 + c] / 255 - asked[i][c]) <= 1 / 255 + 1e-9, `colour ${i} plate ${c}: ${out.data[i * 5 + c]} against ${asked[i][c]}`);
    assert.equal(out.data[i * 5 + 4], 10 + i, 'the alpha sample is the source\'s');
  });
});

test('sixteen bits are converted at sixteen and agree with the eight-bit answer to one level of eight; a grey with no profile is the sRGB grey', async () => {
  const { convert } = await converter();
  const rgb8 = convert({ width: 2, height: 1, data: Uint8Array.from([20, 90, 200, 200, 32, 32]), colorSpace: 'DeviceRGB', bitsPerComponent: 8, alpha: false });
  const wide = Uint8Array.from([20, 90, 200, 200, 32, 32].flatMap((v) => [v, v]));
  const rgb16 = convert({ width: 2, height: 1, data: wide, colorSpace: 'DeviceRGB', bitsPerComponent: 16, alpha: false });
  assert.equal(rgb16.data.length, 2 * 4 * 2);
  for (let i = 0; i < 8; i++) assert.ok(Math.abs(((rgb16.data[i * 2] << 8) | rgb16.data[i * 2 + 1]) / 65535 - rgb8.data[i] / 255) <= 1 / 255 + 1e-9, `sample ${i}`);
  const grey = convert({ width: 2, height: 1, data: Uint8Array.from([119, 200]), colorSpace: 'DeviceGray', bitsPerComponent: 8, alpha: false });
  const same = convert({ width: 2, height: 1, data: Uint8Array.from([119, 119, 119, 200, 200, 200]), colorSpace: 'DeviceRGB', bitsPerComponent: 8, alpha: false });
  assert.deepEqual([...grey.data], [...same.data]);
});

test('a profile of the wrong colour space for the pixels is refused naming it, and one lcms cannot open is refused too', async () => {
  const { convert } = await converter();
  const gray = profile('srgb.icc').slice();
  new TextEncoder().encodeInto('GRAY', gray.subarray(16, 20));
  assert.throws(() => convert({ width: 1, height: 1, data: Uint8Array.from([1, 2, 3]), colorSpace: 'DeviceRGB', bitsPerComponent: 8, alpha: false, icc: gray }), (e: any) => e instanceof CasterError && /"GRAY" profile and its pixels are RGB/u.test(e.message));
  assert.throws(() => convert({ width: 1, height: 1, data: Uint8Array.from([1, 2, 3]), colorSpace: 'DeviceRGB', bitsPerComponent: 8, alpha: false, icc: new Uint8Array(64).fill(0x52) }), (e: any) => e instanceof CasterError);
});

test('convertImages defaults to none, takes none and cmyk, turns colour auto on, and is refused with colour off naming both flags', () => {
  assert.equal(resolveOptions().convertImages, 'none');
  assert.throws(() => resolveOptions({ convertImages: 'rgb' as never }), (e: any) => e instanceof CasterError && e.flag === 'convertImages');
  assert.equal(colourOn({}, resolveOptions()), false);
  assert.equal(colourOn({}, resolveOptions({ convertImages: 'cmyk' })), true);
  assert.throws(() => resolveOptions({ convertImages: 'cmyk', colour: 'off' }), (e: any) => e instanceof CasterError && e.flag === 'convertImages' && /colour: 'off'/u.test(e.message) && /convertImages: 'cmyk'/u.test(e.message));
});

// --- the display list at version 7 ---------------------------------------------------------------------

/** The committed list with its blobs read from `blobs/`. */
function listOf(name: string): DisplayList {
  const list = JSON.parse(fs.readFileSync(path.join(LISTS, `${name}.json`), 'utf8'));
  const entry = JSON.parse(fs.readFileSync(path.join(LISTS, 'corpus.json'), 'utf8')).documents.find((e: any) => e.name === name);
  list.resources.blobs = Object.fromEntries(entry.list.blobs.map((hash: string) => [hash, new Uint8Array(fs.readFileSync(path.join(LISTS, 'blobs', hash)))]));
  return list;
}

test('the recorded convert-images list is version 7, validateList holds its CMYK samples to four components, and a list of version 6 is refused in the version\'s sentence', () => {
  const list = listOf('convert-images');
  assert.equal(list.version, 7);
  validateList(list);
  const cmyk = Object.values(list.resources.images).filter((i) => i.samples?.colorSpace === 'DeviceCMYK');
  assert.equal(cmyk.length, 7);
  const first = cmyk[0].samples!;
  const wrong = listOf('convert-images');
  const sample = Object.values(wrong.resources.images).find((i) => i.samples?.colorSpace === 'DeviceCMYK')!.samples!;
  sample.colorSpace = 'DeviceRGB';
  assert.throws(() => validateList(wrong), (e: any) => e instanceof CasterError && /samples hold \d+ bytes, and \d+ by \d+ DeviceRGB at 8 bits is/u.test(e.message), 'four components are held to the bytes: read as three they do not add up');
  const withIcc = listOf('convert-images');
  const target = Object.values(withIcc.resources.images).find((i) => i.samples?.colorSpace === 'DeviceCMYK')!.samples!;
  target.icc = first.blob;
  assert.throws(() => validateList(withIcc), (e: any) => e instanceof CasterError && /DeviceCMYK at 8 bits with a profile, a shape the schema does not name/u.test(e.message));
  const old = listOf('convert-images');
  (old as { version: number }).version = 6;
  assert.throws(() => validateList(old), (e: any) => e instanceof CasterError && /reads a display list of version 7, and this one is version 6/u.test(e.message));
});

// --- the recorded document, read back -------------------------------------------------------------------

test('the recorded convert-images file holds its converted images as /DeviceCMYK XObjects, their alpha as an /SMask, and the CMYK JPEG as it was', async () => {
  const pdf = await PDFDocument.load(fs.readFileSync(path.join(LISTS, 'convert-images.pdf')));
  const images: { cs: string; bits: number; smask: boolean; filter: string; w: number; h: number; decode: boolean }[] = [];
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream) || object.dict.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
    const get = (key: string) => object.dict.get(PDFName.of(key));
    images.push({ cs: String(get('ColorSpace')), bits: (get('BitsPerComponent') as PDFNumber).asNumber(), smask: get('SMask') !== undefined, filter: String(get('Filter')), w: (get('Width') as PDFNumber).asNumber(), h: (get('Height') as PDFNumber).asNumber(), decode: get('Decode') !== undefined });
  }
  const cmyk = images.filter((i) => i.cs === '/DeviceCMYK');
  assert.equal(cmyk.filter((i) => i.filter === '/FlateDecode').length, 7, 'seven converted images, deflated');
  assert.equal(cmyk.filter((i) => i.filter === '/DCTDecode').length, 1, 'the CMYK JPEG, as it was');
  assert.equal(cmyk.filter((i) => i.smask).length, 3, 'alpha.png, deep-alpha.png and palette-trns.png carry their alpha as an /SMask');
  assert.equal(cmyk.filter((i) => i.bits === 16).length, 1, 'deep-alpha.png stays at sixteen bits');
  assert.ok(!images.some((i) => i.cs === '/DeviceRGB'), 'no RGB image is left in the file');
  const sizes = cmyk.map((i) => `${i.w}x${i.h}`);
  assert.ok(sizes.includes('900x675') && sizes.includes('472x315'), `the two photographs are reduced first: ${sizes.join(' ')}`);
  const report = JSON.parse(fs.readFileSync(path.join(LISTS, 'convert-images.report.json'), 'utf8'));
  const named = report.images.filter((i: any) => i.converted);
  assert.equal(named.length, 7);
  assert.equal(report.images.filter((i: any) => i.notConverted).length, 1);
  assert.match(report.images.find((i: any) => i.notConverted).notConverted, /CMYK JPEG is left alone/u);
});

// --- in the page ---------------------------------------------------------------------------------------

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>
<style>@font-face { font-family: "Crimson Pro"; src: url("/fonts/CrimsonPro-Variable.ttf"); font-weight: 200 900; }
body { margin: 0; } .s { width: 100mm; height: 200mm; font: 12px "Crimson Pro"; } img { display: block; margin: 0 0 3mm; }</style></head><body><div class="s"><p>Conversion.</p>
<img src="/roads/large.jpg" alt="a" style="width: 76.2mm"><img src="/roads/large.png" alt="b" style="width: 40mm"><img src="/roads/alpha.png" alt="c" style="width: 24mm"><img src="/roads/deep-alpha.png" alt="d" style="width: 24mm"><img src="/roads/cmyk-adobe.jpg" alt="e" style="width: 24mm"></div></body></html>`;

function serve(): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
    const [root, rel] = url.pathname.startsWith('/common/') ? [COMMON, url.pathname.slice(8)] : url.pathname.startsWith('/fonts/') ? [FONTS, url.pathname.slice(7)] : url.pathname.startsWith('/roads/') ? [ROADS, url.pathname.slice(7)] : [DIST, url.pathname.slice(1)];
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': contentType(file) }).end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

type Seen = { bytes: number; images: { src: string; colorSpace: string; bpc: number; hasSMask: boolean; intrinsic: number[]; converted?: any; convertMs?: number; notConverted?: string; resampled?: any; resampleMs?: number; decodeMs: number }[]; };

async function printed(options: Record<string, unknown>): Promise<Seen> {
  const server = await serve();
  const port = (server.address() as { port: number }).port;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.evaluate(async () => { await Promise.all([...document.images].map((image) => image.decode())); });
    return await page.evaluate(async ([given, writer]: [Record<string, unknown>, string]) => {
      const caster = await import('/src/index.js' as string);
      caster.prepare(document);
      const strip = document.querySelector('.s') as HTMLElement;
      const box = strip.getBoundingClientRect();
      const pt = (px: number) => Math.round(((px * 72) / 96) * 1000) / 1000;
      const out = await caster.print({
        document,
        created: '2026-11-04T10:20:30.456Z',
        strip: {
          strip, probeRoot: strip, pageElements: [strip],
          pages: [{ element: strip, index: 0, flow: [...strip.children], flowBox: null, trimBox: null, nominal: { widthPt: pt(box.width), heightPt: pt(box.height) }, declaredPx: { widthPx: box.width, heightPx: box.height }, contentArea: strip, continuations: [] }],
          pageOfNode: new Map(), twinOf: () => null, transparent: () => false, lang: 'en', pageElementOf: () => strip, backgrounds: [],
        },
      }, { writer, ...given });
      return {
        bytes: out.bytes.length,
        images: out.report.images.map((i: any) => ({ src: i.src, colorSpace: i.colorSpace, bpc: i.bpc, hasSMask: i.hasSMask, intrinsic: i.intrinsic, converted: i.converted, convertMs: i.convertMs, notConverted: i.notConverted, resampled: i.resampled, resampleMs: i.resampleMs, decodeMs: i.decodeMs })),
      };
    }, [options, WRITER] as [Record<string, unknown>, string]);
  } finally {
    await browser.close();
    server.close();
  }
}

test('in the page: under convertImages cmyk each RGB image is reduced and then converted, its alpha kept, a CMYK JPEG left alone and named; off, nothing is', async (t) => {
  const on = await printed({ convertImages: 'cmyk' });
  const [jpg, png, alpha, deep, cmykJpeg] = on.images;
  assert.deepEqual([jpg.colorSpace, png.colorSpace, alpha.colorSpace, deep.colorSpace], ['DeviceCMYK', 'DeviceCMYK', 'DeviceCMYK', 'DeviceCMYK']);
  assert.deepEqual(jpg.intrinsic, [900, 675], 'reduced first, then converted');
  assert.deepEqual(png.intrinsic, [472, 315]);
  assert.deepEqual([alpha.hasSMask, deep.hasSMask, deep.bpc], [true, true, 16]);
  assert.deepEqual(jpg.converted, { from: 'DeviceRGB', bitsPerComponent: 8, profile: 'embedded' });
  assert.equal(cmykJpeg.converted, undefined);
  assert.match(cmykJpeg.notConverted ?? '', /CMYK JPEG is left alone/u);
  t.diagnostic(`convertImages: ${on.images.slice(0, 4).map((i) => `${i.src.split('/').pop()} ${i.intrinsic.join('x')} ${i.convertMs} ms`).join('; ')}; the file is ${on.bytes} bytes`);
  console.log(`convert-images.test: ${on.images.slice(0, 4).map((i) => `${i.src.split('/').pop()} ${i.intrinsic.join('x')} (${(i.intrinsic[0] * i.intrinsic[1] / 1e6).toFixed(2)} MP) converted in ${i.convertMs} ms`).join('; ')}; the file is ${on.bytes} bytes`);
  const off = await printed({});
  assert.ok(off.images.every((i) => i.converted === undefined && i.notConverted === undefined && i.colorSpace !== 'DeviceCMYK' || i.src.endsWith('cmyk-adobe.jpg')));
});
