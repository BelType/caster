/**
 * The frame's own arithmetic: which page a viewport point falls in, and what a rectangle is in that page's coordinates.
 *
 * Measuring a frame needs a browser — `beginFrame` reads probes, computed styles and client rectangles out of a live strip — but every lookup OVER a frame is arithmetic on the numbers it stored, and that is what this checks. `installFrame` is the door `beginFrame` itself ends at, so the frame put in front of these functions is exactly the shape a measured one has.
 *
 * The case that matters is R1's, and it is the reason the port generalised the lookup at all: the harness laid its pages left to right and Cicero stacks them vertically, so a rule that read x alone answers with the last page of the file for every point on every page.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { endFrame, installFrame, pageIndexAt, toLocal, toLocalOn, toLocalX, toLocalY } from '../src/coordinates/frame.ts';

/** The measured numbers of a real three-page A4 run at scale 1, from DESIGN.md S9: one left, three tops, 793.688 × 1121.516 each. */
function stack(scale: number = 1) {
  const pages = [24, 1161.516, 2299.031].map((top) => ({
    element: ({} as any),
    left: 203.156,
    top,
    paintedWidthPx: 793.688 * scale,
    paintedHeightPx: 1121.516 * scale,
    widthPx: 793.688,
    heightPx: 1121.516,
    offsetWidthPx: 794,
    offsetHeightPx: 1122,
    nominal: '',
  }));
  return ({
    strip: ({} as any),
    scale,
    scaleFromHeight: scale,
    scaleFromWidthRatio: scale,
    scaleFromHeightRatio: scale,
    linear: [scale, 0, 0, scale],
    offAxisPx: 0,
    cornersAxisAligned: true,
    widthSource: 'computed',
    zoomSeen: [],
    pages,
  } as any);
}

/**
 * @param [w] @param [h]
 */
const rect = (x: number, y: number, w: number = 10, h: number = 10) => ({ left: x, top: y, width: w, height: h, right: x + w, bottom: y + h } as any);

test('a point belongs to the page whose rectangle contains it, and the pages are stacked in y', (t) => {
  t.after(endFrame);
  installFrame(stack());
  assert.equal(pageIndexAt(300, 100), 0, 'inside the first page');
  assert.equal(pageIndexAt(300, 1200), 1, 'inside the second');
  assert.equal(pageIndexAt(300, 2400), 2, 'inside the third');
  // The gutter between two pages belongs to the page above it: the last one starting at or before the point in y.
  assert.equal(pageIndexAt(300, 1150), 0, 'a point in the gutter takes the page above');
  // A trim mark hanging off the left edge of a page is still that page's, because it is below that page's top and no later page starts before it.
  assert.equal(pageIndexAt(190, 1200), 1);
  // Above every page: the first one, rather than a negative index or a throw.
  assert.equal(pageIndexAt(300, -50), 0);
  // With no frame installed there is no answer at all, which is what every no-frame fallback path in the port tests for.
  endFrame();
  assert.equal(pageIndexAt(300, 100), null);
  assert.equal(toLocal(rect(300, 100)), null);
  assert.equal(toLocalOn(rect(300, 100), 1), null);
  assert.equal(toLocalY(100, 0), null);
  assert.equal(toLocalX(300, 0), null);
});

test('a rectangle is expressed against the page the caller names, whatever band its own top falls in', (t) => {
  t.after(endFrame);
  installFrame(stack());
  // Read by its own origin, a rectangle 40 px below the second page's top belongs to the second page.
  assert.deepEqual(toLocal(rect(303.156, 1201.516)), { page: 1, xPx: 100, yPx: 40, wPx: 10, hPx: 10 });
  // Named against the FIRST page — which is S27's rule, a rectangle belonging to the page its node was assigned to — the same rectangle is 1177.516 px down that page, well past its bottom, which is what lets the clip drop it.
  const onFirst = (toLocalOn(rect(303.156, 1201.516), 0) as any);
  assert.equal(onFirst.page, 0);
  assert.equal(onFirst.yPx, 1177.516);
  assert.ok(onFirst.yPx > 1121.516, 'below the first page, which is what a straddler’s tail is');
  // A page index outside the document is clamped rather than answered with undefined: the caller has already decided which page it means.
  assert.equal((toLocalOn(rect(303.156, 100), 9) as any).page, 2);
  assert.equal((toLocalOn(rect(303.156, 100), -3) as any).page, 0);
});

test('every page-local coordinate is divided by the container scale', (t) => {
  t.after(endFrame);
  installFrame(stack(2));
  // The strip is painted at twice its own size, so a rectangle 200 painted px right of the page's left edge is 100 px in the page's own coordinates, and it measures half its painted size.
  assert.deepEqual(toLocal(rect(403.156, 224, 20, 20)), { page: 0, xPx: 100, yPx: 100, wPx: 10, hPx: 10 });
  assert.equal(toLocalX(403.156, 0), 100);
  assert.equal(toLocalY(224, 0), 100);
});
