/**
 * The pure arithmetic of the painting stage, checked against the source it came from rather than against the numbers a fixture happened to produce.
 *
 * `docs/guide/vector-painting.md` closes with exactly that instruction, and names the checks: `strokeIsDashed(3, 'dotted')` true and `strokeIsDashed(4, 'dotted')` false; a 4 px dash of 8 and a 2 px dash of 6; `selectBestDashGap(100, 10, 5, false)` equal to `(100 − 7·10)/6`; `darkColour([1,1,1])` equal to 171 and `lightColour([0,0,0])` equal to 84. Beside those sit the guide's frozen numbers — kappa `0.5523`, the one-factor radius clamp, the millionth-of-a-domain `/Bounds` nudge, the `1.75` contrast rule, the `13` px dilation cap and the `0.5` px band inset — and the two `d`-grammar rules a path cannot be waved through without.
 *
 * Everything here runs in node. The DOM-reading halves of these modules — `collectCssBoxes`, `collectSvg`, `markerAttributes` — are exercised by the browser acceptance test; what is checked here is what they compute once the DOM has answered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  KAPPA,
  ZERO_RADII,
  clampRadii,
  cssShapePath,
  ellipsePath,
  parseMatrix,
  parsePath,
  pathBounds,
  roundedRectPath,
  transformPath,
} from '../src/vectors/pathData.ts';
import {
  DOT_EPSILON,
  MINIMUM_BORDER_EDGE_CONTRAST_RATIO,
  SIDE_NAMES,
  STYLED_BORDER_STYLES,
  chromiumDash,
  contrastRatio,
  darkColour,
  darkenBoxSide,
  dashGapRatio,
  dashLengthRatio,
  effectiveStyle,
  insetOutsetColour,
  lightColour,
  pathLength,
  selectBestDashGap,
  strokeIsDashed,
} from '../src/vectors/borderStyles.ts';
import { bboxOf, boundaryPieces, borderSidePath, cssGradient, insetBox, parseBoxShadow, pathToSvg, periodsFor, unrollGradient } from '../src/vectors/cssBoxes.ts';
import { BAND_INSET_PX, MAX_DILATION_PX, blinkThicknessPx, complementOf } from '../src/vectors/skipInk.ts';
import { markerAngle, markerVertices, placementMatrix, positionOf, viewBoxMatrix } from '../src/vectors/svgMarkers.ts';
import { blendName, emptyNodeCommon, parseCssColor } from '../src/vectors/vector.ts';
import { IDENTITY, apply, mul } from '../src/coordinates/matrix.ts';
import type { MarkerAttributes } from '../src/vectors/svgMarkers.ts';

/**
 * @param [tolerance] @param [what]
 */
const near = (a: number, b: number, tolerance: number = 1e-9, what: string = '') => assert.ok(Math.abs(a - b) <= tolerance, `${what || 'value'}: ${a} against ${b}`);

test('kappa is 0.5523, and a rounded corner is four cubics at it', () => {
  assert.equal(KAPPA, 0.5523);
  const path = roundedRectPath({ x: 0, y: 0, w: 100, h: 60 }, [[10, 10], [10, 10], [10, 10], [10, 10]]);
  const cubics = path.filter((s) => s.op === 'c');
  assert.equal(cubics.length, 4, 'one cubic per corner');
  assert.equal(path[path.length - 1].op, 'h');
  // The top-right corner's first control point sits kappa of the radius past the end of the top edge.
  const topRight = (cubics[0] as any);
  near(topRight.c1[0], 100 - 10 + 10 * KAPPA, 1e-9, 'the control point is pulled in by kappa');
  near(topRight.c1[1], 0);
  near(topRight.to[0], 100);
  near(topRight.to[1], 10);

  // A square-cornered box is four lines and a close, with no cubic at all.
  const square = roundedRectPath({ x: 0, y: 0, w: 10, h: 10 });
  assert.deepEqual(square.map((s) => s.op), ['m', 'l', 'l', 'l', 'h']);
  assert.deepEqual(roundedRectPath({ x: 0, y: 0, w: 10, h: 10 }, ZERO_RADII), square);

  // An ellipse is four cubics too, and the same kappa makes it a circle to within a thousandth of a radius.
  const circle = ellipsePath(0, 0, 20, 20);
  assert.equal(circle.filter((s) => s.op === 'c').length, 4);
  const quarter = (circle[1] as any);
  near(quarter.c1[1], 20 * KAPPA);
});

test('the radius clamp is ONE factor over all eight numbers — 200 px asked, 30 px painted', () => {
  // `border-radius: 200px` on a 104 x 60 box. The four side ratios are 104/400, 104/400, 60/400 and 60/400; the smallest is 0.15, and one factor scales every radius.
  const asked = ([[200, 200], [200, 200], [200, 200], [200, 200]] as any);
  const clamped = clampRadii(asked, 104, 60);
  for (const [rx, ry] of clamped) {
    near(rx, 30, 1e-9, 'every radius becomes 30');
    near(ry, 30, 1e-9);
  }
  // Clamping PER SIDE would have given 52 x 30 and a top edge of 0 px; the measurement excluded that outright.
  const top = roundedRectPath({ x: 0, y: 0, w: 104, h: 60 }, clamped);
  const edge = (top[1] as any);
  near(edge.to[0] - (top[0] as any).to[0], 104 - 60, 1e-9, 'the straight part of the top edge is 44 px');

  // Nothing is scaled when the radii already fit.
  const fits = ([[10, 10], [10, 10], [10, 10], [10, 10]] as any);
  assert.deepEqual(clampRadii(fits, 104, 60), fits);
});

test('insetBox reduces the radii by the same amounts it insets the sides', () => {
  const { box, radii } = insetBox({ x: 0, y: 0, w: 100, h: 60 }, [[10, 10], [8, 8], [6, 6], [4, 4]], 5, 5, 5, 5);
  assert.deepEqual(box, { x: 5, y: 5, w: 90, h: 50 });
  assert.deepEqual(radii, [[5, 5], [3, 3], [1, 1], [0, 0]]);
  // A radius never goes negative, and a box never goes below zero size.
  const crushed = insetBox({ x: 0, y: 0, w: 10, h: 10 }, ZERO_RADII, 20, 20, 20, 20);
  assert.deepEqual(crushed.box, { x: 20, y: 20, w: 0, h: 0 });
});

test('a square-cornered box still has eight boundary pieces, so the side indices hold', () => {
  const square = boundaryPieces({ x: 0, y: 0, w: 100, h: 60 }, ZERO_RADII);
  assert.equal(square.length, 8, 'four edges and four zero-length corners');
  assert.equal(boundaryPieces({ x: 0, y: 0, w: 100, h: 60 }, [[10, 10], [10, 10], [10, 10], [10, 10]]).length, 8);

  // One side is a closed region: outer run, a line across to the inner run, the inner run backwards, close.
  const outer = boundaryPieces({ x: 0, y: 0, w: 100, h: 60 }, ZERO_RADII);
  const inner = boundaryPieces({ x: 4, y: 4, w: 92, h: 52 }, ZERO_RADII);
  const side = borderSidePath(outer, inner, 0);
  assert.equal(side[0].op, 'm');
  assert.equal(side[side.length - 1].op, 'h');
  const bounds = pathBounds(side);
  assert.deepEqual([bounds.x, bounds.y, bounds.w, bounds.h], [0, 0, 100, 4], 'the top side is the trapezoid between the two contours');
});

test('a degenerate box has eight pieces too, whichever dimension collapsed', () => {
  // Agent A's S21: `{w:100,h:0}` answered THREE pieces where `{w:0,h:20}` answered eight, because a square-cornered box of zero height closes its fourth edge exactly on its start point and the closing edge was dropped for having no length. `borderSidePath` then indexed `outer[7]` and threw — an `<hr>` is the element that meets it, and any zero-height bordered box an author writes some other way meets it too.
  for (const box of [{ x: 0, y: 0, w: 100, h: 0 }, { x: 0, y: 0, w: 0, h: 20 }, { x: 0, y: 0, w: 0, h: 0 }]) {
    assert.equal(boundaryPieces(box, ZERO_RADII).length, 8, `square ${box.w}x${box.h}`);
    assert.equal(boundaryPieces(box, [[5, 5], [5, 5], [5, 5], [5, 5]]).length, 8, `rounded ${box.w}x${box.h}`);
  }

  // The pieces are in the same order they are for any other box: the fourth edge is the left one, walked from the bottom-left corner back to the start.
  const flat = boundaryPieces({ x: 10, y: 40, w: 100, h: 0 }, ZERO_RADII);
  assert.deepEqual(flat[0].start, [10, 40]);
  assert.deepEqual(flat[6].start, [10, 40], 'the left edge starts where the bottom edge ended');
  assert.deepEqual(flat[6].segs, [{ op: 'l', to: [10, 40] }], 'and it is a line of zero length, not an absence');
  assert.ok(flat.every((piece, index) => (index % 2 === 1 ? piece.segs.length === 0 : piece.segs.length === 1)), 'four edges and four zero-length corners, alternating');

  // What the throw was: every side of a zero-height box now yields a closed, empty region rather than an exception.
  const outer = boundaryPieces({ x: 0, y: 0, w: 100, h: 0 }, ZERO_RADII);
  const inner = boundaryPieces({ x: 2, y: 0, w: 96, h: 0 }, ZERO_RADII);
  for (const side of [0, 1, 2, 3]) {
    const path = borderSidePath(outer, inner, (side as 0 | 1 | 2 | 3));
    assert.equal(path[0].op, 'm');
    assert.equal(path[path.length - 1].op, 'h');
    assert.equal(pathBounds(path).h, 0, `side ${side} of a flat box encloses nothing`);
  }
});

test('the `d` grammar expands everything into moves, lines, cubics and closes', () => {
  // H and V become lines; a repeated M means L.
  assert.deepEqual(parsePath('M0 0 H10 V10 20 30'), [
    { op: 'm', to: [0, 0] },
    { op: 'l', to: [10, 0] },
    { op: 'l', to: [10, 10] },
    { op: 'l', to: [10, 20] },
    { op: 'l', to: [10, 30] },
  ]);
  assert.deepEqual(parsePath('M0 0 5 5'), [{ op: 'm', to: [0, 0] }, { op: 'l', to: [5, 5] }]);
  assert.deepEqual(parsePath('m0 0 m5 5'), [{ op: 'm', to: [0, 0] }, { op: 'm', to: [5, 5] }]);

  // A quadratic is elevated to a cubic: the controls sit two thirds of the way from each endpoint towards the quadratic's own.
  const quad = (parsePath('M0 0 Q30 0 30 30')[1] as any);
  assert.equal(quad.op, 'c');
  near(quad.c1[0], 20);
  near(quad.c1[1], 0);
  near(quad.c2[0], 30);
  near(quad.c2[1], 10);

  // S reflects the previous cubic's second control point; T reflects the previous quadratic's.
  const smooth = (parsePath('M0 0 C10 0 20 10 30 10 S40 30 50 30')[2] as any);
  near(smooth.c1[0], 40, 1e-9, 'reflection of (20,10) about (30,10)');
  near(smooth.c1[1], 10);

  // An arc becomes cubics; a quarter turn is one, and a coincident pair of endpoints is no arc at all.
  assert.equal(parsePath('M0 0 A10 10 0 0 1 10 10').length, 2);
  assert.deepEqual(parsePath('M5 5 A10 10 0 0 1 5 5'), [{ op: 'm', to: [5, 5] }]);
  // A radius of zero is a straight line, per SVG 1.1 F.6.6.
  assert.deepEqual(parsePath('M0 0 A0 0 0 0 1 10 10'), [{ op: 'm', to: [0, 0] }, { op: 'l', to: [10, 10] }]);
  // A large-arc sweep needs three quarters and comes back as three cubics.
  assert.equal(parsePath('M10 0 A10 10 0 1 1 0 10').filter((s) => s.op === 'c').length, 3);
  // COMPRESSED FLAGS. SVG 1.1's `flag` production is a single character and needs no separator after it, so `0110 10` is `large-arc 0`, `sweep 1`, endpoint `(10, 10)` — the spelling every path minifier emits. Read as one number `0110` the arc got the wrong flags and one argument too few.
  assert.deepEqual(parsePath('M0 0 A10 10 0 0110 10'), parsePath('M0 0 A10 10 0 0 1 10 10'));
  assert.deepEqual(parsePath('M10 0 A10 10 0 1110 10'), parsePath('M10 0 A10 10 0 1 1 10 10'));
  // And the flags stay single digits for every repetition of the argument set, not only the first.
  assert.deepEqual(parsePath('M0 0 A10 10 0 0110 10 10 10 0 0110 10'), parsePath('M0 0 A10 10 0 0 1 10 10 A10 10 0 0 1 10 10'));

  // Z returns to the subpath's start, so the next relative command is measured from there.
  assert.deepEqual(parsePath('M10 10 L20 10 Z l5 0'), [
    { op: 'm', to: [10, 10] },
    { op: 'l', to: [20, 10] },
    { op: 'h' },
    { op: 'l', to: [15, 10] },
  ]);
});

test('a `d` this grammar cannot read is an error, and one refusal is unreachable', () => {
  assert.throws(() => parsePath('10 10 L20 20'), /starts with a number rather than a command/);
  assert.throws(() => parsePath('M0 0 L10'), /ends in the middle of a L command/);
  // The harness's third refusal — "is not an SVG path command" — cannot be reached through its own tokeniser: the pattern matches only the twenty command letters and numbers, so an `X` is not tokenised at all and its coordinates are read as an implicit `L`. Recorded rather than repaired (DESIGN.md §Painting, proposition P4); the branch is kept because it is the harness's, and because a tokeniser that grew a case would want it.
  assert.deepEqual(parsePath('M0 0 X10 10'), [{ op: 'm', to: [0, 0] }, { op: 'l', to: [10, 10] }]);
});

test('a path maps through a matrix control point by control point', () => {
  const path = parsePath('M0 0 C1 2 3 4 5 6');
  const scaled = transformPath(path, [2, 0, 0, 2, 10, 10]);
  assert.deepEqual(scaled, [
    { op: 'm', to: [10, 10] },
    { op: 'c', c1: [12, 14], c2: [16, 18], to: [20, 22] },
  ]);
  // The bounds are the hull of the anchors AND the control points, which is what a clip and a /BBox both have to contain.
  const bounds = pathBounds(scaled);
  assert.deepEqual([bounds.x, bounds.y, bounds.w, bounds.h], [10, 10, 10, 12]);
  assert.deepEqual(pathBounds([]), { x: 0, y: 0, w: 0, h: 0 });
  assert.equal(pathToSvg(scaled), 'M10 10 C12 14 16 18 20 22');
});

test('a CSS basic shape resolves against its reference box', () => {
  const box = { x: 0, y: 0, w: 100, h: 60 };
  assert.equal(cssShapePath('none', box), null);
  assert.equal(cssShapePath('', box), null);
  const inset = cssShapePath('inset(10px 20px)', box);
  assert.deepEqual(pathBounds((inset as any).path), { x: 20, y: 10, w: 60, h: 40 });
  assert.equal((inset as any).evenOdd, false);
  const polygon = cssShapePath('polygon(evenodd, 0% 0%, 100% 0%, 50% 100%)', box);
  assert.equal((polygon as any).evenOdd, true);
  assert.deepEqual(pathBounds((polygon as any).path), { x: 0, y: 0, w: 100, h: 60 });
  // `circle()` with no radius is `closest-side`, which on a 100x60 box centred is 30.
  const circle = cssShapePath('circle()', box);
  assert.deepEqual(pathBounds((circle as any).path), { x: 20, y: 0, w: 60, h: 60 });
});

test('parseMatrix reads a computed transform, and refuses one it cannot', () => {
  assert.deepEqual(parseMatrix('none'), IDENTITY);
  assert.deepEqual(parseMatrix(''), IDENTITY);
  assert.deepEqual(parseMatrix('matrix(1, 2, 3, 4, 5, 6)'), [1, 2, 3, 4, 5, 6]);
  // The `matrix3d` branch is written to take the 2-D part of a 3-D matrix, and it never fires: the number pattern matches the `3` in the function's own name, so seventeen numbers come back rather than sixteen and the sixteen-operand branch is skipped. Recorded rather than repaired (DESIGN.md §Painting, proposition P5); E10's frame refuses a `matrix3d` on the chain by name long before a path reaches here, which is why the defect is latent.
  assert.deepEqual(parseMatrix('matrix3d(1,2,0,0, 3,4,0,0, 0,0,1,0, 5,6,0,1)'), [3, 1, 2, 0, 0, 3]);
  assert.throws(() => parseMatrix('rotate(9deg)'), /cannot read the transform/);
});

test('Chromium’s dash and gap ratios, and the 3 px dotted threshold', () => {
  // DashLengthRatio is 2 at and above 3 px and 3 below it; DashGapRatio is 1 and 2.
  assert.equal(dashLengthRatio(3), 2);
  assert.equal(dashLengthRatio(2.9), 3);
  assert.equal(dashGapRatio(3), 1);
  assert.equal(dashGapRatio(2.9), 2);
  // StrokeIsDashed: dotted is dashed until it is thick, and the threshold is three pixels.
  assert.equal(strokeIsDashed(3, 'dotted'), true);
  assert.equal(strokeIsDashed(4, 'dotted'), false);
  assert.equal(strokeIsDashed(9, 'dashed'), true);
  assert.equal(strokeIsDashed(9, 'solid'), false);
  // A 4 px dash is 8, a 2 px dash is 6.
  assert.equal((chromiumDash('dashed', 4, 400, false) as any).intervals[0], 8);
  assert.equal((chromiumDash('dashed', 2, 400, false) as any).intervals[0], 6);
  assert.equal(DOT_EPSILON, 1.0e-2);
});

test('the gap absorbs the corner fitting, never the dash', () => {
  // SelectBestDashGap(100, 10, 5, false): available is 105, so n = 7 and the gap is (100 − 70)/6.
  near(selectBestDashGap(100, 10, 5, false), (100 - 7 * 10) / 6, 1e-12);
  // A closed path counts no extra gap in `available`, so the same length fits six dashes rather than seven — and the seven-dash gap of 30/7 is nearer the nominal 5 than the six-dash gap of 40/6, so it is the one kept.
  near(selectBestDashGap(100, 10, 5, true), 30 / 7, 1e-12);

  const dashed = (chromiumDash('dashed', 4, 150, false) as any);
  assert.equal(dashed.intervals[0], 8, 'the dash length is never adjusted');
  assert.equal(dashed.cap, 0, 'square-ended dashes, under a butt cap');
  assert.ok(dashed.intervals[1] > 0 && dashed.intervals[1] !== 4, 'the gap is what was fitted');

  // A path no longer than two dashes carries none at all and is stroked solid.
  assert.equal(chromiumDash('dashed', 4, 16, false), null);
  // A path no longer than two dashes and a gap carries exactly two, scaled to fit.
  const two = (chromiumDash('dashed', 4, 19, false) as any);
  assert.equal(two.dashes, 2);
  near(two.intervals[0] + two.intervals[1] + two.intervals[0], 19, 1e-9, 'two dashes and a gap fill the path exactly');
});

test('a thick dotted border is circles, a thin one is squares', () => {
  // Above three pixels: {0, gap + w − 0.01} under a round cap.
  const thick = (chromiumDash('dotted', 6, 150, false) as any);
  assert.equal(thick.cap, 1, 'a round cap paints circles of diameter w');
  assert.equal(thick.intervals[0], 0);
  near(thick.intervals[1], selectBestDashGap(150, 6, 6, false) + 6 - DOT_EPSILON, 1e-9);

  // At three pixels or less: the dashed branch with no ratio applied — a dash of w and a gap of w under a butt cap.
  const thin = (chromiumDash('dotted', 3, 150, false) as any);
  assert.equal(thin.cap, 0, 'a butt cap paints squares');
  assert.equal(thin.intervals[0], 3);
  assert.equal(thin.intervals[1], 3, 'the dotted branch does not fit its gap');

  // A path shorter than one dot is one dot.
  assert.deepEqual(chromiumDash('dotted', 6, 5, false), { intervals: [0, 12], cap: 1, dashes: 1 });
  // Nothing else has a dash pattern at all.
  assert.equal(chromiumDash('solid', 4, 150, false), null);
  assert.equal(chromiumDash('double', 9, 150, false), null);
});

test('the engine’s own downgrade: double below 3 px and groove/ridge at 1 px are solid before the painter sees them', () => {
  assert.equal(effectiveStyle('double', 2), 'solid');
  assert.equal(effectiveStyle('double', 2.4), 'solid');
  assert.equal(effectiveStyle('double', 2.9), 'double', 'the width is ROUNDED first, so 2.9 is three pixels');
  assert.equal(effectiveStyle('double', 3), 'double');
  assert.equal(effectiveStyle('groove', 1), 'solid');
  assert.equal(effectiveStyle('ridge', 1), 'solid');
  assert.equal(effectiveStyle('groove', 2), 'groove');
  assert.equal(effectiveStyle('dashed', 1), 'dashed', 'a thin dashed border is still dashed');
  assert.deepEqual([...SIDE_NAMES], ['top', 'right', 'bottom', 'left']);
  assert.equal(STYLED_BORDER_STYLES.has('solid'), false, 'solid is E9’s, not this module’s');
});

test('Color::Dark, Color::Light and the 1.75 contrast rule', () => {
  // White's hard-coded answer is rgb(171,171,171); black's is rgb(84,84,84).
  assert.deepEqual(darkColour([1, 1, 1]).map((c) => Math.round(c * 255)), [171, 171, 171]);
  assert.deepEqual(lightColour([0, 0, 0]).map((c) => Math.round(c * 255)), [84, 84, 84]);
  // Otherwise: v = max(r,g,b), m = max(0, (v − 0.33)/v), every channel times m.
  const grey = darkColour([0.5, 0.5, 0.5]);
  near(grey[0], Math.trunc(0.5 * ((0.5 - 0.33) / 0.5) * 255.99998474121094) / 255, 1e-12);
  assert.deepEqual(darkColour([0, 0, 0]), [0, 0, 0], 'a zero maximum darkens to nothing');

  assert.equal(MINIMUM_BORDER_EDGE_CONTRAST_RATIO, 1.75);
  // Contrast is symmetric and is 21 between black and white.
  near(contrastRatio([0, 0, 0], [1, 1, 1]), 21, 1e-9);
  near(contrastRatio([1, 1, 1], [0, 0, 0]), 21, 1e-9);
  near(contrastRatio([0.5, 0.5, 0.5], [0.5, 0.5, 0.5]), 1, 1e-12);

  // Darkening always returns the dark colour.
  assert.deepEqual(insetOutsetColour(true, [1, 1, 1]), darkColour([1, 1, 1]));
  // Above either brute-force bound the answer is the colour itself and the contrast is never measured.
  assert.deepEqual(insetOutsetColour(false, [0.9, 0.1, 0.1]), [0.9, 0.1, 0.1], 'r >= 150/255');
  assert.deepEqual(insetOutsetColour(false, [0.1, 0.9, 0.1]), [0.1, 0.9, 0.1], 'g >= 92/255');
  // A colour dark enough that it and its own dark would not be told apart is lightened instead.
  const veryDark = ([0.05, 0.05, 0.05] as [number, number, number]);
  assert.ok(contrastRatio(veryDark, darkColour(veryDark)) < MINIMUM_BORDER_EDGE_CONTRAST_RATIO);
  assert.deepEqual(insetOutsetColour(false, veryDark), lightColour(veryDark));
});

test('DarkenBoxSide: inset darkens the top and the left, outset the bottom and the right', () => {
  assert.deepEqual([0, 1, 2, 3].map((s) => darkenBoxSide((s as any), 'inset')), [true, false, false, true]);
  assert.deepEqual([0, 1, 2, 3].map((s) => darkenBoxSide((s as any), 'outset')), [false, true, true, false]);
});

test('pathLength flattens cubics finely enough for a dash count', () => {
  near(pathLength([{ op: 'm', to: [0, 0] }, { op: 'l', to: [3, 4] }]), 5, 1e-12);
  // A closed square of side 10 is 40, the close included.
  near(pathLength([{ op: 'm', to: [0, 0] }, { op: 'l', to: [10, 0] }, { op: 'l', to: [10, 10] }, { op: 'l', to: [0, 10] }, { op: 'h' }]), 40, 1e-9);
  // A circle of radius 10 as four kappa cubics is 2πr to well under a thousandth.
  near(pathLength(ellipsePath(0, 0, 10, 10)), 2 * Math.PI * 10, 0.01);
});

test('a hard stop stays two stops, and unrolling covers the shape', () => {
  const stops: any[] = [
    { offset: 0, rgb: [1, 0, 0], alpha: 1 },
    { offset: 0.5, rgb: [1, 0, 0], alpha: 1 },
    { offset: 0.5, rgb: [0, 0, 1], alpha: 1 },
    { offset: 1, rgb: [0, 0, 1], alpha: 1 },
  ];
  const unrolled = unrollGradient(stops, 'repeat', 2);
  assert.equal(unrolled.stops.length, stops.length * 5, 'five periods for k = 2');
  assert.equal(unrolled.fromT, -2);
  assert.equal(unrolled.toT, 3);
  // The duplicate offset survives the unrolling: a hard stop IS two stops at one offset, and dropping one turns every stripe into a ramp.
  const duplicates = unrolled.stops.filter((s, i, all) => i > 0 && s.offset === all[i - 1].offset);
  assert.equal(duplicates.length, 9, 'one hard edge inside each of the five periods, and one at each of the four seams between them');

  // `reflect` reverses the stop list on alternate copies.
  const reflected = unrollGradient(stops, 'reflect', 1);
  assert.deepEqual(reflected.stops.slice(0, 4).map((s) => s.rgb), [[0, 0, 1], [0, 0, 1], [1, 0, 0], [1, 0, 0]]);

  // A radial gradient's periods are cut at radius zero: the first stop sits at the floor, every stop above it keeps its parameter, and the parameter of each stop is its radius over the outer radius, so a ring keeps its width.
  const ramp: any[] = [{ offset: 0, rgb: [1, 1, 0], alpha: 1 }, { offset: 1, rgb: [0, 0, 1], alpha: 1 }];
  const cut = unrollGradient(ramp, 'reflect', 2, 0);
  assert.equal(cut.fromT, 0);
  assert.equal(cut.toT, 3);
  assert.deepEqual(cut.stops.map((s) => [s.offset * cut.toT, s.rgb]), [[0, [1, 1, 0]], [0, [1, 1, 0]], [1, [0, 0, 1]], [1, [0, 0, 1]], [2, [1, 1, 0]], [2, [1, 1, 0]], [3, [0, 0, 1]]]);
  const mid = unrollGradient(ramp, 'repeat', 1, -0.25);
  assert.deepEqual(mid.stops[0], { offset: 0, rgb: [0.25, 0.25, 0.75], alpha: 1 }, 'a stop interpolated at a floor inside a period');

  // Chromium keeps a gradient's absolute lengths as written in its computed value, so a stripe of 2mm is 2mm, 7.559 px, and not 2 px.
  const striped = cssGradient('repeating-linear-gradient(90deg, rgb(0, 0, 0) 0px, rgb(0, 0, 0) 2mm, rgb(255, 221, 0) 2mm, rgb(255, 221, 0) 4mm)', { x: 0, y: 0, w: 100, h: 10 }, [1, 0, 0, 1, 0, 0]).shading as any;
  const line = Math.hypot(striped.coords[2] - striped.coords[0], striped.coords[3] - striped.coords[1]);
  near((striped.stops[2].offset - striped.stops[0].offset) * line, (2 * 96) / 25.4, 1e-6, 'a 2mm stripe');
  // A period's last stop and the next one's first are one offset; in floats they can come out an ulp apart and in the wrong order, which the shading builder's sort turned into a ramp. Measured on the vector roads document's backdrop, a box 211.640625 px wide, as layout measured it.
  const backdrop = cssGradient('repeating-linear-gradient(90deg, rgb(0, 0, 0) 0px, rgb(0, 0, 0) 4mm, rgb(255, 221, 0) 4mm, rgb(255, 221, 0) 8mm)', { x: 0, y: 0, w: 211.640625, h: 10 }, [1, 0, 0, 1, 0, 0]).shading as any;
  assert.ok(backdrop.stops.every((stop: any, i: number) => i === 0 || stop.offset >= backdrop.stops[i - 1].offset), 'the unrolled offsets never decrease');

  // periodsFor is how many stop-ranges fit across the shape, plus one so the edges are covered whatever the phase.
  assert.equal(periodsFor(1, 0.25), 5);
  assert.equal(periodsFor(1, 1), 2);
  assert.equal(periodsFor(1, 0), 0, 'a zero span asks for nothing');
  assert.equal(periodsFor(1, 1e-9), 0, 'and a span at the epsilon is a zero span');
  assert.equal(periodsFor(1e9, 1e-8), 64, 'never more than 64 periods, whatever the arithmetic asks for');
});

test('the /Bounds nudge is a millionth of the domain, so the edge stays an edge', () => {
  // ShadingBuilder does the nudging when it writes the dictionary; the arithmetic it uses is the one asserted here, so the rule is checked without a PDFContext.
  const t0 = 0;
  const t1 = 1;
  const epsilon = (t1 - t0) * 1e-6;
  const offsets = [0, 0.5, 0.5, 1];
  for (let i = 1; i < offsets.length - 1; i++) {
    if (offsets[i] <= offsets[i - 1]) offsets[i] = offsets[i - 1] + epsilon;
  }
  assert.deepEqual(offsets, [0, 0.5, 0.5 + 1e-6, 1]);
  assert.ok(offsets[2] > offsets[1], '/Bounds has to be strictly increasing');
  assert.ok(offsets[2] - offsets[1] < 1e-5, 'and no renderer can see a millionth of a gradient');
});

test('the skip-ink band inset and dilation cap are Blink’s two numbers', () => {
  assert.equal(MAX_DILATION_PX, 13);
  assert.equal(BAND_INSET_PX, 0.5);
  // ComputeDecorationThickness: an `auto` underline is font-size / 10, floored at one pixel.
  assert.equal(blinkThicknessPx(16), 1.6);
  assert.equal(blinkThicknessPx(8), 1, 'floored at one pixel');
  assert.equal(blinkThicknessPx(120), 12);
  // The dilation is min(thickness, 13), so a 200 px heading's underline dilates by 13 and not by 20.
  assert.equal(Math.min(blinkThicknessPx(200), MAX_DILATION_PX), 13);
});

test('complementOf is the pieces of a line the glyphs did not cut out', () => {
  assert.deepEqual(complementOf(0, 100, []), [[0, 100]]);
  assert.deepEqual(complementOf(0, 100, [[20, 30], [50, 60]]), [[0, 20], [30, 50], [60, 100]]);
  // Cuts outside the line are ignored; a cut that swallows it leaves nothing.
  assert.deepEqual(complementOf(0, 100, [[-50, -10], [200, 300]]), [[0, 100]]);
  assert.deepEqual(complementOf(0, 100, [[-10, 110]]), []);
  // Overlapping cuts do not double-count, and a piece narrower than a millionth is not a piece.
  assert.deepEqual(complementOf(0, 100, [[10, 60], [30, 80]]), [[0, 10], [80, 100]]);
  assert.deepEqual(complementOf(0, 100, [[0, 50], [50 + 1e-9, 100]]), []);
});

test('marker vertices: a closed triangle carries four, and the two at the seam point the same way', () => {
  const triangle = markerVertices(parsePath('M0 0 L10 0 L5 10 Z'));
  assert.equal(triangle.length, 4, 'SVG 1.1 §11.6.2: the closepath contributes one too');
  assert.equal(triangle[3].fromClose, true);
  assert.deepEqual(triangle[3].point, triangle[0].point, 'the closing vertex is the starting point');
  // Both are given the closing segment as their incoming direction and the first segment as their outgoing one, so a closed shape has no seam.
  assert.equal(triangle[0].inDir, triangle[3].inDir);
  assert.equal(triangle[0].outDir, triangle[3].outDir);

  // An open path: the first vertex has no incoming direction and the last has no outgoing one.
  const open = markerVertices(parsePath('M0 0 L10 0 L10 10'));
  assert.equal(open.length, 3);
  assert.equal(open[0].inDir, null);
  assert.equal(open[2].outDir, null);
  near((open[0].outDir as number), 0, 1e-12, 'due east');
  near((open[2].inDir as number), Math.PI / 2, 1e-12, 'arriving from due north in a y-down space');

  // A cubic leaves towards its first control point and arrives from its second — the tangent, never the chord.
  const curve = markerVertices(parsePath('M0 0 C0 10 10 10 10 0'));
  near((curve[0].outDir as number), Math.PI / 2, 1e-12);
  // The incoming direction is the tangent AT the endpoint turned through pi — the direction of travel rather than the direction back towards the control point — so it comes out as 3pi/2 rather than as the equal angle -pi/2.
  near((curve[1].inDir as number), (3 * Math.PI) / 2, 1e-12);
  // A control point coincident with its anchor falls through to the next candidate.
  const doubled = markerVertices(parsePath('M0 0 C0 0 10 10 10 0'));
  assert.notEqual(doubled[0].outDir, null, 'a doubled control point still has a direction');
});

test('markerAngle: a number is degrees, `auto` is the bisector, `auto-start-reverse` turns the start', () => {
  const vertex = (inDir: number|null, outDir: number|null) => ({ point: ([0, 0] as [number, number]), inDir, outDir, subpath: 0, fromClose: false });

  near(markerAngle(vertex(0, 0), 'mid', '90').angle, Math.PI / 2, 1e-12);
  assert.equal(markerAngle(vertex(0, 0), 'mid', 'nonsense').angle, 0);
  // At the first vertex `auto` is the outgoing direction; at the last, the incoming one.
  near(markerAngle(vertex(null, 1), 'start', 'auto').angle, 1, 1e-12);
  near(markerAngle(vertex(2, null), 'end', 'auto').angle, 2, 1e-12);
  // In between it is the bisector, computed as the angle of the SUM of the two unit vectors — which is what keeps it right across the ±180° wrap.
  near(markerAngle(vertex(-Math.PI + 0.1, Math.PI - 0.1), 'mid', 'auto').angle, Math.PI, 1e-9);
  near(markerAngle(vertex(0, Math.PI / 2), 'mid', 'auto').angle, Math.PI / 4, 1e-12);
  // Exactly opposite directions have no bisector; the incoming one is taken.
  near(markerAngle(vertex(0, Math.PI), 'mid', 'auto').angle, 0, 1e-12);
  assert.equal(markerAngle(vertex(null, null), 'mid', 'auto').angle, 0);

  // `auto-start-reverse` is `auto` with the start marker turned 180° and every other vertex unchanged.
  const start = markerAngle(vertex(null, 0), 'start', 'auto-start-reverse');
  near(start.angle, Math.PI, 1e-12);
  assert.equal(start.reversed, true);
  assert.equal(markerAngle(vertex(0, 0), 'mid', 'auto-start-reverse').reversed, false);

  assert.deepEqual([positionOf(0, 3), positionOf(1, 3), positionOf(2, 3)], ['start', 'mid', 'end']);
});

test('the marker placement matrix subtracts the reference point first and adds the vertex last', () => {
  // No viewBox, no rotation, scale 1: the reference point lands on the vertex.
  const plain = placementMatrix([100, 50], 0, 1, 3, 3, IDENTITY);
  assert.deepEqual(apply(plain, 3, 3), [100, 50]);
  // markerUnits: strokeWidth scales about the reference point.
  const scaled = placementMatrix([100, 50], 0, 4, 3, 3, IDENTITY);
  assert.deepEqual(apply(scaled, 3, 3), [100, 50]);
  assert.deepEqual(apply(scaled, 4, 3), [104, 50], 'one unit out is four units out');
  // A quarter turn takes the +x axis onto +y.
  const turned = placementMatrix([0, 0], Math.PI / 2, 1, 0, 0, IDENTITY);
  const [tx, ty] = apply(turned, 1, 0);
  near(tx, 0, 1e-12);
  near(ty, 1, 1e-12);
  // refX/refY are in the marker's CONTENT coordinates, so they go through the viewBox matrix before they are subtracted.
  const viewBox = viewBoxMatrix({
    id: 'a', refX: 5, refY: 5, markerWidth: 10, markerHeight: 10,
    units: 'strokeWidth', orient: 'auto', overflow: 'hidden',
    viewBox: [0, 0, 20, 20], preserveAspectRatio: 'xMidYMid meet',
  });
  assert.deepEqual(viewBox, [0.5, 0, 0, 0.5, 0, 0]);
  const mapped = placementMatrix([100, 50], 0, 1, 5, 5, viewBox);
  assert.deepEqual(apply(mapped, 2.5, 2.5), [100, 50], 'the content point (5,5) is the viewport point (2.5,2.5)');
});

test('viewBoxMatrix is SVG 1.1 §7.8, with `meet` uniform and `none` free', () => {
  const attrs = (over: Partial<MarkerAttributes>) => ({
    id: 'm', refX: 0, refY: 0, markerWidth: 10, markerHeight: 20,
    units: 'strokeWidth', orient: '0', overflow: 'hidden',
    viewBox: null, preserveAspectRatio: 'xMidYMid meet', ...over,
  } as any);
  assert.deepEqual(viewBoxMatrix(attrs({})), IDENTITY, 'no viewBox is the identity');
  assert.deepEqual(viewBoxMatrix(attrs({ viewBox: [0, 0, 0, 10] })), IDENTITY, 'a degenerate viewBox is too');
  // `meet` takes the smaller scale and centres under xMidYMid.
  assert.deepEqual(viewBoxMatrix(attrs({ viewBox: [0, 0, 10, 10] })), [1, 0, 0, 1, 0, 5]);
  // `slice` takes the larger.
  assert.deepEqual(viewBoxMatrix(attrs({ viewBox: [0, 0, 10, 10], preserveAspectRatio: 'xMidYMid slice' })), [2, 0, 0, 2, -5, 0]);
  // `none` scales the two axes independently. (`-minX * scaleX` on a zero origin is negative zero, which `deepStrictEqual` tells apart from zero; adding zero is what makes the assertion about the number rather than about its sign bit.)
  assert.deepEqual(viewBoxMatrix(attrs({ viewBox: [0, 0, 10, 10], preserveAspectRatio: 'none' })).map((n) => n + 0), [1, 0, 0, 2, 0, 0]);
  // A non-zero origin translates by −min × scale.
  assert.deepEqual(viewBoxMatrix(attrs({ viewBox: [4, 4, 10, 10], preserveAspectRatio: 'none' })), [1, 0, 0, 2, -4, -8]);
});

test('parseCssColor and blendName, the two little readers every node goes through', () => {
  assert.deepEqual(parseCssColor('rgb(255, 0, 51)'), { rgb: [1, 0, 0.2], alpha: 1 });
  assert.deepEqual(parseCssColor('rgba(0, 0, 0, 0.5)'), { rgb: [0, 0, 0], alpha: 0.5 });
  assert.deepEqual(parseCssColor('rgb(100% 0% 0%)'), { rgb: [1, 0, 0], alpha: 1 });
  assert.deepEqual(parseCssColor('transparent'), { rgb: [0, 0, 0], alpha: 0 });
  assert.deepEqual(parseCssColor('none'), { rgb: [0, 0, 0], alpha: 0 });
  assert.throws(() => parseCssColor('rebeccapurple'), /cannot parse colour/);

  assert.equal(blendName('normal'), 'Normal');
  assert.equal(blendName(''), 'Normal');
  assert.equal(blendName('multiply'), 'Multiply');
  assert.equal(blendName('color-burn'), 'ColorBurn');
  assert.equal(blendName('hard-light'), 'HardLight');
});

test('bboxOf is the union of every child, a stroke’s width and a form’s placement included', () => {
  assert.deepEqual(bboxOf([]), [0, 0, 0, 0]);
  const fill: any = {
    ...emptyNodeCommon('p', 'background'),
    kind: 'path',
    path: parsePath('M0 0 L10 0 L10 10 L0 10 Z'),
    fill: { kind: 'rgb', rgb: [0, 0, 0] },
    fillRule: 'nonzero',
    stroke: { kind: 'none' },
    strokeStyle: null,
  };
  assert.deepEqual(bboxOf([fill]), [0, 0, 10, 10]);
  // A stroke grows the box by its whole width on each side, because half of it falls outside the path.
  const stroked = { ...fill, strokeStyle: { widthPt: 2, cap: 0, join: 0, miterLimit: 10, dashPt: [], dashPhasePt: 0, nonScaling: false } };
  assert.deepEqual(bboxOf([stroked]), [-2, -2, 12, 12]);
  // A raster contributes its own rectangle, and a group its children's union.
  const raster: any = { ...emptyNodeCommon('p', 'shadow'), kind: 'raster', raster: { feature: 'box-shadow', reason: '', svg: '', rectPt: [20, 20, 5, 5], dpi: 300, cm: [5, 0, 0, 5, 20, 20] } };
  assert.deepEqual(bboxOf([fill, raster]), [0, 0, 25, 25]);
  const group: any = { ...emptyNodeCommon('p', 'box'), kind: 'group', children: [fill, raster], bboxPt: [0, 0, 0, 0], forceForm: false, formReason: '' };
  assert.deepEqual(bboxOf([group]), [0, 0, 25, 25]);
  // A form's content is in the form's own space, so its bounds outside it are the four corners of its /BBox under the placement matrix.
  const form: any = { ...emptyNodeCommon('p', 'marker'), kind: 'form', formKey: 'k', content: [], bboxPt: [0, 0, 10, 10], matrix: mul([2, 0, 0, 2, 0, 0], [1, 0, 0, 1, 100, 100]), reason: '' };
  assert.deepEqual(bboxOf([form]), [100, 100, 120, 120]);
});

test('a box shadow carries its inset keyword and its spread', () => {
  // `spread` was parsed and then used only to pad the raster's canvas, so a shadow was drawn smaller than the browser drew it; `inset` was not read at all, and the deferred record claimed a raster nobody had drawn.
  const outer = parseBoxShadow('rgba(0, 0, 0, 0.4) 0px 2px 8px 4px');
  assert.deepEqual(outer, { color: 'rgba(0, 0, 0, 0.4)', dx: 0, dy: 2, blur: 8, spread: 4, inset: false });
  const inner = parseBoxShadow('rgb(255, 255, 255) 0px 0px 0px 1px inset');
  assert.equal(inner?.inset, true, 'the addendum\'s own inset marker ring is read as one');
  assert.equal(inner?.spread, 1);
  // Only the first layer is painted, and the split is on top-level commas so a colour function keeps its own.
  assert.equal(parseBoxShadow('rgba(0, 0, 0, 0.4) 1px 1px 2px, rgb(255, 0, 0) 9px 9px 9px')?.dx, 1);
  assert.equal(parseBoxShadow('none'), null);
});
