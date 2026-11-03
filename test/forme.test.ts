/**
 * The Rust writer's door in node, whatever writer the run prints with: forme's vendored module writes every committed list, the same bytes twice, and a refusal that names an item crosses as a `CasterError` carrying it, as the oracle's does.
 *
 * @remarks
 * forme is held to the oracle's files by the readers of `npm run identity -- compare`, and to its own bytes in the page by `npm run identity -- check --writer forme`; this is the part of both a suite can afford. `CASTER_WRITER=forme npm test` runs every other suite with forme too (`test/writer.ts`).
 *
 * @see /Users/egildo/Privata/dev/beltype/.claude/plans/the-rust-writer/plan-rust-writer.md (stage 9)
 * @packageDocumentation
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from '../src/capabilities.ts';
import { writeWithForme } from '../src/emit/forme.ts';
import { recordsOf } from '../src/displayList/records.ts';
import { CasterError } from '../src/errors.ts';

import type { DisplayList } from '../src/displayList.ts';

const LISTS = path.join(path.dirname(fileURLToPath(new URL('../package.json', import.meta.url))), 'fixtures', 'lists');
const corpus: { name: string; list: { blobs: string[] } }[] = JSON.parse(fs.readFileSync(path.join(LISTS, 'corpus.json'), 'utf8')).documents;

function listOf(name: string): DisplayList {
  const list = JSON.parse(fs.readFileSync(path.join(LISTS, `${name}.json`), 'utf8'));
  list.resources.blobs = Object.fromEntries(corpus.find((e) => e.name === name)!.list.blobs.map((hash) => [hash, new Uint8Array(fs.readFileSync(path.join(LISTS, 'blobs', hash)))]));
  return list;
}

before(async () => { await load(['forme']); });

test('forme writes every committed list in node, the CFF2 face the oracle refuses among them, the same bytes twice, with records recordsOf reads', async () => {
  for (const { name } of corpus) {
    const first = await writeWithForme(listOf(name));
    const second = await writeWithForme(listOf(name));
    assert.ok(Buffer.from(first.bytes).equals(Buffer.from(second.bytes)), `${name}: the second write is the first`);
    assert.equal(Buffer.from(first.bytes).subarray(0, 8).toString('latin1'), '%PDF-2.0', `${name}: a PDF 2.0 file`);
    assert.equal(recordsOf(listOf(name), first.records).runs.length, first.records.pens.length, `${name}: one run per pen`);
  }
});

test('a refusal of forme\'s that names an item crosses as a CasterError carrying it', async () => {
  const list = listOf('cast');
  const instance = list.resources.fonts.find((f) => list.pages.some((page) => page.items.some((item) => item.kind === 'text' && item.font === f.key)))!;
  const dropped = instance.widths.gids.pop()!;
  instance.widths.units.pop();
  await assert.rejects(writeWithForme(list), (error: unknown) => error instanceof CasterError && error.message.includes(`glyph ${dropped} of ${instance.key}`) && error.listItem !== undefined && Number.isInteger(error.listItem.page) && Number.isInteger(error.listItem.item));
});
