/**
 * The writer the suites print with: `CASTER_WRITER=forme npm test` runs every suite that writes a file with the Rust writer, and the default, unset or `pdf-lib`, with the TypeScript writer, the oracle.
 *
 * @remarks
 * The browser suites hand {@link WRITER} to `print()` as the `writer` flag; the node suites write a list through {@link writeList}, which calls the writer the flag names, as `print()` does. A test that holds a fact only one writer can have (the oracle's own committed bytes, its refusal of the CFF2 face) says so with {@link oracleOnly}.
 *
 * @packageDocumentation
 */

import { load } from '../src/capabilities.ts';
import { loadSubsetter } from '../src/fonts/hbSubset.ts';
import { emitStructure } from '../src/emit/structureEmit.ts';
import { writeWithForme } from '../src/emit/forme.ts';

import type { DisplayList } from '../src/displayList.ts';
import type { WriterResult } from '../src/displayList/contract.ts';

const asked = process.env.CASTER_WRITER ?? 'pdf-lib';
if (asked !== 'pdf-lib' && asked !== 'forme') throw new Error(`CASTER_WRITER is ${JSON.stringify(asked)}; the writers are pdf-lib and forme`);

/** The writer this run's suites print with. */
export const WRITER: 'pdf-lib' | 'forme' = asked;

/** A test's `skip` where a fact is the oracle's alone: false under the oracle, the reason under forme. */
export const oracleOnly = (why: string): string | false => (WRITER === 'pdf-lib' ? false : `the oracle's alone: ${why}`);

/** Load what a node-side write needs, both writers' capabilities, once. */
export async function loadWriters(): Promise<void> {
  await load(['pdf', 'fontkit', 'hbSubset', 'fastPng', 'forme']);
  await loadSubsetter();
}

/** Write the list with this run's writer. */
export function writeList(list: DisplayList): Promise<WriterResult> {
  return WRITER === 'forme' ? writeWithForme(list) : emitStructure(list);
}
