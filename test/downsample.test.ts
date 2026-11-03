/**
 * Downsampling: the resampler against hand-computed cases, the flags, and the image pass reducing a synthetic photograph in a page.
 *
 * The kernel's cases are small enough to compute by hand and run in node. The page cases print `fixtures/roads/downsample.html`'s three placements (a 4 000 by 3 000 JPEG in a box three inches wide, a 2 400 by 1 600 PNG in a box 40 mm wide and the same file in one 80 mm wide) and read the report back: the targets are the ones the rule predicts (the smallest resolution over a file's uses, the intrinsic size times 300 over it), and with `downsampleImages: false` nothing is reduced.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentType } from '@beltype/common/mime';
import { resample } from '../src/images/resample.ts';
import { reducedSize } from '../src/images/imagePass.ts';
import { withIccProfile, parseJpeg } from '../src/images/jpeg.ts';
import { resolveOptions } from '../src/options.ts';
import { CasterError } from '../src/errors.ts';
import { WRITER } from './writer.ts';
import { launchBrowser } from './launch.ts';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const DIST = path.join(PACKAGE, 'dist');
const COMMON = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));
const ROADS = path.join(PACKAGE, 'fixtures', 'roads');
const FONTS = path.join(PACKAGE, 'fixtures', 'specimen', 'fonts');

test('the filters give the hand-computed answer on a row of four', () => {
  const row = Uint8Array.from([10, 20, 30, 40]);
  assert.deepEqual([...resample(row, 4, 1, 1, false, 2, 1, 'subsample')], [20, 40], 'nearest takes the pixel under each centre');
  assert.deepEqual([...resample(row, 4, 1, 1, false, 2, 1, 'average')], [15, 35], 'area average is the mean of each pair');
  // Catmull-Rom at a factor of two: the taps of the first output are 10, 20, 30 and 40 weighted 0.8671875, 0.8671875, 0.2265625 and -0.0703125 over their sum 1.890625, which is 30 / 1.890625 = 15.868, so 16; the second is the mirror, 50 - 15.868 = 34.132, so 34.
  assert.deepEqual([...resample(row, 4, 1, 1, false, 2, 1, 'bicubic')], [16, 34]);
});

test('a constant image stays constant under every filter, and a size that does not change is the input itself', () => {
  const flat = new Uint8Array(7 * 5 * 3).fill(123);
  for (const filter of ['bicubic', 'average', 'subsample'] as const) assert.ok(resample(flat, 7, 5, 3, false, 3, 2, filter).every((v) => v === 123), filter);
  assert.equal(resample(flat, 7, 5, 3, false, 7, 5, 'bicubic'), flat);
});

test('alpha is resampled premultiplied: an opaque red beside a transparent black averages to opaque-looking red at half alpha', () => {
  const pixels = Uint8Array.from([255, 0, 0, 255, 0, 0, 0, 0]);
  assert.deepEqual([...resample(pixels, 2, 1, 4, true, 1, 1, 'average')], [255, 0, 0, 128]);
  assert.deepEqual([...resample(Uint8Array.from([255, 0, 0, 255, 0, 0, 0, 0]), 2, 1, 4, false, 1, 1, 'average')], [128, 0, 0, 128], 'straight, the transparent edge would have darkened the red');
});

test('a 16-bit ramp keeps more than 256 levels after a halving, and the same input gives the same bytes twice', () => {
  const ramp = new Uint16Array(8192);
  for (let i = 0; i < ramp.length; i++) ramp[i] = i * 8;
  for (const filter of ['bicubic', 'average'] as const) {
    const half = resample(ramp, 8192, 1, 1, false, 4096, 1, filter);
    assert.ok(half instanceof Uint16Array);
    assert.ok(new Set(half).size > 3000, `${filter}: ${new Set(half).size} levels`);
    assert.deepEqual(resample(ramp, 8192, 1, 1, false, 4096, 1, filter), half);
  }
});

test('a size, a channel count or a buffer the kernel does not read is refused', () => {
  assert.throws(() => resample(new Uint8Array(4), 2, 2, 1, false, 0, 1, 'average'), CasterError);
  assert.throws(() => resample(new Uint8Array(6), 2, 1, 3, true, 1, 1, 'average'), CasterError);
  assert.throws(() => resample(new Uint8Array(5), 2, 2, 1, false, 1, 1, 'average'), CasterError);
});

test('the reduced size is the stored size times the target over the measured resolution, in whole pixels, never below one', () => {
  assert.deepEqual(reducedSize(4000, 3000, 1333.3, 300), [900, 675]);
  assert.deepEqual(reducedSize(2400, 1600, 762, 300), [945, 630]);
  assert.deepEqual(reducedSize(3, 1, 9600, 300), [1, 1]);
});

test('the four flags default to Distiller\'s print-ready values and refuse a value outside their set naming the flag', () => {
  const options = resolveOptions();
  assert.deepEqual([options.downsampleImages, options.imageResolution, options.downsampleThreshold, options.downsampleType], [true, 300, 1.5, 'bicubic']);
  for (const [flag, value] of [['downsampleThreshold', 0.9], ['downsampleThreshold', 10.5], ['imageResolution', 0], ['downsampleType', 'lanczos'], ['downsampleImages', 'yes']] as const) {
    assert.throws(() => resolveOptions({ [flag]: value } as never), (e: any) => e instanceof CasterError && e.flag === flag, `${flag}: ${value}`);
  }
  assert.equal(resolveOptions({ downsampleThreshold: 10 }).downsampleThreshold, 10);
  assert.equal(resolveOptions({ downsampleThreshold: 1 }).downsampleThreshold, 1);
});

test('an ICC profile spliced into a JPEG is read back whole, across markers, and a profile that is not RGB is dropped', () => {
  const jpeg = Uint8Array.from(fs.readFileSync(path.join(ROADS, 'large.jpg')));
  const profile = new Uint8Array(70_000).map((_, i) => i % 251);
  profile.set([...'RGB '].map((c) => c.charCodeAt(0)), 16);
  assert.equal(parseJpeg(jpeg).iccProfile?.length, 456, 'the browser\'s encoder wrote a profile of its own into the fixture');
  assert.deepEqual(parseJpeg(withIccProfile(jpeg, profile)).iccProfile, profile, 'two markers, read back to the same bytes, the encoder\'s own profile gone');
  const grey = profile.slice();
  grey.set([...'GRAY'].map((c) => c.charCodeAt(0)), 16);
  assert.equal(withIccProfile(jpeg, grey), jpeg);
  assert.equal(withIccProfile(jpeg, null), jpeg);
});

// --- in the page ------------------------------------------------------------

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>
<style>@font-face { font-family: "Crimson Pro"; src: url("/fonts/CrimsonPro-Variable.ttf"); font-weight: 200 900; }
body { margin: 0; } .s { width: 100mm; height: 170mm; font: 12px "Crimson Pro"; } img { display: block; margin: 0 0 3mm; }</style></head><body><div class="s"><p>Three placements.</p>
<img src="/roads/large.jpg" alt="a" style="width: 76.2mm"><img src="/roads/large.png" alt="b" style="width: 40mm"><img src="/roads/large.png" alt="c" style="width: 80mm"></div></body></html>`;

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

type Seen = { bytes: number; images: { src: string; effectiveDpi: number; intrinsic: number[]; filter: string; resampled?: { from: number[]; to: number[]; ppi: number; type: string }; notResampled?: string; bytesOut: number; bytesIn: number; format: string; icc: string; decodeMs: number; encodeMs: number; resampleMs?: number }[]; warnings: string[] };

/** The three placements, printed in a page under the options given. */
async function printed(options: Record<string, unknown>): Promise<Seen> {
  const server = await serve();
  const port = (server.address() as { port: number }).port;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.evaluate(async () => { await Promise.all([...document.images].map((image) => image.decode())); });
    return await page.evaluate(async ([given, writer]: [Record<string, unknown>, string]) => {
      const load = (p: string) => import(p);
      const caster = await load('/src/index.js');
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
        images: out.report.images.map((i: any) => ({ src: i.src, effectiveDpi: i.effectiveDpi, intrinsic: i.intrinsic, filter: i.filter, resampled: i.resampled, notResampled: i.notResampled, bytesOut: i.bytesOut, bytesIn: i.bytesIn, format: i.format, icc: i.icc, decodeMs: i.decodeMs, encodeMs: i.encodeMs, resampleMs: i.resampleMs })),
        warnings: out.report.warnings,
      };
    }, [options, WRITER] as [Record<string, unknown>, string]);
  } finally {
    await browser.close();
    server.close();
  }
}

test('in the page: each file is reduced to 300 ppi for its largest box, and with downsampleImages false nothing is', async () => {
  const on = await printed({});
  const [jpg, small, large] = on.images;
  assert.deepEqual([jpg.effectiveDpi, small.effectiveDpi, large.effectiveDpi], [1333.3, 1524.1, 762]);
  assert.deepEqual(jpg.resampled, { from: [4000, 3000], to: [900, 675], ppi: 1333.3, type: 'bicubic' });
  assert.deepEqual(small.resampled, { from: [2400, 1600], to: [945, 630], ppi: 762, type: 'bicubic' }, 'the smaller box does not set the size: the file keeps enough for the larger');
  assert.deepEqual(large.resampled, small.resampled);
  assert.deepEqual(on.images.map((i) => i.intrinsic), [[900, 675], [945, 630], [945, 630]]);
  assert.ok(on.images.every((i) => i.filter === 'DCTDecode'), 'a reduced photograph is a JPEG in the file');
  assert.deepEqual(on.images.map((i) => i.icc), ['embedded', 'none', 'none'], 'the JPEG\'s own profile came back with it and is read as /ICCBased; the PNG had none');
  assert.deepEqual(on.images.map((i) => [i.format, i.bytesIn]), [['image/jpeg', 192240], ['image/png', 1831914], ['image/png', 1831914]], 'the report names the source and its size');

  const off = await printed({ downsampleImages: false });
  assert.ok(off.images.every((i) => i.resampled === undefined && i.notResampled === undefined), 'nothing reduced');
  assert.deepEqual(off.images.map((i) => i.intrinsic), [[4000, 3000], [2400, 1600], [2400, 1600]]);
  assert.ok(off.bytes > on.bytes * 3, `the file is ${off.bytes} bytes with the flag off and ${on.bytes} on`);
  console.log(`downsample.test: three placements, ${on.bytes} bytes with downsampleImages on, ${off.bytes} off; decode, resample, encode ms per placement: ${on.images.map((i) => `${i.decodeMs}/${i.resampleMs}/${i.encodeMs}`).join(', ')}`);
});

test('in the page: a threshold above the placement leaves the files alone, and the other filters reduce to the same sizes', async () => {
  const high = await printed({ downsampleThreshold: 6 });
  assert.ok(high.images.every((i) => i.resampled === undefined), 'at 6 the 762 ppi use is not above 1 800');
  for (const type of ['average', 'subsample']) {
    const seen = await printed({ downsampleType: type });
    assert.deepEqual(seen.images.map((i) => i.resampled?.type), [type, type, type]);
    assert.deepEqual(seen.images.map((i) => i.intrinsic), [[900, 675], [945, 630], [945, 630]]);
  }
});
