/** The capability registry (§4) — which capabilities a run needs, and the refusal that is never a fallback. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES, neededCapabilities, capability, clearCapabilities } from '../src/capabilities.ts';
import { resolveOptions } from '../src/options.ts';
import type { ReportNeeds } from '../src/report.ts';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

const NOTHING: ReportNeeds = { forcedPngDecode: false, colourHints: false, hasTables: false, hasSvg: false, hasEmoji: false };

test('a plain document loads the two always-on capabilities and the shaper tier', () => {
  assert.deepEqual(neededCapabilities(NOTHING, resolveOptions()), ['pdf', 'fontkit', 'harfbuzz', 'hbSubset']);
});

test('fast-png loads only where a decode is forced, and the profiles only where colour is on', () => {
  const options = resolveOptions();
  assert.ok(!neededCapabilities(NOTHING, options).includes('fastPng'));
  assert.ok(neededCapabilities({ ...NOTHING, forcedPngDecode: true }, options).includes('fastPng'));
  assert.ok(!neededCapabilities(NOTHING, options).includes('profiles'));
  assert.ok(neededCapabilities({ ...NOTHING, colourHints: true }, options).includes('profiles'));
  assert.ok(!neededCapabilities(NOTHING, resolveOptions({ shaper: 'fontkit', subset: 'pdf-lib' })).includes('harfbuzz'));
  assert.ok(neededCapabilities(NOTHING, resolveOptions({ convertRgb: 'wasm' })).includes('lcms'));
});

test('an unloaded capability refuses naming itself and the flag that would have loaded it — never a fallback', () => {
  clearCapabilities();
  assert.throws(() => capability('harfbuzz'), ( e: any) => e.name === 'CapabilityError' && e.capability === 'harfbuzz' && e.flag === 'shaper' && /no fallback/.test(e.message));
});

test('localFonts is a visible door with nothing behind it (D2)', () => {
  assert.ok(CAPABILITIES.localFonts.reserved);
  assert.ok(!neededCapabilities(NOTHING, resolveOptions()).includes('localFonts'));
});

test('every url, wasm and file a capability names exists in the committed vendor tree', () => {
  for (const [name, spec] of Object.entries(CAPABILITIES)) {
    if (spec.reserved) continue;
    for (const rel of [spec.url, spec.wasm, ...(spec.files ?? [])]) {
      if (!rel) continue;
      const file = path.join(PACKAGE, 'src', rel);
      assert.ok(fs.existsSync(file), `${name} names ${rel}, which is not in the tree`);
    }
  }
});
