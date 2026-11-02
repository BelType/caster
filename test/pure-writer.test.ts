/**
 * The writer's import closure reaches no walk, no measurement and no DOM: a guard on what `emitStructure` can reach, not on what it happens to call.
 *
 * @remarks
 * A sweep of the writer's own files by text would pass while the writer still imported the walk through one pure helper, which is how the closure reached 47 modules and fifteen DOM reads at Caster 0.1.4 (the inventory of `.claude/plans/the-rust-writer/plan-close-the-list.md`). This reads the value imports of `src/emit/structureEmit.ts` and `src/vectors/vectorEmit.ts`, transitively, and holds the closure to an allowed list; a module that joins it is a decision to make here, by name. No module in it may name a browser API: the browser's decoders and the photo rule's canvas (`images/canvasDecode.ts`, `images/photoRule.ts`) run in the image pass before the list since stage 3 of the plan, and the writer imports neither.
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

/** Every module the writer may reach, relative to `src/`. */
const ALLOWED = new Set([
  'capabilities.ts', 'errors.ts', 'options.ts',
  'colour/colorResources.ts',
  'coordinates/matrix.ts', 'coordinates/printMarks.ts', 'coordinates/units.ts',
  'displayList/validate.ts',
  'emit/document.ts', 'emit/outline.ts', 'emit/pdf20-writer.ts', 'emit/structureEmit.ts', 'emit/textEmit.ts',
  'fonts/axisMap.ts', 'fonts/cidFont.ts', 'fonts/clusters.ts', 'fonts/fontEmbed.ts', 'fonts/fontProgram.ts', 'fonts/hbSubset.ts', 'fonts/toUnicode.ts',
  'images/facsimile.ts', 'images/imageEmbed.ts', 'images/jpeg.ts', 'images/png.ts', 'images/samples.ts',
  'vectors/pathData.ts', 'vectors/shading.ts', 'vectors/transparency.ts', 'vectors/vectorEmit.ts',
]);
/** One line each module may keep, and why: a clock that fills a report field and never a byte. */
const EXCUSED: Record<string, RegExp> = {
  'capabilities.ts': /performance\.now\(\) : Date\.now\(\)/u,
};

/** What a module may not name outside a comment: the DOM, the browser's canvas and decoders, a clock that reaches a byte, chance. */
const FORBIDDEN = /(\bgetComputedStyle|(?<![\w./])document\.|(?<![\w./])window\.|\bOffscreenCanvas|createImageBitmap|new Image\b|querySelector|getBoundingClientRect|new Date\b|Date\.now|Math\.random)/u;

/** The source with its comments removed, crudely: block comments, and line comments not inside a URL. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:'"`\\])\/\/.*$/gmu, '$1');

/** The closure of value imports from the given modules, each with the module that first imported it. */
function closure(roots: string[]): Map<string, string | null> {
  const seen = new Map<string, string | null>();
  const visit = (file: string, from: string | null) => {
    if (seen.has(file)) return;
    seen.set(file, from);
    for (const m of fs.readFileSync(path.join(SRC, file), 'utf8').matchAll(/^import\s+(?!type\b)(?:[^'"]*?from\s+)?['"](\.[^'"]+)['"]/gmu))
      visit(path.relative(SRC, path.resolve(path.dirname(path.join(SRC, file)), m[1])), file);
  };
  roots.forEach((root) => visit(root, null));
  return seen;
}

test('the writer\'s import closure is the allowed list: no walk, no measurement, no host, no adapter, no geometry, no shaper', () => {
  const reached = closure(['emit/structureEmit.ts', 'vectors/vectorEmit.ts']);
  const outside = [...reached].filter(([file]) => !ALLOWED.has(file)).map(([file, from]) => `${file} (imported by ${from})`);
  assert.deepEqual(outside, [], 'every module the writer reaches is allowed by name');
  for (const browser of ['images/canvasDecode.ts', 'images/photoRule.ts', 'images/imagePass.ts']) assert.ok(!reached.has(browser), `${browser} runs before the list, and the writer does not reach it`);
  assert.ok(reached.size >= 20, `${reached.size} modules read`);
});

test('no module the writer reaches names the DOM, a decoder of the browser\'s, the wall clock or chance', () => {
  const named = [...closure(['emit/structureEmit.ts', 'vectors/vectorEmit.ts']).keys()]
    .flatMap((file) => code(fs.readFileSync(path.join(SRC, file), 'utf8')).split('\n').filter((line) => FORBIDDEN.test(line) && !EXCUSED[file]?.test(line)).map((line) => `${file}: ${line.trim()}`));
  assert.deepEqual(named, []);
});

test('the guard sees a module that names the DOM, and one the list does not allow', () => {
  assert.ok(FORBIDDEN.test(code('const s = getComputedStyle(element);')));
  assert.ok(!FORBIDDEN.test(code('// read with getComputedStyle, once\nconst x = 1;')));
  assert.ok(FORBIDDEN.test('const r = document.createRange();') && !FORBIDDEN.test("import { serialize } from './document.ts';"), 'a module named document is not the DOM');
  assert.ok(closure(['images/imagePlace.ts']).has('measure/textMeasure.ts'), 'the placement module reaches the measurement, which is why the writer no longer imports it');
  const pass = closure(['images/imagePass.ts']);
  assert.ok(pass.has('images/canvasDecode.ts') && pass.has('images/photoRule.ts'), 'the image pass reaches the browser\'s decoder and the photo rule\'s canvas, which is why it runs before the list');
  assert.ok(FORBIDDEN.test(code(fs.readFileSync(path.join(SRC, 'images/canvasDecode.ts'), 'utf8'))), 'and the guard would see them');
});
