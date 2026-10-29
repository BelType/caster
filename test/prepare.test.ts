/** The print preparation's pure half (D9): the counter a marker falls back to when `::marker`'s computed content is `normal`, which is what Chromium answers for every ordinary numbered list. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roman, alpha, pairsOf, resolveGenerated, GEOMETRY_PROPERTIES, taskMark, TASK_MARKS } from '../src/adapters/prepare.ts';
import { CasterError } from '../src/errors.ts';
import { groundOf } from '../src/adapters/cicero.ts';

test('roman numerals, over the range a page number can reach', () => {
  assert.equal(roman(1), 'I');
  assert.equal(roman(4), 'IV');
  assert.equal(roman(9), 'IX');
  assert.equal(roman(14), 'XIV');
  assert.equal(roman(40), 'XL');
  assert.equal(roman(1987), 'MCMLXXXVII');
  assert.equal(roman(3999), 'MMMCMXCIX');
  assert.equal(roman(0), '0', 'out of range answers with the number rather than an empty marker');
});

test('bijective base-26, which is what an alphabetic list counts in', () => {
  assert.equal(alpha(1), 'A');
  assert.equal(alpha(26), 'Z');
  assert.equal(alpha(27), 'AA');
  assert.equal(alpha(52), 'AZ');
  assert.equal(alpha(53), 'BA');
  assert.equal(alpha(703), 'AAA');
});

test('the four geometry properties are registered with the guide\'s syntax and initial value', () => {
  assert.deepEqual(GEOMETRY_PROPERTIES, [
    { name: '--pdf-bleed', syntax: '<length>', initialValue: '0px' },
    { name: '--pdf-trim-inset', syntax: '<length>', initialValue: '0px' },
    { name: '--pdf-marks', syntax: '*', initialValue: 'none' },
    { name: '--pdf-page-label', syntax: '*', initialValue: '' }
  ]);
});

/** The generated-content resolver's pure half: `getComputedStyle` answers with the SPECIFIED `counter(h2) ". "` and never a used value, so the counters are resolved here and the parser is the part that can be wrong. */

test('counter-reset / counter-increment / counter-set parse into name-value pairs, with the right fallback each', () => {
  assert.deepEqual(pairsOf('none'), []);
  assert.deepEqual(pairsOf(''), []);
  assert.deepEqual(pairsOf('h2 0'), [['h2', 0]]);
  assert.deepEqual(pairsOf('a 1 b 3'), [['a', 1], ['b', 3]]);
  // A bare name resets to 0 and increments by 1 — the two defaults the properties differ on.
  assert.deepEqual(pairsOf('section'), [['section', 0]]);
  assert.deepEqual(pairsOf('section', 1), [['section', 1]]);
  assert.deepEqual(pairsOf('a b 2', 1), [['a', 1], ['b', 2]]);
  assert.deepEqual(pairsOf('a -1'), [['a', -1]]);
});

test('content resolves strings, counter(), counters() and attr(), and refuses everything else by name', () => {
  const scopes = [{ name: 'h2', value: 3, ownerDepth: 1 }, { name: 'sec', value: 2, ownerDepth: 1 }, { name: 'sec', value: 7, ownerDepth: 3 }];
  const el = ({ getAttribute: ( n: string) => (n === 'data-tag' ? 'NOTE' : null) } as any);
  const at = ( content: string) => resolveGenerated(content, el, scopes, 'h2', '::before');

  assert.equal(at('counter(h2) ". "'), '3. ');
  assert.equal(at('"§ " counter(h2)'), '§ 3');
  assert.equal(at('counter(h2, upper-roman)'), 'III');
  assert.equal(at('counter(h2, lower-alpha)'), 'c');
  // An unknown counter is zero, which is what a browser paints rather than nothing.
  assert.equal(at('counter(nobody)'), '0');
  // `counters()` is the one place the SCOPE STACK matters rather than the innermost value: both `sec` scopes join.
  assert.equal(at('counters(sec, ".")'), '2.7');
  assert.equal(at('counters(sec, "-", upper-alpha)'), 'B-G');
  assert.equal(at('attr(data-tag) ": "'), 'NOTE: ');
  // An escaped quote inside the string survives, which is how an author writes one.
  assert.equal(at('"a \\"b\\" c"'), 'a "b" c');

  assert.throws(() => at('url("mark.png")'), ( e: any) => e instanceof CasterError && /url\(\) on h2::before/.test(e.message));
  assert.throws(() => at('open-quote'), ( e: any) => e instanceof CasterError && /open-quote/.test(e.message));
});

/** The `@page` ground: what a page paints under everything, read off the page host Cicero forwarded the declaration to. */

test('a page ground composites its own alpha against the medium, and paints nothing where the medium already is', () => {
  assert.deepEqual(groundOf('rgb(253, 242, 208)'), [253, 242, 208]);
  // Nothing is behind a page, so the sheet is the other operand and the alpha resolves here.
  assert.deepEqual(groundOf('rgba(0, 0, 0, 0.1)'), [230, 230, 230]);
  assert.deepEqual(groundOf('rgb(0 0 0 / 0.5)'), [128, 128, 128]);
  // White is the medium and a transparent page is the medium: both paint nothing, which is what keeps a rectangle off every page of every document that declares no background.
  assert.equal(groundOf('rgb(255, 255, 255)'), null);
  assert.equal(groundOf('rgba(0, 0, 0, 0)'), null);
  assert.equal(groundOf('rgba(1, 2, 3, 0)'), null);
  // A colour that composites TO white is the same paint as white, and is skipped for the same reason.
  assert.equal(groundOf('rgba(255, 255, 255, 0.4)'), null);
  assert.equal(groundOf('transparent'), null, 'a keyword getComputedStyle never answers with is refused rather than guessed at');
});

test('a task state is text the walk can measure, and ASCII so any face covers it (M3)', () => {
  assert.equal(taskMark(false), '[ ]');
  assert.equal(taskMark(true), '[x]');
  for (const mark of Object.values(TASK_MARKS)) assert.ok(/^[\x20-\x7e]+$/.test(mark), `${JSON.stringify(mark)} is ASCII`);
});
