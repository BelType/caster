/**
 * The flag table (`src/options.js`) — every row of the guide's table exists with the guide's default, an unknown flag refuses by name, and D8's `colour: 'auto'` says yes exactly when the document has a colour story.
 *
 * `paintOrder` is the one default that is Caster's rather than the guide's, and it moved on 2026-09-08: `'dom'` emits a background after the words it sits behind, which paints them out. `options.js`'s own comment carries the measurement.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLAGS, DEFAULTS, resolveOptions, colourOn } from '../src/options.ts';
import { CasterError } from '../src/errors.ts';

test('every flag of the guide\'s table is present with the guide\'s default', () => {
  assert.deepEqual(DEFAULTS, {
    shaper: 'harfbuzz', subset: 'hb', cffContainer: 'bare', widthDecimals: 3,
    pngDecoder: 'fast-png', photoRule: true, rasterDpi: 300, paintOrder: 'css',
    styledBorders: false, blackText: 'none', convertRgb: 'none', skipInk: true,
    colour: 'auto', unknownElements: 'infer'
  });
});

test('an unknown flag, and a value outside a flag\'s set, refuse by name', () => {
  assert.throws(() => resolveOptions(({ nope: 1 } as any)), ( e: any) => e instanceof CasterError && /unknown option 'nope'/.test(e.message));
  assert.throws(() => resolveOptions({ shaper: ('graphite' as any) }), ( e: any) => e.flag === 'shaper' && /"harfbuzz" or "fontkit"/.test(e.message));
  assert.throws(() => resolveOptions({ rasterDpi: ('300' as any) }), ( e: any) => e.flag === 'rasterDpi');
});

test('the defaults survive an empty call, and a given flag rides through', () => {
  assert.equal(resolveOptions().shaper, 'harfbuzz');
  assert.equal(resolveOptions({ styledBorders: true }).styledBorders, true);
  assert.equal(resolveOptions({ title: 'A specimen' }).title, 'A specimen');
});

test('colour: auto is on for a colour hint, for a black-text policy, and for a conversion tier — off for a document with no colour story', () => {
  const auto = resolveOptions();
  assert.equal(colourOn({ colourHints: false }, auto), false);
  assert.equal(colourOn({ colourHints: true }, auto), true);
  assert.equal(colourOn({ colourHints: false }, resolveOptions({ blackText: '100k' })), true);
  assert.equal(colourOn({ colourHints: false }, resolveOptions({ convertRgb: 'wasm' })), true);
  assert.equal(colourOn({ colourHints: true }, resolveOptions({ colour: 'off' })), false);
  assert.equal(colourOn({ colourHints: false }, resolveOptions({ colour: 'on' })), true);
});

test('FLAGS names a positive number rather than a set for rasterDpi alone', () => {
  const free = Object.entries(FLAGS).filter(([, spec]) => spec.values === null).map(([name]) => name);
  assert.deepEqual(free, ['rasterDpi']);
});
