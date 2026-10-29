/**
 * THE PIN BETWEEN CASTER'S ENGINE WORDS AND THE REGISTRY (*the piece words*, 2026-10-11; DESIGN.md S72; *one grammar in common*, 2026-10-11).
 *
 * The Cicero adapter reads the grammar from `common/src/data-beltype.js` (pinned against the engine's registry by the root `test/data-beltype.test.js`) but names the engine's WORDS itself, because Caster declares no dependency on `engine-cicero` and its modules run in a print frame that cannot be assumed to resolve it. This file is what makes the named set of the engine's own marks, and what the helpers built on the words say, true.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE_MARKS as REGISTRY_MARKS, ARTIFACT as REGISTRY_ARTIFACT } from '@beltype/cicero/internal/data-beltype';
import { ARTIFACT_WORD, ENGINE_MARKS, isEngineMark, isContinuation, isFirstFragment, isFixedClone, isFragment } from '../src/adapters/cicero.ts';

const el = (value: string|null) => {
  const attrs: Map<string,string> = new Map(value === null ? [] : [['data-beltype', value]]);
  return { attrs, getAttribute: ( k: string) => attrs.get(k) ?? null, setAttribute: ( k: string,  v: string) => attrs.set(k, v), removeAttribute: ( k: string) => attrs.delete(k) };
};
const asElement = ( e: ReturnType<typeof el>) => ((e as unknown) as Element);

test('the named set of the engine\'s own marks is the registry\'s', () => {
  assert.deepEqual([...ENGINE_MARKS].sort(), [...REGISTRY_MARKS].sort());
  for (const word of REGISTRY_MARKS) assert.equal(isEngineMark(asElement(el(`pos:3 ${word}`))), true, word);
  for (const word of ['fragment', 'start', 'end', 'away', 'wrapped', 'adjoin', 'pos:3']) assert.equal(isEngineMark(asElement(el(word))), false, word);
});

test('a continuation is split without start, a first fragment is split with it, and neither is a composed block\'s clone', () => {
  assert.equal(isContinuation(asElement(el('fragment split end'))), true);
  assert.equal(isContinuation(asElement(el('fragment split'))), true, 'a middle piece');
  assert.equal(isContinuation(asElement(el('fragment split start'))), false);
  assert.equal(isFirstFragment(asElement(el('fragment split start'))), true);
  assert.equal(isFirstFragment(asElement(el('fragment split end'))), false);
  assert.equal(isContinuation(asElement(el('fragment'))), false, 'a composed clone is neither');
  assert.equal(isFirstFragment(asElement(el('fragment'))), false);
  assert.equal(isFixedClone(asElement(el('fragment fixed'))), true);
  assert.equal(isFragment(asElement(el('pos:3 fragment'))), true);
  assert.equal(isFragment(asElement(el('pos:3'))), false);
});

test('the artifact word is the engine\'s, and it is furniture rather than one of the engine\'s marks', () => {
  assert.equal(ARTIFACT_WORD, REGISTRY_ARTIFACT);
  assert.equal(isEngineMark(asElement(el(`fragment ${ARTIFACT_WORD}`))), false);
  assert.equal(isFragment(asElement(el(`fragment fixed ${ARTIFACT_WORD}`))), true, 'a fixed copy after the first is a clone too');
});
