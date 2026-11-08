/**
 * A two-column `<dl>` taller than the page, which Cicero does not divide and paints as a slice on each page (the showcase's list), printed by Caster and read back with mupdf.
 *
 * @remarks
 * Every page of the slice holds the whole box's words under the wrapper's own clip, so the pairing counts them once and the print keeps each line on the page that holds its top (DESIGN.md S69, *the slice wrapper's clip*). Held here by reading the file, because the cast acceptance's oracle, Cicero's own account of the words, is empty for a painted slice's pages and cannot judge it.
 *
 * @packageDocumentation
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mupdf from 'mupdf';
import { castDocument } from './cast-checks.ts';

test('a two-column <dl> of 90 entries painted as a slice on each page prints, each term and definition on exactly one page', { timeout: 300000 }, async () => {
  const cast = await castDocument({ name: 'cast-column-slice/index.html' });
  assert.ok(cast.pages > 2, `${cast.pages} pages`);
  const doc = mupdf.Document.openDocument(new Uint8Array(cast.bytes), 'application/pdf');
  const text = Array.from({ length: doc.countPages() }, (_, i) => doc.loadPage(i).toStructuredText('preserve-whitespace').asText().replace(/\s+/g, ' '));
  const count = (re: RegExp) => text.reduce((n, t) => n + (t.match(re)?.length ?? 0), 0);
  for (let n = 1; n <= 90; n++) {
    assert.equal(count(new RegExp(`\\bTerm ${n}\\b`, 'g')), 1, `Term ${n} is printed once`);
    assert.equal(count(new RegExp(`\\bDefinition number ${n} of\\b`, 'g')), 1, `Definition ${n} is printed once`);
  }
});
