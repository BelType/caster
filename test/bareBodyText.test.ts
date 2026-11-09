/**
 * Text standing directly in `<body>`, with no element around it, is words the screen shows and no page holds, and the print refuses them by name.
 *
 * @remarks
 * Cicero's intake takes the body's element children (`topLevelBoxes`, `driver.ts`), so a bare text node is never adopted into `<beltype-root>`, never cut and never presented: it stays in the body, laid out above the pages, and the one page Cicero presents is empty. The census of the conservation of words (DESIGN.md S61) walks the strip, which is the root, so it never met the text, and the print was a PDF of one empty page and a summary of 0 words. Measured 2026-11-09 on `fixtures/cast-bare-body-text/` before the fix: one page, no text, no warning.
 *
 * @packageDocumentation
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as mupdf from 'mupdf';
import path from 'node:path';
import { castDocument, FIXTURES } from './cast-checks.ts';

const NAME = 'cast-bare-body-text/index.html';

test('text standing directly in the body refuses the print, naming the words no page holds', { timeout: 300000 }, async () => {
  await assert.rejects(castDocument({ name: NAME }), /the print refused: caster: 11 words in 1 text node stand directly in <body>.*"Hello there, standing in the body with no elemen…"/su);
});

test('the control: the same words in a paragraph print', { timeout: 300000 }, async () => {
  const html = fs.readFileSync(path.join(FIXTURES, NAME), 'utf8').replace(/<body>([^<]*)<\/body>/u, '<body><p>$1</p></body>');
  const cast = await castDocument({ name: NAME, html });
  const doc = mupdf.Document.openDocument(new Uint8Array(cast.bytes), 'application/pdf');
  assert.equal(doc.countPages(), 1);
  assert.match(doc.loadPage(0).toStructuredText('preserve-whitespace').asText().replace(/\s+/gu, ' '), /Hello there, standing in the body with no element around it\./u);
});
