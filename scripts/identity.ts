/**
 * `npm run identity -- record|check|replay [dir] [--writer forme]`: the byte-identity gate of the round that closes the display list, and the replay that measures how far the writer is from a function of the list; `npm run identity -- compare <dir> [--only <families>]` holds forme's files in `<dir>` to the oracle's with the readers of `scripts/compare.ts`; `npm run identity -- browser <dir>` holds both writers' files to the browser, drawing by drawing.
 *
 * @remarks
 * Ported from the monorepo's `packages/caster/scripts/identity.js` (Caster 0.32.0), which is a model and not a dependency: its corpus and doors (the editing tools, the CLI's `Orchestrator`, Paged.js) are not this repository's. The shape is kept: `record` prints the corpus and writes each file, `check` prints it again and compares bytes. **No byte is masked.** The door hands every print the same `created` (2000-01-01T00:00:00Z), which the display list carries as `info.created` and the writer writes into `/CreationDate` and `/ModDate`, so the gate compares the files exactly; a file that does not carry that date in both entries is a failure, so a writer that went back to a clock cannot turn the gate into a quiet pass.
 *
 * **The door is the CLI's.** Each document is served from disk on the CLI's made-up origin, cut by Cicero with the CLI's own `cutInPage` and its own Cicero (both read from the CLI checkout at `BELTYPE_CLI`, the sibling `../cli` by default, never declared as a dependency), and printed by this checkout's `dist/` in the page, which hands back the display list and the report beside the bytes. A document marked `cli` is also printed by `beltype print` itself, and its file must equal the door's, which is what makes the door the CLI's and not a second one.
 *
 * **`--list-out`** on `record` also writes, for every document, the display list without its blobs (`<name>.json`), each blob once under its SHA-256 in `blobs/`, and the report with what varies by run removed (`<name>.report.json`). Nothing the writer reads is recorded beside the list: the list is all it is handed. `check` compares the report snapshot as well as the bytes wherever one was recorded.
 *
 * **`replay`** runs in node with no browser: it reads each saved list, checks every blob against its hash, holds it to `validateList`, hands it to `emitStructure` with nothing beside it, and compares the bytes with the recorded file. What differs or throws is a writer that is no longer a function of the list; nothing here fixes it.
 *
 * **`--writer forme`** prints with the Rust writer (Caster's `writer` flag). `replay --writer forme --out <dir>` writes every saved list with the vendored module in node, each twice, into `<dir>`: the files and records `compare` reads, and a `corpus.json` naming them by their SHA-256. `check <dir> --writer forme` then prints the corpus in the page with forme and holds each file to those bytes, so the page and node agree. Under forme no document refuses in the writer, and no file is held to `beltype print`'s, which prints with the default; `record` stays the oracle's.
 *
 * **A document that `refuses`** is one the oracle refuses in its writer (the CFF2 face, whose pinned `hmtx` is not the instance's): its page loads the writer through a wrapper that keeps the list it was handed, and `corpus.json` records the refusal's message with no file and no report; `check` asks for the same refusal and the same list, and `replay` for the same refusal from the saved list.
 *
 * **`browser <dir> [--out <dir>]`** is the gate against the browser, since two writers can agree and both be wrong (Egildo's ruling 13 of the Rust writer): every corpus document that names drawings (`data-drawing`) is looked at through the same door as its author sees it, at two device pixels a CSS px, and each drawing's region is held to the oracle's file and to forme's in `<dir>`, rendered by mupdf and by yapr at the same resolution (`againstBrowser`, `scripts/compare.ts`, which states the method and the line). `--out` writes each drawing's crops as PNG.
 *
 * Kept out of `npm test`: it prints fifteen documents in Chromium.
 *
 * @see /Users/egildo/Privata/dev/beltype/.claude/plans/the-rust-writer/plan-close-the-list.md (stage 0)
 * @packageDocumentation
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { contentType } from '@beltype/common/mime';
import { CasterError } from '../src/errors.ts';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const FIXTURES = path.join(PACKAGE, 'fixtures');
const LISTS = path.join(FIXTURES, 'lists');
const CLI = path.resolve(process.env.BELTYPE_CLI ?? path.join(PACKAGE, '..', 'cli'));
const SPECIMENS = path.join(path.dirname(fileURLToPath(import.meta.resolve('@beltype/specimens/package.json'))), 'specimens');

/** The CLI's own constants (`src/print.ts`), copied because the CLI exports none of them. */
const ORIGIN = 'https://print.invalid';
const VIEWPORT = { width: 1200, height: 1600 };
const ARGS = ['--font-render-hinting=none', '--force-device-scale-factor=1', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];

/** The date every file the door prints carries, as the writer writes it. */
const FIXED_DATE = 'D:20000101000000Z';
/** The display list's `info.created` the door hands every print, which the writer writes as {@link FIXED_DATE}. */
const FIXED_CREATED = '2000-01-01T00:00:00.000Z';
const DATE_PATTERN = /(\/(?:CreationDate|ModDate) \()D:[^)]*\)/gu;

/** The writer the page prints with, `--writer` on the command line: the oracle's by default. Under `forme` no document refuses in the writer, since forme writes the CFF2 face, and no file is held to `beltype print`'s, which prints with the default. */
let WRITER: 'pdf-lib' | 'forme' = 'pdf-lib';

/**
 * One document of the corpus.
 *
 * @property root - The folder served at the origin's root; the document's own folder when absent, as `beltype print` serves it.
 * @property options - Caster's flags for this print; the defaults when absent, as `beltype print` passes them.
 * @property cli - Also printed by `beltype print`, whose file must equal the door's.
 * @property why - The road the document is in the corpus for.
 * @property refuses - The oracle is expected to refuse the print in its writer: the list the builder handed the writer is recorded, with the refusal, and no file.
 */
type Doc = { name: string; file: string; root?: string; options?: Record<string, unknown>; cli?: boolean; why: string; refuses?: true };

const CORPUS: Doc[] = [
  { name: 'paper', file: path.join(SPECIMENS, 'paper', 'index.html'), cli: true, why: 'the large document: `@beltype/specimens` paper, four pages of running text, notes, a table, three variable faces' },
  { name: 'cast', file: path.join(FIXTURES, 'cast', 'index.html'), cli: true, why: 'a hand-written document with margin boxes, a page counter, a figure and a passed-through PNG' },
  { name: 'cast-divided-row', file: path.join(FIXTURES, 'cast-divided-row', 'index.html'), root: FIXTURES, why: 'a table row divided across pages' },
  { name: 'roads', file: path.join(FIXTURES, 'roads', 'index.html'), root: FIXTURES, options: { blackText: '100k' }, why: 'rotated text, a gradient with a soft mask, a radial shading, a spot ink with overprint, a CMYK ground, print marks with a bleed, a blurred shadow (the raster fallback), hyphenation, sub and superscript, internal and external links, `blackText: 100k`' },
  { name: 'facsimile', file: path.join(FIXTURES, 'roads', 'facsimile.html'), root: FIXTURES, why: 'a page of another PDF, reopened by pdf-lib inside the writer' },
  { name: 'webp', file: path.join(FIXTURES, 'roads', 'webp.html'), root: FIXTURES, why: 'a WebP, which the image pass decodes through the browser before the list' },
  { name: 'arithmetic', file: path.join(FIXTURES, 'roads', 'arithmetic.html'), root: FIXTURES, why: 'an arithmetic-coded JPEG, which the browser refuses to decode, so the image pass hands the file through' },
  { name: 'photo', file: path.join(FIXTURES, 'roads', 'photo.html'), root: FIXTURES, why: 'an opaque 8-bit RGB PNG of 255 000 pixels, which the photo rule of the image pass re-encodes through the browser before the list' },
  { name: 'faces', file: path.join(FIXTURES, 'roads', 'faces.html'), root: FIXTURES, why: 'a static TrueType face (Crimson Text Regular, `glyf`) and a static CFF face (Source Sans Pro Regular, `CFF `), neither variable nor unwrapped from WOFF2' },
  { name: 'cff2', file: path.join(FIXTURES, 'roads', 'cff2.html'), root: FIXTURES, why: 'a CFF2 variable face with `HVAR` (HarfBuzz\'s Hello World subset of Source Serif 4 Variable, its space glyph among them) at weight 700, away from its default master', refuses: true },
  { name: 'images', file: path.join(FIXTURES, 'roads', 'images.html'), root: FIXTURES, why: 'a CMYK JPEG with the Adobe marker, a JPEG with an ICC profile, and PNGs with alpha, Adam7 interlace, a palette with `tRNS`, 16 bits a sample, 16 bits with alpha and one grey channel' },
  { name: 'facsimile-pages', file: path.join(FIXTURES, 'roads', 'facsimile-pages.html'), root: FIXTURES, why: 'two pages of one facsimile file' },
  { name: 'vectors', file: path.join(FIXTURES, 'roads', 'vectors.html'), root: FIXTURES, why: 'an SVG marker (a form), `mix-blend-mode` inside `isolation: isolate` (an isolated group with a blend mode), an SVG `<mask>` (a soft mask), an `<hr>` (a `rect` item)' },
  { name: 'pages', file: path.join(FIXTURES, 'roads', 'pages.html'), root: FIXTURES, why: 'a `--pdf-page-label` run with a prefix and a start (`/PageLabels`), an outline three levels deep, a link whose text wraps (two rectangles)' },
  { name: 'vector-roads', file: path.join(FIXTURES, 'roads', 'vector-roads.html'), root: FIXTURES, why: 'every vector road the first vectors document does not take, each drawn once and named by its `data-drawing` (Egildo\'s ruling 13 of the Rust writer): gradient strokes (patterns), `paint-order: stroke`, even-odd fills and clips, plain and stroke opacity, group opacity, luminance and alpha masks, masks over a form and over a raster fallback, a form and a raster nested in a form, a marker in a marker, a blend mode, spread methods, caps, joins and dashes, curves, `<use>` of a `<symbol>`, SVG transforms, a CMYK shading under the colour story, CSS transforms one by one and in a chain, styled borders, radii, `clip-path`, repeating and elliptical gradients, box opacity and blend' }
];

// ---- small helpers ---------------------------------------------------------------------------------------------------

const sha256 = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * The file as printed, once it is shown to carry {@link FIXED_DATE} in both dates.
 *
 * @throws {CasterError} Where either date is missing or another, because then the list's `info.created` did not reach the file.
 */
function fixedDated(bytes: Uint8Array): Buffer {
  const file = Buffer.from(bytes);
  const dates = [...file.toString('latin1').matchAll(DATE_PATTERN)].map((m) => m[0]);
  const wanted = [`/ModDate (${FIXED_DATE})`, `/CreationDate (${FIXED_DATE})`];
  if (dates.length !== 2 || !wanted.every((w) => dates.includes(w))) throw new CasterError(`identity: the file's dates are ${JSON.stringify(dates)}, not the ${FIXED_DATE} the door handed the print as created; the list's info.created did not reach the file`);
  return file;
}

/**
 * The CLI's file with its two dates set to {@link FIXED_DATE}: `beltype print` hands Caster no `created`, so its file carries the wall clock. The one mask left in the harness, and it is on the CLI's file, never on the door's.
 *
 * @throws {CasterError} Where the file has no date to set.
 */
function cliDated(bytes: Uint8Array): Buffer {
  let count = 0;
  const text = Buffer.from(bytes).toString('latin1').replace(DATE_PATTERN, (_, head) => { count++; return `${head}${FIXED_DATE})`; });
  if (count === 0) throw new CasterError('identity: no /CreationDate or /ModDate found in the CLI\'s file; the dates moved and the harness must be taught where');
  return Buffer.from(text, 'latin1');
}

/** Where two files first differ: the byte, and the object it falls in on each side. */
function describe(was: Buffer, now: Buffer): string {
  const limit = Math.min(was.length, now.length);
  let offset = 0;
  while (offset < limit && was[offset] === now[offset]) offset++;
  const objectAt = (bytes: Buffer) => {
    const head = bytes.subarray(0, offset + 1).toString('latin1');
    const found = [...head.matchAll(/(\d+) 0 obj/gu)].pop();
    return found ? `object ${found[1]}` : 'before the first object';
  };
  const line = (bytes: Buffer) => JSON.stringify(bytes.subarray(Math.max(0, offset - 30), offset + 50).toString('latin1'));
  return `first differing byte at offset ${offset} (recorded ${was.length} bytes, now ${now.length}), in ${objectAt(was)} recorded and ${objectAt(now)} now\n  recorded: ${line(was)}\n  now:      ${line(now)}`;
}

/** The report with what moves between two prints of one document removed: every timing, and nothing else (measured, see the results of stage 0). */
function snapshot(report: unknown): unknown {
  return JSON.parse(JSON.stringify(report, (key, value) => (key === 'timing' || key === 'ms' || key === 'fontTiming' || /Ms$/u.test(key) ? undefined : value)));
}

/** The first path at which two plain values differ, or null. */
function firstDifference(a: unknown, b: unknown, at = ''): string | null {
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) return at || '(root)';
  if (a && typeof a === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b as object)]);
    for (const key of keys) {
      const found = firstDifference((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${at}.${key}`);
      if (found) return found;
    }
    return null;
  }
  return a === b ? null : at || '(root)';
}

// ---- the door --------------------------------------------------------------------------------------------------------

/** What the page hands back: the file, the list without its blobs, the blobs and the report. */
type Printed = { bytes: Buffer; list: string; blobs: Record<string, Buffer>; report: unknown; ms: number; refused?: string };

/** The CLI's modules, from its checkout: its in-page cut and the Cicero it serves. */
async function cliParts() {
  if (!fs.existsSync(path.join(CLI, 'dist', 'src', 'in-page.js'))) throw new CasterError(`identity: no built CLI at ${CLI}; set BELTYPE_CLI to a checkout of codeberg.org/BelType/cli with its dist/ built`);
  const { cutInPage } = await import(pathToFileURL(path.join(CLI, 'dist', 'src', 'in-page.js')).href);
  const { spliceHead } = await import(pathToFileURL(path.join(CLI, 'dist', 'src', 'print.js')).href);
  const cicero = path.join(CLI, 'node_modules', '@beltype', 'cicero');
  const entry = JSON.parse(fs.readFileSync(path.join(cicero, 'package.json'), 'utf8')).exports['./engine'];
  const { ciceroEngine } = await import(pathToFileURL(path.join(cicero, typeof entry === 'string' ? entry : entry.import ?? entry.default)).href);
  const common = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));
  return { cutInPage, spliceHead, ciceroEngine, common };
}

/**
 * Caster prints the presented pages and hands back everything this script records. Runs in the page, so it closes over nothing.
 *
 * @remarks
 * Where the print refuses and the writer had been handed a list (`__identityList`, set by {@link CAPTURE_EMIT} for a document that `refuses`), the list comes back beside the refusal's message.
 */
async function printInPage({ options, created }: { options: Record<string, unknown>; created: string }) {
  const base64 = (bytes: Uint8Array) => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  const bare = (list: { resources: { blobs: Record<string, Uint8Array> } }) => {
    const blobs: Record<string, string> = {};
    for (const [hash, bytes] of Object.entries(list.resources.blobs)) blobs[hash] = base64(bytes);
    return { list: JSON.stringify({ ...list, resources: { ...list.resources, blobs: undefined } }), blobs };
  };
  try {
    const load = (url: string) => import(url);
    const caster = await load('/_beltype/caster/src/index.js');
    const started = performance.now();
    const printed = await caster.print({ document, created }, options);
    const ms = performance.now() - started;
    return { base64: base64(printed.bytes), ...bare(printed.displayList), report: JSON.stringify(printed.report), ms };
  } catch (error) {
    const handed = (globalThis as { __identityList?: Parameters<typeof bare>[0] }).__identityList;
    return { refused: String((error as Error | undefined)?.stack ?? error), message: String((error as Error | undefined)?.message ?? error), ...(handed ? bare(handed) : {}) };
  }
}

/** The writer's module as the page of a document that `refuses` loads it, through its import map: the real one, whose `emitStructure` keeps the list it is handed where {@link printInPage} finds it after a refusal. */
const CAPTURE_EMIT = `import * as real from '/_beltype/caster/src/emit/structureEmit.js?real';
export * from '/_beltype/caster/src/emit/structureEmit.js?real';
export async function emitStructure(list, ...rest) { globalThis.__identityList = list; return real.emitStructure(list, ...rest); }
`;

/** Every request answered from disk, as `beltype print` answers it; anything else is a refusal. */
async function answerFromDisk(context: BrowserContext, missing: Set<string>, o: { root: string; docPath: string; served: string; dirs: Record<string, string>; files: Record<string, string>; bodies?: Record<string, string> }) {
  const within = (dir: string, rel: string) => {
    const file = path.resolve(dir, rel);
    const inside = path.relative(dir, file);
    return !inside.startsWith('..') && !path.isAbsolute(inside) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
  };
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) { missing.add(url.href); return route.abort('blockedbyclient'); }
    if (url.pathname === o.docPath) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: o.served });
    const body = o.bodies?.[url.pathname];
    if (body !== undefined) return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body });
    const pathname = decodeURIComponent(url.pathname);
    let file: string | null = null;
    if (pathname.startsWith('/_beltype/')) {
      const rel = pathname.slice('/_beltype/'.length);
      file = o.files[rel] ?? null;
      for (const [prefix, dir] of Object.entries(o.dirs)) if (!file && rel.startsWith(`${prefix}/`)) file = within(dir, rel.slice(prefix.length + 1));
    } else {
      file = within(o.root, `.${pathname}`);
    }
    if (file) return route.fulfill({ status: 200, path: file, contentType: contentType(file) });
    if (pathname !== '/favicon.ico') missing.add(pathname);
    return route.fulfill({ status: 404, body: '' });
  });
}

/**
 * Open every document through the CLI's door, one browser and a fresh context each, cut it with the CLI's `cutInPage`, and hand the page to `visit`.
 *
 * @param look - Where the page is looked at rather than printed: the browser drops the print's forced device scale factor and the context takes `scale`, as an author's screen does.
 */
async function throughDoor(docs: Doc[], visit: (doc: Doc, page: Page, done: { started: number; refuses: boolean; missing: Set<string> }) => Promise<void>, look: { scale: number } | null = null) {
  const parts = await cliParts();
  const cicero = parts.ciceroEngine.vendorAssets();
  // `caster` is this checkout's `dist/`, as `beltype print` serves the Caster it resolves.
  const dirs = { ...cicero.dirs, caster: path.join(PACKAGE, 'dist'), common: parts.common };
  const imports = Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/_beltype/common/${m}.js`]));
  const browser = await chromium.launch({ headless: true, args: look ? ARGS.filter((a) => !a.startsWith('--force-device-scale-factor')) : ARGS });
  try {
    for (const doc of docs) {
      const started = Date.now();
      const root = doc.root ?? path.dirname(doc.file);
      const docPath = `/${path.relative(root, doc.file).split(path.sep).map(encodeURIComponent).join('/')}`;
      const refuses = Boolean(doc.refuses && WRITER === 'pdf-lib' && !look);
      const capture = refuses ? { '/_beltype/caster/src/emit/structureEmit.js': '/_beltype/identity/capture-emit.js' } : {};
      const served = parts.spliceHead(fs.readFileSync(doc.file, 'utf8'), `<script type="importmap">${JSON.stringify({ imports: { ...imports, ...capture } })}</script>\n  ${parts.ciceroEngine.headHtml('/')}`);
      const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: 'block', ...(look ? { deviceScaleFactor: look.scale } : {}) });
      try {
        const missing = new Set<string>();
        await answerFromDisk(context, missing, { root, docPath, served, dirs, files: cicero.files, ...(refuses ? { bodies: { '/_beltype/identity/capture-emit.js': CAPTURE_EMIT } } : {}) });
        const page = await context.newPage();
        await page.goto(ORIGIN + docPath, { waitUntil: 'load' });
        const cut: { refused?: string; at?: string } = await page.evaluate(parts.cutInPage, { cicero: {}, measures: false });
        if (cut.refused !== undefined) throw new CasterError(`identity: ${doc.name}: the ${cut.at} step refused: ${cut.refused}`);
        await visit(doc, page, { started, refuses, missing });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

/** Print every document through the door. */
async function printCorpus(docs: Doc[], each: (doc: Doc, printed: Printed) => void | Promise<void>) {
  await throughDoor(docs, async (doc, page, { started, refuses, missing }) => {
    const answer = await page.evaluate(printInPage, { options: { ...doc.options, ...(WRITER === 'forme' ? { writer: 'forme' } : {}) }, created: FIXED_CREATED });
    if ('refused' in answer && !(refuses && answer.list)) throw new CasterError(`identity: ${doc.name}: the print refused: ${answer.refused}`);
    if (refuses && !('refused' in answer)) throw new CasterError(`identity: ${doc.name}: the print was expected to refuse in the writer, and printed`);
    if (missing.size) throw new CasterError(`identity: ${doc.name} asked for what the run cannot give it:\n  ${[...missing].join('\n  ')}`);
    const blobs = Object.fromEntries(Object.entries(answer.blobs ?? {}).map(([hash, b64]) => [hash, Buffer.from(b64, 'base64')]));
    if ('refused' in answer) await each(doc, { bytes: Buffer.alloc(0), list: answer.list as string, blobs, report: null, ms: Date.now() - started, refused: answer.message });
    else await each(doc, { bytes: Buffer.from(answer.base64, 'base64'), list: answer.list, blobs, report: JSON.parse(answer.report), ms: Date.now() - started });
  });
}

/** The same document printed by `beltype print` itself, its dates set to the door's. */
function viaCli(doc: Doc): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caster-identity-'));
  try {
    const out = path.join(dir, 'out.pdf');
    execFileSync(process.execPath, [path.join(CLI, 'dist', 'src', 'cli.js'), 'print', doc.file, '-o', out, '--printer', 'caster'], { stdio: 'pipe' });
    return cliDated(fs.readFileSync(out));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The commits the corpus is printed with: this checkout's, and the Cicero checkout's the CLI's door serves (`node_modules/@beltype/cicero`, a link to the sibling), each short. */
function heads(): { caster: string; cicero: string } {
  const rev = (cwd: string) => execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd }).toString().trim();
  return { caster: rev(PACKAGE), cicero: rev(fs.realpathSync(path.join(CLI, 'node_modules', '@beltype', 'cicero'))) };
}

// ---- the verbs -------------------------------------------------------------------------------------------------------

/** One recorded document, as `corpus.json` lists it: a file's hash and size, or, for a document that `refuses`, the writer's refusal. */
type Entry = { name: string; why: string; sha256?: string; bytes?: number; refused?: string; options?: Record<string, unknown>; cli?: 'same' | string; list?: { bytes: number; blobs: string[] } };

async function record(dir: string, listOut: string | null) {
  fs.mkdirSync(dir, { recursive: true });
  const entries: Entry[] = [];
  const started = Date.now();
  await printCorpus(CORPUS, (doc, printed) => {
    const file = printed.refused === undefined ? fixedDated(printed.bytes) : null;
    if (file) fs.writeFileSync(path.join(dir, `${doc.name}.pdf`), file);
    const entry: Entry = { name: doc.name, why: doc.why, ...(file ? { sha256: sha256(file), bytes: file.length } : { refused: printed.refused }), ...(doc.options ? { options: doc.options } : {}) };
    if (doc.cli && file) entry.cli = cliVerdict(doc, file);
    if (listOut) {
      fs.mkdirSync(path.join(listOut, 'blobs'), { recursive: true });
      for (const [hash, bytes] of Object.entries(printed.blobs)) {
        if (sha256(bytes) !== hash) throw new CasterError(`identity: ${doc.name}: a blob is not stored under its own SHA-256 (${hash})`);
        fs.writeFileSync(path.join(listOut, 'blobs', hash), bytes);
      }
      fs.writeFileSync(path.join(listOut, `${doc.name}.json`), `${printed.list}\n`);
      if (file) fs.writeFileSync(path.join(listOut, `${doc.name}.report.json`), `${JSON.stringify(snapshot(printed.report), null, 1)}\n`);
      entry.list = { bytes: Buffer.byteLength(printed.list), blobs: Object.keys(printed.blobs).sort() };
    }
    entries.push(entry);
    console.log(`${doc.name.padEnd(18)} ${file ? `${String(file.length).padStart(9)} bytes` : '  refused'}  ${seconds(printed.ms)}${entry.cli ? `  cli: ${entry.cli}` : ''}${entry.list ? `  list ${entry.list.bytes} bytes, ${entry.list.blobs.length} blobs` : ''}`);
  });
  fs.writeFileSync(path.join(dir, 'corpus.json'), `${JSON.stringify({ ...heads(), documents: entries }, null, 1)}\n`);
  console.log(`recorded ${entries.length} documents into ${dir} in ${seconds(Date.now() - started)}`);
  return 0;
}

function cliVerdict(doc: Doc, file: Buffer): string {
  const cli = viaCli(doc);
  return cli.equals(file) ? 'same' : `differs: ${describe(file, cli).split('\n')[0]}`;
}

async function check(dir: string) {
  const recorded: { caster?: string; cicero?: string; documents: Entry[] } = JSON.parse(fs.readFileSync(path.join(dir, 'corpus.json'), 'utf8'));
  // A Cicero that moved layout makes the corpus differ with no change in Caster (the stage 0 results of the Rust writer); naming both commits when they moved says where to look first.
  const now = heads();
  if (recorded.caster !== now.caster || recorded.cicero !== now.cicero) console.log(`recorded with caster ${recorded.caster ?? '?'} and cicero ${recorded.cicero ?? '?'}; printing with caster ${now.caster} and cicero ${now.cicero}`);
  const names = new Set(recorded.documents.map((d) => d.name));
  const started = Date.now();
  let failures = 0;
  let seen = 0;
  await printCorpus(CORPUS.filter((d) => names.has(d.name)), (doc, printed) => {
    seen++;
    const entry = recorded.documents.find((d) => d.name === doc.name) as Entry;
    const problems: string[] = [];
    if (entry.refused !== undefined || printed.refused !== undefined) {
      if (printed.refused !== entry.refused) problems.push(`refused ${JSON.stringify(printed.refused ?? null)}, recorded ${JSON.stringify(entry.refused ?? null)}`);
      const listFile = path.join(dir, `${doc.name}.json`);
      if (fs.existsSync(listFile)) {
        const differs = firstDifference(JSON.parse(fs.readFileSync(listFile, 'utf8')), JSON.parse(printed.list));
        if (differs) problems.push(`the list differs first at ${differs}`);
      }
      if (problems.length) { failures++; console.log(`DIFFERS ${doc.name}\n  ${problems.join('\n  ')}`); } else console.log(`same    ${doc.name.padEnd(18)} ${seconds(printed.ms)}  refused as recorded`);
      return;
    }
    const now = fixedDated(printed.bytes);
    if (sha256(now) !== entry.sha256) {
      const file = path.join(dir, `${doc.name}.pdf`);
      problems.push(fs.existsSync(file) ? describe(fs.readFileSync(file), now) : `the file's SHA-256 is ${sha256(now)}, recorded ${entry.sha256}`);
      fs.writeFileSync(path.join(os.tmpdir(), `caster-identity-${doc.name}.fresh.pdf`), now);
    }
    const reportFile = path.join(dir, `${doc.name}.report.json`);
    if (fs.existsSync(reportFile)) {
      const differs = firstDifference(JSON.parse(fs.readFileSync(reportFile, 'utf8')), snapshot(printed.report));
      if (differs) problems.push(`the report differs first at ${differs}`);
    }
    if (doc.cli && entry.cli === 'same' && WRITER === 'pdf-lib') {
      const verdict = cliVerdict(doc, now);
      if (verdict !== 'same') problems.push(`beltype print ${verdict}`);
    }
    if (problems.length) { failures++; console.log(`DIFFERS ${doc.name}\n  ${problems.join('\n  ')}`); } else console.log(`same    ${doc.name.padEnd(18)} ${seconds(printed.ms)}`);
  });
  if (seen !== names.size) { failures++; console.log(`FAIL ${names.size - seen} recorded documents did not print`); }
  console.log(`${failures ? `${failures} FAILED` : 'all identical'} (${names.size} documents, ${seconds(Date.now() - started)})`);
  return failures ? 1 : 0;
}

/** One row of the gap table. */
type Gap = { name: string; stubs: string[]; result: string; ms: number };

/**
 * Replay every saved list in node and compare bytes.
 *
 * @remarks
 * No stub is left and nothing is handed beside the list: the writer is called with the list alone, as `emitStructure(list)`, since stage 4 of the plan took the report's join to the walk's text origins (`originOf`) out of the writer and into `print()`.
 *
 * @param without - Stubs to leave out, to measure what each one stands in for; kept for the stubs a later stage may need, and none is installed now.
 */
async function replay(dir: string, without: Set<string>, out: string | null) {
  if (out) return replayForme(dir, out);
  const { load } = await import('../src/capabilities.ts');
  const { loadSubsetter } = await import('../src/fonts/hbSubset.ts');
  const { emitStructure } = await import('../src/emit/structureEmit.ts');
  const { validateList } = await import('../src/displayList/validate.ts');
  const recorded: { documents: Entry[] } = JSON.parse(fs.readFileSync(path.join(dir, 'corpus.json'), 'utf8'));
  await load(['pdf', 'fontkit', 'hbSubset', 'fastPng']);
  await loadSubsetter();
  const gaps: Gap[] = [];
  for (const entry of recorded.documents) {
    const listFile = path.join(dir, `${entry.name}.json`);
    if (!fs.existsSync(listFile)) { gaps.push({ name: entry.name, stubs: [], result: 'no saved list (record with --list-out)', ms: 0 }); continue; }
    const started = performance.now();
    const stubs: string[] = [];
    let result: string;
    try {
      const list = JSON.parse(fs.readFileSync(listFile, 'utf8'));
      list.resources.blobs = {};
      for (const hash of entry.list?.blobs ?? []) {
        const bytes = new Uint8Array(fs.readFileSync(path.join(dir, 'blobs', hash)));
        if (sha256(bytes) !== hash) throw new CasterError(`replay: the blob ${hash} is not what its name says`);
        list.resources.blobs[hash] = bytes;
      }
      const checked = performance.now();
      validateList(list);
      const validMs = performance.now() - checked;
      const colour = list.writing.colour !== undefined;
      if (entry.refused !== undefined) {
        const refusal = await emitStructure(list).then(() => null, (error) => String((error as Error)?.message ?? error));
        result = refusal === entry.refused ? 'refused as recorded' : `DIFFERS: refused ${JSON.stringify(refusal)}, recorded ${JSON.stringify(entry.refused)}`;
        gaps.push({ name: entry.name, stubs, result, ms: performance.now() - started });
        continue;
      }
      const emitted = await emitStructure(list);
      const now = Buffer.from(emitted.bytes);
      const was = fs.readFileSync(path.join(dir, `${entry.name}.pdf`));
      result = `${was.equals(now) ? 'identical' : `DIFFERS: ${describe(was, now)}`}\n    colour ${colour ? 'on' : 'off'}, valid in ${validMs.toFixed(2)} ms`;
    } catch (error) {
      result = `THROWS: ${String((error as Error)?.message ?? error).split('\n')[0]}`;
    }
    gaps.push({ name: entry.name, stubs, result, ms: performance.now() - started });
  }
  for (const gap of gaps) console.log(`${gap.name.padEnd(18)} ${seconds(gap.ms).padStart(7)}  ${gap.result}`);
  console.log(`stubs: ${[...new Set(gaps.flatMap((g) => g.stubs))].join(', ') || 'none'}; nothing beside the list${without.size ? `; left out: ${[...without].join(', ')}` : ''}`);
  return gaps.every((g) => g.result.startsWith('identical') || g.result === 'refused as recorded') ? 0 : 1;
}

/**
 * Write every saved list with forme's vendored module in node, into `out`: `<name>.pdf` and `<name>.records.json` for `compare`, and a `corpus.json` naming forme's files by their SHA-256 for `check --writer forme <out>`.
 *
 * @remarks
 * The list is handed as `print()` hands it, through `emit/forme.ts`, its blobs checked against their names first. A list the oracle refuses (`refuses`) is one forme writes, so its entry here is a file. Each list is written twice and the two files must be one, and the time of each write is printed: the second, with the module compiled and the glue initialised, is the write's own.
 */
async function replayForme(dir: string, out: string) {
  const { load } = await import('../src/capabilities.ts');
  const { writeWithForme } = await import('../src/emit/forme.ts');
  const recorded: { documents: Entry[] } = JSON.parse(fs.readFileSync(path.join(dir, 'corpus.json'), 'utf8'));
  await load(['forme']);
  fs.mkdirSync(out, { recursive: true });
  const entries: Entry[] = [];
  let failures = 0;
  for (const entry of recorded.documents) {
    const listFile = path.join(dir, `${entry.name}.json`);
    if (!fs.existsSync(listFile)) { failures++; console.log(`${entry.name.padEnd(18)} no saved list (record with --list-out)`); continue; }
    try {
      const list = JSON.parse(fs.readFileSync(listFile, 'utf8'));
      list.resources.blobs = {};
      for (const hash of entry.list?.blobs ?? []) {
        const bytes = new Uint8Array(fs.readFileSync(path.join(dir, 'blobs', hash)));
        if (sha256(bytes) !== hash) throw new CasterError(`replay: the blob ${hash} is not what its name says`);
        list.resources.blobs[hash] = bytes;
      }
      const times: number[] = [];
      const files: Buffer[] = [];
      let records: unknown = null;
      for (let i = 0; i < 2; i++) {
        const started = performance.now();
        const written = await writeWithForme(list);
        times.push(performance.now() - started);
        files.push(Buffer.from(written.bytes));
        records = written.records;
      }
      const file = fixedDated(files[0]);
      fs.writeFileSync(path.join(out, `${entry.name}.pdf`), file);
      fs.writeFileSync(path.join(out, `${entry.name}.records.json`), `${JSON.stringify(records)}\n`);
      entries.push({ name: entry.name, why: entry.why, sha256: sha256(file), bytes: file.length, ...(entry.options ? { options: entry.options } : {}) });
      const twice = files[0].equals(files[1]);
      if (!twice) failures++;
      console.log(`${entry.name.padEnd(18)} ${String(file.length).padStart(9)} bytes  ${sha256(file).slice(0, 12)}  ${times.map((t) => `${t.toFixed(1)} ms`).join(', ')}${twice ? '' : '  DIFFERS: written twice, two files'}`);
    } catch (error) {
      failures++;
      console.log(`${entry.name.padEnd(18)} THROWS: ${String((error as Error)?.message ?? error).split('\n')[0]}`);
    }
  }
  fs.writeFileSync(path.join(out, 'corpus.json'), `${JSON.stringify({ ...heads(), writer: 'forme', documents: entries }, null, 1)}\n`);
  console.log(`${failures ? `${failures} FAILED` : `wrote ${entries.length} files with forme`} into ${out}`);
  return failures ? 1 : 0;
}

/** The device pixels a CSS px the browser's gate looks at the page with, as a screen of twice the density shows it. */
const LOOK_SCALE = 2;

/**
 * Every presented page and every `data-drawing` element, in CSS px from the document's top left; runs in the page. Each page is first moved by the fraction of a device pixel its layout left it at, so that its top left falls on a whole device pixel as a PDF renderer's page does.
 */
function drawingsInPage(scale: number) {
  const host = document.querySelector('beltype-root');
  const pageElements = [...(host?.shadowRoot ?? document).querySelectorAll('beltype-page')] as HTMLElement[];
  const box = (e: Element) => { const r = e.getBoundingClientRect(); return [r.left + scrollX, r.top + scrollY, r.width, r.height]; };
  for (const element of pageElements) {
    const [x, y] = box(element);
    const fx = x * scale - Math.floor(x * scale);
    const fy = y * scale - Math.floor(y * scale);
    element.style.translate = `${-fx / scale}px ${-fy / scale}px`;
  }
  const pages = pageElements.map(box);
  const drawings = [...document.querySelectorAll('[data-drawing]')].map((e) => ({ name: e.getAttribute('data-drawing') as string, at: box(e) })).filter((d) => d.at[2] > 0 && d.at[3] > 0);
  return { pages, drawings };
}

/**
 * `browser <dir>`: every corpus document with drawings (`data-drawing`), looked at through the door as its author sees it and held, drawing by drawing, to the oracle's file in `fixtures/lists/` and forme's in `<dir>` by `againstBrowser` (`scripts/compare.ts`).
 *
 * @param out - `--out <dir>`: each drawing's crops as PNG.
 */
async function browserGate(dir: string, out: string | null) {
  const { againstBrowser } = await import('./compare.ts');
  const { decode } = await import('fast-png');
  const docs = CORPUS.filter((d) => fs.readFileSync(d.file, 'utf8').includes('data-drawing="'));
  let failed = 0;
  await throughDoor(docs, async (doc, page) => {
    const seen = await page.evaluate(drawingsInPage, LOOK_SCALE);
    const full = decode(await page.screenshot({ fullPage: true, scale: 'device', type: 'png' }));
    const shots = seen.pages.map(([x, y, w, h]) => {
      const [x0, y0] = [Math.floor(x * LOOK_SCALE), Math.floor(y * LOOK_SCALE)];
      const [width, height] = [Math.ceil((x + w) * LOOK_SCALE) - x0, Math.ceil((y + h) * LOOK_SCALE) - y0];
      const pixels = new Uint8Array(width * height * full.channels);
      for (let row = 0; row < height; row++) pixels.set(full.data.subarray(((y0 + row) * full.width + x0) * full.channels, ((y0 + row) * full.width + x0 + width) * full.channels), row * width * full.channels);
      return { pixels, width, height, channels: full.channels, scale: LOOK_SCALE };
    });
    const drawings = seen.drawings.map((d) => {
      const page = seen.pages.findIndex(([x, y, w, h]) => d.at[0] >= x - 0.01 && d.at[1] >= y - 0.01 && d.at[0] + d.at[2] <= x + w + 0.01 && d.at[1] + d.at[3] <= y + h + 0.01);
      if (page < 0) throw new CasterError(`identity: ${doc.name}: the drawing ${d.name} lies on no page (its box ${JSON.stringify(d.at)}, the pages ${JSON.stringify(seen.pages)})`);
      const [px, py] = seen.pages[page];
      const [fx, fy] = [Math.floor(px * LOOK_SCALE) / LOOK_SCALE, Math.floor(py * LOOK_SCALE) / LOOK_SCALE];
      return { name: d.name, page, rect: [d.at[0] - fx, d.at[1] - fy, d.at[2], d.at[3]] as [number, number, number, number] };
    });
    failed += await againstBrowser(doc.name, shots, drawings, path.join(LISTS, `${doc.name}.pdf`), path.join(dir, `${doc.name}.pdf`), out);
  }, { scale: LOOK_SCALE });
  console.log(failed ? `${failed} drawings past the line` : 'every drawing within the line');
  return failed ? 1 : 0;
}

const all = process.argv.slice(2);
if (all[0] === 'compare') {
  const onlyAt = all.indexOf('--only');
  const rest = all.filter((_, i) => i > 0 && (onlyAt < 0 || (i !== onlyAt && i !== onlyAt + 1)));
  if (rest.length !== 1) {
    console.error('usage: npm run identity -- compare <dir> [--only text,tags,images]');
    process.exit(2);
  }
  const { compare } = await import('./compare.ts');
  process.exit(await compare(LISTS, path.resolve(rest[0]), onlyAt >= 0 ? all[onlyAt + 1] ?? '' : null));
}
if (all[0] === 'browser') {
  const outAt = all.indexOf('--out');
  const rest = all.filter((_, i) => i > 0 && (outAt < 0 || (i !== outAt && i !== outAt + 1)));
  if (rest.length !== 1) {
    console.error('usage: npm run identity -- browser <dir> [--out <dir>]');
    process.exit(2);
  }
  process.exit(await browserGate(path.resolve(rest[0]), outAt >= 0 ? path.resolve(all[outAt + 1] ?? '.') : null));
}
/** A flag with a value, taken out of `from`: its value, or null where it is absent. */
const take = (from: string[], name: string): string | null => {
  const at = from.indexOf(name);
  if (at < 0) return null;
  const [, value] = from.splice(at, 2);
  return value ?? '';
};
const rest = [...all];
const withoutArg = take(rest, '--without');
const without = new Set((withoutArg ?? '').split(',').filter(Boolean));
const writerArg = take(rest, '--writer');
if (writerArg !== null && writerArg !== 'forme' && writerArg !== 'pdf-lib') { console.error(`identity: --writer takes forme or pdf-lib, not ${JSON.stringify(writerArg)}`); process.exit(2); }
const writer = (writerArg ?? 'pdf-lib') as 'pdf-lib' | 'forme';
WRITER = writer;
const outArg = take(rest, '--out');
const args = rest;
const flag = args.indexOf('--list-out');
const flagValue = flag >= 0 && args[flag + 1] && !args[flag + 1].startsWith('--') ? args[flag + 1] : null;
const listOut = flag >= 0 ? path.resolve(flagValue ?? LISTS) : null;
const [verb, dirArg] = args.filter((_, i) => flag < 0 || (i !== flag && !(flagValue && i === flag + 1)));
const dir = path.resolve(dirArg ?? LISTS);
if (verb !== 'record' && verb !== 'check' && verb !== 'replay') {
  console.error('usage: npm run identity -- record [dir] [--list-out [dir]]\n       npm run identity -- check [dir] [--writer forme]\n       npm run identity -- replay [dir] [--without <stub>]\n       npm run identity -- replay [dir] --writer forme --out <dir>\n       npm run identity -- compare <dir> [--only text,tags,images]\n       npm run identity -- browser <dir> [--out <dir>]\n(dir defaults to fixtures/lists)');
  process.exit(2);
}
if (outArg !== null && (verb !== 'replay' || writer !== 'forme')) { console.error('identity: --out is replay --writer forme\'s'); process.exit(2); }
if (writer === 'forme' && verb === 'replay' && outArg === null) { console.error('identity: replay --writer forme needs --out <dir>'); process.exit(2); }
if (writer === 'forme' && verb === 'record') { console.error('identity: record is the oracle\'s until the flip; write forme\'s files with replay --writer forme --out <dir>'); process.exit(2); }
process.exit(await (verb === 'record' ? record(dir, listOut) : verb === 'check' ? check(dir) : replay(dir, without, outArg === null ? null : path.resolve(outArg))));
