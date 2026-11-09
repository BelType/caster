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

/** One line the wrapper's top divides, page-local in CSS px: `[left, top, width, height]`, on `page` (from 0) whose wrapper starts at `shellTop`. */
type Divided = { page: number; shellTop: number; lines: [number, number, number, number][] };

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

test('a line the slice wrapper\'s top divides draws its lower part on the later page, clipped at the wrapper\'s top, and nothing above it', { timeout: 300000, todo: 'stopped: drawing the line on both pages is refused by the tiling invariant (S71); the second copy must be marked a repeat or an artifact, a ruling the row does not carry' }, async () => {
  const cast = await castDocument({ name: 'cast-column-slice/index.html', inspect: { cut: (page) => page.evaluate(async () => {
    const caster: any = await import('/_beltype/caster/src/index.js' as string);
    const strip = caster.adaptStrip(document);
    const out: Divided[] = [];
    for (const shell of document.querySelectorAll('[data-beltype~="shell"]')) {
      const pageBox = strip.pageElementOf(shell).getBoundingClientRect();
      const top = shell.getBoundingClientRect().top;
      const range = document.createRange();
      range.selectNodeContents(shell);
      const lines = [...range.getClientRects()].filter((r) => r.width > 0 && r.height < 40 && r.top < top && r.bottom > top + 1).map((r) => [r.left - pageBox.left, r.top - pageBox.top, r.width, r.height] as [number, number, number, number]);
      if (lines.length) out.push({ page: strip.pageElements.indexOf(strip.pageElementOf(shell)), shellTop: top - pageBox.top, lines });
    }
    return out;
  }) } });
  const divided = cast.inspected.cut as Divided[];
  assert.ok(divided.length >= 3, `${divided.length} pages whose wrapper top divides a line`);
  const doc = mupdf.Document.openDocument(new Uint8Array(cast.bytes), 'application/pdf');
  for (const { page, shellTop, lines } of divided) {
    const pixmap = doc.loadPage(page).toPixmap(mupdf.Matrix.scale(96 / 72, 96 / 72), mupdf.ColorSpace.DeviceGray, false);
    const width = pixmap.getWidth();
    const samples = pixmap.getPixels();
    const dark = (x0: number, x1: number, y0: number, y1: number) => { let n = 0; for (let y = Math.ceil(y0); y < Math.floor(y1); y++) for (let x = Math.floor(x0); x < Math.ceil(x1); x++) if (samples[y * width + x]! < 128) n++; return n; };
    for (const [left, top, w, h] of lines) {
      assert.ok(dark(left, left + w, shellTop + 1, top + h - 1) > 0, `page ${page + 1}: the lower part of the line at ${Math.round(left)},${Math.round(top)} is drawn below the wrapper's top`);
      assert.equal(dark(left, left + w, top, shellTop - 1), 0, `page ${page + 1}: nothing of the line is drawn above the wrapper's top`);
    }
  }
});
