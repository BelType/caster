/**
 * `adapters/pagedjs.js` — the second module that knows an engine's DOM, and the proof that the first one was an adapter rather than the printer.
 *
 * Caster's own; no harness source — the harness's fixtures laid their pages in one horizontal strip themselves (E10), so there was no engine to ask; this adapter is what the Paged.js adapter's round built (DESIGN.md S50–S55). Guide: `docs/guide/coordinates-and-pages.md`.
 *
 * It reads what Paged.js's `Chunker` and `Page` leave in the light DOM after `PagedPolyfill.preview()` resolved (measured 2026-09-14 on the Caster specimen under `--engine pagedjs`, the Paged.js adapter's round, DESIGN.md S50–S54) and fills the same `PageStrip` `adapters/cicero.js` fills; nothing downstream of it learns the engine's name. Every selector is Paged.js's own (`dist/paged.esm.js`'s page template and its `rebuildAncestors`), and every rule below carries the measurement it rests on.
 *
 * What is different from Cicero, and why the strip's shape absorbs it: the pages live in the light DOM (so the probes go on the strip itself), a page's size is a CSS length the engine wrote as a custom property (so the nominal box is exact for free), a continuation is a rebuilt ancestor chain of empty shells the tail's nodes were moved into (so a shell has a twin and the nodes under it are fresh, and there is no clipped tail to drop), and every text a margin box or a footnote call shows is `::after` or `::marker` content the paginator wrote — so the reification the preparation did before pagination has to run once more, here, after it.
 *
 * @packageDocumentation
 */

import { addWordTo } from '@beltype/common/data-beltype';
import { CasterError } from '../errors.ts';
import { PX_TO_PT } from '../coordinates/units.ts';
import { ARTIFACT_ATTRIBUTE } from '../walk/structure.ts';
import { TABLE_FRAGMENT_ATTRIBUTE } from '../walk/tableModel.ts';
import { reify, GENERATED_CLASS, MARKER_CLASS } from './reify.ts';
import { ARTIFACT_WORD, groundOf } from './cicero.ts';
import { SOURCE_ATTRIBUTE, sourceSnapshotOf } from './prepare.ts';
import { deriveIntervals } from './intervals.ts';

import type { PageStrip, StripPage } from './strip.ts';
import type { DerivationNote } from './intervals.ts';

/** The element Paged.js renders into: `.pagedjs_pages`, appended to `body`, one `.pagedjs_page` child per page in order. */
export const STRIP_SELECTOR = '.pagedjs_pages';
/** One page of the strip, whose border box is the page. */
export const PAGE_SELECTOR = '.pagedjs_page';

/**
 * The engine's own scaffolding between a page and the author's content, every class from the page template (`paged.esm.js` `Page.create`) and the footnote machinery.
 *
 * @remarks
 * Each is transparent to the walk (R8): no node, no owner, children walked in its place. The sixteen `.pagedjs_margin-*` cells are not here — they are artifacts, stamped below — and neither is any class Paged.js adds to an author's element (`pagedjs_hyphen` on a word it hyphenated at a cut), which is content like any other.
 */
const CHROME = new Set([
  'pagedjs_page', 'pagedjs_sheet', 'pagedjs_pagebox', 'pagedjs_area', 'pagedjs_page_content',
  'pagedjs_bleed', 'pagedjs_bleed-top', 'pagedjs_bleed-bottom', 'pagedjs_bleed-left', 'pagedjs_bleed-right', 'pagedjs_marks-crop', 'pagedjs_marks-cross', 'pagedjs_marks-middle',
  'pagedjs_footnote_area', 'pagedjs_footnote_content', 'pagedjs_footnote_inner_content'
]);

/** The id of the one `<style>` the adapter adds, so a second adaptation adds none. */
const STYLE_ID = 'caster-pagedjs-chrome';

/**
 * Read the strip Paged.js presented.
 *
 * @param doc - The print frame's document, after `PagedPolyfill.preview()` resolved.
 * @param options - `note` is handed to `deriveIntervals`, for a caller that reports what the derivation met (the census).
 * @throws {CasterError} Whatever says this is not a document Paged.js presented: no `.pagedjs_pages`, zero pages, a page without its sheet, page box or area, a page box that is not one plain length, a continuation shell or continued table with no original, a shell whose tag differs from its original's.
 */
export function adaptPagedjs(doc: Document, { note }: { note?: (note: DerivationNote) => void; } = {}): PageStrip {
  const strip = (doc.querySelector(STRIP_SELECTOR) as HTMLElement|null);
  if (!strip) throw new CasterError('caster: the document holds no .pagedjs_pages; the Paged.js adapter is looking at a document the engine never presented. Was `preview()` awaited?');
  const pageElements = ([...strip.querySelectorAll(`:scope > ${PAGE_SELECTOR}`)] as HTMLElement[]);
  if (pageElements.length === 0) throw new CasterError('caster: .pagedjs_pages presented no pages. The engine paginated to zero, which is a document error rather than a print error — read the page console before concluding the printer is at fault.');
  const view = doc.defaultView ?? window;

  // THE SECOND MOMENT OF REIFICATION (*reification is one primitive with two moments*, S49; *reification's second moment is real*, S52). Paged.js writes every margin box as `.pagedjs_margin-content::after { content: … }`, every footnote call as `a[data-footnote-call]::after { content: counter(footnote) }` and every footnote body's number as a `::marker` — all of it created during pagination, so `prepare()`'s pass, which ran before it, never saw any of it. Layout-neutral by construction: a reified span carries the pseudo's own computed style, so nothing moves, and the cuts were decided already in any case.
  reify(doc);

  // The `@page` ground, read before the chrome rule below makes the page host transparent: the interface sheet paints `.pagedjs_page` white on screen (`--color-paper`), which `groundOf` skips as the medium's own colour, and an author's `@page { background }` would arrive on the same boxes.
  const backgrounds: { page: number; rgb: [number,number,number]; }[] = [];
  pageElements.forEach((element, index) => {
    for (const box of [element.querySelector('.pagedjs_pagebox'), element.querySelector('.pagedjs_sheet'), element]) {
      if (!box) continue;
      const style = view.getComputedStyle(box);
      if (style.backgroundImage !== 'none') throw new CasterError(`caster: the @page background on page ${index + 1} is ${style.backgroundImage}, and this printer places a page's image only on the pages Cicero presents. A colour is placed; an image would be dropped, and a page whose ground the author chose is not one to drop in silence.`, { element: `page ${index + 1}` });
      const ground = groundOf(style.backgroundColor);
      if (ground) { backgrounds.push({ page: index, rgb: ground }); break; }
    }
  });

  // The screen chrome, taken off in Caster's own frame (D1): the interface sheet's page shadow (`box-shadow: 0 0 0 1px`) and paper background are ink the collectors would otherwise paint around every page, and the strip has to be a containing block for the frame's probes (`beginFrame`: "the strip must establish a containing block"), which a static flex column is not (measured: `position: static`).
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `${STRIP_SELECTOR} { position: relative; }\n${PAGE_SELECTOR}, .pagedjs_sheet, .pagedjs_pagebox { box-shadow: none !important; }\n${PAGE_SELECTOR} { background: transparent !important; }`;
    doc.head.append(style);
  }

  const pages: StripPage[] = [];
  pageElements.forEach((element, index) => {
    const sheet = (element.querySelector('.pagedjs_sheet') as HTMLElement|null);
    const pagebox = (element.querySelector('.pagedjs_pagebox') as HTMLElement|null);
    const contentArea = (element.querySelector('.pagedjs_area') as HTMLElement|null);
    if (!sheet || !pagebox || !contentArea) throw new CasterError(`caster: page ${index + 1} is missing its sheet, page box or area; Paged.js's page template writes all three (\`.pagedjs_sheet > .pagedjs_pagebox > .pagedjs_area\`), and a page without them came from something else.`);

    // The page box is a CSS length the engine wrote (S50): `--pagedjs-width`/`--pagedjs-height` (the sheet, bleed included, per page — recto and verso may differ), read at the page's own scope where the per-page variants have been resolved. `210mm` is A4 by definition and converts to 595.276 pt with no 1/64-px grid in the way; the computed px (793.688) is what the frame measures and is recorded beside it. A value that is not one plain length — Paged.js writes `calc()` for a page with bleed — is refused by name rather than guessed at.
    const pageStyle = view.getComputedStyle(element);
    const widthPt = lengthToPt(pageStyle.getPropertyValue('--pagedjs-width'), `page ${index + 1}'s --pagedjs-width`);
    const heightPt = lengthToPt(pageStyle.getPropertyValue('--pagedjs-height'), `page ${index + 1}'s --pagedjs-height`);
    const widthPx = Number.parseFloat(pageStyle.width);
    const heightPx = Number.parseFloat(pageStyle.height);

    // *the strip is static and the pages are light DOM* (S51): the trim is `.pagedjs_pagebox`, the sheet minus the engine's own `bleed`. Where the two boxes coincide — no `@page { bleed }` — there is no trim child and the `--pdf-trim-inset` road (*the page-level `--pdf-*` properties are read from the document root*, S12) governs, exactly as under Cicero.
    const sheetRect = sheet.getBoundingClientRect();
    const boxRect = pagebox.getBoundingClientRect();
    const bled = Math.abs(sheetRect.width - boxRect.width) > 0.5 || Math.abs(sheetRect.height - boxRect.height) > 0.5;

    // R6 for this engine: the sixteen cells are `.pagedjs_margin-<row>-<column>` around the page box. Stamped with the walk's own artifact attribute, because they sit in the light DOM the walk runs over — which is also what gets their text measured. Cicero's cells sit in a shadow, and that adapter lifts them into the light DOM to reach the same stamp (*the margins are lifted into the light DOM*, S57). The three-row rule is `artifactKindOfBox`'s: top row a header, bottom row a footer, the side columns nearest to a header.
    for (const cell of element.querySelectorAll('.pagedjs_margin')) {
      const box = [...cell.classList].find((name) => /^pagedjs_margin-(top|bottom|left|right)/.test(name)) ?? '';
      cell.setAttribute(ARTIFACT_ATTRIBUTE, box.startsWith('pagedjs_margin-bottom') ? 'footer' : 'header');
      // *the margins are lifted into the light DOM* (DESIGN.md S57) and *a running element's original is the element the engine hid* (S60), the artifact word: a running element's copy in a cell is what Paged.js's `afterPageLayout` clones into it, an element of the cell's content that is not a reified pseudo, and it wears the word Cicero's engine writes on its copies, so both adapters end with one marker.
      for (const copy of cell.querySelectorAll(`.pagedjs_margin-content > :not(.${GENERATED_CLASS})`)) addWordTo(copy, ARTIFACT_WORD);
    }

    pages.push({
      element, index,
      flow: [...(element.querySelector('.pagedjs_page_content > div')?.children ?? [])],
      // No clip: Paged.js moves the overflow to the next page (`Layout.removeOverflow` is `range.extractContents()`), so nothing a page holds lies past its area. `null` tells `measureText`'s `clipToPage` and the SVG collector that every rectangle a page owns is the page's own.
      flowBox: null,
      trimBox: bled ? pagebox : null,
      nominal: { widthPt, heightPt },
      declaredPx: { widthPx, heightPx },
      contentArea,
      continuations: []
    });
  });

  // R4 for this engine (*one continuation rule covers two spellings*, S54): a block cut across pages is its original on the first page — `data-split-to`, `data-split-original` — and a shallow-cloned shell on each later page, `data-split-from`, with the same `data-ref` the engine gave every element before it began; the tail's nodes were moved into the shell, so the shell's children are the source's no longer. Every shell's twin is the first element carrying its `data-ref`, in document order — the original, since pages are appended in order — and the pairing is the engine's own word, verified only for the shape it promises.
  const twins: Map<Element,Element> = new Map<any, any>();
  for (const shell of strip.querySelectorAll('[data-split-from]')) {
    // A shell that is a table, or a table's part, is not a twin (*a table Paged.js cut across pages is one table in several fragments*, S63). Its rows are handled below, as fragments of one table.
    if (shell.closest('table')) continue;
    const ref = shell.getAttribute('data-ref');
    const source = ref ? strip.querySelector(`[data-ref="${ref}"]`) : null;
    if (!source || source === shell) throw new CasterError(`caster: the continuation shell <${shell.tagName.toLowerCase()} data-split-from="${shell.getAttribute('data-split-from')}"> has no earlier element with its data-ref; Paged.js's \`rebuildAncestors\` clones every shell from an element that is already on a page, so a shell with no original is not a document the engine presented.`, { element: shell.tagName.toLowerCase() });
    if (source.tagName !== shell.tagName) throw new CasterError(`caster: the continuation shell on page ${pageIndexOfElement(shell) + 1} is a <${shell.tagName.toLowerCase()}> where its original is a <${source.tagName.toLowerCase()}>; a shell is \`cloneNode(false)\` of its original and cannot differ in tag.`, { element: shell.tagName.toLowerCase() });
    twins.set(shell, source);
    const page = pages[pageIndexOfElement(shell)];
    if (page && !shell.parentElement?.hasAttribute('data-split-from')) page.continuations.push({ clone: shell, source, sourcePage: pageIndexOfElement(source) });
  }

  // A table Paged.js cut across pages is one table in several fragments (S63), and the walk already has that word — `data-pdf-table` (`tableModel.js`, E11), one key on every `<table>` that is a part of the same table, merged into one grid, one `Table` element, rows in DOM order. The twin road is the wrong one here and lost every word it carried (measured 2026-09-21 on the manual: 2 300 words over eight pages, the rules and code chips printed around them): a twin "introduces no node and its children are fresh prose", but a table's children are not prose, they are rows, and a fresh `<td>` met outside `visitTable` fell to the branch written for `role="presentation"` tables, which registers no block for a cell of bare text. So the engine's own `data-ref` becomes the key, on the original and on every shell. A row cut mid-cell arrives as a `<tr>` in each of two fragments and is tagged as two rows — every word once, the grid regular, the tree one `TR` richer than the author's; joining them wants the twin's cell as the owner of the shell's words and is not done here.
  for (const shell of strip.querySelectorAll('table[data-split-from]')) {
    const ref = shell.getAttribute('data-ref');
    const source = ref ? strip.querySelector(`table[data-ref="${ref}"]`) : null;
    if (!ref || !source || source === shell) throw new CasterError(`caster: the continued table on page ${pageIndexOfElement(shell) + 1} has no earlier <table> with its data-ref, so there is no table for its rows to belong to.`, { element: 'table' });
    // An author's own key wins: they have already said which table this is.
    const key = (source.getAttribute(TABLE_FRAGMENT_ATTRIBUTE) ?? '').trim() || `pagedjs-${ref}`;
    source.setAttribute(TABLE_FRAGMENT_ATTRIBUTE, key);
    shell.setAttribute(TABLE_FRAGMENT_ATTRIBUTE, key);
  }

  // A running element's original (S60). Paged.js's `RunningHeaders.afterParsed` hides every element matching a `position: running()` selector with an inline `display: none` before it lays out, and clones it — `display` cleared, `data-ref` kept — into each margin cell whose `element()` names it; the original stays in the flow on the page it was parsed onto, with no box and no rectangle, and a walk that met it measured nothing (`no rect for "A"`). That inline `display: none` is the engine's one lasting write of the kind (its only other, `TargetCounters`' forced redraw, removes the property on the next line), so it names the originals — a placed one and one no page ever showed alike. Each is stamped an artifact, the kind its first clone's cell gave it, which keeps it out of the structure tree as `adapters/cicero.js` keeps its own running original (*the margins are lifted into the light DOM*, S57); and `pageElementOf` answers no page for it, so `renders` filters its block and images exactly as it does a Cicero original's. The ink is the clones', which the stamped cells already carry.
  const runningOriginals = [...strip.querySelectorAll('.pagedjs_page_content [style]')].filter((element) => (element as HTMLElement).style.display === 'none');
  for (const original of runningOriginals) {
    const ref = original.getAttribute('data-ref');
    const cell = ref ? strip.querySelector(`.pagedjs_margin [data-ref="${ref}"]`)?.closest('.pagedjs_margin') : null;
    original.setAttribute(ARTIFACT_ATTRIBUTE, cell?.getAttribute(ARTIFACT_ATTRIBUTE) ?? 'header');
    addWordTo(original, ARTIFACT_WORD);
  }

  // A footnote call is a link to its note, and Paged.js dresses it in the same `footnote` class the belt gave the note itself (`data-footnote-call`, `href="#note-…"`); the walk's `.footnote` branch would make the call a second FENote. The class comes off the call, which leaves an `<a href>` carrying its reified number — a `Link` to the note, which is what a reader's reference to a note is.
  for (const call of strip.querySelectorAll('a.footnote[data-footnote-call]')) call.classList.remove('footnote');

  /** The index of the page an element is on, or -1. */
  function pageIndexOfElement(element: Element) {
    const page = element.closest(PAGE_SELECTOR);
    return page ? pageElements.indexOf((page as HTMLElement)) : -1;
  }

  const lang = doc.documentElement.getAttribute('lang')?.trim() ?? '';

  const adapted: PageStrip = {
    strip,
    probeRoot: strip,
    pageElements,
    pages,
    pageOfNode: new Map<any, any>(),
    twinOf: (element) => twins.get(element) ?? null,
    transparent: (element) => isChrome(element),
    lang,
    pageElementOf: (element) => runningOriginals.some((original) => original.contains(element)) ? null : (element.closest(PAGE_SELECTOR) as HTMLElement|null),
    backgrounds
  };

  // The record (*an interval is a marked-content sequence*, DESIGN.md S71), against the source `prepare()` kept: Paged.js moved and split the author's nodes, so a carrier's source is the snapshot's element with the carrier's stamp — a moved element and a `cloneNode(false)` shell carry it alike — and what the engine wrote while paginating carries none. Where `prepare()` never ran on this document in this realm there is no source to derive against, and the strip carries no record.
  const snapshot = sourceSnapshotOf(doc);
  if (snapshot) {
    const bySource: Map<string,Element> = new Map<any, any>();
    for (const element of snapshot.querySelectorAll(`[${SOURCE_ATTRIBUTE}]`)) bySource.set((element.getAttribute(SOURCE_ATTRIBUTE) as string), element);
    adapted.intervals = deriveIntervals(adapted, {
      note,
      origin: (node, parent) => {
        const own = parent.getAttribute(SOURCE_ATTRIBUTE);
        if (own === null) {
          if (parent.closest('[data-footnote-call]')) return { sourceless: 'content', label: 'footnote call' };
          if (parent.parentElement?.classList.contains('pagedjs_hyphen')) return { sourceless: 'content', label: 'layout hyphen', text: '\u00AD' };
          if (parent.classList.contains(MARKER_CLASS) && parent.closest('.footnote')) return { sourceless: 'content', label: "footnote number (a note's ::marker)" };
          if (parent.classList.contains(GENERATED_CLASS)) return { sourceless: 'content', label: 'generated content Paged.js wrote while paginating' };
          return { sourceless: 'content', label: 'other' };
        }
        const source = bySource.get(own);
        if (!source) return { unmapped: 'a stamp the snapshot does not hold' };
        // A continued table's header row is the one place Paged.js may lawfully present covered text again.
        return { source, repeat: !!(parent.closest('thead') && parent.closest('table')?.hasAttribute('data-split-from')) };
      }
    });
  }
  return adapted;
}

/**
 * R8 for this engine: the page template's own boxes, and the one unnamed `<div>` the `Chunker` wraps each page's content in.
 *
 * @remarks
 * Measured: `.pagedjs_page_content > div`, no class, no `data-ref`, one per page.
 */
export function isChrome(element: Element) {
  if (element.classList && [...element.classList].some((name) => CHROME.has(name))) return true;
  return element.tagName === 'DIV' && element.className === '' && element.parentElement?.classList.contains('pagedjs_page_content') === true;
}

/** Points per unit, for every absolute CSS length unit. */
const PT_PER_UNIT = { pt: 1, px: PX_TO_PT, in: 72, pc: 12, cm: 72 / 2.54, mm: 72 / 25.4, q: 72 / 101.6 };

/**
 * One plain CSS length as points, to the three decimals a PDF carries: `210mm` → 595.276.
 *
 * @param what - For the refusal.
 * @throws {CasterError} The value is not one plain absolute length — a `calc()` included.
 */
export function lengthToPt(value: string, what: string) {
  const match = /^\s*(-?\d*\.?\d+)\s*(pt|px|in|pc|cm|mm|q)\s*$/i.exec(value ?? '');
  if (!match) throw new CasterError(`caster: ${what} reads ${JSON.stringify((value ?? '').trim())}, which is not one plain CSS length. Paged.js writes a \`calc()\` there for a page with its own \`bleed\`; this printer reads the page box only where the engine states it as one length, and refuses rather than measure a page ten thousandths of a point short.`);
  const n = Number.parseFloat(match[1]) * PT_PER_UNIT[(match[2].toLowerCase() as keyof typeof PT_PER_UNIT)];
  return Math.round(n * 1000) / 1000;
}
