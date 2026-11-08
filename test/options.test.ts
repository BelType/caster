/**
 * The flag table (`src/options.js`) — every row of the guide's table exists with the guide's default, an unknown flag refuses by name, and D8's `colour: 'auto'` says yes exactly when the document has a colour story.
 *
 * `paintOrder` is the one default that is Caster's rather than the guide's, and it moved on 2026-09-08: `'dom'` emits a background after the words it sits behind, which paints them out. `options.js`'s own comment carries the measurement.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLAGS, DEFAULTS, resolveOptions, colourOn, casterFlags, refuseUnbuiltTiers } from '../src/options.ts';
import { CasterError } from '../src/errors.ts';
import { readFileSync } from 'node:fs';

const CMYK = new Uint8Array(readFileSync(new URL('./assets/default_cmyk.icc', import.meta.url)));

test('every flag of the guide\'s table is present with the guide\'s default', () => {
  assert.deepEqual(DEFAULTS, {
    shaper: 'harfbuzz', subset: 'hb', cffContainer: 'bare', widthDecimals: 3,
    pngDecoder: 'fast-png', photoRule: true,
    downsampleImages: true, imageResolution: 300, downsampleThreshold: 1.5, downsampleType: 'bicubic',
    convertImages: 'none', rasterDpi: 300, paintOrder: 'css',
    styledBorders: true, blackText: 'none', convertRgb: 'none', skipInk: true,
    colour: 'auto', unknownElements: 'infer', standard: 'ua-2', writer: 'pdf-lib'
  });
});

test('an unknown flag, and a value outside a flag\'s set, refuse by name', () => {
  assert.throws(() => resolveOptions(({ nope: 1 } as any)), ( e: any) => e instanceof CasterError && /unknown option 'nope'/.test(e.message));
  assert.throws(() => resolveOptions({ shaper: ('graphite' as any) }), ( e: any) => e.flag === 'shaper' && /"harfbuzz" or "fontkit"/.test(e.message));
  assert.throws(() => resolveOptions({ rasterDpi: ('300' as any) }), ( e: any) => e.flag === 'rasterDpi');
});

test('the defaults survive an empty call, and a given flag rides through', () => {
  assert.equal(resolveOptions().shaper, 'harfbuzz');
  assert.equal(resolveOptions({ styledBorders: false }).styledBorders, false);
  assert.equal(resolveOptions({ title: 'A specimen' }).title, 'A specimen');
});

test('colour: auto is on for a colour hint, for a black-text policy, and for a conversion tier — off for a document with no colour story', () => {
  const auto = resolveOptions();
  assert.equal(colourOn({ colourHints: false }, auto), false);
  assert.equal(colourOn({ colourHints: true }, auto), true);
  assert.equal(colourOn({ colourHints: false }, resolveOptions({ blackText: '100k' })), true);
  assert.equal(colourOn({ colourHints: false }, resolveOptions({ convertRgb: 'wasm', profile: CMYK })), true);
  assert.equal(colourOn({ colourHints: true }, resolveOptions({ colour: 'off' })), false);
  assert.equal(colourOn({ colourHints: false }, resolveOptions({ colour: 'on' })), true);
});

test('FLAGS names a positive number rather than a set for rasterDpi, imageResolution and downsampleThreshold alone', () => {
  const free = Object.entries(FLAGS).filter(([, spec]) => spec.values === null).map(([name]) => name);
  assert.deepEqual(free, ['imageResolution', 'downsampleThreshold', 'rasterDpi']);
});

test('casterFlags is the table in common\'s shape: the same rows, the same defaults, and parse reads a command-line string', () => {
  assert.equal(casterFlags.owner, 'caster');
  assert.equal(casterFlags.table, FLAGS);
  assert.deepEqual(casterFlags.defaults, DEFAULTS);
  assert.equal(casterFlags.parse('shaper', 'fontkit'), 'fontkit');
  assert.equal(casterFlags.parse('photoRule', 'false'), false);
  assert.equal(casterFlags.parse('rasterDpi', '150'), 150);
});

test('a tier this port does not build refuses by its own flag, and the defaults pass', () => {
  assert.doesNotThrow(() => refuseUnbuiltTiers(DEFAULTS));
  for (const [flag, value] of [['shaper', 'fontkit'], ['subset', 'pdf-lib'], ['convertRgb', 'endpoint'], ['pngDecoder', 'canvas']] as const) {
    assert.throws(() => refuseUnbuiltTiers(resolveOptions({ [flag]: value })), (e: any) => e instanceof CasterError && e.flag === flag, `${flag}: ${value}`);
  }
});

test("`convertRgb: 'wasm'` is built and no longer refused; `'endpoint'` is the one value still refused, by its own sentence", () => {
  assert.doesNotThrow(() => refuseUnbuiltTiers(resolveOptions({ convertRgb: 'wasm', profile: CMYK })));
  assert.throws(() => refuseUnbuiltTiers(resolveOptions({ convertRgb: 'endpoint' })), (e: any) => e.flag === 'convertRgb' && /needs a gateway with a `convertColors` method/u.test(e.message));
});

test('the writer flag takes the oracle or forme, and refuses anything else by name', () => {
  assert.equal(resolveOptions({ writer: 'forme' }).writer, 'forme');
  assert.throws(() => resolveOptions({ writer: 'pdfkit' as never }), (e: any) => e instanceof CasterError && e.flag === 'writer');
});
