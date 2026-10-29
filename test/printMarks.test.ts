/**
 * The print marks' geometry, checked against `docs/guide/coordinates-and-pages.md` §"Print marks (E12D)" rather than against a fixture's output.
 *
 * The guide states the four frozen numbers — a `3 mm` offset, a `5 mm` mark, a `0.25 pt` hairline, a `1.6 mm` target with `2.4 mm` arms — and it states the growth it measured: 31.181 pt with a 3 mm bleed (8.504 + 8.504 + 14.173) and 22.677 pt without, taking A4's `[0 0 595.276 841.89]` to `[−31.181 −31.181 626.457 873.071]` and to `[−22.677 −22.677 617.953 864.567]`, with a page that declares no marks staying at the nominal size. Those are the numbers below, and the negative origin is the assertion that matters most: it is the whole reason the convention was chosen, because a grown media with a `[0 0 …]` origin would move every content coordinate, every `TrimBox` and every structure `/BBox` in the file.
 *
 * Everything here runs in node. `registerMarksProperty` is the one function that touches the DOM, and its refusal path is checked here precisely because node has no `CSS`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MARKS_PROPERTY,
  MARK_LENGTH_MM,
  MARK_OFFSET_MM,
  MARK_STROKE_PT,
  MM_TO_PT,
  REGISTRATION_ARM_MM,
  REGISTRATION_RADIUS_MM,
  circleSegments,
  pageMarksOf,
  parseMarks,
  registerMarksProperty,
} from '../src/coordinates/printMarks.ts';
import { KAPPA } from '../src/vectors/pathData.ts';
import { CasterError } from '../src/errors.ts';

/** The rounding the module itself does, restated here so an expectation written as arithmetic reads as the module reads it: 10 − 17.008 is −7.007999999999999 in binary floating point and −7.008 in the file. */
const round3 = ( n: number) => Math.round(n * 1000) / 1000;

/** A4 as `pageGeometry.js` names it: nominal, not measured. */
const A4 = { widthPt: 595.276, heightPt: 841.89, marginPt: 0, columnWidthPx: 794, nominal: 'A4' };

/** 3 mm of bleed, in the CSS pixels the page declares it in. */
const BLEED_3MM_PX = (3 * 96) / 25.4;

test('the frozen numbers are the trade’s, and the millimetre is 72/25.4', () => {
  assert.equal(MM_TO_PT, 72 / 25.4);
  assert.equal(MARK_OFFSET_MM, 3);
  assert.equal(MARK_LENGTH_MM, 5);
  assert.equal(MARK_STROKE_PT, 0.25);
  assert.equal(REGISTRATION_RADIUS_MM, 1.6);
  assert.equal(REGISTRATION_ARM_MM, 2.4);
  assert.equal(MARKS_PROPERTY, '--pdf-marks');
});

test('parseMarks takes crop, cross, both and none, in any order and any case', () => {
  assert.deepEqual(parseMarks('crop'), { declared: 'crop', crop: true, cross: false });
  assert.deepEqual(parseMarks('cross'), { declared: 'cross', crop: false, cross: true });
  assert.deepEqual(parseMarks('crop cross'), { declared: 'crop cross', crop: true, cross: true });
  assert.deepEqual(parseMarks('CROSS   CROP'), { declared: 'cross crop', crop: true, cross: true });
  assert.deepEqual(parseMarks('  crop\tcross '), { declared: 'crop cross', crop: true, cross: true });
});

test('an undeclared property and the word none are both no marks', () => {
  assert.deepEqual(parseMarks(''), { declared: 'none', crop: false, cross: false });
  assert.deepEqual(parseMarks('   '), { declared: 'none', crop: false, cross: false });
  assert.deepEqual(parseMarks('none'), { declared: 'none', crop: false, cross: false });
});

test('anything else is a refusal naming the value, and it is a CasterError', () => {
  assert.throws(() => parseMarks('crop marks'), (error) => {
    assert.ok(error instanceof CasterError);
    assert.equal(error.message, 'printMarks: "crop marks" is not a marks value; it takes crop, cross, both or none');
    return true;
  });
  // `none` is only a marks value alone: the grammar has no way to mean "none of these two".
  assert.throws(() => parseMarks('none crop'), CasterError);
  assert.throws(() => parseMarks('registration'), CasterError);
});

test('registerMarksProperty refuses honestly where there is no CSS object', () => {
  const registration = registerMarksProperty();
  assert.equal(registration.property, MARKS_PROPERTY);
  assert.equal(registration.registered, false);
  assert.match(String(registration.error), /CSS is not defined/);
});

test('the media grows by bleed + 3 mm + 5 mm on every side, with a negative origin', () => {
  const marks = pageMarksOf(0, A4, parseMarks('crop cross'), BLEED_3MM_PX);
  assert.equal(marks.bleedPt, 8.504);
  assert.equal(marks.offsetPt, 8.504);
  assert.equal(marks.lengthPt, 14.173);
  assert.equal(marks.growthPt, 31.181);
  assert.deepEqual(marks.mediaBefore, [0, 0, 595.276, 841.89]);
  assert.deepEqual(marks.mediaAfter, [-31.181, -31.181, 626.457, 873.071]);
  // The point of the whole convention: the origin went negative rather than the content moving.
  assert.ok(marks.mediaAfter[0] < 0 && marks.mediaAfter[1] < 0);
  assert.equal(round3(marks.mediaAfter[2] - marks.mediaBefore[2]), marks.growthPt);
});

test('a page with no bleed grows by 22.677 pt, the offset and the mark alone', () => {
  const marks = pageMarksOf(1, A4, parseMarks('crop'), 0);
  assert.equal(marks.bleedPt, 0);
  assert.equal(marks.growthPt, 22.677);
  assert.deepEqual(marks.mediaAfter, [-22.677, -22.677, 617.953, 864.567]);
});

test('a page that declares no marks keeps the nominal media and carries no shape', () => {
  const marks = pageMarksOf(2, A4, parseMarks('none'), BLEED_3MM_PX);
  assert.equal(marks.growthPt, 0);
  assert.deepEqual(marks.mediaAfter, marks.mediaBefore);
  assert.deepEqual(marks.mediaAfter, [0, 0, 595.276, 841.89]);
  assert.equal(marks.shapes.length, 0);
  // The bleed is still reported: it is a fact about the page, not about the marks.
  assert.equal(marks.bleedPt, 8.504);
});

test('crop marks are four corners of two hairlines, starting past the bleed and running 5 mm out', () => {
  const marks = pageMarksOf(0, A4, parseMarks('crop'), BLEED_3MM_PX);
  assert.equal(marks.shapes.length, 4);
  assert.deepEqual(marks.shapes.map((s) => s.at), ['bottom-left', 'bottom-right', 'top-right', 'top-left']);
  assert.ok(marks.shapes.every((s) => s.kind === 'crop' && s.segments.length === 2 && s.circle === undefined));

  // near = bleed + offset = 17.008; far = near + length = 31.181, which is the growth.
  const [horizontal, vertical] = marks.shapes[0].segments;
  assert.deepEqual(horizontal, [-17.008, 0, -31.181, 0]);
  assert.deepEqual(vertical, [0, -17.008, 0, -31.181]);
  assert.equal(round3(Math.abs(horizontal[2] - horizontal[0])), marks.lengthPt);
  assert.equal(round3(Math.abs(vertical[3] - vertical[1])), marks.lengthPt);
  // A mark starts outside the bleed and never inside it.
  assert.ok(Math.abs(horizontal[0]) > marks.bleedPt);

  // The far end of every arm is exactly the media edge the growth produced.
  const [, , topRightX, topRightY] = marks.shapes[2].segments[0];
  assert.equal(topRightX, 626.457);
  assert.equal(topRightY, A4.heightPt);
});

test('cross marks are four registration targets, centred in the mark band on each trim side', () => {
  const marks = pageMarksOf(0, A4, parseMarks('cross'), BLEED_3MM_PX);
  assert.equal(marks.shapes.length, 4);
  assert.deepEqual(marks.shapes.map((s) => s.at), ['bottom', 'right', 'top', 'left']);

  const bottom = marks.shapes[0];
  assert.equal(bottom.kind, 'cross');
  const radius = Math.round(REGISTRATION_RADIUS_MM * MM_TO_PT * 1000) / 1000;
  const arm = Math.round(REGISTRATION_ARM_MM * MM_TO_PT * 1000) / 1000;
  // The band's middle: near + length/2 = 17.008 + 7.0865.
  assert.deepEqual(bottom.circle, [297.638, -24.095, radius]);
  assert.deepEqual(bottom.segments, [
    [290.835, -24.095, 304.441, -24.095],
    [297.638, -30.898, 297.638, -17.292],
  ]);
  assert.equal(round3(297.638 - arm), bottom.segments[0][0]);
  assert.equal(round3(-24.095 + arm), bottom.segments[1][3]);
  // The arms reach past the circle, or the crosshair would be invisible inside its own target.
  assert.ok(arm > radius);

  assert.deepEqual(marks.shapes[1].circle, [619.371, 420.945, radius]);
  assert.deepEqual(marks.shapes[2].circle, [297.638, 865.985, radius]);
  assert.deepEqual(marks.shapes[3].circle, [-24.095, 420.945, radius]);
});

test('marks sit against the trim box when the page declares one, not against the media', () => {
  const trim: [number,number,number,number] = [10, 10, 585.276, 831.89];
  const geometry = { ...A4, trimPt: trim, bleedPt: ([5, 5, 590.276, 836.89] as [number, number, number, number]) };
  const marks = pageMarksOf(0, geometry, parseMarks('crop'), BLEED_3MM_PX);
  assert.deepEqual(marks.trimPt, trim);
  assert.deepEqual(marks.bleedBoxPt, [5, 5, 590.276, 836.89]);
  // The bottom-left corner's arms start from the trim corner, 10 pt in from the media.
  assert.deepEqual(marks.shapes[0].segments, [
    [-7.008, 10, -21.181, 10],
    [10, -7.008, 10, -21.181],
  ]);
  // The growth is the media's, and it does not know about the inset: a trim mark can then land inside the grown media.
  assert.equal(marks.growthPt, 31.181);
});

test('both keywords put eight shapes on the page, crop first', () => {
  const marks = pageMarksOf(0, A4, parseMarks('crop cross'), BLEED_3MM_PX);
  assert.equal(marks.shapes.length, 8);
  assert.deepEqual(marks.shapes.map((s) => s.kind), ['crop', 'crop', 'crop', 'crop', 'cross', 'cross', 'cross', 'cross']);
});

test('a registration circle is four cubics rounded with pathData’s own kappa', () => {
  const segments = circleSegments(100, 200, 10);
  assert.equal(segments.length, 5);
  assert.deepEqual(segments[0], [110, 200]);
  const k = KAPPA * 10;
  assert.deepEqual(segments[1], [110, 200 + k, 100 + k, 210, 100, 210]);
  assert.deepEqual(segments[2], [100 - k, 210, 90, 200 + k, 90, 200]);
  assert.deepEqual(segments[3], [90, 200 - k, 100 - k, 190, 100, 190]);
  assert.deepEqual(segments[4], [100 + k, 190, 110, 200 - k, 110, 200]);
  // It closes on the point it opened at.
  assert.deepEqual(segments[4].slice(4), segments[0]);
  assert.equal(KAPPA, 0.5523);
});
