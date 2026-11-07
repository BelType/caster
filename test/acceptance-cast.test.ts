/**
 * The cast acceptance: a finished document cut by Cicero and printed by Caster, and the file held to the pages Cicero presented, word for word, place for place and picture for picture.
 *
 * @remarks
 * Ported from the monorepo's `packages/caster/test/acceptance-cast.test.js` (BelType `aea2b2a1`), where it drove `beltype cast` in both Chromium binaries. Here every document is printed through Caster's own entry points ({@link castDocument}: `prepare()`, Cicero's `run()`, `print()`), in the full binary, over the fixtures in `fixtures/`; the readings and comparisons are `cast-checks.ts`'s. The oracle is the page Cicero presented, measured by the check itself and never by Caster, so a misreading Caster's report and its file share fails here.
 *
 * On every file: the words (page N of the file holds exactly the words of Cicero's page N, in the structure tree's order, each generated text in its own place); the generated text (every pseudo-element and checkbox Chromium draws against the span Caster made of it); the furniture (each page's margins); where each word sits (within 0.25 pt of the presented page); the picture (each page against mupdf's rendering, by pixelmatch's method); the shape markers (each bullet Blink paints on the unprepared pages, against the file's ink); and preparation moves no cut (the pages cut unprepared are the pages cut prepared).
 *
 * **A known Caster defect names the elements it lives in** ({@link KNOWN}: a selector over the presented document and its why), never the pages it fails on. It excuses a failure only there and only as what it is, and a known defect that excuses nothing in its document fails the check, naming it, so a healed defect asks for its removal. `CAST_ONLY=cast,clipped` narrows the run to those documents.
 *
 * @packageDocumentation
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as mupdf from 'mupdf';
import { castDocument, checks, streamDifferences, cutCheck, inspection, markerDifferences, FIXTURES, type Known } from './cast-checks.ts';

/**
 * Known Caster defects, each keyed by the elements it lives in. A known defect excuses a failure only where its elements are, and one that excuses nothing in its document fails the check, which asks for its removal here.
 *
 * @remarks
 * The monorepo carried five for its minimal fixtures, and five more for the manual, which this repository does not hold. Measured 2026-11-07 on Caster 0.2.1 and Cicero 0.1.7, the first run of this port, three of the five excused nothing and are removed, each with its fixture kept and its check now holding it to the page: the divided row (`fixtures/cast-divided-row/`, its long row on the second and third pages, whose cells the file now reads in the page's order), the wrapped Mermaid label (`fixtures/cast-wrapped-label/`, 0.001 % of the page's pixels differ, 0.7 % of the worst tile), and the heading clipped to nothing (`fixtures/cast-clipped/`, 0.018 % and 1.6 %, since 0.2.1 honours `clip: rect()`). The inline formula healed with 0.2.2's reading order, and the sequence diagram's labels on 2026-11-07, once a `<tspan>`'s own fill and a centred baseline were printed (CHANGELOG, Unreleased); none stands.
 */
const KNOWN: Known[] = [];
/** The documents: the hand-written one, and one minimal fixture for each defect the monorepo's Press round found. The three Markdown fixtures are committed finished (`index.html` beside `index.md`), because the belt that compiles them is BelType's. */
const DOCUMENTS: { key: string; label: string; name: string; markers?: number; later?: string[] }[] = [
  { key: 'cast', label: 'the hand-written document', name: 'cast/index.html', markers: 3 },
  // The manual's page 36, reduced: an inline formula's text is read after the paragraph's in the file's structure tree. KaTeX's sheet makes a display formula's `.katex-html` `position: relative`, so CSS paints it after the paragraph below it and the stream follows the paint (`later`).
  { key: 'inline-formula', label: 'an inline formula', name: 'cast-inline-formula/index.html', later: ['30×90,000'] },
  // The manual's page 92, reduced: a row divided across a page, whose long cell is read first in the file's structure tree.
  { key: 'divided-row', label: 'a divided table row', name: 'cast-divided-row/index.html' },
  // The manual's pages 90, 198, 237 and 275, reduced: a Mermaid sequence diagram's actor labels are missing from the file.
  { key: 'sequence-diagram', label: 'a sequence diagram', name: 'cast-sequence-diagram/index.html' },
  // The manual's page 111 and some forty more, reduced: a Mermaid label that wraps draws its second line's first word at the end of the first.
  { key: 'wrapped-label', label: 'a wrapped diagram label', name: 'cast-wrapped-label/index.html' },
  // The manual's last page, reduced: a heading clipped to nothing on the page is drawn in the file. The heading is `position: absolute`, so CSS paints it after the notes and their numbers, and the stream follows the paint (`later`).
  { key: 'clipped', label: 'a visually hidden heading', name: 'cast-clipped/index.html', later: ['Footnotes'] },
];

const only = (process.env.CAST_ONLY ?? '').split(',').filter(Boolean);

test('the file holds the pages Cicero presented, word for word, place for place and picture for picture, and preparing them moved no cut', { timeout: 600000 }, async (t) => {
  // A name `CAST_ONLY` does not know is a failure, never a run that checks nothing.
  const unknown = only.filter((k) => !DOCUMENTS.some((d) => d.key === k));
  assert.deepEqual(unknown, [], `CAST_ONLY names ${unknown.join(', ')}, which this suite does not have; it has ${DOCUMENTS.map((d) => d.key).join(', ')}`);
  for (const { key, label, name, markers: least, later } of DOCUMENTS.filter((d) => !only.length || only.includes(d.key))) {
    await t.test(label, async (st) => {
      const known = KNOWN.filter((k) => k.at.startsWith(`${key}:`));
      const cast = await castDocument({ name, inspect: inspection(known, true) });
      const ledger = cast.inspected.cut.ledger;
      st.diagnostic(`${cast.pages} pages, ${ledger.pages.flat().length} words placed by Cicero, ${ledger.unanswered.length} outside the flow`);
      const markers = cast.inspected.loaded.markers;
      // A document with bullets compares them, or the marker check passes over none.
      if (least) await st.test(`Blink's shape markers are read, at least ${least}`, () => { const read = markers?.filter((m: { shape: string }) => m.shape !== 'gutter').length ?? 0; assert.ok(read >= least, `${read} read`); });
      await checks(st, key, cast.inspected, cast.bytes, known, markers);
      // A continuation is painted where its page shows it, not where the root's light DOM holds it, and a positioned box where CSS paints it, after the in-flow text (DESIGN.md S76 and its amendments). Held on every document.
      await st.test('the content stream reads the tagged text in the structure tree\'s order, a positioned box where CSS paints it', async (ct) => {
        const differ = await streamDifferences(cast.bytes, later);
        for (const d of differ.slice(0, 8)) ct.diagnostic(d);
        assert.deepEqual(differ, [], 'every page\'s stream in reading order, so an extractor that reads the stream reads the page as a reader does');
      });
      await st.test('preparation moves no cut: the pages cut unprepared are the pages cut prepared', (ct) => cutCheck(ct, cast.inspected.loaded.unprepared, ledger));
    });
  }
});

test('the marker check fails a bullet moved a pixel or recoloured, and passes one Blink paints transparent or the author hid, and what the author draws in a gutter', { timeout: 600000, skip: only.length && !only.includes('cast') ? 'CAST_ONLY leaves the hand-written document out' : false }, async (t) => {
  // Each case is the hand-written fixture, Caster's spans changed after the cut and before the print, and its file held to Blink's markers as the acceptance holds it. Every one was a false pass or a false red in the monorepo's reviews of 2026-10-29 and 2026-10-30.
  const html = fs.readFileSync(`${FIXTURES}/cast/index.html`, 'utf8');
  const look = inspection([], true);
  const spans = 'span.marker[data-caster-marker]';
  const hide = 'ul.loose > li::marker { content: none }';
  /** The case, the document's change, the change to Caster's spans, whether the check must fail, how many markers and gutters it reads if not 3, and a style for Blink's unprepared run alone. */
  const cases: [string, string, string, boolean, number?, string?][] = [
    ['every bullet 1 px right', '', `for (const s of document.querySelectorAll('${spans}')) { const c = getComputedStyle(s); s.style.marginLeft = (parseFloat(c.marginLeft) + 1) + 'px'; s.style.marginRight = (parseFloat(c.marginRight) - 1) + 'px'; }`, true],
    ['every bullet half a pixel down', '', `for (const s of document.querySelectorAll('${spans}')) s.style.setProperty('margin-top', (parseFloat(getComputedStyle(s).marginTop) + 0.5) + 'px', 'important');`, true],
    ['every bullet 1 px down', '', `for (const s of document.querySelectorAll('${spans}')) s.style.setProperty('margin-top', (parseFloat(getComputedStyle(s).marginTop) + 1) + 'px', 'important');`, true],
    ['a navy bullet', '', `document.querySelector('${spans}').style.color = 'rgb(0, 0, 128)';`, true],
    ['a dark green bullet', '', `document.querySelector('${spans}').style.color = 'rgb(0, 90, 0)';`, true],
    ['a transparent marker, which Blink paints as nothing', '<style>ul.loose > li::marker { color: transparent }</style>', '', false],
    ['a bullet the author hid, which Blink lays out as nothing', `<style>${hide}</style>`, '', false],
    ['a dash marker on a disc list, which Blink and the file both draw', '<style>ul.loose > li::marker { content: "– " }</style>', '', false, 0],
    ['a hidden bullet beside a first line hanging by text-indent', `<style>${hide} ul.loose > li > p { text-indent: -1.5em }</style>`, '', false],
    ['a hidden bullet beside a border in the padding', `<style>${hide} ul.loose > li { padding-left: 12px; border-left: 3px solid #c00 }</style>`, '', false],
    ['a hidden bullet beside a background in the padding', `<style>${hide} ul.loose > li { padding-left: 12px; background: #ddd }</style>`, '', false],
    // Blink hangs an outside marker against the item's border box: on main before 2026-11-07 each of these three printed its bullets where Blink paints none.
    ['a padded item, whose bullet stays where Blink hangs it', '<style>ul.loose > li { padding-left: 12px }</style>', '', false],
    ['an indented item, whose bullet stays where Blink hangs it', '<style>ul.loose > li { text-indent: 2em }</style>', '', false],
    ['a right-to-left list, its bullets on the right', '<style>ul.loose { direction: rtl }</style>', '', false],
    ['a square list, compared as squares and its markers as shapes', '<style>ul.loose { list-style-type: square }</style>', '', false],
    // Five gutters: each piece of an item Cicero divides is a list item of its own, and Cicero 0.1.7 cuts the three items into five pieces on six pages (measured 2026-11-07; six pieces under the monorepo's Cicero).
    ['a hidden bullet beside a bold 30 px first line hanging by text-indent', `<style>${hide} ul.loose > li > p { text-indent: -1.5em; font-weight: bold; font-size: 30px }</style>`, '', false, 5],
    ['a 16 px circle the file draws where Blink paints none', '<style>ul.loose { list-style-type: circle }</style>', '', true, 3, hide],
    ['a #aaa disc the file draws where Blink paints none', '<style>ul.loose > li::marker { color: #aaa }</style>', '', true, 3, hide],
  ];
  for (const [name, style, change, fails, read = 3, blink = ''] of cases) {
    await t.test(name, async () => {
      const run = await castDocument({
        name: 'cast/index.html',
        html: html.replace('</head>', `${style}</head>`),
        inspect: { loaded: async (page) => { if (blink) await page.addStyleTag({ content: blink }); return look.loaded(page); }, cut: async (page) => page.evaluate(`(() => { ${change} })()`), printed: look.printed },
      });
      const found = markerDifferences(run.inspected.loaded.markers, mupdf.Document.openDocument(new Uint8Array(run.bytes), 'application/pdf'));
      assert.equal(found.compared + found.gutters, read, 'the fixture\'s three markers compared, or their gutters read');
      if (fails) assert.ok(found.over.length > 0, `the check fails it (at most ${found.dx.toFixed(2)} px across, ${found.dy.toFixed(2)} down, colour ${found.colour.toFixed(0)})`);
      else assert.deepEqual(found.over, [], 'the check passes it');
      assert.deepEqual(run.inspected.printed.against.differ, [], 'the generated-text check passes it');
    });
  }
});
