/**
 * The type check, as a test: `tsc -p tsconfig.test.json` over the package exits 0.
 *
 * @remarks
 * Caster's contract with its capabilities is a type — `capability(name)` answers `CapabilityMap[name]` with no `| undefined`, which is "never a fallback" made checkable — so a red check is a broken rule and not a style note, and this suite carries it into `npm test`. It SKIPS where `typescript` cannot be resolved: the root pins it as a devDependency and `npm ci --omit=dev` never installs it, and a missing checker is an absent tool, not a failing package. PLAN.md D3; DESIGN.md S5.
 *
 * @packageDocumentation
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function tscPath(): string|null {
  try {
    const manifest = createRequire(import.meta.url).resolve('typescript/package.json');
    return join(dirname(manifest), 'bin', 'tsc');
  } catch {
    return null;
  }
}

const tsc = tscPath();

test('tsc -p tsconfig.test.json exits 0', { skip: tsc ? false : 'typescript is not installed here' }, () => {
  const run = spawnSync(process.execPath, [(tsc as string), '-p', 'tsconfig.test.json'], { cwd: packageDir, encoding: 'utf8' });
  assert.equal(run.status, 0, `tsc -p tsconfig.test.json exited ${run.status}:\n${run.stdout}${run.stderr}`);
});
