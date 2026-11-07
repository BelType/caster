/**
 * veraPDF's PDF/UA-2 profile passes the recorded prints whose figures hold something other than one image: the paper's table and SVG figures, and the canvas figure.
 *
 * @remarks
 * The files are the corpus's (`fixtures/lists/`), which `npm run identity -- check` holds to what the page prints now. veraPDF is a Java application outside the package, so the test skips by name where `verapdf` is not on the path.
 *
 * @packageDocumentation
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LISTS = path.join(path.dirname(fileURLToPath(new URL('../package.json', import.meta.url))), 'fixtures', 'lists');
const FILES = ['paper', 'canvas'].map((name) => path.join(LISTS, `${name}.pdf`));

test('veraPDF -f ua2 fails no rule on the paper and the canvas figure', (t) => {
  const run = spawnSync('verapdf', ['--flavour', 'ua2', '--format', 'json', ...FILES], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (run.error || !run.stdout) { t.skip('verapdf is not on the path'); return; }
  const failed = JSON.parse(run.stdout).report.jobs.flatMap((job: any) => (job.validationResult ?? [{ details: { ruleSummaries: [{ clause: 'not validated', testNumber: 0, failedChecks: 0 }] } }])
    .flatMap((result: any) => result.details.ruleSummaries.map((rule: any) => `${path.basename(job.itemDetails.name)}: ${rule.clause} t${rule.testNumber} (${rule.failedChecks})`)));
  assert.deepEqual(failed, []);
});
