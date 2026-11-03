/**
 * The same list prints the same bytes: written twice, and written with every order that is not data changed, each committed list gives one file; and each order that is data changes it.
 *
 * @remarks
 * Order is data in the list's arrays and in none of its objects. What the test reorders and expects the same: the blob pool (`resources.blobs`, keyed by hash), and the keys of every object in the list, at every depth. What it reorders and expects to differ, each list still valid: `resources.fonts` (the order of `F0`, `F1`, …), `structure.elements` (the order the writer allocates the elements' objects in), an element's `children` (its `/K`), a page's `items` (the painting order). That the bytes do not depend on the realm is the replay's, which writes in node the file the page wrote (`test/displayList.test.ts`, `npm run identity -- replay`).
 *
 * @see /Users/egildo/Privata/dev/beltype/.claude/plans/the-rust-writer/plan-close-the-list.md (stage 5)
 * @packageDocumentation
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WRITER, loadWriters, writeList } from './writer.ts';
import { validateList } from '../src/displayList/validate.ts';

import type { DisplayList, StructChild } from '../src/displayList.ts';

const LISTS = path.join(path.dirname(fileURLToPath(new URL('../package.json', import.meta.url))), 'fixtures', 'lists');
/** The lists the oracle printed; a list recorded with the oracle's refusal has no file to be deterministic about. */
const corpus: { name: string; list: { blobs: string[] }; refused?: string }[] = JSON.parse(fs.readFileSync(path.join(LISTS, 'corpus.json'), 'utf8')).documents.filter((e: { refused?: string }) => e.refused === undefined);

/** A committed list with its blobs, in the pool's order or reversed. */
function listOf(name: string, reverseBlobs = false): DisplayList {
  const list = JSON.parse(fs.readFileSync(path.join(LISTS, `${name}.json`), 'utf8'));
  const hashes = corpus.find((e) => e.name === name)!.list.blobs;
  list.resources.blobs = Object.fromEntries((reverseBlobs ? [...hashes].reverse() : hashes).map((hash) => [hash, new Uint8Array(fs.readFileSync(path.join(LISTS, 'blobs', hash)))]));
  return list;
}

/** The value with the keys of every object at every depth in reverse order, arrays and bytes as they are. */
function keysReversed(value: unknown): any {
  if (Array.isArray(value)) return value.map(keysReversed);
  if (value instanceof Uint8Array || value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, keysReversed((value as Record<string, unknown>)[key])]));
}

const written = async (list: DisplayList) => Buffer.from((await writeList(list)).bytes);

before(async () => {
  await loadWriters();
});

test('each committed list written twice gives the same bytes, and, by the oracle, the committed file', async () => {
  for (const { name } of corpus) {
    const first = await written(listOf(name));
    assert.ok(first.equals(await written(listOf(name))), `${name}: the second write is the first`);
    // The committed file is the oracle's; forme is held to it by the readers (`npm run identity -- compare`), not by its bytes.
    if (WRITER === 'pdf-lib') assert.ok(first.equals(fs.readFileSync(path.join(LISTS, `${name}.pdf`))), `${name}: and the committed file`);
  }
});

test('the pool\'s order and every object\'s key order are not data: reversed, each list gives the same bytes', async () => {
  for (const { name } of corpus) {
    const was = await written(listOf(name));
    assert.ok(was.equals(await written(listOf(name, true))), `${name}: the blob pool in reverse`);
    const reordered = keysReversed(listOf(name, true));
    assert.deepEqual(Object.keys(reordered), Object.keys(listOf(name)).reverse(), `${name}: the keys did move`);
    assert.ok(was.equals(await written(reordered)), `${name}: every object's keys in reverse, the attribute objects' among them`);
  }
});

/** The list with elements `a` and `b` swapped in the array, every index that names either changed with them. */
function elementsSwapped(list: DisplayList, a: number, b: number): DisplayList {
  const to = (index: number) => (index === a ? b : index === b ? a : index);
  const elements = [...list.structure.elements];
  [elements[a], elements[b]] = [elements[b], elements[a]];
  list.structure.elements = elements.map((element) => ({ ...element, children: element.children.map((child: StructChild) => (typeof child === 'number' ? to(child) : child)) }));
  for (const page of list.pages) for (const item of page.items) {
    if (item.kind === 'tag' && 'start' in item && 'element' in item.start) item.start.element = to(item.start.element);
    if (item.kind === 'link') { item.element = to(item.element); if (item.target.dest) item.target.dest.element = to(item.target.dest.element); }
  }
  for (const heading of list.outline) heading.element = to(heading.element);
  return list;
}

test('the order of the arrays is data: the fonts, the elements, an element\'s children and a page\'s items, each reordered, give a valid list and another file', async () => {
  const was = await written(listOf('paper'));
  const differs = async (what: string, change: (list: DisplayList) => void) => {
    const list = listOf('paper');
    change(list);
    validateList(list);
    assert.ok(!was.equals(await written(list)), `${what} reordered changes the file`);
  };
  await differs('resources.fonts', (list) => list.resources.fonts.reverse());
  await differs('structure.elements', (list) => elementsSwapped(list, 1, 2));
  await differs('an element\'s children', (list) => { list.structure.elements.find((e) => e.children.length > 1)!.children.reverse(); });
  await differs('a page\'s items', (list) => {
    const items = list.pages[0].items;
    const at = items.findIndex((item, i) => item.kind === 'text' && items[i + 1]?.kind === 'text');
    [items[at], items[at + 1]] = [items[at + 1], items[at]];
  });
});
