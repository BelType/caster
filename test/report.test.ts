/** The report (D7) — a fresh one has every list present and empty, a `CasterError`'s context travels onto it, and it serialises (the panel reads it over no wire, but the acceptance test hands it out of the page). */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReport, recordProblem, stage } from '../src/report.ts';
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
