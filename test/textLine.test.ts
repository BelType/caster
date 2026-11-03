/**
 * A line's text object holds text and nothing else: an item that paints anything but text closes the open line, the next run opens a new one, and a page end closes it too.
 *
 * @remarks
 * No committed list reaches either case, because the builder ends a tag before every non-text item and sets every run inside a tag; the list here is made by hand from the photo list, with an image and a rectangle between two runs of the heading's first line and an untagged run at the page's end. Only text-object operators may sit inside `BT … ET` (ISO 32000-2, 9.4 and figure 9), so the scan admits the general graphics state, colour, text state, positioning, showing and marked content there, and nothing else. It runs with this run's writer (`test/writer.ts`).
 *
 * @see /Users/egildo/Privata/dev/beltype/.claude/plans/the-rust-writer/plan-rust-writer.md (ruling 8 of 2026-11-03)
 * @packageDocumentation
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as mupdf from 'mupdf';
import { loadWriters, writeList } from './writer.ts';

import type { DisplayList } from '../src/displayList.ts';

const LISTS = path.join(path.dirname(fileURLToPath(new URL('../package.json', import.meta.url))), 'fixtures', 'lists');

/** The photo list with an image and a rectangle between two runs of line 0, and a run after the page's last tag end. */
export function interrupted(): DisplayList {
  const list = JSON.parse(fs.readFileSync(path.join(LISTS, 'photo.json'), 'utf8'));
  const corpus = JSON.parse(fs.readFileSync(path.join(LISTS, 'corpus.json'), 'utf8')).documents;
  list.resources.blobs = Object.fromEntries(corpus.find((e: { name: string }) => e.name === 'photo').list.blobs.map((hash: string) => [hash, new Uint8Array(fs.readFileSync(path.join(LISTS, 'blobs', hash)))]));
  const items = list.pages[0].items;
  const [run, image, last] = [items[1], items[6], items[10]];
  items.splice(2, 0,
    { ...image, transform: [20, 0, 0, 20, 300, 265] },
    { kind: 'shape', owner: run.owner, rect: [34, 262, 120, 1.5], fill: { rgb: [0.8, 0, 0.2] } },
    structuredClone(run));
  for (const element of list.structure.elements)
    for (const child of element.children)
      if (typeof child === 'object' && child.item >= 2) child.item += 3;
  items.push({ ...structuredClone(last), lineIndex: last.lineIndex + 1, baseline: last.baseline - 16.5 });
  return list;
}

/** Text-object operators, the only ones a `BT … ET` may hold. */
const IN_TEXT = new Set(['w', 'J', 'j', 'M', 'd', 'ri', 'i', 'gs', 'CS', 'cs', 'SC', 'SCN', 'sc', 'scn', 'G', 'g', 'RG', 'rg', 'K', 'k', 'Tc', 'Tw', 'Tz', 'TL', 'Tf', 'Tr', 'Ts', 'Td', 'TD', 'Tm', 'T*', 'Tj', 'TJ', "'", '"', 'BDC', 'BMC', 'EMC', 'MP', 'DP']);

/** Each page's operators, in order. */
export function operatorsOf(bytes: Uint8Array): string[][] {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf') as mupdf.PDFDocument;
  const pages: string[][] = [];
  for (let p = 0; p < doc.countPages(); p += 1) {
    const content = doc.findPage(p).get('Contents');
    const parts: mupdf.PDFObject[] = [];
    if (content.isArray()) content.forEach((part) => parts.push(part));
    else parts.push(content);
    const text = parts.map((part) => Buffer.from(part.readStream().asUint8Array()).toString('latin1')).join('\n');
    const tokens = text.match(/<<|>>|<[0-9A-Fa-f\s]*>|\((?:\\.|[^\\)])*\)|\/[^\s/[\]<>(){}%]*|[[\]]|[^\s/[\]<>(){}%]+/gu) ?? [];
    pages.push(tokens.filter((t) => /^[A-Za-z'"][A-Za-z*'"0-9]*$/u.test(t)));
  }
  return pages;
}

/** Every operator outside text-object operators found between a `BT` and its `ET`, and every page that ends inside one. */
export function nesting(pages: string[][]): string[] {
  const faults: string[] = [];
  for (const [p, ops] of pages.entries()) {
    let inText = false;
    for (const [at, op] of ops.entries()) {
      if (op === 'BT') { if (inText) faults.push(`page ${p + 1}, operator ${at}: BT inside BT`); inText = true; }
      else if (op === 'ET') { if (!inText) faults.push(`page ${p + 1}, operator ${at}: ET outside BT`); inText = false; }
      else if (inText && !IN_TEXT.has(op)) faults.push(`page ${p + 1}, operator ${at}: ${op} inside BT … ET`);
    }
    if (inText) faults.push(`page ${p + 1} ends inside BT … ET`);
  }
  return faults;
}

before(loadWriters);

test('an image and a rectangle between two runs of one line close it, the next run reopens it, and a page end closes it', async () => {
  const { bytes, records } = await writeList(interrupted());
  const pages = operatorsOf(bytes);
  assert.deepEqual(nesting(pages), []);
  // Line 0's two text objects, the image and the rectangle between them, and the untagged line at the end.
  assert.equal(pages[0].filter((op) => op === 'BT').length, 7);
  assert.deepEqual(pages[0].slice(pages[0].indexOf('ET'), pages[0].indexOf('BT', pages[0].indexOf('ET')) + 1), ['ET', 'q', 'cm', 'Do', 'Q', 'q', 'rg', 're', 'f', 'Q', 'BT']);
  assert.equal(pages[0].at(-1), 'ET');
  assert.equal(records.pens.length, 7);
});
