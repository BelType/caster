/**
 * The page labels: the grammar, the two numbering styles PDF spells out, and the runs.
 *
 * `/PageLabels` is the front matter question — front matter in lower roman, the body restarting at arabic 1, an appendix with a prefix — and every one of those is a fact about the document that CSS has no way to state, so the grammar below is the exporter's own and this suite is where it is held to it. Two of the checks are ISO 32000-2 12.4.2 read literally: the `a` style is NOT base 26 (the 27th page is `aa`, not `ba`), and roman is roman including the four subtractive pairs. The rest is the run rule — consecutive pages that follow from the one above them are one `/Nums` entry, so a three-hundred-page book is two entries and not three hundred — and the deliberate asymmetry inside it: a page that declares nothing under an open run continues it, while a document whose first page declares nothing gets no labels at all rather than an invented decimal run.
 *
 * Everything here runs in node. `readPageLabels` and `registerPageLabelProperty` are the module's two DOM halves; the second's refusal path is checked here because node has no `CSS`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LABEL_STYLES,
  PAGE_LABEL_PROPERTY,
  PageLabelParseError,
  labelText,
  pageLabelRuns,
  parsePageLabel,
  registerPageLabelProperty,
  toAlpha,
  toRoman,
} from '../src/emit/pageLabels.ts';
import { CasterError } from '../src/errors.ts';

test('the six style names map onto PDF’s own /S names', () => {
  assert.deepEqual(LABEL_STYLES, {
    decimal: 'D',
    'lower-roman': 'r',
    'upper-roman': 'R',
    'lower-alpha': 'a',
    'upper-alpha': 'A',
    none: '',
  });
  assert.equal(PAGE_LABEL_PROPERTY, '--pdf-page-label');
});

test('toRoman is roman, subtractive pairs included', () => {
  assert.equal(toRoman(1), 'i');
  assert.equal(toRoman(4), 'iv');
  assert.equal(toRoman(9), 'ix');
  assert.equal(toRoman(14), 'xiv');
  assert.equal(toRoman(40), 'xl');
  assert.equal(toRoman(49), 'xlix');
  assert.equal(toRoman(90), 'xc');
  assert.equal(toRoman(400), 'cd');
  assert.equal(toRoman(900), 'cm');
  assert.equal(toRoman(1987), 'mcmlxxxvii');
  assert.equal(toRoman(0), '');
});

test('toAlpha is 12.4.2’s repetition and not base 26', () => {
  assert.equal(toAlpha(1), 'a');
  assert.equal(toAlpha(26), 'z');
  // The 27th page is `aa`, which base 26 would spell `ba`.
  assert.equal(toAlpha(27), 'aa');
  assert.equal(toAlpha(52), 'zz');
  assert.equal(toAlpha(53), 'aaa');
});

test('the grammar reads a style, a start and a quoted prefix, in that order', () => {
  assert.deepEqual(parsePageLabel('decimal'), { style: 'D', start: 1, prefix: '' });
  assert.deepEqual(parsePageLabel('lower-roman'), { style: 'r', start: 1, prefix: '' });
  assert.deepEqual(parsePageLabel('decimal start 7'), { style: 'D', start: 7, prefix: '' });
  assert.deepEqual(parsePageLabel('upper-alpha "Appendix "'), { style: 'A', start: 1, prefix: 'Appendix ' });
  assert.deepEqual(parsePageLabel("decimal start 3 'A-'"), { style: 'D', start: 3, prefix: 'A-' });
  // A prefix is a quoted string precisely so it may hold spaces: the tokeniser is a regular expression, never a split.
  assert.deepEqual(parsePageLabel('none "Front cover"'), { style: '', start: 1, prefix: 'Front cover' });
});

test('an undeclared property is no label at all, not a refusal', () => {
  assert.equal(parsePageLabel(''), null);
  assert.equal(parsePageLabel('   '), null);
});

test('a declaration this grammar cannot read is a CasterError naming the value', () => {
  assert.throws(() => parsePageLabel('roman'), (error) => {
    assert.ok(error instanceof PageLabelParseError);
    assert.ok(error instanceof CasterError);
    assert.equal(error.value, 'roman');
    assert.match(error.message, /"roman" is not one of decimal, lower-roman, upper-roman, lower-alpha, upper-alpha, none/);
    return true;
  });
  assert.throws(() => parsePageLabel('decimal start 0'), /start wants an integer of at least 1/);
  assert.throws(() => parsePageLabel('decimal start two'), /start wants an integer of at least 1/);
  assert.throws(() => parsePageLabel('decimal start 1.5'), /start wants an integer of at least 1/);
  assert.throws(() => parsePageLabel('decimal Appendix'), /is neither "start <n>" nor a quoted prefix/);
  // `none` alone would write a label that shows nothing, which is a page with no label spelled the long way.
  assert.throws(() => parsePageLabel('none'), /labels the page with nothing at all/);
});

test('labelText is the prefix and the styled number, and none is the prefix alone', () => {
  assert.equal(labelText({ style: 'D', start: 1, prefix: '' }, 0), '1');
  assert.equal(labelText({ style: 'D', start: 7, prefix: '' }, 2), '9');
  assert.equal(labelText({ style: 'r', start: 1, prefix: '' }, 3), 'iv');
  assert.equal(labelText({ style: 'R', start: 1, prefix: '' }, 3), 'IV');
  assert.equal(labelText({ style: 'a', start: 1, prefix: '' }, 26), 'aa');
  assert.equal(labelText({ style: 'A', start: 1, prefix: '' }, 26), 'AA');
  assert.equal(labelText({ style: 'D', start: 1, prefix: 'A-' }, 4), 'A-5');
  assert.equal(labelText({ style: '', start: 1, prefix: 'Cover' }, 0), 'Cover');
});

test('a book is two runs, not three hundred entries', () => {
  const { runs, records } = pageLabelRuns([
    'lower-roman',
    '',
    '',
    'decimal start 1',
    '',
    '',
    '',
  ]);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0], { page: 0, label: { style: 'r', start: 1, prefix: '' } });
  assert.deepEqual(runs[1], { page: 3, label: { style: 'D', start: 1, prefix: '' } });
  assert.deepEqual(records.map((r) => r.label), ['i', 'ii', 'iii', '1', '2', '3', '4']);
  assert.deepEqual(records.map((r) => r.opensRun), [true, false, false, true, false, false, false]);
  assert.deepEqual(records.map((r) => r.style), ['r', 'r', 'r', 'D', 'D', 'D', 'D']);
});

test('a page that restates the number the run already reached does not open a run', () => {
  const { runs } = pageLabelRuns(['decimal start 1', 'decimal start 2', 'decimal start 3']);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0], { page: 0, label: { style: 'D', start: 1, prefix: '' } });
});

test('a number that does not follow, a changed style or a changed prefix each opens a run', () => {
  assert.equal(pageLabelRuns(['decimal start 1', 'decimal start 9']).runs.length, 2);
  assert.equal(pageLabelRuns(['decimal start 1', 'lower-roman start 2']).runs.length, 2);
  assert.equal(pageLabelRuns(['decimal start 1', 'decimal start 2 "A-"']).runs.length, 2);
});

test('a document whose first page declares nothing gets no labels rather than an invented run', () => {
  const { runs, records } = pageLabelRuns(['', '', '']);
  assert.equal(runs.length, 0);
  assert.deepEqual(records.map((r) => r.label), ['', '', '']);
  assert.deepEqual(records.map((r) => r.style), ['', '', '']);
  assert.deepEqual(records.map((r) => r.opensRun), [false, false, false]);

  // The same silence AFTER a run continues it: the labels start where the author started them.
  const late = pageLabelRuns(['', 'decimal start 1', '']);
  assert.equal(late.runs.length, 1);
  assert.deepEqual(late.records.map((r) => r.label), ['', '1', '2']);
  assert.deepEqual(late.records.map((r) => r.opensRun), [false, true, false]);
});

test('a record carries start and prefix only where they are not the default', () => {
  const { records } = pageLabelRuns(['decimal', 'upper-alpha start 3 "App "']);
  assert.deepEqual(records[0], { page: 0, declared: 'decimal', style: 'D', opensRun: true, label: '1' });
  assert.deepEqual(records[1], { page: 1, declared: 'upper-alpha start 3 "App "', style: 'A', start: 3, prefix: 'App ', opensRun: true, label: 'App C' });
});

test('registerPageLabelProperty refuses honestly where there is no CSS object', () => {
  const registration = registerPageLabelProperty();
  assert.equal(registration.property, PAGE_LABEL_PROPERTY);
  assert.equal(registration.registered, false);
  assert.match(String(registration.error), /CSS is not defined/);
});
