/** The error family has no dead names: every class `errors.js` exports is thrown somewhere in `src/`. A named refusal nobody raises reads as a guarantee the printer does not make. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as errors from '../src/errors.ts';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

test('every error class errors.js exports has a thrower in src/', () => {
  const sources = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && file !== 'errors.ts')
    .map((file) => readFileSync(join(SRC, file), 'utf8'))
    .join('\n');
  for (const name of Object.keys(errors)) {
    // A class a module extends is live through its subclass (`ColorHintError` is `HintParseError`'s family).
    assert.ok(sources.includes(`new ${name}(`) || sources.includes(`extends ${name} `), `${name} is declared in errors.js and neither constructed nor extended anywhere in src/`);
  }
});

test('the maintainer scripts throw the family too, never a bare Error', () => {
  const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));
  for (const file of readdirSync(SCRIPTS).filter((f) => f.endsWith('.js'))) {
    assert.doesNotMatch(readFileSync(join(SCRIPTS, file), 'utf8'), /new Error\(/, `scripts/${file} throws a bare Error`);
  }
});
