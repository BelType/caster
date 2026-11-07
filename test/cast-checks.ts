/**
 * The cast acceptance's checks (`test/acceptance-cast.test.ts`), and the harness that prints a finished document through Caster's own entry points: the readings of the page Cicero presented, taken by the check itself and never by Caster, Chromium's own layout read through CDP, the readings of the file by pdf.js and mupdf, and the comparisons.
 *
 * @remarks
 * Ported from the monorepo's `packages/caster/test/cast-checks.js` (BelType `aea2b2a1`). There the document was printed by `beltype cast`, BelType's command, in either Chromium binary; here {@link castDocument} serves the fixture from disk with Cicero's assets and Caster's `dist/`, and calls `prepare()`, Cicero's `run()` and `print()` in the page, the order `cast-in-page.js` ran them. What did not come: the belt's `finished()` (the three Markdown fixtures are committed finished, beside their source), the headless shell's run and its cut compared with the full binary's, and yapr's position reading, which was a diagnostic and asserted nothing.
 *
 * The oracle is the page Cicero presented. Caster's other suites compare the file with Caster's own report, so a misreading in its measurement passes there because the report and the file share it; here the check reads the presented pages itself and the file with readers that are not Caster. Cicero's view gate already holds the presented pages to its Ledger, so a mismatch here is the printer's, or the check's own.
 *
 * Nothing here ships.
 *
 * @packageDocumentation
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, encode } from 'fast-png';
import * as mupdf from 'mupdf';
import { ciceroEngine } from '@beltype/cicero/engine';
import { contentType } from '@beltype/common/mime';
import { launchBrowser, type Page } from './launch.ts';
import { WRITER } from './writer.ts';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const COMMON = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));
/** The fixtures folder: every document here is served from it, so a fixture may reach a sibling's files (`../cast/…`, `../beltype-ua/…`). */
export const FIXTURES = path.join(PACKAGE, 'fixtures');
/** Where a page whose picture fails leaves its difference image; `CAST_FINDINGS` names another folder. */
const FINDINGS = process.env.CAST_FINDINGS ?? path.join(os.tmpdir(), 'caster-cast-findings');

/** Caster's own tolerance for where a glyph sits, in points. */
const TOLERANCE_PT = 0.25;
/** The scale both pictures are taken at, in device pixels per CSS pixel. */
const SCALE = 2;
/** The colour threshold, pixelmatch's own default (0.1, on its YIQ scale, where 1 is black against white). */
const THRESHOLD = 0.1;
/** pixelmatch's square of the largest YIQ distance, 35215, times the threshold squared. */
export const MAX_DELTA = 35215 * THRESHOLD * THRESHOLD;
/** How far, in device pixels, an edge pixel of the screenshot may find its match in the rendering: the two rasterizers snap baselines and hairlines to the pixel grid differently. */
const REACH = 2;
/** A page's picture fails where more than this share of its pixels differ; `CAST_SHARE` sets another. Measured 2026-10-29 in the monorepo: at most 0.043 % on the hand-written fixture. */
const SHARE = Number(process.env.CAST_SHARE ?? 0.002);
/** The side of a tile, in device pixels, and the share of one tile's pixels that fails its page however few differ on the rest of it: a word drawn in the wrong place is a few hundred pixels in one spot (measured on `fixtures/cast-wrapped-label/`). */
const TILE = 24;
const TILE_SHARE = Number(process.env.CAST_TILE_SHARE ?? 0.1);
/** The fewest pixels a tile's share is counted against: a quarter of a tile. */
const TILE_FLOOR = TILE * TILE / 4;
/** How far, in device pixels, a known element's box is widened before its pixels are excused. */
const PAD = REACH;
/** How far a shape marker's ink in the file may stand from Blink's once Blink's pixel grid is undone, in CSS pixels, either way. Measured 2026-10-29: within 0.035 px on 125 discs and 100 placed markers; a quarter pixel, so a bullet moved half a pixel fails. */
export const MARKER_REACH = 0.25;
/** How much wider than Blink's bullet, in CSS pixels each way, the window the file's ink is read in is. */
const MARKER_WINDOW = 2.5;
/** The least ink, in device pixels' worth of full contrast, that is a bullet. */
const INK_FLOOR = 1;
/**
 * How much the file's ink in a gutter may differ from Blink's in any square {@link REACH} each way, in device pixels' worth of full contrast.
 *
 * @remarks
 * Measured 2026-10-30: the two rasterizers' text differed there by at most 5.7, where a bullet the file draws and Blink does not differs by 8.3 to 21.8. A known gap of this check, filed and not fixed: paint in an item's gutter that the file draws otherwise is blamed on a bullet. A `radial-gradient` in the padding (24.5) and a dotted border (25.0) fail here with a message that names a bullet, though they are the file's painting of a background or a border, the picture check's to judge.
 */
const GUTTER_INK = 7;
/** How far the side of a shape marker's ink may differ between the file and Blink's, in device pixels. */
export const MARKER_SIZE = 0.5;
/** The border, in device pixels, left out of the comparison: a page box stands at a fractional CSS pixel. */
const EDGE = 2;
/** The viewport the document is laid out in, `beltype cast`'s. */
const VIEWPORT = { width: 1200, height: 1600 };

/*
 * pixelmatch's method, by Mapbox (ISC licence, https://github.com/mapbox/pixelmatch, version 7): a colour difference measured in YIQ and an anti-aliasing detector that forgives a pixel only where it is an edge's antialiasing in one image and its neighbourhood has a match in both. Written out here because it is the three functions below. The images are RGB, three bytes a pixel, opaque.
 */

/** pixelmatch's `colorDelta`: the squared YIQ distance between two pixels, signed by which is brighter, or the brightness difference alone. */
function colorDelta(a: Uint8Array, b: Uint8Array, i: number, j: number, yOnly = false): number {
  const r1 = a[i]!, g1 = a[i + 1]!, b1 = a[i + 2]!;
  const r2 = b[j]!, g2 = b[j + 1]!, b2 = b[j + 2]!;
  if (r1 === r2 && g1 === g2 && b1 === b2) return 0;
  const y1 = r1 * 0.29889531 + g1 * 0.58662247 + b1 * 0.11448223;
  const y2 = r2 * 0.29889531 + g2 * 0.58662247 + b2 * 0.11448223;
  const y = y1 - y2;
  if (yOnly) return y;
  const i0 = r1 * 0.59597799 - g1 * 0.2741761 - b1 * 0.32180189 - (r2 * 0.59597799 - g2 * 0.2741761 - b2 * 0.32180189);
  const q = r1 * 0.21147017 - g1 * 0.52261711 + b1 * 0.31114694 - (r2 * 0.21147017 - g2 * 0.52261711 + b2 * 0.31114694);
  const delta = 0.5053 * y * y + 0.299 * i0 * i0 + 0.1957 * q * q;
  return y1 > y2 ? -delta : delta;
}

/** pixelmatch's `hasManySiblings`: three or more of the pixel's eight neighbours are the same colour as it. */
function hasManySiblings(img: Uint8Array, x1: number, y1: number, width: number, height: number): boolean {
  const x0 = Math.max(x1 - 1, 0), y0 = Math.max(y1 - 1, 0), x2 = Math.min(x1 + 1, width - 1), y2 = Math.min(y1 + 1, height - 1);
  const pos = (y1 * width + x1) * 3;
  let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;
  for (let x = x0; x <= x2; x++) {
    for (let y = y0; y <= y2; y++) {
      if (x === x1 && y === y1) continue;
      const pos2 = (y * width + x) * 3;
      if (img[pos] === img[pos2] && img[pos + 1] === img[pos2 + 1] && img[pos + 2] === img[pos2 + 2]) zeroes++;
      if (zeroes > 2) return true;
    }
  }
  return false;
}

/** pixelmatch's `antialiased`: is this pixel of `img` an edge's antialiasing, its darkest or brightest neighbour sitting in a flat run of colour in both images? */
function antialiased(img: Uint8Array, x1: number, y1: number, width: number, height: number, other: Uint8Array): boolean {
  const x0 = Math.max(x1 - 1, 0), y0 = Math.max(y1 - 1, 0), x2 = Math.min(x1 + 1, width - 1), y2 = Math.min(y1 + 1, height - 1);
  const pos = (y1 * width + x1) * 3;
  let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;
  let min = 0, max = 0, minX = 0, minY = 0, maxX = 0, maxY = 0;
  for (let x = x0; x <= x2; x++) {
    for (let y = y0; y <= y2; y++) {
      if (x === x1 && y === y1) continue;
      const delta = colorDelta(img, img, pos, (y * width + x) * 3, true);
      if (delta === 0) {
        zeroes++;
        if (zeroes > 2) return false;
      } else if (delta < min) { min = delta; minX = x; minY = y; }
      else if (delta > max) { max = delta; maxX = x; maxY = y; }
    }
  }
  if (min === 0 || max === 0) return false;
  return (hasManySiblings(img, minX, minY, width, height) && hasManySiblings(other, minX, minY, width, height))
    || (hasManySiblings(img, maxX, maxY, width, height) && hasManySiblings(other, maxX, maxY, width, height));
}

/** Is this pixel on an edge of its own image, some neighbour further from it than the threshold? */
function onEdge(img: Uint8Array, x1: number, y1: number, width: number, height: number): boolean {
  const pos = (y1 * width + x1) * 3;
  for (let y = Math.max(y1 - 1, 0); y <= Math.min(y1 + 1, height - 1); y++) {
    for (let x = Math.max(x1 - 1, 0); x <= Math.min(x1 + 1, width - 1); x++) {
      if (Math.abs(colorDelta(img, img, pos, (y * width + x) * 3)) > MAX_DELTA) return true;
    }
  }
  return false;
}

/** Has the pixel of `a` at (x, y) a pixel within the threshold in `b`, within {@link REACH} of the same place? */
function nearMatch(a: Uint8Array, b: Uint8Array, x: number, y: number, width: number, height: number): boolean {
  const o = (y * width + x) * 3;
  for (let dy = -REACH; dy <= REACH; dy++) {
    for (let dx = -REACH; dx <= REACH; dx++) {
      const ry = y + dy, rx = x + dx;
      if (ry >= 0 && rx >= 0 && ry < height && rx < width && Math.abs(colorDelta(a, b, o, (ry * width + rx) * 3)) <= MAX_DELTA) return true;
    }
  }
  return false;
}

/** The bytes of an image cropped to `width` by `height`, three a pixel; `stride` is pixels a row in `data`. */
function rgbOf(data: ArrayLike<number>, stride: number, channels: number, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) out[(y * width + x) * 3 + c] = data[(y * stride + x) * channels + c]!;
  return out;
}

/** A check's look at the page between the steps: `loaded` once the document has loaded and before anything prepares it, `cut` once Cicero has presented every page and before the printer touches them, `printed` once the file is made. */
export type Inspect = {
  loaded?: (page: Page) => Promise<unknown>;
  cut?: (page: Page) => Promise<unknown>;
  printed?: (page: Page) => Promise<unknown>;
};

/** What a cast answers: the file, its page count, and what each look returned. */
export type Cast = { bytes: Buffer; pages: number; warnings: unknown[]; inspected: { loaded?: any; cut?: any; printed?: any } };

/**
 * Print a finished document through Caster's own entry points: served from {@link FIXTURES} with Cicero's head spliced in, `prepare()`, Cicero's `run()` whole, `document.fonts.ready`, then `print()`, the order `beltype cast` runs them.
 *
 * @remarks
 * A file the document asks for and the disk does not hold fails the cast, naming it, because the print would not be the document. Each look in `inspect` runs between two steps, in the page, and what it answers comes back in `inspected`.
 *
 * @param input.name - The document's path under {@link FIXTURES}, `cast/index.html`.
 * @param input.html - The document's text, where it is not the file's own (a case that adds a style).
 */
export async function castDocument({ name, html, inspect = {} }: { name: string; html?: string; inspect?: Inspect }): Promise<Cast> {
  const engine = ciceroEngine.vendorAssets();
  const dirs: Record<string, string> = { ...engine.dirs, caster: path.join(PACKAGE, 'dist'), common: COMMON };
  const imports = Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/_beltype/common/${m}.js`]));
  const source = html ?? fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  const head = `<script type="importmap">${JSON.stringify({ imports })}</script>${ciceroEngine.headHtml('/')}`;
  const served = source.replace(/<\/head>/i, `${head}</head>`);
  const missing = new Set<string>();
  const docPath = `/${name}`;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === docPath) return void response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(served);
    let file: string | null = null;
    if (pathname.startsWith('/_beltype/')) {
      const rel = pathname.slice(10);
      file = (engine.files as Record<string, string>)[rel] ?? null;
      for (const [prefix, dir] of Object.entries(dirs)) if (!file && rel.startsWith(`${prefix}/`)) file = path.join(dir, rel.slice(prefix.length + 1));
    } else {
      const resolved = path.resolve(FIXTURES, `.${pathname}`);
      if (resolved.startsWith(FIXTURES + path.sep)) file = resolved;
    }
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (pathname !== '/favicon.ico') missing.add(pathname);
      return void response.writeHead(404).end();
    }
    response.writeHead(200, { 'Content-Type': contentType(file) }).end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const browser = await launchBrowser();
  const inspected: Cast['inspected'] = {};
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}${docPath}`, { waitUntil: 'load' });
    if (inspect.loaded) inspected.loaded = await inspect.loaded(page);
    const cut = await page.evaluate(async () => {
      try {
        const caster = await import('/_beltype/caster/src/index.js' as string);
        await caster.prepare(document).ready;
        const cicero = (window as any).__beltypeCicero;
        if (!cicero?.run) return { refused: 'the document loaded no Cicero client' };
        const answer = await cicero.run();
        await document.fonts.ready;
        return { pages: answer.pages as number };
      } catch (error) {
        return { refused: String((error as Error)?.message ?? error) };
      }
    });
    if ('refused' in cut) throw new Error(`the cut refused: ${cut.refused}`);
    if (inspect.cut) inspected.cut = await inspect.cut(page);
    const printed = await page.evaluate(async (writer: string) => {
      try {
        const caster = await import('/_beltype/caster/src/index.js' as string);
        const { bytes, report } = await caster.print({ document }, { writer });
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return { base64: btoa(binary), warnings: report.warnings ?? [] };
      } catch (error) {
        return { refused: String((error as Error)?.message ?? error) };
      }
    }, WRITER);
    if ('refused' in printed) throw new Error(`the print refused: ${printed.refused}`);
    if (inspect.printed) inspected.printed = await inspect.printed(page);
    assert.deepEqual([...missing], [], 'every file the document asks for is on disk, or the print would not be the document');
    assert.deepEqual(errors, [], 'the page threw nothing');
    return { bytes: Buffer.from(printed.base64, 'base64'), pages: cut.pages, warnings: printed.warnings, inspected };
  } finally {
    await browser.close();
    server.close();
  }
}

/** A run of one page's characters lying in one element a selector matches: the words `[from, to)` it touches, and its first character and the one after its last, each as a word index and a character of that word's text. */
export type Span = { known: number; element: number; page: number; from: number; to: number; start: [number, number]; end: [number, number] };

/** A generated text and where it stands: before character `char` (0 by default) of the page's word `at`. */
export type Generated = { text: string; at: number; char?: number };

/** Where in an element a picture defect lies: its borders and its rows' and cells', the edges of a drawing's stroked shapes, a drawing's text, a drawing's line ends that carry a marker. */
export type Part = 'rules' | 'strokes' | 'labels' | 'arrowheads';

/** A known Caster defect: the elements it lives in, by a selector over the presented document, and what it is. */
export type Known = {
  /** `document:check`, the check one of `words` or `pictures`. */
  at: string;
  /** A selector, matched under `<beltype-root>`: the words of the elements it matches for `words`, their boxes on each page for `pictures`. */
  elements: string;
  /** For `words`: only an element whose words Cicero put on more than one page. */
  divided?: boolean;
  /** For `words`: the element's characters may stand after the rest of the nearest ancestor this selector matches (a formula's after its paragraph's), every other character of it in its own order. */
  after?: string;
  /** For `words`: the element's parts this selector matches (a row's cells) may stand in another order, each in its own. */
  cells?: string;
  /** For `pictures`: only these parts of the element are excused, each read from the layout; absent, its whole box. */
  parts?: Part[];
  why: string;
};

/** One of Blink's shape markers: its page (from 0); its layout box and the top left of its picture, in CSS pixels from the page box's top left; how far Blink's pixel grid moved what it painted; and Blink's picture of the box and a pixel round it, at {@link SCALE} (a PNG, base64). Or an item's gutter where Blink lays out no bullet: its shape `gutter`. */
export type Marker = { page: number; shape: string; box: { left: number; top: number; width: number; height: number }; clip: { left: number; top: number }; snap: { x: number; y: number }; png: string };

type Box = { left: number; top: number; width: number; height: number; areaTop: number; areaBottom: number };
type Word = { text: string; x: number; top: number; bottom: number; baseline: number | null };

/**
 * In the page, after the cut: each page's words by Cicero's own account, the words of boxes outside the flow, and where the known defects' elements lie among them.
 *
 * @remarks
 * Cicero's side is the engine's own account: every word of the source, tokenized by `fragments.js`'s `joinedWords`, placed by `pageContaining` over `pageIntervals` of the run's account, rebuilt here because `pageOf` refuses every word of a block that holds a geometric cut. Generated text (a counter, a reified marker, a task state) is the printer's and left out, so the account holds the same words with or without `prepare()`, which the cut check needs. The words placed are left in the page (`__castLedgerWords`, `__castLedgerCounts`) for `generatedInPage`.
 *
 * Self-contained: Playwright serializes it with `toString()`.
 *
 * @param selectors - By index; an empty place matches nothing.
 */
export async function ledgerInPage(selectors: (string | null | undefined)[] = []): Promise<{ pages: string[][]; unanswered: string[]; spans: Span[] }> {
  const load = (url: string) => import(url);
  const [{ joinedWords }, { indexBlocks, pageIntervals, pageContaining, wordsBeforeChar }, { isFixedBox }] = await Promise.all([
    load('/_beltype/cicero/src/fragments.js'),
    load('/_beltype/cicero/src/positions.js'),
    load('/_beltype/cicero/src/word-space.js')
  ]);
  const cicero = (window as any).__beltypeCicero;
  const root = document.querySelector('beltype-root') as any;
  const sources = Array.from(root.children as HTMLCollection).filter((el) => !(el.getAttribute('data-beltype') ?? '').split(/\s+/).includes('fragment'));
  const blocks = sources.filter((el) => !isFixedBox(el));
  const index = indexBlocks(blocks);
  const table = pageIntervals(cicero.ledger, index.bases, index.endOf);
  const offsets = new Map<Element, Map<Node, number>>();
  const offsetsIn = (el: Element) => {
    let map = offsets.get(el);
    if (!map) {
      map = new Map();
      let chars = 0;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) { map.set(node, chars); chars += (node as Text).data.length; }
      offsets.set(el, map);
    }
    return map;
  };
  // Text the word space counts and no reader sees (a sheet's, a script's, KaTeX's MathML twin, anything under `display: none`), and a drawing's own words, which are the drawing's.
  const hidden = new Map<Element, boolean>();
  const unseen = (el: Element, box: Element): boolean => {
    if (hidden.has(el)) return hidden.get(el)!;
    const answer = !!el.closest('script, style, template, svg, .katex-mathml') || getComputedStyle(el).display === 'none' || (el !== box && !!el.parentElement && unseen(el.parentElement, box));
    hidden.set(el, answer);
    return answer;
  };
  const read = { pages: Array.from({ length: cicero.last.pages }, () => [] as string[]), unanswered: [] as string[], spans: [] as any[] };
  const ids = new Map<Element, number>();
  const open = new Map<string, any>();
  const placedWords: { node: Node; offset: number; page: number; at: number; char: number }[] = [];
  for (const box of sources) {
    const inFlow = blocks.includes(box);
    for (const whole of joinedWords(box)) {
      const parts = whole.parts.filter((part: { node: Text }) => !part.node.parentElement?.closest('.caster-generated, span.marker, span.task-state'));
      if (!parts.length) continue;
      const first = parts[0];
      const el = first.node.parentElement as Element;
      if (unseen(el, box)) continue;
      // A word the page box cuts is read as what the page shows of it (`geometryInPage`, which runs first), and not at all where nothing shows.
      const cut = (window as any).__castClipped?.get(first.node)?.get(first.start) as string | undefined;
      if (cut === '') continue;
      const text = cut ?? parts.map((part: { node: Text; start: number; end: number }) => part.node.data.slice(part.start, part.end)).join('');
      const entry = inFlow ? index.entryFor(el) : null;
      const within = entry ? wordsBeforeChar(el, offsetsIn(el).get(first.node)! + first.start) : null;
      const page = within == null ? null : pageContaining(table, { b: entry.block, w: entry.before + within });
      if (typeof page !== 'number') { read.unanswered.push(text); continue; }
      const at = read.pages[page]!.push(text) - 1;
      let offset = 0;
      const pieces = cut === undefined
        ? parts.map((part: { node: Text; start: number; end: number }) => { const from = offset; offset += part.end - part.start; return { el: part.node.parentElement, node: part.node, start: part.start, from, to: offset }; })
        : [{ el, node: first.node, start: first.start, from: 0, to: text.length }];
      for (const piece of pieces) placedWords.push({ node: piece.node, offset: piece.start, page, at, char: piece.from });
      selectors.forEach((selector, known) => {
        if (!selector) return;
        for (const piece of pieces) {
          const host = piece.el?.closest(selector);
          if (!host) continue;
          if (!ids.has(host)) ids.set(host, ids.size);
          const element = ids.get(host)!;
          const span = open.get(`${known}:${page}`);
          const runs = span && span.element === element && ((span.end[0] === at && span.end[1] === piece.from) || (span.end[0] === at - 1 && span.whole && piece.from === 0));
          if (span && runs) { span.end = [at, piece.to]; span.to = at + 1; span.whole = piece.to === text.length; }
          else { const next = { known, element, page, from: at, to: at + 1, start: [at, piece.from], end: [at, piece.to], whole: piece.to === text.length }; read.spans.push(next); open.set(`${known}:${page}`, next); }
        }
      });
    }
  }
  (window as any).__castLedgerWords = placedWords;
  (window as any).__castLedgerCounts = read.pages.map((words) => words.length);
  return { ...read, spans: read.spans.map((span) => { const { whole, ...rest } = span; return rest; }) };
}

/**
 * In the page, after the cut and before the print: every page built, each page box in document coordinates, every word's first rectangle on the page it is drawn on, in points from the page box's top left, and the boxes of the known defects' parts, page by page.
 *
 * @remarks
 * Each page is brought into view and given two frames first, because a page is `content-visibility: auto` and a page far from the viewport is neither laid out nor painted; then the reading waits until Cicero says it is settled, and says whether it ran again. The baseline is the rectangle's top plus the ascent the 2D canvas reports for the same computed font; a word drawn partly in a fallback face is placed on its left edge alone. A word the page box cuts is recorded with what shows of it, for the ledger to read.
 *
 * Self-contained: Playwright serializes it with `toString()`.
 */
export async function geometryInPage(specs: { elements: string; parts?: Part[] }[] = []): Promise<{ boxes: Box[]; words: Word[][]; known: { known: number; page: number; x0: number; y0: number; x1: number; y1: number }[]; rerun: unknown }> {
  await (window as any).__beltypeCicero.buildAll();
  const root = document.querySelector('beltype-root') as any;
  const pages = Array.from(root.shadowRoot.querySelectorAll('beltype-page') as NodeListOf<Element>);
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const cicero = (window as any).__beltypeCicero;
  const before = cicero.last;
  for (const page of pages) { page.scrollIntoView({ block: 'start' }); await frame(); }
  await cicero.settled();
  await frame();
  const rerun = cicero.last !== before ? cicero.last : null;
  const PT = 0.75;
  const boxes = pages.map((page) => {
    const r = page.getBoundingClientRect();
    const area = (page.shadowRoot?.querySelector('.content-area') as Element).getBoundingClientRect();
    return { left: r.left + scrollX, top: r.top + scrollY, width: r.width, height: r.height, areaTop: area.top + scrollY, areaBottom: area.bottom + scrollY };
  });
  const words: { text: string; x: number; top: number; bottom: number; baseline: number | null }[][] = pages.map(() => []);
  const range = document.createRange();
  const context = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D;
  const ascents = new Map<string, [number, number]>();
  const ascentOf = (el: Element) => {
    const style = getComputedStyle(el);
    const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    if (!ascents.has(font)) { context.font = font; const m = context.measureText('x'); ascents.set(font, [m.fontBoundingBoxAscent, m.fontBoundingBoxAscent + m.fontBoundingBoxDescent]); }
    return ascents.get(font)!;
  };
  const primaryOnly = (el: Element, word: string) => {
    const style = getComputedStyle(el);
    const first = style.fontFamily.split(',')[0]!.trim();
    const base = `${style.fontStyle} ${style.fontWeight} ${style.fontSize}`;
    const widths = [style.fontFamily, `${first}, monospace`, `${first}, serif`].map((family) => { context.font = `${base} ${family}`; return context.measureText(word).width; });
    return Math.max(...widths) - Math.min(...widths) < 0.01;
  };
  const clipped = new Map<Node, Map<number, string>>();
  (window as any).__castClipped = clipped;
  // A word an ancestor clips away whole is not shown, though its text has a rectangle: the sr-only pattern (`clip: rect(0, 0, 0, 0)` on a 1-pixel box) lays its words out beside a box that draws none of them. Its words stay in Cicero's account, which is reading content, and leave the places this check holds the file to (measured 2026-11-07 on `fixtures/cast-clipped/`, once Caster stopped drawing the heading: the page's "Footnotes" was asked of a file that rightly draws nothing there).
  const clipOf = (a: Element, s: CSSStyleDeclaration) => {
    const b = a.getBoundingClientRect();
    const box = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    const rect = /^rect\((.*)\)$/.exec(s.clip)?.[1]?.split(/\s*,\s*|\s+/);
    if (rect && rect.length === 4 && (s.position === 'absolute' || s.position === 'fixed')) {
      const [t, r, bo, l] = rect.map((v) => (v === 'auto' ? null : Number.parseFloat(v)));
      return { left: l == null ? box.left : b.left + l, top: t == null ? box.top : b.top + t, right: r == null ? box.right : b.left + r, bottom: bo == null ? box.bottom : b.top + bo };
    }
    return s.overflowX !== 'visible' || s.overflowY !== 'visible' ? box : null;
  };
  const clippedAway = (el: Element, r: DOMRect) => {
    for (let a: Element | null = el; a && a !== root; a = a.parentElement) {
      const c = clipOf(a, getComputedStyle(a));
      if (c && (c.right <= c.left || c.bottom <= c.top || r.right <= c.left || r.left >= c.right || r.bottom <= c.top || r.top >= c.bottom)) return true;
    }
    return false;
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const parent = node.parentElement;
    if (!parent || parent.closest('script, style, template, svg, .katex-mathml') || getComputedStyle(parent).visibility !== 'visible') continue;
    for (const match of node.data.matchAll(/\S+/g)) {
      range.setStart(node, match.index!);
      range.setEnd(node, match.index! + match[0].length);
      const rect = Array.from(range.getClientRects()).find((r) => r.width > 0 && r.height > 0);
      if (!rect) continue;
      const cy = rect.top + rect.height / 2 + scrollY;
      const k = boxes.findIndex((b) => cy >= b.top && cy < b.top + b.height);
      // Inside the content area only: margin content is furniture, which the file draws as artifacts.
      if (k < 0 || cy < boxes[k]!.areaTop || cy > boxes[k]!.areaBottom) continue;
      const b = boxes[k]!;
      const right = b.left + b.width - scrollX;
      let text = match[0];
      if (rect.right > right) {
        let shown = 0;
        for (const ch of text) {
          range.setStart(node, match.index! + shown);
          range.setEnd(node, match.index! + shown + ch.length);
          if (range.getBoundingClientRect().left >= right) break;
          shown += ch.length;
        }
        text = text.slice(0, shown);
        const source = root.sourcePoint(node, match.index) ?? { node, offset: match.index };
        if (!clipped.has(source.node)) clipped.set(source.node, new Map());
        clipped.get(source.node)!.set(source.offset, text);
        if (!text) continue;
      }
      if (clippedAway(parent, rect)) continue;
      const [ascent, height] = ascentOf(parent);
      const baseline = Math.abs(rect.height - height) < 0.05 && primaryOnly(parent, text) ? (rect.top + ascent + scrollY - b.top) * PT : null;
      words[k]!.push({ text, x: (rect.left + scrollX - b.left) * PT, top: (rect.top + scrollY - b.top) * PT, bottom: (rect.bottom + scrollY - b.top) * PT, baseline });
    }
  }
  // A known element's box, whole, is its border box and every text rectangle under it; a part is read from the layout too, never from the pixels that differ. In CSS pixels from the page box's top left, clipped to each page box it meets.
  const known: { known: number; page: number; x0: number; y0: number; x1: number; y1: number }[] = [];
  const partsOf = (el: Element, part: string | undefined) => {
    const out: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const rect = (r: DOMRect) => ({ x0: r.left, y0: r.top, x1: r.right, y1: r.bottom });
    if (!part) {
      range.selectNode(el);
      return Array.from(range.getClientRects()).filter((r) => r.width && r.height).map(rect);
    }
    if (part === 'rules') {
      for (const box of [el, ...Array.from(el.querySelectorAll('thead, tbody, tfoot, tr, th, td'))]) {
        const style = getComputedStyle(box);
        const sides: [string, string, string][] = [['top', style.borderTopWidth, style.borderTopStyle], ['right', style.borderRightWidth, style.borderRightStyle], ['bottom', style.borderBottomWidth, style.borderBottomStyle], ['left', style.borderLeftWidth, style.borderLeftStyle]];
        for (const r of Array.from(box.getClientRects())) {
          for (const [side, width, kind] of sides) {
            const w = Number.parseFloat(width);
            if (!w || kind === 'none' || kind === 'hidden') continue;
            if (side === 'top' || side === 'bottom') { const y = side === 'top' ? r.top : r.bottom; out.push({ x0: r.left - w, y0: y - w, x1: r.right + w, y1: y + w }); }
            else { const x = side === 'left' ? r.left : r.right; out.push({ x0: x - w, y0: r.top - w, x1: x + w, y1: r.bottom + w }); }
          }
        }
      }
      return out;
    }
    if (part === 'strokes') {
      for (const shape of Array.from(el.querySelectorAll('rect, line, path, polyline, polygon, circle, ellipse'))) {
        const style = getComputedStyle(shape);
        const ctm = (shape as SVGGraphicsElement).getScreenCTM();
        const w = (Number.parseFloat(style.strokeWidth) || 0) * (ctm ? Math.hypot(ctm.a, ctm.b) : 1);
        if (style.stroke === 'none' || !w) continue;
        const r = shape.getBoundingClientRect();
        out.push({ x0: r.left - w, y0: r.top - w, x1: r.right + w, y1: r.top + w }, { x0: r.left - w, y0: r.bottom - w, x1: r.right + w, y1: r.bottom + w });
        out.push({ x0: r.left - w, y0: r.top - w, x1: r.left + w, y1: r.bottom + w }, { x0: r.right - w, y0: r.top - w, x1: r.right + w, y1: r.bottom + w });
      }
      return out;
    }
    if (part === 'labels') {
      const texts = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = texts.nextNode(); node; node = texts.nextNode()) {
        if (!(node as Text).data.trim() || node.parentElement?.closest('style, script, title, desc')) continue;
        range.selectNodeContents(node);
        for (const r of Array.from(range.getClientRects())) if (r.width && r.height) out.push(rect(r));
      }
      return out;
    }
    for (const line of Array.from(el.querySelectorAll('path, line, polyline'))) {
      const style = getComputedStyle(line);
      const g = line as SVGGeometryElement;
      const ctm = g.getScreenCTM();
      if (!ctm) continue;
      const length = g.getTotalLength();
      for (const [value, at] of [[style.markerStart, 0], [style.markerEnd, length]] as [string, number][]) {
        const id = /url\("?#([^")]+)"?\)/.exec(String(value))?.[1];
        const marker = id ? g.ownerSVGElement?.querySelector(`marker[id="${CSS.escape(id)}"]`) : null;
        if (!marker) continue;
        const units = marker.getAttribute('markerUnits') === 'userSpaceOnUse' ? 1 : Number.parseFloat(style.strokeWidth) || 1;
        const size = Math.max(Number.parseFloat(marker.getAttribute('markerWidth') ?? '3'), Number.parseFloat(marker.getAttribute('markerHeight') ?? '3')) * units * Math.hypot(ctm.a, ctm.b);
        const point = g.getPointAtLength(at).matrixTransform(ctm);
        out.push({ x0: point.x - size, y0: point.y - size, x1: point.x + size, y1: point.y + size });
      }
    }
    return out;
  };
  specs.forEach(({ elements, parts }, i) => {
    for (const el of Array.from(root.querySelectorAll(elements) as NodeListOf<Element>)) {
      for (const r of (parts ?? [undefined]).flatMap((part) => partsOf(el, part))) {
        const x0 = r.x0 + scrollX, y0 = r.y0 + scrollY, x1 = r.x1 + scrollX, y1 = r.y1 + scrollY;
        boxes.forEach((b, k) => {
          const box = { x0: Math.max(x0, b.left) - b.left, y0: Math.max(y0, b.top) - b.top, x1: Math.min(x1, b.left + b.width) - b.left, y1: Math.min(y1, b.top + b.height) - b.top };
          if (box.x1 > box.x0 && box.y1 > box.y0) known.push({ known: i, page: k, ...box });
        });
      }
    }
  });
  return { boxes: boxes.map(({ left, top, width, height, areaTop, areaBottom }) => ({ left, top, width, height, areaTop: (areaTop - top) * PT, areaBottom: (areaBottom - top) * PT })), words, known, rerun };
}

/**
 * In the page, after the print: the generated text as printed (a heading's counter, a list item's marker, a contents line's page number, a task state), each page's with the place it stands in among the page's words: the first character of Cicero's account after it in the document, as that word's index and the character in it. Margin content is furniture and left out.
 *
 * Self-contained: Playwright serializes it with `toString()`.
 */
export async function generatedInPage(): Promise<Generated[][]> {
  const root = document.querySelector('beltype-root') as any;
  const words: { node: Node; offset: number; page: number; at: number; char: number }[] = (window as any).__castLedgerWords ?? [];
  const counts: number[] = (window as any).__castLedgerCounts ?? [];
  const pages: { text: string; at: number; char: number }[][] = Array.from({ length: root.shadowRoot.querySelectorAll('beltype-page').length }, () => []);
  const range = document.createRange();
  const after = ({ node, offset }: { node: Node; offset: number }) => {
    let lo = 0, hi = words.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; const w = words[mid]!; if (w.node === node ? w.offset >= offset : node.compareDocumentPosition(w.node) & Node.DOCUMENT_POSITION_FOLLOWING) hi = mid; else lo = mid + 1; }
    return words[lo];
  };
  const texts = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nextSource = (span: Element) => {
    texts.currentNode = span;
    for (let node = texts.nextNode(); node; node = texts.nextNode()) {
      if (span.contains(node) || node.parentElement?.closest('.caster-generated, span.marker, span.task-state')) continue;
      return (root.sourcePoint(node, 0) ?? { node, offset: 0 }) as { node: Node; offset: number };
    }
    return null;
  };
  for (const span of Array.from(document.querySelectorAll('.caster-generated, span.marker, span.task-state'))) {
    if (span.closest('[data-pdf-artifact], [data-beltype~="artifact"]')) continue;
    let child: Element = span;
    while (child.parentElement && child.parentElement !== root) child = child.parentElement;
    const page = child.parentElement === root ? root.pageHolding(child) : null;
    // The text's rectangle, not the span's: a reified marker's box is 0 wide and its text stands outside it.
    range.selectNodeContents(span);
    const rect = range.getBoundingClientRect();
    if (page == null || rect.width <= 0) continue;
    const source = nextSource(span);
    const next = source ? after(source) : undefined;
    const end = !next || next.page > page;
    const at = end ? counts[page] ?? 0 : next.page < page ? 0 : next.at;
    pages[page]!.push({ text: span.textContent ?? '', at, char: end || next.page < page ? 0 : next.char });
  }
  return pages.map((list) => list.sort((a, b) => a.at - b.at || a.char - b.char));
}

/** Each presented page as a PNG at {@link SCALE}, clipped to its page box, through CDP. */
export async function screenshots(page: Page, boxes: Box[]): Promise<{ png: Buffer }[]> {
  const session = await page.context().newCDPSession(page);
  const shots = [];
  for (const b of boxes) {
    await page.evaluate((y: number) => new Promise((resolve) => { scrollTo(0, y); requestAnimationFrame(() => requestAnimationFrame(resolve)); }), b.top);
    const { data } = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: b.left, y: b.top, width: b.width, height: b.height, scale: SCALE } });
    shots.push({ png: Buffer.from(data, 'base64') });
  }
  await session.detach();
  return shots;
}

/**
 * Blink's own shape markers (a `disc`, `circle` or `square` `::marker`), each with the picture of what Blink paints in its box, read on pages Cicero cut without `prepare()`: once prepared a shape marker is an empty span that paints nothing on screen.
 *
 * @remarks
 * The box is the `::marker`'s layout through CDP (`DOMSnapshot.captureSnapshot`), never Caster's span. Every item that would hang a bullet beside which Blink lays out none is a gutter instead, with Blink's picture of it, which the file must match there.
 */
export async function nativeMarkers(page: Page, boxes: Box[]): Promise<Marker[]> {
  const items = await page.evaluate(() => {
    const found: { left: number; top: number; right: number; bottom: number }[] = [];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const style = getComputedStyle(el);
      if (style.display !== 'list-item' || style.listStylePosition !== 'outside' || style.direction !== 'ltr' || !['disc', 'circle', 'square'].includes(style.listStyleType)) continue;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (node) => (/\S/.test(node.nodeValue ?? '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) });
      const text = walker.nextNode();
      if (!text) continue;
      const range = document.createRange();
      const first = text.nodeValue!.search(/\S/);
      range.setStart(text, first); range.setEnd(text, first + 1);
      const line = range.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      const right = box.left + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft) + scrollX;
      el.setAttribute('data-cast-gutter', String(found.length));
      found.push({ left: right - 2 * Number.parseFloat(style.fontSize), top: line.top + scrollY, right, bottom: line.bottom + scrollY });
    }
    return found;
  });
  const cdp = await page.context().newCDPSession(page);
  const snap: any = await cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: [] });
  await page.evaluate(() => { for (const el of Array.from(document.querySelectorAll('[data-cast-gutter]'))) el.removeAttribute('data-cast-gutter'); });
  const d = snap.documents[0];
  const str = (i: number) => (i < 0 ? '' : snap.strings[i] as string);
  const markers = new Set<number>();
  (d.nodes.pseudoType?.index ?? []).forEach((n: number, k: number) => { if (str(d.nodes.pseudoType.value[k]) === 'marker') markers.add(n); });
  const tagged = new Map<number, number>();
  d.nodes.attributes.forEach((attributes: number[], n: number) => { const k = attributes.findIndex((a, j) => j % 2 === 0 && str(a) === 'data-cast-gutter'); if (k >= 0) tagged.set(n, Number(str(attributes[k + 1]!))); });
  const marked = new Set<number>();
  const found = new Map<number, { text: string; x0: number; y0: number; x1: number; y1: number }>();
  for (let i = 0; i < d.layout.nodeIndex.length; i++) {
    const node = d.layout.nodeIndex[i];
    if (!markers.has(node)) continue;
    const [x, y, w, h] = d.layout.bounds[i];
    const e = found.get(node) ?? { text: '', x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    e.text += str(d.layout.text[i]);
    e.x0 = Math.min(e.x0, x); e.y0 = Math.min(e.y0, y); e.x1 = Math.max(e.x1, x + w); e.y1 = Math.max(e.y1, y + h);
    found.set(node, e);
  }
  // Blink paints a symbol marker on whole pixels: the page box's origin rounded, and the marker box's offset in it rounded (measured 2026-10-29).
  const grid = (at: number, origin: number) => Math.round(origin) + Math.round(at - origin) - at;
  const bringIntoView = (top: number) => page.evaluate((y: number) => new Promise((resolve) => { scrollTo(0, y); requestAnimationFrame(() => requestAnimationFrame(resolve)); }), top);
  const out: Marker[] = [];
  let shown = -1;
  for (const [node, e] of found) {
    const shape = e.text.trim();
    if (shape) marked.add(d.nodes.parentIndex[node]);
    if (!['•', '◦', '■'].includes(shape)) continue;
    const k = boxes.findIndex((b) => (e.y0 + e.y1) / 2 >= b.top && (e.y0 + e.y1) / 2 < b.top + b.height && e.x0 >= b.left && e.x0 < b.left + b.width);
    if (k < 0) continue;
    const b = boxes[k]!;
    if (k !== shown) { await bringIntoView(b.top); shown = k; }
    const x0 = Math.floor(e.x0) - 1, y0 = Math.floor(e.y0) - 1, x1 = Math.ceil(e.x1) + 1, y1 = Math.ceil(e.y1) + 1;
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0, scale: SCALE } });
    out.push({ page: k, shape, box: { left: e.x0 - b.left, top: e.y0 - b.top, width: e.x1 - e.x0, height: e.y1 - e.y0 }, clip: { left: x0 - b.left, top: y0 - b.top }, snap: { x: grid(e.x0, b.left), y: grid(e.y0, b.top) }, png: data });
  }
  for (const [n, i] of tagged) {
    if (marked.has(n)) continue;
    const g = items[i]!;
    const k = boxes.findIndex((b) => (g.top + g.bottom) / 2 >= b.top && (g.top + g.bottom) / 2 < b.top + b.height && g.right > b.left && g.right <= b.left + b.width);
    if (k < 0) continue;
    const b = boxes[k]!;
    if (k !== shown) { await bringIntoView(b.top); shown = k; }
    const x0 = Math.floor(g.left) - 1, y0 = Math.floor(g.top) - 1, x1 = Math.ceil(g.right) + 1, y1 = Math.ceil(g.bottom) + 1;
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0, scale: SCALE } });
    out.push({ page: k, shape: 'gutter', box: { left: g.left - b.left, top: g.top - b.top, width: g.right - g.left, height: g.bottom - g.top }, clip: { left: x0 - b.left, top: y0 - b.top }, snap: { x: grid(g.right, b.left), y: grid(g.top, b.top) }, png: data });
  }
  await cdp.detach();
  return out;
}

/** The ink in a picture's region: its weight, the weight's centre in device pixels from the region's top left, and its colour (the pixel farthest from the region's commonest colour). */
function inkOf(rgb: Uint8Array, stride: number, x0: number, y0: number, width: number, height: number) {
  const counts = new Map<number, number>();
  for (let y = y0; y < y0 + height; y++) for (let x = x0; x < x0 + width; x++) { const o = (y * stride + x) * 3; const key = (rgb[o]! << 16) | (rgb[o + 1]! << 8) | rgb[o + 2]!; counts.set(key, (counts.get(key) ?? 0) + 1); }
  const ground = [...counts].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  const back = new Uint8Array([ground >> 16, (ground >> 8) & 255, ground & 255]);
  let weight = 0, sx = 0, sy = 0, far = 0, core = back;
  for (let y = y0; y < y0 + height; y++) for (let x = x0; x < x0 + width; x++) {
    const o = (y * stride + x) * 3;
    const w = Math.abs(colorDelta(rgb, back, o, 0, true)) / 255;
    weight += w; sx += w * (x - x0); sy += w * (y - y0);
    const d = Math.abs(colorDelta(rgb, back, o, 0));
    if (d > far) { far = d; core = rgb.slice(o, o + 3); }
  }
  return { weight, x: weight ? sx / weight : 0, y: weight ? sy / weight : 0, colour: core };
}

/** Each pixel's ink, its brightness against the picture's commonest colour, 1 for black on white. */
function inkMap(rgb: Uint8Array): Float64Array {
  const counts = new Map<number, number>();
  for (let o = 0; o < rgb.length; o += 3) { const key = (rgb[o]! << 16) | (rgb[o + 1]! << 8) | rgb[o + 2]!; counts.set(key, (counts.get(key) ?? 0) + 1); }
  const ground = [...counts].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  const back = new Uint8Array([ground >> 16, (ground >> 8) & 255, ground & 255]);
  const out = new Float64Array(rgb.length / 3);
  for (let i = 0; i < out.length; i++) out[i] = Math.abs(colorDelta(rgb, back, i * 3, 0, true)) / 255;
  return out;
}

/**
 * Each of Blink's shape markers against the file: its centre within {@link MARKER_REACH} either way once Blink's pixel grid is undone, its side within {@link MARKER_SIZE} and its colour within the picture's threshold; where Blink paints nothing in the box, the file must draw nothing; in a gutter where Blink lays out no bullet, the file's ink must be Blink's there, within {@link GUTTER_INK}.
 */
export function markerDifferences(markers: Marker[], doc: mupdf.Document): { compared: number; gutters: number; dx: number; dy: number; size: number; colour: number; over: string[] } {
  const pages = new Map<number, { rgb: Uint8Array; width: number; height: number }>();
  const over: string[] = [];
  let dx = 0, dy = 0, size = 0, colour = 0;
  for (const m of markers) {
    if (!pages.has(m.page) && m.page < doc.countPages()) {
      const pixmap = doc.loadPage(m.page).toPixmap(mupdf.Matrix.scale(SCALE * 96 / 72, SCALE * 96 / 72), mupdf.ColorSpace.DeviceRGB, false);
      pages.set(m.page, { rgb: rgbOf(pixmap.getPixels(), pixmap.getWidth(), 3, pixmap.getWidth(), pixmap.getHeight()), width: pixmap.getWidth(), height: pixmap.getHeight() });
      pixmap.destroy();
    }
    const file = pages.get(m.page);
    const where = `page ${m.page + 1}, the ${m.shape} at ${m.box.left.toFixed(1)}, ${m.box.top.toFixed(1)} px`;
    const shot = decode(Buffer.from(m.png, 'base64'));
    if (m.shape === 'gutter') {
      const width = shot.width, height = shot.height, fx = Math.round((m.clip.left - m.snap.x) * SCALE), fy = Math.round((m.clip.top - m.snap.y) * SCALE);
      if (!file || fx < 0 || fy < 0 || fy + height > file.height || fx + width > file.width) { over.push(`${where}: the file has no such page or place`); continue; }
      const painted = inkMap(rgbOf(shot.data, shot.width, shot.channels, width, height));
      const printed = inkMap(rgbOf(file.rgb.subarray((fy * file.width + fx) * 3), file.width, 3, width, height));
      let worst = 0;
      for (let y = EDGE; y < height - EDGE; y++) for (let x = EDGE; x < width - EDGE; x++) {
        let sum = 0;
        for (let v = Math.max(0, y - REACH); v <= Math.min(height - 1, y + REACH); v++) for (let u = Math.max(0, x - REACH); u <= Math.min(width - 1, x + REACH); u++) sum += printed[v * width + u]! - painted[v * width + u]!;
        if (Math.abs(sum) > Math.abs(worst)) worst = sum;
      }
      // The known gap named at GUTTER_INK: this message names a bullet whatever the paint that differs.
      if (Math.abs(worst) >= GUTTER_INK) over.push(`${where}: Blink lays out no bullet beside this item, and the file draws ${worst > 0 ? 'more' : 'less'} ink than Blink paints there, ${Math.abs(worst).toFixed(1)} device pixels' worth in ${2 * REACH + 1} by ${2 * REACH + 1}`);
      continue;
    }
    const blink = inkOf(rgbOf(shot.data, shot.width, shot.channels, shot.width, shot.height), shot.width, 0, 0, shot.width, shot.height);
    const at = blink.weight >= INK_FLOOR ? { x: m.clip.left + blink.x / SCALE - m.snap.x, y: m.clip.top + blink.y / SCALE - m.snap.y } : { x: m.box.left + m.box.width / 2, y: m.box.top + m.box.height / 2 };
    const half = blink.weight >= INK_FLOOR ? Math.sqrt(blink.weight) / SCALE / 2 + MARKER_WINDOW : Math.max(m.box.width, m.box.height) / 2;
    const x0 = Math.floor((at.x - half) * SCALE), y0 = Math.floor((at.y - half) * SCALE);
    const x1 = Math.ceil((at.x + half) * SCALE), y1 = Math.ceil((at.y + half) * SCALE);
    if (!file || x0 < 0 || y0 < 0 || y1 > file.height || x1 > file.width) { over.push(`${where}: the file has no such page or place`); continue; }
    const printed = inkOf(file.rgb, file.width, x0, y0, x1 - x0, y1 - y0);
    if (blink.weight < INK_FLOOR) {
      if (printed.weight >= INK_FLOOR) over.push(`${where}: Blink paints nothing there, the file draws ink of side ${Math.sqrt(printed.weight).toFixed(2)} device px`);
      continue;
    }
    if (printed.weight < INK_FLOOR) { over.push(`${where}: Blink paints it, the file draws nothing there`); continue; }
    const gap = { x: (x0 + printed.x) / SCALE - at.x, y: (y0 + printed.y) / SCALE - at.y, side: Math.abs(Math.sqrt(printed.weight) - Math.sqrt(blink.weight)), colour: Math.abs(colorDelta(printed.colour, blink.colour, 0, 0)) };
    dx = Math.max(dx, Math.abs(gap.x)); dy = Math.max(dy, Math.abs(gap.y)); size = Math.max(size, gap.side); colour = Math.max(colour, gap.colour);
    const rgb = (c: Uint8Array) => `rgb(${[...c].join(', ')})`;
    if (Math.abs(gap.x) > MARKER_REACH || Math.abs(gap.y) > MARKER_REACH || gap.side > MARKER_SIZE) over.push(`${where}: the file's ink stands ${gap.x.toFixed(2)} px across and ${gap.y.toFixed(2)} px down from Blink's, its side ${Math.sqrt(printed.weight).toFixed(2)} device px against ${Math.sqrt(blink.weight).toFixed(2)}`);
    if (gap.colour > MAX_DELTA) over.push(`${where}: the file draws it ${rgb(printed.colour)}, Blink ${rgb(blink.colour)}`);
  }
  return { compared: markers.filter((m) => m.shape !== 'gutter').length, gutters: markers.filter((m) => m.shape === 'gutter').length, dx, dy, size, colour, over };
}

/**
 * The file read by pdf.js: each page's tagged text in the structure tree's order, whitespace out, and the text no marked-content sequence holds.
 *
 * @remarks
 * Content-stream order is not reading order (a page that resumes a paragraph paints a figure first), so the text is gathered by marked-content id and read out in the structure tree's order. A drawing's own content, its `Figure`'s direct child, is left out, as the ledger leaves a drawing's words out.
 */
export async function readPages(bytes: Buffer): Promise<{ pages: string[]; stray: string[]; artifacts: string }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  const doc = await task.promise;
  const pages: string[] = [];
  const stray: string[] = [];
  let artifacts = '';
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent({ includeMarkedContent: true });
    const byId = new Map<string, string>();
    const open: { id?: string; tag: string }[] = [];
    for (const item of content.items as any[]) {
      if (item.type === 'beginMarkedContent' || item.type === 'beginMarkedContentProps') { open.push({ id: item.id, tag: item.tag }); continue; }
      if (item.type === 'endMarkedContent') { open.pop(); continue; }
      if (open.some((m) => m.tag === 'Artifact')) { artifacts += item.str; continue; }
      const id = open.findLast((m) => m.id)?.id;
      if (id) byId.set(id, (byId.get(id) ?? '') + item.str);
      else if (item.str.trim()) stray.push(`page ${n}: ${item.str}`);
    }
    let text = '';
    const walk = (node: any, role?: string) => {
      if (node.type === 'content') { if (role !== 'Figure') text += byId.get(node.id) ?? ''; byId.delete(node.id); return; }
      for (const child of node.children ?? []) walk(child, node.role);
    };
    walk(await page.getStructTree());
    for (const [id, rest] of byId) if (rest.trim()) stray.push(`page ${n}: ${id} is in no structure element: ${rest}`);
    pages.push(text.replace(/\s+/g, ''));
  }
  await task.destroy();
  return { pages, stray, artifacts: artifacts.replace(/\s+/g, '') };
}

/**
 * Every page whose text is not Cicero's, with the place it first differs, and which known defects excuse it.
 *
 * @remarks
 * A page reads as Cicero's words, whitespace out and case folded, with each generated text standing whole before the character `generatedInPage` placed it before, and nowhere else. A known defect excuses only what it is: one with `after` lets its elements' characters stand after the rest of the nearest `after` ancestor's, every other character in its own order; one with `cells` lets the cells of its element stand in another order, each cell's characters in their own. A page is excused when it reads so once every known defect on it is applied, and each defect is credited that the page needs.
 *
 * A known gap of this check, filed and not fixed: `reading()` drops a region that overlaps another (the `region.a < at` test below), so a formula inside a divided row reads unexcused, a false red. And `after` also lets a generated text standing before the formula move after the paragraph.
 *
 * @param spans - The ledger's, `known` the index in `defects`, `role` 0 for the defect's elements, 1 for an `after` ancestor, 2 for a cell.
 * @returns `page` 0 where the page counts differ.
 */
export function wordDifferences(cicero: string[][], generated: Generated[][], printed: string[], spans: (Span & { role: number })[] = [], defects: { after?: boolean; cells?: boolean }[] = []): { page: number; text: string; excused: number[] }[] {
  if (cicero.length !== printed.length) return [{ page: 0, text: `Cicero cut ${cicero.length} pages, the file has ${printed.length}`, excused: [] }];
  const out: { page: number; text: string; excused: number[] }[] = [];
  const bare = (word: string) => word.replace(/[\s­]+/g, '').toLowerCase();
  for (let k = 0; k < cicero.length; k++) {
    const words = cicero[k]!;
    const lowered = words.map(bare);
    const want = lowered.join('');
    const starts = [0];
    for (const word of lowered) starts.push(starts[starts.length - 1]! + word.length);
    const gens = (generated[k] ?? []).map((g) => ({ text: g.text.replace(/\s+/g, '').toLowerCase(), at: Math.min(g.at, words.length), char: g.char ?? 0 })).filter((g) => g.text);
    const got = printed[k]!.toLowerCase();
    const before = Array.from({ length: want.length + 1 }, () => '');
    const place = ([w, c]: [number, number]) => starts[w]! + bare((words[w] ?? '').slice(0, c)).length;
    for (const g of gens) before[place([g.at, g.char])] += g.text;
    const piece = (i: number) => before[i]! + (want[i] ?? '');
    const run = (a: number, b: number) => { let text = ''; for (let i = a; i < b; i++) text += piece(i); return text; };
    const mine = spans.filter((sp) => sp.page === k).map((sp) => ({ ...sp, a: place(sp.start), b: place(sp.end) }));
    const reading = (taken: number[]): (string | string[])[] => {
      const regions: { a: number; b: number; slot: string | string[] }[] = [];
      const inside = (x: { a: number; b: number }, host: { a: number; b: number }) => x.a >= host.a && x.b <= host.b;
      for (const n of taken) {
        if (defects[n]?.after) for (const host of mine.filter((sp) => sp.known === n && sp.role === 1)) {
          const moved = mine.filter((sp) => sp.known === n && sp.role === 0 && inside(sp, host));
          if (!moved.length) continue;
          const isMoved = (i: number) => moved.some((m) => i >= m.a && i < m.b);
          let stay = '', go = '';
          for (let i = host.a; i < host.b; i++) { if (isMoved(i)) go += piece(i); else stay += piece(i); }
          regions.push({ a: host.a, b: host.b, slot: stay + go });
        }
        if (defects[n]?.cells) for (const row of mine.filter((sp) => sp.known === n && sp.role === 0)) {
          const cells = mine.filter((sp) => sp.known === n && sp.role === 2 && inside(sp, row)).sort((x, y) => x.a - y.a);
          if (cells.length < 2) continue;
          const units: string[] = [];
          let at = row.a;
          for (const cell of cells) { if (cell.a > at) units.push(run(at, cell.a)); units.push(run(cell.a, cell.b)); at = cell.b; }
          if (row.b > at) units.push(run(at, row.b));
          regions.push({ a: row.a, b: row.b, slot: units });
        }
      }
      regions.sort((x, y) => x.a - y.a);
      const slots: (string | string[])[] = [];
      let at = 0;
      for (const region of regions) {
        // The known gap: a region overlapping one already taken is dropped, not merged.
        if (region.a < at) continue;
        slots.push(run(at, region.a), region.slot);
        at = region.b;
      }
      slots.push(run(at, want.length) + before[want.length]);
      return slots;
    };
    const spells = (slots: (string | string[])[], pos = 0, index = 0): boolean => {
      if (index === slots.length) return pos === got.length;
      const slot = slots[index]!;
      if (typeof slot === 'string') return got.startsWith(slot, pos) && spells(slots, pos + slot.length, index + 1);
      const any = (left: string[], p: number): boolean => !left.length ? spells(slots, p, index + 1) : left.some((unit, u) => got.startsWith(unit, p) && any([...left.slice(0, u), ...left.slice(u + 1)], p + unit.length));
      return any(slot, pos);
    };
    if (spells(reading([]))) continue;
    const present = [...new Set(mine.map((sp) => sp.known))].filter((n) => defects[n]?.after || defects[n]?.cells);
    let excused: number[] = [];
    if (present.length && spells(reading(present))) {
      excused = present.filter((n) => !spells(reading(present.filter((m) => m !== n))));
      if (!excused.length) excused = present;
    }
    const strict = reading([])[0] as string;
    let i = 0;
    while (i < strict.length && strict[i] === got[i]) i++;
    out.push({ page: k + 1, excused, text: `page ${k + 1} first differs at character ${i} of ${strict.length} (file: ${got.length}${gens.length ? `, ${gens.length} generated texts placed` : ''}): Cicero …${strict.slice(Math.max(0, i - 30), i + 40)}… file …${got.slice(Math.max(0, i - 30), i + 40)}…` });
  }
  return out;
}

/** Where each presented word sits against where mupdf finds its first letter on the same page of the file: the left edge against the glyph's origin, and the baseline against the origin's height, both within {@link TOLERANCE_PT}. */
export function positionDifferences(presented: Word[][], doc: mupdf.Document): { compared: number; fallback: number; missing: string[]; over: string[]; dx: number[]; dy: number[] } {
  const out = { compared: 0, fallback: 0, missing: [] as string[], over: [] as string[], dx: [] as number[], dy: [] as number[] };
  for (let k = 0; k < presented.length && k < doc.countPages(); k++) {
    const chars = new Map<string, { x: number; baseline: number }[]>();
    doc.loadPage(k).toStructuredText('preserve-spans').walk({
      onChar(c: string, origin: mupdf.Point) {
        const key = c.toLowerCase();
        if (!chars.has(key)) chars.set(key, []);
        chars.get(key)!.push({ x: origin[0], baseline: origin[1] });
      }
    });
    for (const word of presented[k]!) {
      // mupdf 1.28's walker hands an astral character over as its low sixteen bits (measured on the manual), so the presented letter is asked the way the reader answers.
      const point = [...word.text][0]!.codePointAt(0)!;
      const candidates = chars.get((point > 0xffff ? String.fromCharCode(point & 0xffff) : String.fromCodePoint(point)).toLowerCase()) ?? [];
      let best: { x: number; baseline: number } | null = null;
      let distance = Infinity;
      for (const c of candidates) {
        const d = Math.abs(c.x - word.x) + Math.abs(c.baseline - (word.baseline ?? (word.top + word.bottom) / 2));
        if (d < distance) { distance = d; best = c; }
      }
      out.compared++;
      if (!best || distance > 4) { out.missing.push(`page ${k + 1}: "${word.text}" at ${word.x.toFixed(2)}, ${word.top.toFixed(2)} pt`); continue; }
      const dx = best.x - word.x;
      out.dx.push(Math.abs(dx));
      const dy = word.baseline === null ? 0 : best.baseline - word.baseline;
      if (word.baseline === null) out.fallback++;
      else out.dy.push(Math.abs(dy));
      if (Math.abs(dx) > TOLERANCE_PT || Math.abs(dy) > TOLERANCE_PT) out.over.push(`page ${k + 1}: "${word.text}" at ${word.x.toFixed(2)}, baseline ${word.baseline?.toFixed(2)} → ${best.x.toFixed(2)}, ${best.baseline.toFixed(2)} pt`);
    }
  }
  return out;
}

/**
 * Each presented page's picture against the file's page rendered by mupdf at the same scale; a difference image for every page that fails the gate.
 *
 * @remarks
 * A page fails where more than {@link SHARE} of its pixels differ, or where one tile's differing pixels are more than {@link TILE_SHARE} of that tile's own. The pixels inside the boxes of a known defect's parts on a page are taken out, and the gate is applied to what remains; a page that passes once every known defect on it is taken out is excused, and each defect is credited that the page needs.
 *
 * @param known - The known defects' boxes, `known` their index among this check's defects (at most 8, one bit each), in CSS pixels from each page box's top left.
 */
export function pictureDifferences(shots: { png: Buffer }[], doc: mupdf.Document, prefix: string, known: { known: number; page: number; x0: number; y0: number; x1: number; y1: number }[] = []): { shares: number[]; tiles: number[]; runs: number[]; over: string[]; excused: { page: number; by: number[] }[] } {
  const shares: number[] = [];
  const tileShares: number[] = [];
  const runs: number[] = [];
  const over: string[] = [];
  const excused: { page: number; by: number[] }[] = [];
  for (let k = 0; k < shots.length && k < doc.countPages(); k++) {
    const shot = decode(shots[k]!.png);
    const mupage = doc.loadPage(k);
    const pixmap = mupage.toPixmap(mupdf.Matrix.scale(SCALE * 96 / 72, SCALE * 96 / 72), mupdf.ColorSpace.DeviceRGB, false);
    const rendered = pixmap.getPixels();
    const width = Math.min(shot.width, pixmap.getWidth());
    const height = Math.min(shot.height, pixmap.getHeight());
    const presented = rgbOf(shot.data, shot.width, shot.channels, width, height);
    const printed = rgbOf(rendered, pixmap.getWidth(), 3, width, height);
    const diff = new Uint8Array(width * height * 3);
    const mask = new Uint8Array(width * height);
    const mine = known.filter((b) => b.page === k);
    for (const b of mine) {
      const x1 = Math.min(width, Math.ceil(b.x1 * SCALE) + PAD), y1 = Math.min(height, Math.ceil(b.y1 * SCALE) + PAD);
      for (let y = Math.max(0, Math.floor(b.y0 * SCALE) - PAD); y < y1; y++) for (let x = Math.max(0, Math.floor(b.x0 * SCALE) - PAD); x < x1; x++) mask[y * width + x]! |= 1 << b.known;
    }
    const defects = [...new Set(mine.map((b) => b.known))];
    const across = Math.ceil(width / TILE);
    const tileCount = across * Math.ceil(height / TILE);
    const patterns = new Map<number, { pixels: Uint32Array; differ: Uint32Array }>();
    const of = (bits: number) => { let entry = patterns.get(bits); if (!entry) { entry = { pixels: new Uint32Array(tileCount), differ: new Uint32Array(tileCount) }; patterns.set(bits, entry); } return entry; };
    const columns = new Uint32Array(width);
    let run = 0;
    for (let y = EDGE; y < height - EDGE; y++) {
      let row = 0;
      for (let x = EDGE; x < width - EDGE; x++) {
        const bits = mask[y * width + x]!;
        const tile = Math.floor(y / TILE) * across + Math.floor(x / TILE);
        const entry = of(bits);
        entry.pixels[tile]!++;
        const o = (y * width + x) * 3;
        // pixelmatch's rule first, then the grid's slack, and only for a pixel on an edge in either image; a pixel inside a flat run of colour is held to its own place.
        let differs = Math.abs(colorDelta(presented, printed, o, o)) > MAX_DELTA
          && !antialiased(presented, x, y, width, height, printed) && !antialiased(printed, x, y, width, height, presented);
        if (differs && (onEdge(presented, x, y, width, height) || onEdge(printed, x, y, width, height))) differs = !nearMatch(presented, printed, x, y, width, height);
        if (differs) {
          entry.differ[tile]!++;
          row++;
          columns[x]!++;
          run = Math.max(run, row, columns[x]!);
          diff[o] = 255; diff[o + 1] = bits ? 160 : 0; diff[o + 2] = 0;
          continue;
        }
        row = 0;
        columns[x] = 0;
        const grey = 160 + (presented[o]! + presented[o + 1]! + presented[o + 2]!) / 9.6;
        diff[o] = grey; diff[o + 1] = grey; diff[o + 2] = grey;
      }
    }
    pixmap.destroy();
    mupage.destroy();
    const gate = (taken: number) => {
      const pixels = new Uint32Array(tileCount);
      const differ = new Uint32Array(tileCount);
      for (const [bits, entry] of patterns) {
        if (bits & taken) continue;
        for (let n = 0; n < tileCount; n++) { pixels[n]! += entry.pixels[n]!; differ[n]! += entry.differ[n]!; }
      }
      let all = 0, changed = 0, worst = 0, worstShare = 0;
      for (let n = 0; n < tileCount; n++) {
        all += pixels[n]!;
        changed += differ[n]!;
        const share = differ[n]! / Math.max(pixels[n]!, TILE_FLOOR);
        if (share > worstShare) { worstShare = share; worst = n; }
      }
      const share = all ? changed / all : 0;
      return { share, worst, worstShare, fails: share > SHARE || worstShare > TILE_SHARE };
    };
    const plain = gate(0);
    shares.push(plain.share);
    tileShares.push(plain.worstShare);
    runs.push(run);
    if (!plain.fails) continue;
    fs.mkdirSync(FINDINGS, { recursive: true });
    const file = path.join(FINDINGS, `${prefix}-p${k + 1}.png`);
    fs.writeFileSync(file, encode({ width, height, data: diff, channels: 3 }));
    const every = defects.reduce((set, n) => set | (1 << n), 0);
    const rest = gate(every);
    if (defects.length && !rest.fails) {
      const needed = defects.filter((n) => gate(every & ~(1 << n)).fails);
      excused.push({ page: k + 1, by: needed.length ? needed : defects });
      continue;
    }
    const at = `${((rest.worst % across) * TILE / SCALE * 0.75).toFixed(0)}, ${(Math.floor(rest.worst / across) * TILE / SCALE * 0.75).toFixed(0)} pt`;
    over.push(`page ${k + 1}: ${(plain.share * 100).toFixed(3)} % of pixels differ, ${(plain.worstShare * 100).toFixed(1)} % of the worst tile's, a run of ${run}; outside the known parts ${(rest.share * 100).toFixed(3)} %, ${(rest.worstShare * 100).toFixed(1)} % of the worst tile's remaining pixels, at ${at} (${file})`);
  }
  return { shares, tiles: tileShares, runs, over, excused };
}

const stats = (xs: number[]) => {
  if (!xs.length) return 'none';
  const sorted = [...xs].sort((a, b) => a - b);
  return `max ${sorted[sorted.length - 1]!.toFixed(3)} pt, p99 ${sorted[Math.floor(sorted.length * 0.99)]!.toFixed(3)} pt, median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(3)} pt`;
};

/**
 * What Chromium itself draws, read from its layout through CDP and never from Caster's reified DOM: each pseudo-element's text, noted on the element that owns it as `__castPseudo`, each checkbox's state noted on its item as `__castTask`, and each page's furniture, the text drawn inside the page box and outside its content area.
 *
 * @remarks
 * Read once the document has loaded and before `prepare()` runs, when every pseudo-element is Chromium's own, and again after the cut, when the ones still drawn natively are those that read a value the engine delivers.
 */
export async function rendered(page: Page, boxes: Box[] = []): Promise<{ pseudos: number; furniture: string[] }> {
  const cdp = await page.context().newCDPSession(page);
  const snap: any = await cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: [], includeDOMRects: true });
  const d = snap.documents[0];
  const str = (i: number) => (i < 0 ? '' : snap.strings[i] as string);
  const kinds = new Map<number, string>();
  (d.nodes.pseudoType?.index ?? []).forEach((n: number, k: number) => kinds.set(n, str(d.nodes.pseudoType.value[k])));
  const owners = new Map<number, Record<string, string>>();
  const furniture: { text: string; row: number; x: number }[][] = boxes.map(() => []);
  for (let i = 0; i < d.layout.nodeIndex.length; i++) {
    const text = str(d.layout.text[i]);
    if (!text) continue;
    const node = d.layout.nodeIndex[i];
    const kind = kinds.get(node);
    if (kind === 'before' || kind === 'after' || kind === 'marker') {
      const owner = d.nodes.parentIndex[node];
      const texts = owners.get(owner) ?? {};
      texts[kind] = (texts[kind] ?? '') + text;
      owners.set(owner, texts);
    }
    if (!text.trim()) continue;
    const [x, y, , h] = d.layout.bounds[i];
    const k = boxes.findIndex((b) => y + h / 2 >= b.top && y + h / 2 < b.top + b.height && x >= b.left && x < b.left + b.width);
    if (k < 0) continue;
    const centre = (y + h / 2 - boxes[k]!.top) * 0.75;
    if (centre >= boxes[k]!.areaTop && centre <= boxes[k]!.areaBottom) continue;
    furniture[k]!.push({ text, row: Math.round(centre / 4), x });
  }
  for (const [owner, texts] of owners) {
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: d.nodes.backendNodeId[owner] });
    if (!object?.objectId) continue;
    await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function (texts) { this.__castPseudo = Object.assign(this.__castPseudo || {}, texts); }', arguments: [{ value: texts }] });
  }
  const checked = new Set(d.nodes.inputChecked?.index ?? []);
  for (let node = 0; node < d.nodes.nodeName.length; node++) {
    if (str(d.nodes.nodeName[node]) !== 'INPUT') continue;
    const attributes: number[] = d.nodes.attributes[node] ?? [];
    let checkbox = false;
    for (let a = 0; a < attributes.length; a += 2) if (str(attributes[a]!) === 'type' && str(attributes[a + 1]!).toLowerCase() === 'checkbox') checkbox = true;
    if (!checkbox) continue;
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: d.nodes.backendNodeId[node] });
    if (!object?.objectId) continue;
    await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function (task) { if (this.parentElement) this.parentElement.__castTask = task; }', arguments: [{ value: checked.has(node) ? '[x]' : '[ ]' }] });
  }
  await cdp.detach();
  return { pseudos: owners.size, furniture: furniture.map((items) => items.sort((a, b) => a.row - b.row || a.x - b.x).map((item) => item.text).join('').replace(/\s+/g, '')) };
}

/**
 * In the page, after the print: every element Chromium drew a pseudo-element for, its texts as Chromium drew them against the texts of the spans Caster made of them; and every item Chromium drew a checkbox in, against its `span.task-state`.
 *
 * @remarks
 * Originals the page shows, and only they: a copy is the engine's reconstruction, whose resumed pieces drop their markers and counters on purpose, so a divided block's generated text is not asked here. A known gap, filed and not fixed: that is why the check compares so few elements (2 on the manual, 2 on the hand-written fixture), and the count is a diagnostic, not a floor.
 *
 * Self-contained: Playwright serializes it with `toString()`.
 */
export async function generatedAgainstRendered(): Promise<{ compared: number; differ: string[] }> {
  const norm = (text: string) => text.replace(/\s+/g, ' ').trim();
  let compared = 0;
  const differ: string[] = [];
  const root = document.querySelector('beltype-root') as any;
  for (const el of Array.from(document.querySelectorAll('beltype-root *'))) {
    let top: Element = el;
    while (top.parentElement && top.parentElement !== root) top = top.parentElement;
    if (!root.isPresented(top) || root.sourceOf(el)) continue;
    const task = (el as any).__castTask;
    if (task !== undefined && !el.closest('[data-pdf-artifact], [data-beltype~="artifact"]')) {
      const made = el.querySelector(':scope > span.task-state')?.textContent ?? '(no task state)';
      compared++;
      if (made !== task) differ.push(`<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}> Chromium drew a checkbox ${task === '[x]' ? 'checked' : 'unchecked'}, Caster made ${JSON.stringify(made)}`);
    }
    const seen = (el as any).__castPseudo ?? {};
    if (!Object.keys(seen).length || el.closest('[data-pdf-artifact], [data-beltype~="artifact"]')) continue;
    // A disc, circle or square marker Caster draws as the shape Blink draws, with no text, so such a marker is asked for as a shape.
    const SHAPES = new Set(['•', '◦', '■']);
    const want = Object.entries(seen as Record<string, string>).map(([kind, text]) => (kind === 'marker' && SHAPES.has(norm(text)) ? '(a shape)' : norm(text))).filter(Boolean).sort();
    const got = Array.from(el.children).filter((c) => c.matches('.caster-generated, .marker')).map((c) => (c.matches('.marker') && !norm(c.textContent ?? '') ? '(a shape)' : norm(c.textContent ?? ''))).filter(Boolean).sort();
    compared++;
    if (want.join('\u0000') !== got.join('\u0000')) differ.push(`<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}> Chromium drew ${JSON.stringify(want)}, Caster made ${JSON.stringify(got)}`);
  }
  return { compared, differ };
}

/** The furniture the file draws on each page: the text of its artifacts that lies outside the page's content area, top to bottom and left to right, whitespace out. */
export async function fileFurniture(bytes: Buffer, boxes: { areaTop: number; areaBottom: number }[]): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  const doc = await task.promise;
  const out: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const height = page.getViewport({ scale: 1 }).height;
    const content = await page.getTextContent({ includeMarkedContent: true });
    const open: string[] = [];
    const items: { text: string; row: number; x: number }[] = [];
    for (const item of content.items as any[]) {
      if (item.type === 'beginMarkedContent' || item.type === 'beginMarkedContentProps') { open.push(item.tag); continue; }
      if (item.type === 'endMarkedContent') { open.pop(); continue; }
      if (!open.includes('Artifact') || !item.str.trim()) continue;
      const centre = height - item.transform[5] - item.height * 0.3;
      const area = boxes[n - 1];
      if (area && centre >= area.areaTop && centre <= area.areaBottom) continue;
      items.push({ text: item.str, row: Math.round(centre / 4), x: item.transform[4] });
    }
    out.push(items.sort((a, b) => a.row - b.row || a.x - b.x).map((item) => item.text).join('').replace(/\s+/g, ''));
  }
  await task.destroy();
  return out;
}

/** The known defects' verdict on one check: every failure excused by one of them, and every one of them excusing something, or it has healed and asks for its removal. */
function assertKnown(failing: string[], known: Known[], credited: Set<number>, what: string): void {
  assert.deepEqual(failing, [], `${what}: ${failing.length} ${failing.length === 1 ? 'failure' : 'failures'} no known defect accounts for`);
  const healed = known.filter((_, n) => !credited.has(n)).map((k) => `${k.elements} (${k.why})`);
  assert.deepEqual(healed, [], `${what}: ${healed.length === 1 ? 'a known defect excuses' : 'known defects excuse'} nothing in this document; remove ${healed.length === 1 ? 'it' : 'them'} from KNOWN`);
}

/** Preparation moves no cut: Cicero's account of the pages from a run without `prepare()` against the account from the cast's own run, page by page. No known defect excuses a page here. */
export function cutCheck(t: { diagnostic: (message: string) => void }, unprepared: { pages: string[][] }, prepared: { pages: string[][] }): void {
  const pages = Math.max(unprepared.pages.length, prepared.pages.length);
  const differ: number[] = [];
  for (let p = 0; p < pages; p++) if (JSON.stringify(unprepared.pages[p]) !== JSON.stringify(prepared.pages[p])) differ.push(p + 1);
  t.diagnostic(`unprepared ${unprepared.pages.length} pages, prepared ${prepared.pages.length}; ${differ.length ? `${differ.length} differ: ${differ.slice(0, 20).join(' ')}${differ.length > 20 ? ' …' : ''}` : 'every page the same'}`);
  assert.deepEqual(differ, [], 'every page holds the same words prepared and unprepared');
}

/**
 * How a cast is looked at: the ledger, the geometry and the pictures after the cut, the generated text after the print, each reading the known defects' elements; and with `unprepared`, a run of Cicero without `prepare()` once the document has loaded, its ledger, its list items' places and Blink's own markers read, and the page reloaded, so that the cast goes on from a fresh document.
 */
export function inspection(known: Known[], unprepared = false): Required<Inspect> {
  // Three places a known defect: its elements, the ancestor its `after` names, its `cells`; the ledger's `known` is then three times the defect's index plus the place.
  const selectors = known.flatMap((k) => (k.at.endsWith(':words') ? [k.elements, k.after, k.cells] : [null, null, null]));
  const specs = known.map((k) => ({ elements: k.elements, parts: k.parts }));
  return {
    loaded: async (page) => {
      let ledger = null;
      let items = null;
      let markers: Marker[] | null = null;
      if (unprepared) {
        await page.evaluate(async () => { await (window as any).__beltypeCicero.run(); await document.fonts.ready; });
        // The same readings as after the cast's cut, in the same order, so that the two accounts differ by the preparation alone.
        const geometry = await page.evaluate(geometryInPage, []);
        ledger = await page.evaluate(ledgerInPage, []);
        items = await page.evaluate(listItemsInPage);
        markers = await nativeMarkers(page, geometry.boxes);
        await page.reload({ waitUntil: 'load' });
      }
      await rendered(page);
      return { unprepared: ledger, items, markers };
    },
    cut: async (page) => {
      const geometry = await page.evaluate(geometryInPage, specs);
      const ledger = await page.evaluate(ledgerInPage, selectors);
      const items = await page.evaluate(listItemsInPage);
      const drawn = await rendered(page, geometry.boxes);
      return { ledger, geometry, items, furniture: drawn.furniture, shots: await screenshots(page, geometry.boxes) };
    },
    printed: async (page) => ({ generated: await page.evaluate(generatedInPage), against: await page.evaluate(generatedAgainstRendered) })
  };
}

/**
 * In the page, after a cut: where each list item's first word of its own begins, against its page box, in CSS pixels, keyed by the item's text. A cut sees a line added or lost, never a word moved along its line; a made-real `1.` once pushed its item's words 9 pt to the right (DESIGN.md S81, amended 2026-10-19), and this is what sees it.
 *
 * Self-contained: Playwright serializes it with `toString()`.
 */
export function listItemsInPage(): { key: string; x: number }[] {
  const root = document.querySelector('beltype-root') as any;
  const pages = Array.from(root.shadowRoot.querySelectorAll('beltype-page') as NodeListOf<Element>).map((page) => page.getBoundingClientRect());
  const seen = new Map<string, number>();
  const out: { key: string; x: number }[] = [];
  for (const li of Array.from(root.querySelectorAll('li') as NodeListOf<Element>)) {
    const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
    let first: Text | null = null;
    let text = '';
    for (let node = walker.nextNode() as Text | null; node && text.length < 40; node = walker.nextNode() as Text | null) {
      if (node.parentElement?.closest('.marker, .caster-generated, .task-state')) continue;
      if (!first && node.data.trim()) first = node;
      if (first) text += node.data;
    }
    if (!first) continue;
    const start = first.data.search(/\S/);
    const range = document.createRange();
    range.setStart(first, start);
    range.setEnd(first, start + 1);
    const rect = range.getBoundingClientRect();
    const page = pages.find((p) => rect.top + rect.height / 2 >= p.top && rect.top + rect.height / 2 < p.bottom);
    if (!page || !rect.width) continue;
    const key = text.replace(/\s+/g, ' ').trim().slice(0, 40);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    out.push({ key: n > 1 ? `${key} #${n}` : key, x: rect.left - page.left });
  }
  return out;
}

/** The list items whose first word moved along its line, prepared against unprepared, by more than half a CSS pixel. Paired by the item's own text, so a cut that differs elsewhere does not misalign the pairs. */
export function movedItems(unprepared: { key: string; x: number }[], prepared: { key: string; x: number }[]): string[] {
  const before = new Map(unprepared.map((item) => [item.key, item.x]));
  return prepared.filter((item) => before.has(item.key) && Math.abs(item.x - before.get(item.key)!) > 0.5).map((item) => `"${item.key}" at ${item.x.toFixed(2)} px, unprepared ${before.get(item.key)!.toFixed(2)}`);
}

/**
 * The checks on one printed file, each a subtest of its own: the words, the generated text, the shape markers, the furniture, where each word sits, and the picture. A known Caster defect excuses a failure only as what it is and where the page needs it: a page's words (`wordDifferences`), a page's picture (`pictureDifferences`); the furniture, the generated text, the markers and the positions take no known defect.
 *
 * @param known - This document's defects, all checks, in the order {@link inspection} was given them.
 * @param markers - Blink's own shape markers, read on the unprepared pages.
 */
export async function checks(t: any, key: string, inspected: Cast['inspected'], bytes: Buffer, known: Known[] = [], markers: Marker[] | null = inspected.loaded?.markers ?? null): Promise<void> {
  const { ledger, geometry, furniture, shots } = inspected.cut;
  const { generated, against } = inspected.printed;
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), 'application/pdf');
  const of = (check: string) => known.map((k, n) => ({ k, n })).filter(({ k }) => k.at === `${key}:${check}`);
  await t.test('page N holds exactly the words of Cicero\'s page N', async (st: any) => {
    const { pages, stray } = await readPages(bytes);
    const mine = of('words');
    const pagesOf = new Map<number, Set<number>>();
    for (const s of ledger.spans as Span[]) { if (!pagesOf.has(s.element)) pagesOf.set(s.element, new Set()); pagesOf.get(s.element)!.add(s.page); }
    const spans = (ledger.spans as Span[]).flatMap((s) => {
      const n = Math.floor(s.known / 3), role = s.known % 3, local = mine.findIndex((m) => m.n === n);
      if (local < 0 || (role === 0 && known[n]!.divided && pagesOf.get(s.element)!.size < 2)) return [];
      return [{ ...s, known: local, role }];
    });
    const differences = wordDifferences(ledger.pages, generated, pages, spans, mine.map((m) => ({ after: !!m.k.after, cells: !!m.k.cells })));
    if (differences.length) st.diagnostic(`${differences.length} pages differ: ${differences.map((d) => `${d.page}${d.excused.length ? ` (${d.excused.map((n) => mine[n]!.k.elements).join(', ')})` : ''}`).join(' ')}`);
    for (const d of differences.slice(0, 8)) st.diagnostic(d.text);
    assert.deepEqual(stray, [], 'every word the file shows is tagged or an artifact');
    assertKnown(differences.filter((d) => !d.excused.length).map((d) => d.text), mine.map((m) => m.k), new Set(differences.flatMap((d) => d.excused)), 'words');
  });
  await t.test('generated text is what Chromium draws, element by element', async (st: any) => {
    st.diagnostic(`${against.compared} elements with a pseudo-element compared, ${against.differ.length} differ`);
    for (const d of against.differ.slice(0, 8)) st.diagnostic(d);
    assert.deepEqual(against.differ, [], 'every element\'s generated text as Chromium draws it');
  });
  await t.test('each disc, circle and square marker is where Blink draws its own, as large', async (st: any) => {
    assert.ok(markers, 'Blink\'s own markers were read, on the unprepared pages');
    const found = markerDifferences(markers, doc);
    st.diagnostic(`${found.compared} shape markers compared and ${found.gutters} gutters without one read; the file's ink at most ${found.dx.toFixed(2)} px across and ${found.dy.toFixed(2)} px down from Blink's, its side within ${found.size.toFixed(3)} device px, its colour within ${found.colour.toFixed(0)} of pixelmatch's ${MAX_DELTA.toFixed(0)}; ${found.over.length} over`);
    for (const o of found.over.slice(0, 8)) st.diagnostic(o);
    assert.deepEqual(found.over, [], 'every shape marker Blink draws, drawn in the file where Blink draws it and as large');
  });
  await t.test('each page\'s furniture is what the presented page draws in its margins', async (st: any) => {
    const filed = await fileFurniture(bytes, geometry.boxes);
    const failing = (furniture as string[]).map((want, k) => (want === (filed[k] ?? '') ? 0 : k + 1)).filter(Boolean);
    for (const k of failing.slice(0, 8)) st.diagnostic(`page ${k}: the page draws ${JSON.stringify(furniture[k - 1])}, the file ${JSON.stringify(filed[k - 1])}`);
    assert.equal(filed.length, furniture.length, 'one page of the file per presented page');
    assert.deepEqual(failing, [], 'furniture: every page\'s margins as the presented page draws them');
  });
  await t.test(`every word sits where the presented page has it, within ${TOLERANCE_PT} pt`, async (st: any) => {
    const found = positionDifferences(geometry.words, doc);
    if (geometry.rerun) st.diagnostic(`Cicero ran again once the pages were in view: ${JSON.stringify(geometry.rerun)}`);
    st.diagnostic(`${found.compared} words compared, ${found.missing.length} not found; left edge ${stats(found.dx)}; baseline ${stats(found.dy)} (${found.fallback} in a fallback face placed by their left edge alone); ${found.over.length} over ${TOLERANCE_PT} pt`);
    for (const m of [...found.missing, ...found.over].slice(0, 8)) st.diagnostic(m);
    assert.ok(found.compared > 0, 'some words were compared');
    assert.deepEqual([...found.missing, ...found.over], [], 'positions: every word found, and within the tolerance');
  });
  await t.test('each page looks as the presented page does', async (st: any) => {
    const mine = of('pictures');
    const boxes = (geometry.known as { known: number; page: number; x0: number; y0: number; x1: number; y1: number }[]).flatMap((b) => { const i = mine.findIndex((m) => m.n === b.known); return i < 0 ? [] : [{ ...b, known: i }]; });
    const { shares, tiles, runs, over, excused } = pictureDifferences(shots, doc, key, boxes);
    const top = (xs: number[]) => Math.max(0, ...xs);
    st.diagnostic(`per page, the share of differing pixels at most ${(top(shares) * 100).toFixed(3)} %, the worst tile at most ${(top(tiles) * 100).toFixed(1)} %, the longest run ${top(runs)} px`);
    if (excused.length) st.diagnostic(`${excused.length} pages fail inside known elements only: ${excused.map((e) => `${e.page} (${e.by.map((n) => mine[n]!.k.elements).join(', ')})`).join(' ')}`);
    for (const o of over.slice(0, 8)) st.diagnostic(o);
    assert.equal(shots.length, doc.countPages(), 'one presented page per page of the file');
    assertKnown(over, mine.map((m) => m.k), new Set(excused.flatMap((e) => e.by)), `pictures (no page over ${SHARE * 100} % of its pixels, no tile over ${TILE_SHARE * 100} % of its own, outside the known parts)`);
  });
}
