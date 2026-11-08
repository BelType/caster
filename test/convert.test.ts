/**
 * The lcms tier for text fills (brief 3 of the image round): the transform, the work list read off the measured runs, and the recorded `convert-text` document read back.
 *
 * The transform runs here in node over the package's own lcms-wasm and Caster's two profiles, and is held to Little-CMS 2.19's `transicc` (`-t1 -b`, the same intent and black-point compensation), whose answers are the constants below. The recorded document is the identity corpus's: its file and report snapshot, read back, say every text fill is a `k` and the report's conversion entries are the colours the page used.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFRawStream, PDFArray, PDFRef } from 'pdf-lib';

import { LCMS_WASM_VERSION, convertibleRuns, lcmsTransform, textWorklist, wasmConversion } from '../src/colour/rgbToCmyk.ts';
import type { MeasuredRun } from '../src/measure/textMeasure.ts';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const LISTS = path.join(PACKAGE, 'fixtures', 'lists');
const profile = (name: string) => new Uint8Array(fs.readFileSync(path.join(PACKAGE, name === 'default_cmyk.icc' ? 'test/assets' : 'profiles', name)));

async function transform() {
  // By a variable, because the bundle carries no declarations (types/vendor.d.ts).
  const name = 'lcms-wasm';
  const module = await import(name);
  const wasm = new Uint8Array(fs.readFileSync(path.join(PACKAGE, 'node_modules', 'lcms-wasm', 'dist', 'lcms.wasm')));
  return lcmsTransform({ module, wasm }, profile('srgb.icc'), profile('default_cmyk.icc'));
}

test('the transform answers what Little-CMS 2.19 answers for the same intent and black-point compensation, to the four decimals a stream writes', async () => {
  const t = await transform();
  // transicc -i srgb.icc -o default_cmyk.icc -t1 -b, in percent, rounded here to four decimals of a fraction.
  const expected = new Map([
    ['20,90,200', [0.8699, 0.6877, 0, 0]],
    ['0,0,0', [0.7231, 0.6769, 0.6710, 0.8860]],
    ['200,32,32', [0.1423, 1, 1, 0.0450]],
  ]);
  const answers = t.convert([...expected.keys()].map((k) => k.split(',').map(Number) as [number, number, number]));
  [...expected.values()].forEach((want, i) => answers[i].forEach((got, c) => assert.ok(Math.abs(got - want[c]) <= 1e-4, `colour ${i} channel ${c}: ${got} against ${want[c]}`)));
  assert.equal(t.packageName, 'lcms-wasm');
  assert.equal(t.wasmBytes, 315_910);
});

test('the version the report names is the version the vendored bundle declares', () => {
  const head = fs.readFileSync(path.join(PACKAGE, 'vendor', 'lcms.js'), 'utf8').split('\n', 1)[0];
  assert.ok(head.includes(`lcms-wasm ${LCMS_WASM_VERSION} `), head);
});

const run = (rgb: [number, number, number], extra: Partial<MeasuredRun> = {}) => ({ rgb, color: `rgb(${rgb.map((c) => Math.round(c * 255)).join(', ')})`, segments: [{ blockPath: 'Document/P[0]' }], ...extra }) as unknown as MeasuredRun;

test('the work list holds the runs with no declared ink, once per colour, and the black-text policy keeps black out of it', () => {
  const blue = run([0, 0, 1]);
  const lines = [{ runs: [run([0, 0, 0]), blue, run([0, 0, 1]), run([1, 0, 0], { colorHint: { kind: 'cmyk', values: [0, 1, 1, 0] } })] }, { runs: [blue] }];
  const all = convertibleRuns(lines, 'none');
  assert.equal(all.length, 3, 'a run on two lines is one run');
  const list = textWorklist(all);
  assert.deepEqual(list.map((e) => [e.css, e.uses]), [['rgb(0, 0, 0)', 1], ['rgb(0, 0, 255)', 2]]);
  assert.deepEqual(textWorklist(convertibleRuns(lines, '100k')).map((e) => e.css), ['rgb(0, 0, 255)']);
});

test('the table answers each colour of the list, and its record names the wasm', async () => {
  const t = await transform();
  const list = textWorklist([run([0.0784, 0.3529, 0.7843])]);
  const table = wasmConversion(list, t);
  assert.deepEqual(table.cmykOf([0.0784, 0.3529, 0.7843]), [0.8699, 0.6877, 0, 0]);
  assert.equal(table.wasm?.version, LCMS_WASM_VERSION);
  assert.ok((table.wasm?.loadMs ?? -1) >= 0 && (table.wasm?.transformMs ?? -1) >= 0);
});

test('the recorded convert-text document writes every converted text fill as k, and its report names the colours the page used', async () => {
  const pdf = await PDFDocument.load(fs.readFileSync(path.join(LISTS, 'convert-text.pdf')));
  const page = pdf.getPage(0);
  const contents = page.node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  const stream = refs.map((ref) => {
    const raw = (ref instanceof PDFRef ? pdf.context.lookup(ref) : ref) as PDFRawStream;
    return zlib.inflateSync(Buffer.from(raw.contents)).toString('latin1');
  }).join('\n');
  const texts = [...stream.matchAll(/BT[\s\S]*?ET/gu)].map((m) => m[0]);
  assert.ok(texts.length > 0);
  for (const text of texts) {
    assert.match(text, / k\n/u, 'a text object sets a CMYK fill');
    assert.doesNotMatch(text, / rg\n/u, 'and no RGB one');
  }
  const report = JSON.parse(fs.readFileSync(path.join(LISTS, 'convert-text.report.json'), 'utf8'));
  const conversion = report.color.conversion;
  assert.equal(conversion.mode, 'wasm');
  assert.equal(conversion.intent, 'relative colorimetric');
  assert.deepEqual(conversion.entries.map((e: any) => e.css).sort(), ['rgb(0, 0, 0)', 'rgb(119, 119, 119)', 'rgb(20, 90, 200)', 'rgb(200, 32, 32)', 'rgb(31, 78, 156)', 'rgb(42, 127, 59)']);
  assert.equal(report.color.convertRgb, 'wasm');
  const rows = report.color.elements.filter((e: any) => e.target === 'fill');
  assert.equal(report.color.convertedElements, rows.filter((e: any) => e.converted).length);
  assert.ok(rows.some((e: any) => !e.converted && e.hint), 'the run with a declared ink is written as declared and is not counted');
});
