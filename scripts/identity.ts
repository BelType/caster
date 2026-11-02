/**
 * `npm run identity -- record|check|replay [dir]`: the byte-identity gate of the round that closes the display list, and the replay that measures how far the writer is from a function of the list.
 *
 * @remarks
 * Ported from the monorepo's `packages/caster/scripts/identity.js` (Caster 0.32.0), which is a model and not a dependency: its corpus and doors (the editing tools, the CLI's `Orchestrator`, Paged.js) are not this repository's. The shape is kept: `record` prints the corpus and writes each file with `/CreationDate` and `/ModDate` zeroed, `check` prints it again and compares bytes, and a file in which the pattern matches no date is a failure, so a change of pdf-lib that moved the dates cannot turn the gate into a quiet pass.
 *
 * **The door is the CLI's.** Each document is served from disk on the CLI's made-up origin, cut by Cicero with the CLI's own `cutInPage` and its own Cicero (both read from the CLI checkout at `BELTYPE_CLI`, the sibling `../cli` by default, never declared as a dependency), and printed by this checkout's `dist/` in the page, which hands back the display list and the report beside the bytes. A document marked `cli` is also printed by `beltype print` itself, and its file must equal the door's, which is what makes the door the CLI's and not a second one.
 *
 * **`--list-out`** on `record` also writes, for every document, the display list without its blobs (`<name>.json`), each blob once under its SHA-256 in `blobs/`, the report with what varies by run removed (`<name>.report.json`), and what the writer was handed outside the list (`<name>.writer.json`: the document's base URI, the resolved flags, the walk's needs, and HarfBuzz's advance for every glyph the text items show, which is the stub replay installs). `check` compares the report snapshot as well as the bytes wherever one was recorded.
 *
 * **`replay`** runs in node with no browser: it reads each saved list, checks every blob against its hash, hands the list to `emitStructure` with the stubs it still needs, and compares the bytes with the recorded file. What differs or throws is the gap the round closes; nothing here fixes it.
 *
 * Kept out of `npm test`: it prints eight documents in Chromium.
 *
 * @see /Users/egildo/Privata/dev/beltype/.claude/plans/the-rust-writer/plan-close-the-list.md (stage 0)
 * @packageDocumentation
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type BrowserContext } from 'playwright-core';
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

/** What replaces a date. The same length as pdf-lib's `D:YYYYMMDDHHmmssZ`, so no offset after it moves. */
const FIXED_DATE = 'D:20000101000000Z';
const DATE_PATTERN = /(\/(?:CreationDate|ModDate) \()D:[^)]*\)/gu;

/**
 * One document of the corpus.
 *
 * @property root - The folder served at the origin's root; the document's own folder when absent, as `beltype print` serves it.
 * @property options - Caster's flags for this print; the defaults when absent, as `beltype print` passes them.
 * @property cli - Also printed by `beltype print`, whose file must equal the door's.
 * @property why - The road the document is in the corpus for.
 */
type Doc = { name: string; file: string; root?: string; options?: Record<string, unknown>; cli?: boolean; why: string };

const CORPUS: Doc[] = [
  { name: 'paper', file: path.join(SPECIMENS, 'paper', 'index.html'), cli: true, why: 'the large document: `@beltype/specimens` paper, four pages of running text, notes, a table, three variable faces' },
  { name: 'cast', file: path.join(FIXTURES, 'cast', 'index.html'), cli: true, why: 'a hand-written document with margin boxes, a page counter, a figure and a passed-through PNG' },
  { name: 'cast-divided-row', file: path.join(FIXTURES, 'cast-divided-row', 'index.html'), root: FIXTURES, why: 'a table row divided across pages' },
  { name: 'roads', file: path.join(FIXTURES, 'roads', 'index.html'), root: FIXTURES, options: { blackText: '100k' }, why: 'rotated text, a gradient with a soft mask, a radial shading, a spot ink with overprint, a CMYK ground, print marks with a bleed, a blurred shadow (the raster fallback), hyphenation, sub and superscript, internal and external links, `blackText: 100k`' },
  { name: 'facsimile', file: path.join(FIXTURES, 'roads', 'facsimile.html'), root: FIXTURES, why: 'a page of another PDF, reopened by pdf-lib inside the writer' },
  { name: 'webp', file: path.join(FIXTURES, 'roads', 'webp.html'), root: FIXTURES, why: 'a WebP, which the writer decodes through the browser' },
  { name: 'arithmetic', file: path.join(FIXTURES, 'roads', 'arithmetic.html'), root: FIXTURES, why: 'an arithmetic-coded JPEG, which the writer decodes through the browser' },
  { name: 'photo', file: path.join(FIXTURES, 'roads', 'photo.html'), root: FIXTURES, why: 'an opaque 8-bit RGB PNG of 255 000 pixels, which the photo rule may re-encode through the browser' }
];

// ---- small helpers ---------------------------------------------------------------------------------------------------

const sha256 = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * Zero the two dates pdf-lib writes.
 *
 * @throws {CasterError} Where the file has no date to zero, because that is a change of pdf-lib and not a pass.
 */
function zeroDates(bytes: Uint8Array): Buffer {
  let count = 0;
  const text = Buffer.from(bytes).toString('latin1').replace(DATE_PATTERN, (_, head) => { count++; return `${head}${FIXED_DATE})`; });
  if (count === 0) throw new CasterError('identity: no /CreationDate or /ModDate found in the file; the dates moved and the gate must be taught where');
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

/** What the page hands back: the file, the list without its blobs, the blobs, the report, and what the writer was handed outside the list. */
type Printed = { bytes: Buffer; list: string; blobs: Record<string, Buffer>; report: unknown; writer: Writer; ms: number };
/** What the writer is handed today beside the list, recorded so replay can hand it over again. */
type Writer = { baseUri: string; options: Record<string, unknown>; needs: Record<string, unknown>; widths: Record<string, Record<string, number>> };

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
 * The widths are asked of the same HarfBuzz module the print used (one URL, one module instance), with the call the writer makes, for every glyph a text item shows, each instance's space glyph, and glyph 0.
 */
async function printInPage(options: Record<string, unknown>) {
  try {
    const load = (url: string) => import(url);
    const caster = await load('/_beltype/caster/src/index.js');
    const hb = await load('/_beltype/caster/src/fonts/hbShaper.js');
    const axis = await load('/_beltype/caster/src/fonts/axisMap.js');
    const started = performance.now();
    const printed = await caster.print({ document }, options);
    const ms = performance.now() - started;
    const base64 = (bytes: Uint8Array) => {
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(binary);
    };
    const list = printed.displayList;
    const blobs: Record<string, string> = {};
    for (const [hash, bytes] of Object.entries(list.resources.blobs as Record<string, Uint8Array>)) blobs[hash] = base64(bytes);
    const gids = new Map<string, Set<number>>();
    for (const page of list.pages) {
      for (const item of page.items) {
        if (item.kind !== 'text') continue;
        const set = gids.get(item.font) ?? new Set([0]);
        for (const gid of item.glyphs.ids) set.add(gid);
        if (typeof item.space === 'number') set.add(item.space);
        gids.set(item.font, set);
      }
    }
    const widths: Record<string, Record<string, number>> = {};
    for (const [key, set] of gids) {
      const instance = list.resources.fonts[key];
      const variations = axis.shaperVariations(instance.coords);
      const table: Record<string, number> = {};
      for (const gid of [...set].sort((a, b) => a - b)) table[gid] = hb.glyphAdvance(instance.url, gid, variations);
      widths[`${instance.url}|${JSON.stringify(variations ?? null)}`] = table;
    }
    const bare = JSON.stringify({ ...list, resources: { ...list.resources, blobs: undefined } });
    return { base64: base64(printed.bytes), list: bare, blobs, report: JSON.stringify(printed.report), writer: { baseUri: document.baseURI, options: printed.report.options, needs: printed.report.needs, widths }, ms };
  } catch (error) {
    return { refused: String((error as Error | undefined)?.stack ?? error) };
  }
}

/** Every request answered from disk, as `beltype print` answers it; anything else is a refusal. */
async function answerFromDisk(context: BrowserContext, missing: Set<string>, o: { root: string; docPath: string; served: string; dirs: Record<string, string>; files: Record<string, string> }) {
  const within = (dir: string, rel: string) => {
    const file = path.resolve(dir, rel);
    const inside = path.relative(dir, file);
    return !inside.startsWith('..') && !path.isAbsolute(inside) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
  };
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) { missing.add(url.href); return route.abort('blockedbyclient'); }
    if (url.pathname === o.docPath) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: o.served });
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

/** Print every document through one browser, a fresh context each. */
async function printCorpus(docs: Doc[], each: (doc: Doc, printed: Printed) => void | Promise<void>) {
  const parts = await cliParts();
  const cicero = parts.ciceroEngine.vendorAssets();
  // `caster` is this checkout's `dist/`, as `beltype print` serves the Caster it resolves.
  const dirs = { ...cicero.dirs, caster: path.join(PACKAGE, 'dist'), common: parts.common };
  const imports = Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/_beltype/common/${m}.js`]));
  const browser = await chromium.launch({ headless: true, args: ARGS });
  try {
    for (const doc of docs) {
      const started = Date.now();
      const root = doc.root ?? path.dirname(doc.file);
      const docPath = `/${path.relative(root, doc.file).split(path.sep).map(encodeURIComponent).join('/')}`;
      const served = parts.spliceHead(fs.readFileSync(doc.file, 'utf8'), `<script type="importmap">${JSON.stringify({ imports })}</script>\n  ${parts.ciceroEngine.headHtml('/')}`);
      const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: 'block' });
      try {
        const missing = new Set<string>();
        await answerFromDisk(context, missing, { root, docPath, served, dirs, files: cicero.files });
        const page = await context.newPage();
        await page.goto(ORIGIN + docPath, { waitUntil: 'load' });
        const cut: { refused?: string; at?: string } = await page.evaluate(parts.cutInPage, { cicero: {}, measures: false });
        if (cut.refused !== undefined) throw new CasterError(`identity: ${doc.name}: the ${cut.at} step refused: ${cut.refused}`);
        const answer = await page.evaluate(printInPage, doc.options ?? {});
        if ('refused' in answer) throw new CasterError(`identity: ${doc.name}: the print refused: ${answer.refused}`);
        if (missing.size) throw new CasterError(`identity: ${doc.name} asked for what the run cannot give it:\n  ${[...missing].join('\n  ')}`);
        const blobs = Object.fromEntries(Object.entries(answer.blobs).map(([hash, b64]) => [hash, Buffer.from(b64, 'base64')]));
        await each(doc, { bytes: Buffer.from(answer.base64, 'base64'), list: answer.list, blobs, report: JSON.parse(answer.report), writer: answer.writer, ms: Date.now() - started });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

/** The same document printed by `beltype print` itself, dates zeroed. */
function viaCli(doc: Doc): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caster-identity-'));
  try {
    const out = path.join(dir, 'out.pdf');
    execFileSync(process.execPath, [path.join(CLI, 'dist', 'src', 'cli.js'), 'print', doc.file, '-o', out, '--printer', 'caster'], { stdio: 'pipe' });
    return zeroDates(fs.readFileSync(out));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- the verbs -------------------------------------------------------------------------------------------------------

/** One recorded document, as `corpus.json` lists it. */
type Entry = { name: string; why: string; sha256: string; bytes: number; options?: Record<string, unknown>; cli?: 'same' | string; list?: { bytes: number; blobs: string[] } };

async function record(dir: string, listOut: string | null) {
  fs.mkdirSync(dir, { recursive: true });
  const entries: Entry[] = [];
  const started = Date.now();
  await printCorpus(CORPUS, (doc, printed) => {
    const zeroed = zeroDates(printed.bytes);
    fs.writeFileSync(path.join(dir, `${doc.name}.pdf`), zeroed);
    const entry: Entry = { name: doc.name, why: doc.why, sha256: sha256(zeroed), bytes: zeroed.length, ...(doc.options ? { options: doc.options } : {}) };
    if (doc.cli) entry.cli = cliVerdict(doc, zeroed);
    if (listOut) {
      fs.mkdirSync(path.join(listOut, 'blobs'), { recursive: true });
      for (const [hash, bytes] of Object.entries(printed.blobs)) {
        if (sha256(bytes) !== hash) throw new CasterError(`identity: ${doc.name}: a blob is not stored under its own SHA-256 (${hash})`);
        fs.writeFileSync(path.join(listOut, 'blobs', hash), bytes);
      }
      fs.writeFileSync(path.join(listOut, `${doc.name}.json`), `${printed.list}\n`);
      fs.writeFileSync(path.join(listOut, `${doc.name}.report.json`), `${JSON.stringify(snapshot(printed.report), null, 1)}\n`);
      fs.writeFileSync(path.join(listOut, `${doc.name}.writer.json`), `${JSON.stringify(printed.writer)}\n`);
      entry.list = { bytes: Buffer.byteLength(printed.list), blobs: Object.keys(printed.blobs).sort() };
    }
    entries.push(entry);
    console.log(`${doc.name.padEnd(18)} ${String(zeroed.length).padStart(9)} bytes  ${seconds(printed.ms)}${entry.cli ? `  cli: ${entry.cli}` : ''}${entry.list ? `  list ${entry.list.bytes} bytes, ${entry.list.blobs.length} blobs` : ''}`);
  });
  fs.writeFileSync(path.join(dir, 'corpus.json'), `${JSON.stringify({ caster: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: PACKAGE }).toString().trim(), documents: entries }, null, 1)}\n`);
  console.log(`recorded ${entries.length} documents into ${dir} in ${seconds(Date.now() - started)}`);
  return 0;
}

function cliVerdict(doc: Doc, zeroed: Buffer): string {
  const cli = viaCli(doc);
  return cli.equals(zeroed) ? 'same' : `differs: ${describe(zeroed, cli).split('\n')[0]}`;
}

async function check(dir: string) {
  const recorded: { documents: Entry[] } = JSON.parse(fs.readFileSync(path.join(dir, 'corpus.json'), 'utf8'));
  const names = new Set(recorded.documents.map((d) => d.name));
  const started = Date.now();
  let failures = 0;
  let seen = 0;
  await printCorpus(CORPUS.filter((d) => names.has(d.name)), (doc, printed) => {
    seen++;
    const entry = recorded.documents.find((d) => d.name === doc.name) as Entry;
    const now = zeroDates(printed.bytes);
    const problems: string[] = [];
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
    if (doc.cli && entry.cli === 'same') {
      const verdict = cliVerdict(doc, now);
      if (verdict !== 'same') problems.push(`beltype print ${verdict}`);
    }
    if (problems.length) { failures++; console.log(`DIFFERS ${doc.name}\n  ${problems.join('\n  ')}`); } else console.log(`same    ${doc.name.padEnd(18)} ${seconds(printed.ms)}`);
  });
  if (seen !== names.size) { failures++; console.log(`FAIL ${names.size - seen} recorded documents did not print`); }
  console.log(`${failures ? `${failures} FAILED` : 'all identical'} (${names.size} documents, ${seconds(Date.now() - started)})`);
  return failures ? 1 : 0;
}

/**
 * The HarfBuzz stub, installed by a module hook in place of `src/fonts/hbShaper.ts`: everything the real module exports, and `glyphAdvance` answered from the widths the page recorded.
 *
 * @remarks
 * The real module cannot load in node: its bundle stubs the node builtins on purpose (`scripts/vendor-stubs/node-absent.js`). A glyph the recording does not hold throws, naming it, because a stub that guessed would hide the measurement.
 */
function installShaperStub() {
  const real = new URL('../src/fonts/hbShaper.ts', import.meta.url).href;
  const errors = new URL('../src/errors.ts', import.meta.url).href;
  registerHooks({
    load(url, context, next) {
      if (url !== real) return next(url, context);
      const source = `export * from ${JSON.stringify(`${real}?real`)};
import { CasterError } from ${JSON.stringify(errors)};
export function glyphAdvance(key, gid, variations) {
  const table = globalThis.__replayWidths?.[key + '|' + JSON.stringify(variations ?? null)];
  globalThis.__replayCalls = (globalThis.__replayCalls ?? 0) + 1;
  if (!table || !(gid in table)) throw new CasterError('replay: no recorded HarfBuzz advance for glyph ' + gid + ' of ' + key);
  return table[gid];
}`;
      return { format: 'module', source, shortCircuit: true };
    }
  });
}

/** One row of the gap table. */
type Gap = { name: string; stubs: string[]; result: string; ms: number };

/**
 * Replay every saved list in node and compare bytes.
 *
 * @param without - Stubs to leave out, to measure what each one stands in for: `harfbuzz` (the real shaper module, which cannot load here), `toUnicode`, `fontProfile`, `photoRule`, `baseUri`, `colour`, `dates` (the files compared as printed, with the replay's own dates).
 */
async function replay(dir: string, without: Set<string>) {
  if (!without.has('harfbuzz')) installShaperStub();
  const { load } = await import('../src/capabilities.ts');
  const { loadSubsetter } = await import('../src/fonts/hbSubset.ts');
  const { emitStructure } = await import('../src/emit/structureEmit.ts');
  const { listSegments } = await import('../src/emit/textEmit.ts');
  const { buildToUnicode } = await import('../src/fonts/toUnicode.ts');
  const { SUBSET_FONT_PROFILE } = await import('../src/fonts/fontEmbed.ts');
  const { colourOn } = await import('../src/options.ts');
  const recorded: { documents: Entry[] } = JSON.parse(fs.readFileSync(path.join(dir, 'corpus.json'), 'utf8'));
  await load(['pdf', 'fontkit', 'hbSubset', 'fastPng', 'profiles']);
  if (without.has('harfbuzz')) await load(['harfbuzz']).catch((error) => console.log(`the harfbuzz capability does not load in node: ${String(error?.message ?? error).split('\n')[0]}`));
  await loadSubsetter();
  const icc = (name: string) => new Uint8Array(fs.readFileSync(path.join(PACKAGE, 'profiles', name)));
  const gaps: Gap[] = [];
  for (const entry of recorded.documents) {
    const listFile = path.join(dir, `${entry.name}.json`);
    if (!fs.existsSync(listFile)) { gaps.push({ name: entry.name, stubs: [], result: 'no saved list (record with --list-out)', ms: 0 }); continue; }
    const started = performance.now();
    const stubs = ['harfbuzz', 'originOf', 'toUnicode', 'fontProfile', 'photoRule', 'baseUri', 'dates'].filter((s) => !without.has(s));
    let result: string;
    try {
      const list = JSON.parse(fs.readFileSync(listFile, 'utf8'));
      const writer: Writer = JSON.parse(fs.readFileSync(path.join(dir, `${entry.name}.writer.json`), 'utf8'));
      list.resources.blobs = {};
      for (const hash of new Set(JSON.stringify(list).match(/"blob":"([0-9a-f]{64})"/gu)?.map((m) => m.slice(8, -1)) ?? [])) {
        const bytes = new Uint8Array(fs.readFileSync(path.join(dir, 'blobs', hash)));
        if (sha256(bytes) !== hash) throw new CasterError(`replay: the blob ${hash} is not what its name says`);
        list.resources.blobs[hash] = bytes;
      }
      (globalThis as any).__replayWidths = writer.widths;
      (globalThis as any).__replayCalls = 0;
      const originOf = (page: number, index: number) => ({ run: index, paragraph: 0, path: `replay:${page}:${index}`, color: '', rectPt: [0, 0, 0, 0] as [number, number, number, number] });
      const options = writer.options as any;
      const colour = colourOn(writer.needs, options);
      if (colour && !without.has('colour')) stubs.push('colour');
      const emitted = await emitStructure(list, {
        ...(without.has('fontProfile') ? {} : { fontProfile: { ...SUBSET_FONT_PROFILE, widthDecimals: options.widthDecimals, cffContainer: options.cffContainer } }),
        ...(without.has('toUnicode') ? {} : { toUnicode: buildToUnicode(listSegments(list, originOf)) }),
        ...(without.has('photoRule') ? {} : { photoRule: options.photoRule }),
        ...(without.has('baseUri') ? {} : { baseUri: writer.baseUri }),
        originOf,
        ...(colour && !without.has('colour') ? { color: { profileBytes: icc('default_cmyk.icc'), srgbBytes: icc('srgb.icc'), condition: 'Artifex CMYK SWOP Profile', info: 'Ghostscript default CMYK profile, standing in for a press characterisation', blackText: options.blackText } } : {})
      });
      const now = without.has('dates') ? Buffer.from(emitted.bytes) : zeroDates(emitted.bytes);
      const was = fs.readFileSync(path.join(dir, `${entry.name}.pdf`));
      result = `${was.equals(now) ? 'identical' : `DIFFERS: ${describe(was, now)}`}\n    colour ${colour ? 'on' : 'off'}, ${(globalThis as any).__replayCalls} advances asked`;
    } catch (error) {
      result = `THROWS: ${String((error as Error)?.message ?? error).split('\n')[0]}`;
    }
    gaps.push({ name: entry.name, stubs, result, ms: performance.now() - started });
  }
  for (const gap of gaps) console.log(`${gap.name.padEnd(18)} ${seconds(gap.ms).padStart(7)}  ${gap.result}`);
  console.log(`stubs: ${[...new Set(gaps.flatMap((g) => g.stubs))].join(', ')}${without.size ? `; left out: ${[...without].join(', ')}` : ''}`);
  return gaps.every((g) => g.result.startsWith('identical')) ? 0 : 1;
}

const all = process.argv.slice(2);
const withoutAt = all.indexOf('--without');
const without = new Set(withoutAt >= 0 ? (all[withoutAt + 1] ?? '').split(',').filter(Boolean) : []);
const args = withoutAt >= 0 ? all.filter((_, i) => i !== withoutAt && i !== withoutAt + 1) : all;
const flag = args.indexOf('--list-out');
const flagValue = flag >= 0 && args[flag + 1] && !args[flag + 1].startsWith('--') ? args[flag + 1] : null;
const listOut = flag >= 0 ? path.resolve(flagValue ?? LISTS) : null;
const [verb, dirArg] = args.filter((_, i) => flag < 0 || (i !== flag && !(flagValue && i === flag + 1)));
const dir = path.resolve(dirArg ?? LISTS);
if (verb !== 'record' && verb !== 'check' && verb !== 'replay') {
  console.error('usage: npm run identity -- record [dir] [--list-out [dir]]\n       npm run identity -- check [dir]\n       npm run identity -- replay [dir] [--without harfbuzz,toUnicode,fontProfile,photoRule,baseUri,colour,dates]\n(dir defaults to fixtures/lists)');
  process.exit(2);
}
process.exit(await (verb === 'record' ? record(dir, listOut) : verb === 'check' ? check(dir) : replay(dir, without)));
