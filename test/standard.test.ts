/**
 * *PDF/UA-2 is a flag, not a given* (DESIGN.md S103): a word gap in a face with no space glyph is refused by name under a list that claims PDF/UA-2, and under a list that claims nothing it is written as positioning with no glyph, in an XMP that claims nothing.
 *
 * @remarks
 * No committed list reaches the case since the cff2 fixture keeps a space glyph, so the list is made by hand: the photo list with every text item's `space` set to 0, as the builder writes it for a face with no space. It runs with this run's writer (`test/writer.ts`).
 *
 * @see /Users/egildo/Privata/dev/beltype/.claude/plans/the-rust-writer/plan-rust-writer.md (ruling 9 of 2026-11-03)
 * @packageDocumentation
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as mupdf from 'mupdf';
import { loadWriters, writeList } from './writer.ts';
import { CasterError } from '../src/errors.ts';

import type { DisplayList, TextItem } from '../src/displayList.ts';

const LISTS = path.join(path.dirname(fileURLToPath(new URL('../package.json', import.meta.url))), 'fixtures', 'lists');

/** The photo list with its blobs, every text item's space glyph 0 when `spaceless`, claiming `conformance`. */
function photo(conformance: DisplayList['info']['conformance'], spaceless: boolean): DisplayList {
  const list = JSON.parse(fs.readFileSync(path.join(LISTS, 'photo.json'), 'utf8'));
  const corpus = JSON.parse(fs.readFileSync(path.join(LISTS, 'corpus.json'), 'utf8')).documents;
  list.resources.blobs = Object.fromEntries(corpus.find((e: { name: string }) => e.name === 'photo').list.blobs.map((hash: string) => [hash, new Uint8Array(fs.readFileSync(path.join(LISTS, 'blobs', hash)))]));
  list.info.conformance = conformance;
  if (spaceless) {
    for (const item of list.pages.flatMap((page: DisplayList['pages'][number]) => page.items)) if (item.kind === 'text') item.space = 0;
    // The builder asks a width for every space glyph a text item names, glyph 0 among them.
    for (const font of list.resources.fonts) { font.widths.gids.unshift(0); font.widths.units.unshift(500); }
  }
  return list;
}

/** The glyphs every `TJ` of the file shows, and its XMP packet. */
function read(bytes: Uint8Array): { shown: number; xmp: string } {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf') as mupdf.PDFDocument;
  let shown = 0;
  for (let p = 0; p < doc.countPages(); p += 1) {
    const content = doc.findPage(p).get('Contents');
    const parts: mupdf.PDFObject[] = [];
    if (content.isArray()) content.forEach((part) => parts.push(part));
    else parts.push(content);
    const text = parts.map((part) => Buffer.from(part.readStream().asUint8Array()).toString('latin1')).join('\n');
    for (const [, array] of text.matchAll(/\[([^\]]*)\]\s*TJ/gu))
      for (const [, hex] of array.matchAll(/<([0-9A-Fa-f]*)>/gu)) shown += hex.length / 4;
  }
  const xmp = Buffer.from(doc.getTrailer().get('Root').get('Metadata').readStream().asUint8Array()).toString('utf8');
  return { shown, xmp };
}

/** The glyphs the list's text items show, and the gaps they owe. */
function counts(list: DisplayList): { glyphs: number; gaps: number } {
  const text = list.pages.flatMap((page) => page.items).filter((item): item is TextItem => item.kind === 'text');
  return { glyphs: text.reduce((n, item) => n + item.glyphs.ids.length, 0), gaps: text.reduce((n, item) => n + Number(item.leadingSpace) + item.segments.spaceBefore.filter((gap, i) => i > 0 && gap).length, 0) };
}

before(loadWriters);

test('a list claiming PDF/UA-2 whose face has no space glyph is refused by name, naming the face and the flag', async () => {
  await assert.rejects(writeList(photo('pdfua2', true)), (e: CasterError) => {
    assert.match(e.message, /^caster: the face .+ \(.+\) has no space glyph, so the word gap in text item \d+ of page 1 would be glyph 0, \.notdef, which PDF\/UA-2 forbids a file to show \(ISO 14289-2, 8\.4\.5\.9\); give the text a face with a space, or print with `standard: 'none'`/u);
    assert.equal(e.listItem?.page, 0);
    return true;
  });
});

test('a list claiming nothing writes the gap as positioning with no glyph, and its XMP claims nothing', async () => {
  const claimed = photo('pdfua2', false);
  const { glyphs, gaps } = counts(claimed);
  assert.ok(gaps > 0, 'the photo list owes word gaps');
  const spaced = read((await writeList(claimed)).bytes);
  assert.equal(spaced.shown, glyphs + gaps, 'with a space glyph, every gap is one glyph');
  assert.match(spaced.xmp, /pdfuaid:part/u);
  const none = read((await writeList(photo('tagged', true))).bytes);
  assert.equal(none.shown, glyphs, 'with no space glyph, no gap shows a glyph');
  assert.doesNotMatch(none.xmp, /pdfuaid|pdfd:declarations/u);
});
