/**
 * The preview is not prepared, and cuts where the print cuts (*preparation runs in no author preview*, DESIGN.md S81).
 *
 * @remarks
 * `prepare()` runs in no author preview, only in the print's own page, and that commits Caster to a second rule: preparation must not change layout. A reified span occupies the box its pseudo-element did, a made-real marker the marker's. This suite is the check the rule relies on. For every document it lets Cicero cut the page twice, once as an author preview has it, with nothing prepared, and once prepared, as the print has it, and asserts the cuts are equal: the file's page count against the unprepared one, Cicero's own account of every page's words (the text the preparation made real left out, since it is the one thing the two may differ in), and, because a cut sees a line added or lost and never a word moved along its line, the place each list item's first word begins on its page.
 *
 * Ported from the monorepo's `packages/caster/test/preview-unprepared.test.js` (BelType `aea2b2a1`), which compared the editing tools' pane with their print frame, under Paged.js and Cicero, and under Cicero compared only the page count. Here both cuts are Cicero's, through Caster's own entry points ({@link castDocument}), and the words and the list items are compared under Cicero too. The documents are the self-contained fixtures; the monorepo's others load BelType's vendored faces or need its belt.
 *
 * A document whose cuts differ is a fidelity bug in Caster and is not hidden here: it is listed in {@link KNOWN} (or {@link KNOWN_ALONG_THE_LINE}) with the reason and run as `todo`, so it reports every time and fails the day it is fixed without the entry being deleted.
 *
 * @packageDocumentation
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mupdf from 'mupdf';
import { castDocument, cutCheck, geometryInPage, ledgerInPage, listItemsInPage, movedItems } from './cast-checks.ts';

const DOCUMENTS = ['cast/index.html', 'cast-clipped/index.html', 'cast-divided-row/index.html', 'cast-inline-formula/index.html', 'cast-sequence-diagram/index.html', 'cast-wrapped-label/index.html'];

/** Documents whose cuts are known to differ prepared and unprepared, by name, with the reason. */
const KNOWN: Record<string, string> = {};

/** Documents whose list items' text is known to move along the line when prepared, by name, with the reason. */
const KNOWN_ALONG_THE_LINE: Record<string, string> = {};

/** In the page: how many elements the preparation made, and how many of its reified texts are not visible. */
const preparedInPage = () => ({
  prepared: document.querySelectorAll('span.marker, .caster-generated, span.task-state').length,
  hidden: Array.from(document.querySelectorAll('.caster-generated')).filter((span) => getComputedStyle(span).visibility !== 'visible').length,
});

for (const name of DOCUMENTS) {
  test(`${name} is cut where the print cuts it`, { timeout: 300000 }, async (t) => {
    const cast = await castDocument({
      name,
      inspect: {
        loaded: async (page) => {
          await page.evaluate(async () => { await (window as any).__beltypeCicero.run(); await document.fonts.ready; });
          // The geometry first, as after the print's cut: it settles the presentation and records what the page box cuts of a word, which the ledger reads.
          await page.evaluate(geometryInPage, []);
          const read = { ledger: await page.evaluate(ledgerInPage, []), items: await page.evaluate(listItemsInPage), ...(await page.evaluate(preparedInPage)) };
          await page.reload({ waitUntil: 'load' });
          return read;
        },
        cut: async (page) => {
          await page.evaluate(geometryInPage, []);
          return { ledger: await page.evaluate(ledgerInPage, []), items: await page.evaluate(listItemsInPage), ...(await page.evaluate(preparedInPage)) };
        },
      },
    });
    const { loaded: preview, cut: printed } = cast.inspected;
    assert.ok(preview.ledger.pages.length > 0, 'the preview presented pages');
    assert.equal(preview.prepared, 0, 'nothing in the preview was made real: the preview is not prepared');
    // The scar of the hidden unpaginated body: `prepare()` copies each pseudo's computed style onto its span, and `visibility` inherits, so a body hidden with it left every reified counter hidden for good.
    assert.equal(printed.hidden, 0, 'every reified text in the print is visible');
    t.diagnostic(`${preview.ledger.pages.length} pages unprepared, ${printed.prepared} elements made real for the print, ${printed.items.length} list items`);
    const file = mupdf.Document.openDocument(new Uint8Array(cast.bytes), 'application/pdf');

    await t.test('cut where the print cuts it', KNOWN[name] ? { todo: KNOWN[name] } : {}, (ct) => {
      assert.equal(file.countPages(), preview.ledger.pages.length, `the file has exactly the pages the unprepared preview showed (${file.countPages()} against ${preview.ledger.pages.length})`);
      cutCheck(ct, preview.ledger, printed.ledger);
    });
    await t.test('every list item\'s text begins where it began unprepared', KNOWN_ALONG_THE_LINE[name] ? { todo: KNOWN_ALONG_THE_LINE[name] } : {}, () => {
      assert.deepEqual(movedItems(preview.items, printed.items), [], 'no list item\'s first word moved along its line');
    });
  });
}
