/** The report (D7) — a fresh one has every list present and empty, a `CasterError`'s context travels onto it, and it serialises (the panel reads it over no wire, but the acceptance test hands it out of the page). */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confessionsOf, createReport, recordProblem, stage } from '../src/report.ts';
import { clearPageGeometry, setPageGeometry } from '../src/coordinates/pageGeometry.ts';
import { ZoomError } from '../src/errors.ts';

test('a fresh report carries the run\'s options and empty lists', () => {
  const report = createReport({ shaper: 'harfbuzz' });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.capabilities, []);
  assert.deepEqual(report.options, { shaper: 'harfbuzz' });
});

test('a CasterError\'s element and pos travel onto the report, which is how the panel opens a source line', () => {
  const report = createReport();
  recordProblem(report, new ZoomError('the container applies zoom', { element: 'body>div[0]', pos: 42 }));
  assert.deepEqual(report.errors, [{ message: 'the container applies zoom', name: 'ZoomError', element: 'body>div[0]', pos: 42 }]);
});

test('a stage cost is rounded to a tenth of a millisecond', () => {
  const report = createReport();
  stage(report, 'walk', 12.3456);
  assert.equal(report.ms.walk, 12.3);
});

test('the whole report survives JSON, which the acceptance test needs', () => {
  const report = createReport({ colour: 'auto' });
  recordProblem(report, new ZoomError('x'));
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

test('a confession\'s region is in the page\'s CSS px, from its top-left, and clipped to the page', () => {
  // A 300 by 400 pt page whose exporter adds 30 pt on every side: the page box is 320 by 453.333 px.
  setPageGeometry([{ widthPt: 300, heightPt: 400, marginPt: 30, columnWidthPx: 0, nominal: '' }]);
  try {
    const runs = [
      { kind: 'black-text' as const, page: 0, element: 'p[0]', rectPt: [45, 340, 60, 12] },
      { kind: 'black-text' as const, page: 0, element: 'p[0]', rectPt: [45, 325, 90, 12] },
    ];
    const [text] = confessionsOf(runs, [], [], () => false);
    // x from 45 pt is 15 pt into the page box, 20 px; the joined runs' top is 352 pt, 18 pt below the box's top at 370, 24 px; the two lines join to 90 by 27 pt.
    assert.deepEqual(text, { page: 1, kind: 'black-text', rect: { x: 20, y: 24, width: 120, height: 36 }, element: 'p[0]', note: text.note });
    const shadow: any = { owner: 'a', element: null, domPath: 'div[0]', paintIndex: 0, page: 0, node: { domPath: 'div[0]', label: 'box-shadow', clips: [], opacity: 1, strokeOpacity: 1, blend: 'Normal', kind: 'raster', raster: { feature: 'box-shadow', reason: '', svg: '', rectPt: [20, 20, 40, 40], dpi: 300, cm: [40, 0, 0, 40, 20, 20] } } };
    const [clipped] = confessionsOf([], [], [shadow], () => false);
    // The raster reaches 10 pt past the box's left and bottom edges; what is reported is what lies on the page.
    assert.deepEqual(clipped.rect, { x: 0, y: 413.333, width: 40, height: 40 });
    assert.equal(clipped.kind, 'raster-shadow');
  } finally {
    clearPageGeometry();
  }
});
