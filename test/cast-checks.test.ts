/**
 * The cast acceptance's words comparison (`cast-checks.ts`'s `wordDifferences`), on pages written by hand, with no browser: generated text stands in its own place and nowhere else, and a known defect excuses only what it is.
 *
 * @remarks
 * Ported from the monorepo's `packages/caster/test/cast-checks.test.js`; the monorepo's third review of 2026-10-29 found each failing case below passing.
 *
 * @packageDocumentation
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordDifferences, type Span } from './cast-checks.ts';

const verdict = (found: ReturnType<typeof wordDifferences>) => found.map((d) => ({ page: d.page, excused: d.excused }));

test('a marker or a task state reads only before its own item\'s first word', () => {
  const items = [['First', 'item', 'Second', 'item']];
  const markers = [[{ text: '1.', at: 0 }, { text: '2.', at: 2 }]];
  assert.deepEqual(verdict(wordDifferences(items, markers, ['1.firstitem2.seconditem'])), [], 'in place');
  assert.deepEqual(verdict(wordDifferences(items, markers, ['firstitem1.seconditem2.'])), [{ page: 1, excused: [] }], 'each after its item');
  assert.deepEqual(verdict(wordDifferences(items, markers, ['fi1.rstitemsec2.onditem'])), [{ page: 1, excused: [] }], 'inside a word');
  assert.deepEqual(verdict(wordDifferences(items, markers, ['firstitemseconditem1.2.'])), [{ page: 1, excused: [] }], 'all at the page\'s end');
  const tasks = [['Write', 'it', 'Ship', 'it']];
  const states = [[{ text: '[ ]', at: 0 }, { text: '[x]', at: 2 }]];
  assert.deepEqual(verdict(wordDifferences(tasks, states, ['[]writeit[x]shipit'])), [], 'task states in place');
  assert.deepEqual(verdict(wordDifferences(tasks, states, ['writeit[]shipit[x]'])), [{ page: 1, excused: [] }], 'a task state after its item');
});

test('a formula\'s text may stand after its paragraph\'s, and the paragraph is held to its order', () => {
  const page = [['Before.', 'Inline', 'a2+b2=c2,', 'and', 'on', 'its', 'own', 'line:', 'After.']];
  // The paragraph (place 1) is words 1 to 7; the formula (place 0) is the first 8 characters of word 2, the comma after it the paragraph's.
  const spans: (Span & { role: number })[] = [{ known: 0, role: 1, element: 0, page: 0, from: 1, to: 8, start: [1, 0], end: [7, 5] }, { known: 0, role: 0, element: 1, page: 0, from: 2, to: 3, start: [2, 0], end: [2, 8] }];
  const read = (file: string) => verdict(wordDifferences(page, [[]], [file], spans, [{ after: true }]));
  assert.deepEqual(read('before.inline,andonitsownline:a2+b2=c2after.'), [{ page: 1, excused: [0] }], 'the known defect: the formula after the text');
  assert.deepEqual(read('before.inlinea2+b2=c2,andonownitsline:after.'), [{ page: 1, excused: [] }], 'two words swapped in the paragraph');
  assert.deepEqual(read(`before.${[...'inlinea2+b2=c2,andonitsownline:'].reverse().join('')}after.`), [{ page: 1, excused: [] }], 'the paragraph backwards');
  assert.deepEqual(read('before.inlinea2+b2=c2,andonistownline:after.'), [{ page: 1, excused: [] }], 'a misspelt word in the paragraph');
  assert.deepEqual(read('before.inline,andonitsownline:a2+b2=c2aftre.'), [{ page: 1, excused: [] }], 'a misspelt word outside it');
});

test('a divided row\'s cells may stand in another order, each cell in its own', () => {
  const page = [['/second', 'POST', 'word01', 'word02', '200', '404']];
  const span = (role: number, element: number, from: number, to: number): Span & { role: number } => ({ known: 0, role, element, page: 0, from, to, start: [from, 0], end: [to - 1, page[0]![to - 1]!.length] });
  const spans = [span(0, 0, 0, 6), span(2, 1, 0, 1), span(2, 2, 1, 2), span(2, 3, 2, 4), span(2, 4, 4, 6)];
  const read = (file: string) => verdict(wordDifferences(page, [[]], [file], spans, [{ cells: true }]));
  assert.deepEqual(read('word01word02/secondpost200404'), [{ page: 1, excused: [0] }], 'the long cell first');
  assert.deepEqual(read('word02word01/secondpost200404'), [{ page: 1, excused: [] }], 'a cell\'s own words swapped');
});

test('a known defect is credited only where the page needs it', () => {
  const page = [['Inline', 'a2', 'text.', 'Cell', 'one', 'two']];
  const spans: (Span & { role: number })[] = [
    { known: 0, role: 1, element: 0, page: 0, from: 0, to: 3, start: [0, 0], end: [2, 5] },
    { known: 0, role: 0, element: 1, page: 0, from: 1, to: 2, start: [1, 0], end: [1, 2] },
    { known: 1, role: 0, element: 2, page: 0, from: 3, to: 6, start: [3, 0], end: [5, 3] },
    { known: 1, role: 2, element: 3, page: 0, from: 3, to: 5, start: [3, 0], end: [4, 3] },
    { known: 1, role: 2, element: 4, page: 0, from: 5, to: 6, start: [5, 0], end: [5, 3] }
  ];
  const found = wordDifferences(page, [[]], ['inlinetext.a2cellonetwo'], spans, [{ after: true }, { cells: true }]);
  assert.deepEqual(verdict(found), [{ page: 1, excused: [0] }], 'the formula is needed and the row, present and in order, is not');
});
