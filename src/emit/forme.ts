/**
 * `emit/forme.js` — the Rust writer's door: {@link writeWithForme} hands the display list to forme, the vendored WebAssembly module, and takes back the `WriterResult` {@link emitStructure} returns.
 *
 * @remarks
 * forme reads the list and nothing else (*the writer reads only the display list*, S94): the list crosses as the JSON `JSON.stringify` makes of it with `resources.blobs` removed, the fixture format's list file, and each blob crosses as its bytes, never inside JSON. The records come back as the JSON of `WriterRecords` and are parsed here; `pageStreams` is left out, as `WriterResult` allows. A refusal comes back as the `Error` forme throws, with its sentence and, where it names an item, `listItem`, and crosses as a `CasterError` carrying both, so `print()` names the block as it does for the oracle's refusals.
 *
 * The glue is wasm-bindgen's `--target web`, initialised once per realm from the bytes the capability registry fetched (`initSync`), so the module is fetched once and node reads it from disk. The write runs on the calling thread.
 *
 * @see /Users/egildo/Privata/dev/beltype/.claude/plans/the-rust-writer/plan-rust-writer.md (stage 9)
 * @packageDocumentation
 */

import { capability } from '../capabilities.ts';
import { CasterError } from '../errors.ts';

import type { DisplayList } from '../displayList.ts';
import type { WriterRecords, WriterResult } from '../displayList/contract.ts';

/** One write in the making, as `src/wasm.rs` exports it. */
export type FormeWriter = {
  blob(key: string, bytes: Uint8Array): void;
  write(listJson: string): { bytes: Uint8Array, records: string };
  free(): void;
};

/** What `vendor/forme.js` exports that this module calls. */
export type FormeGlue = {
  initSync(module: { module: Uint8Array }): unknown;
  Writer: new () => FormeWriter;
};

/** The glue this realm has initialised, so a second write does not compile the module again. */
let ready: FormeGlue | null = null;

/** The glue, initialised from the capability's bytes on first use. */
function glue(): FormeGlue {
  if (ready) return ready;
  const { module, wasm } = capability('forme');
  module.initSync({ module: wasm });
  ready = module;
  return module;
}

/**
 * The list as forme reads it: its JSON without `resources.blobs`.
 *
 * @remarks
 * The same string the identity harness records as the list file, so a list written here and the fixture written by `forme write` are one input.
 */
export function listJson(list: DisplayList): string {
  return JSON.stringify({ ...list, resources: { ...list.resources, blobs: undefined } });
}

/**
 * Write the list with forme.
 *
 * @throws {CasterError} Every refusal of forme's, its validator's first, in forme's sentence, with `listItem` where it names an item.
 * @throws {CapabilityError} The `forme` capability was not loaded (the flag is `writer`).
 */
export async function writeWithForme(list: DisplayList): Promise<WriterResult> {
  const { Writer } = glue();
  const writer = new Writer();
  try {
    for (const [key, bytes] of Object.entries(list.resources.blobs)) writer.blob(key, bytes);
    let written: { bytes: Uint8Array, records: string };
    try { written = writer.write(listJson(list)); }
    catch (error) {
      const at = (error as { listItem?: [number, number] }).listItem;
      throw new CasterError(String((error as Error)?.message ?? error), at ? { listItem: { page: at[0], item: at[1] } } : {});
    }
    return { bytes: written.bytes, records: JSON.parse(written.records) as WriterRecords };
  } finally {
    writer.free();
  }
}
