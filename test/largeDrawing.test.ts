/**
 * A page with a very large drawing is written: the operators of one path, and of one page, never reach the engine's argument limit.
 *
 * @remarks
 * A map of 408 paths and about 34 000 coordinate pairs overflowed the stack with a bare `RangeError` (codeberg.org/BelType/caster issue 2), because the writer handed a page's whole operator list to pdf-lib as call arguments. One path of 150 000 segments overflowed the same way, through the path's own spread. Both shapes are built here on a committed list and written in node.
 *
 * @packageDocumentation
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from '../src/capabilities.ts';
import { loadSubsetter } from '../src/fonts/hbSubset.ts';
import { emitStructure } from '../src/emit/structureEmit.ts';

import type { DisplayList } from '../src/displayList.ts';

const LISTS = path.join(path.dirname(fileURLToPath(new URL('../package.json', import.meta.url))), 'fixtures', 'lists');
const corpus: { name: string; list: { blobs: string[] } }[] = JSON.parse(fs.readFileSync(path.join(LISTS, 'corpus.json'), 'utf8')).documents;

/** The committed `cast` list, its blobs loaded. */
function cast(): DisplayList {
  const list = JSON.parse(fs.readFileSync(path.join(LISTS, 'cast.json'), 'utf8'));
  list.resources.blobs = Object.fromEntries(corpus.find((e) => e.name === 'cast')!.list.blobs.map((hash) => [hash, new Uint8Array(fs.readFileSync(path.join(LISTS, 'blobs', hash)))]));
  return list;
}

/** A zigzag of `segments` line segments from the point the shape starts at. */
function zigzag(from: [number, number], segments: number) {
  const out: unknown[] = [{ op: 'm', to: from }];
  for (let i = 1; i <= segments; i++) out.push({ op: 'l', to: [from[0] + (i % 2), from[1] + (i % 7) / 7] });
  return out;
}

/** The list with its first shape replaced by a group of `paths` zigzags of `segments` each, in the same item, so the structure tree's indices stand. */
function withDrawing(paths: number, segments: number): DisplayList {
  const list = cast();
  for (const page of list.pages as any[]) {
    const at = page.items.findIndex((item: any) => item.kind === 'shape');
    if (at < 0) continue;
    const { origin, owner, fill, rule, path: was } = page.items[at];
    const items = Array.from({ length: paths }, (_, i) => ({ kind: 'shape', origin: { domPath: origin.domPath, label: `zigzag-${i}` }, path: zigzag(was[0].to, segments), fill, rule }));
    page.items[at] = { kind: 'group', origin, bbox: [0, 0, 0, 0], owner, items };
    return list;
  }
  throw new Error('cast.json has no shape');
}

before(async () => {
  await load(['pdf', 'fontkit', 'hbSubset', 'fastPng']);
  await loadSubsetter();
});

test('one path of 150 000 segments is written', async () => {
  const { bytes } = await emitStructure(withDrawing(1, 150_000));
  assert.ok(bytes.length > 0);
});

test('a page of 300 paths of 600 segments each is written', async () => {
  const { bytes } = await emitStructure(withDrawing(300, 600));
  assert.ok(bytes.length > 0);
});
