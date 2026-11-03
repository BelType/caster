/**
 * The writer's import closure is a short list of modules, none of which names the DOM, a decoder of the browser's, a clock that reaches a byte, chance or the environment: a guard on what `emitStructure`, `recordsOf` and `validateList` can reach, not on what they happen to call.
 *
 * @remarks
 * A sweep of the writer's own files by text would pass while the writer still imported the walk through one pure helper, which is how the closure reached 47 modules and fifteen DOM reads at Caster 0.1.4 (the inventory of `.claude/plans/the-rust-writer/plan-close-the-list.md`, in the BelType monorepo). This reads the value imports and re-exports of the five roots (`emit/structureEmit.ts`, `emit/forme.ts`, the Rust writer's door, `vectors/vectorEmit.ts`, `displayList/records.ts`, `displayList/validate.ts`), transitively, and holds the closure to an allowed list; a module that joins it is a decision to make here, by name, and the refusal names the import chain that brought it. Each module in it is read with its comments removed, and a line that names a forbidden thing fails unless it is excused below with its reason, which the test prints. The clocks excused are the timings the records and the report carry and the writer's pause cadence; none reaches a byte, which the determinism suite proves on the corpus. `crypto.subtle.digest('SHA-256', …)` is allowed: a hash, the same in every realm, which the image and facsimile dedupe and the colour story's profile record read.
 *
 * @see /Users/egildo/Privata/dev/beltype/.claude/plans/the-rust-writer/plan-close-the-list.md (stages 2 and 5)
 * @packageDocumentation
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(new URL('../package.json', import.meta.url))), 'src');

/** Where the closure starts: the writer, the Rust writer's door, its vector half, the records a report derives from the writer's, and the validator. */
const ROOTS = ['emit/structureEmit.ts', 'emit/forme.ts', 'vectors/vectorEmit.ts', 'displayList/records.ts', 'displayList/validate.ts'];

/** Every module the writer may reach, relative to `src/`. */
const ALLOWED = new Set([
  'capabilities.ts', 'errors.ts', 'options.ts',
  'colour/colorResources.ts',
  'coordinates/matrix.ts', 'coordinates/printMarks.ts', 'coordinates/units.ts',
  'displayList/records.ts', 'displayList/validate.ts',
  'emit/document.ts', 'emit/forme.ts', 'emit/outline.ts', 'emit/pdf20-writer.ts', 'emit/structureEmit.ts', 'emit/textEmit.ts',
  'fonts/axisMap.ts', 'fonts/cidFont.ts', 'fonts/clusters.ts', 'fonts/fontEmbed.ts', 'fonts/fontProgram.ts', 'fonts/hbSubset.ts', 'fonts/toUnicode.ts',
  'images/facsimile.ts', 'images/imageEmbed.ts', 'images/jpeg.ts', 'images/png.ts', 'images/samples.ts',
  'vectors/pathData.ts', 'vectors/shading.ts', 'vectors/transparency.ts', 'vectors/vectorEmit.ts',
]);

/** The lines a module in the closure may keep although they name a clock, each with the reason it reaches no byte. */
const EXCUSED: Record<string, { line: RegExp, reason: string }[]> = {
  'capabilities.ts': [{ line: /performance\.now\(\) : Date\.now\(\)/u, reason: 'a capability\'s load time, which the report prints and no byte reads' }],
  'fonts/fontEmbed.ts': [{ line: /const clock = \(\) => performance\.now\(\);/u, reason: 'an instance\'s embed timing (`CidFontStats.ms`), a record the snapshot drops' }],
  'images/facsimile.ts': [{ line: /performance\.now\(\)/u, reason: 'a facsimile\'s `decodeMs`, a record the snapshot drops' }],
  'emit/pdf20-writer.ts': [{ line: /performance\.now\(\);/u, reason: 'when the writer yields to the page, every 50 ms, never what it writes' }],
};

/** What a module may not name outside a comment: the DOM and the browser's canvas and decoders, a clock, chance, the environment, and the platform's crypto beyond a SHA-256 digest. */
const FORBIDDEN = new RegExp([
  String.raw`\bgetComputedStyle`, String.raw`(?<![\w./])document\.`, String.raw`(?<![\w./])window\.`, String.raw`(?<![\w./])navigator\b`,
  String.raw`\bOffscreenCanvas`, 'createImageBitmap', String.raw`new Image\b`, 'querySelector', 'getBoundingClientRect',
  String.raw`new Date\b`, String.raw`Date\.now`, String.raw`performance\.now`,
  String.raw`Math\.random`, 'getRandomValues', 'randomUUID',
  String.raw`(?<![\w./'"])process\.`, String.raw`\bglobalThis\b`,
  String.raw`(?<![\w.])crypto\.(?!subtle\.digest\('SHA-256')`,
].join('|'), 'u');

/** The source with its comments removed, crudely: block comments, and line comments not inside a URL. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:'"`\\])\/\/.*$/gmu, '$1');

/** The closure of value imports and re-exports from the given modules, each with the module that first imported it. */
function closure(roots: string[]): Map<string, string | null> {
  const seen = new Map<string, string | null>();
  const visit = (file: string, from: string | null) => {
    if (seen.has(file)) return;
    seen.set(file, from);
    for (const m of fs.readFileSync(path.join(SRC, file), 'utf8').matchAll(/^(?:import|export)\s+(?!type\b)(?:[^'"]*?from\s+)?['"](\.[^'"]+)['"]/gmu))
      visit(path.relative(SRC, path.resolve(path.dirname(path.join(SRC, file)), m[1])), file);
  };
  roots.forEach((root) => visit(root, null));
  return seen;
}

/** The chain of imports that brought `file` into the closure, from its root. */
function chainOf(reached: Map<string, string | null>, file: string): string {
  const chain = [file];
  for (let from = reached.get(file); from; from = reached.get(from)) chain.unshift(from);
  return chain.join(' → ');
}

/** Every line of the closure that names a forbidden thing and is not excused, with the chain that reached its module. */
function offences(reached: Map<string, string | null>, excused = EXCUSED): string[] {
  return [...reached.keys()].flatMap((file) => code(fs.readFileSync(path.join(SRC, file), 'utf8')).split('\n')
    .filter((line) => FORBIDDEN.test(line) && !excused[file]?.some((e) => e.line.test(line)))
    .map((line) => `${chainOf(reached, file)}: ${line.trim()}`));
}

test('the writer\'s import closure is the allowed list: no walk, no measurement, no host, no adapter, no geometry, no shaper, no decoder of the browser\'s', (t) => {
  const reached = closure(ROOTS);
  const outside = [...reached.keys()].filter((file) => !ALLOWED.has(file));
  assert.equal(outside.length, 0, `outside the allowed list, first by ${outside[0] && chainOf(reached, outside[0])}; all: ${outside.join(', ')}`);
  for (const browser of ['images/canvasDecode.ts', 'images/photoRule.ts', 'images/imagePass.ts', 'images/imagePlace.ts', 'measure/textMeasure.ts', 'walk/structure.ts', 'fonts/hbShaper.ts'])
    assert.ok(!reached.has(browser), `${browser} runs before the list, and the writer does not reach it`);
  t.diagnostic(`${reached.size} modules reached from ${ROOTS.join(', ')}`);
  assert.equal(reached.size, ALLOWED.size, 'every module allowed is reached, so the list says what the closure is');
});

test('no module the writer reaches names the DOM, a decoder of the browser\'s, a clock, chance or the environment, but the excused clocks', (t) => {
  const reached = closure(ROOTS);
  const named = offences(reached);
  assert.equal(named.length, 0, `named, first: ${named[0]}`);
  for (const [file, excuses] of Object.entries(EXCUSED)) {
    assert.ok(reached.has(file), `${file} is in the closure, so its excuse is not stale`);
    const lines = code(fs.readFileSync(path.join(SRC, file), 'utf8')).split('\n').filter((line) => FORBIDDEN.test(line));
    assert.ok(lines.length > 0, `${file} still names what it is excused for`);
    for (const { reason } of excuses) t.diagnostic(`excused in ${file} (${lines.length} line${lines.length === 1 ? '' : 's'}): ${reason}`);
  }
});

test('the guard sees a module that names the DOM, a clock or the environment, and one the list does not allow, and names the chain', () => {
  for (const line of ['const s = getComputedStyle(element);', 'const r = document.createRange();', 'const t = Date.now();', 'const t = performance.now();', 'const n = Math.random();', 'if (process.env.X) {}', 'const g = globalThis.fetch;', 'crypto.getRandomValues(a);', 'navigator.userAgent'])
    assert.ok(FORBIDDEN.test(code(line)), line);
  for (const line of ['// read with getComputedStyle, once\nconst x = 1;', "import { serialize } from './document.ts';", "const d = await crypto.subtle.digest('SHA-256', bytes);"])
    assert.ok(!FORBIDDEN.test(code(line)), line);
  const placement = closure(['images/imagePlace.ts']);
  assert.ok(placement.has('measure/textMeasure.ts'), 'the placement module reaches the measurement, which is why the writer no longer imports it');
  assert.match(chainOf(placement, 'measure/textMeasure.ts'), /^images\/imagePlace\.ts → .*measure\/textMeasure\.ts$/u);
  const pass = closure(['images/imagePass.ts']);
  assert.ok(pass.has('images/canvasDecode.ts') && pass.has('images/photoRule.ts'), 'the image pass reaches the browser\'s decoder and the photo rule\'s canvas, which is why it runs before the list');
  assert.ok(offences(pass, {}).some((line) => line.includes(' → ') && /createImageBitmap|OffscreenCanvas/u.test(line)), 'and the guard would see them, naming the chain');
  assert.ok(offences(closure(ROOTS), {}).length > 0, 'without the excuses the closure has clocks to excuse');
});
