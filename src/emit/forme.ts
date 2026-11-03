/**
 * `emit/forme.js` — the Rust writer's door: {@link writeWithForme} hands the display list to forme, the vendored WebAssembly module, and takes back the `WriterResult` {@link emitStructure} returns.
 *
 * @remarks
 * forme reads the list and nothing else (*the writer reads only the display list*, S94): the list crosses as the JSON `JSON.stringify` makes of it with `resources.blobs` removed, the fixture format's list file, and each blob crosses as its bytes, never inside JSON. The records come back as the JSON of `WriterRecords` and are parsed here; `pageStreams` is left out, as `WriterResult` allows. A refusal comes back as the `Error` forme throws, with its sentence and, where it names an item, `listItem`, and crosses as a `CasterError` carrying both, so `print()` names the block as it does for the oracle's refusals.
 *
 * **In a page the write runs in a dedicated worker, every time** (*the writer pauses after 50 ms of work*, S93, amended: a writer in a worker holds no frame). A wasm call cannot pause, and on a 300-page list forme held the frame's main thread 764 ms in one call. The page compiles the module once per realm (`WebAssembly.compile`, off the main thread) and posts the compiled `WebAssembly.Module` to a fresh worker per write (`emit/formeWorker.js`), which imports the glue and instantiates it there; the worker is terminated when the write returns, so the module's memory goes with it. The list's JSON and the blobs are copied into the worker, the JSON because a string cannot be transferred and the blobs because they are the caller's (a font's bytes are the shaper's too, and a transferred buffer is detached); the file comes back by transfer. A module the page may not compile (its `script-src` without `'wasm-unsafe-eval'`), and a worker that cannot start, a policy that forbids it (`worker-src`) or a glue it cannot import, is a `CapabilityError` naming `forme` and `writer`, and the write never moves to the main thread (*the capability registry never falls back*, S6). The writer reads only the list, so *the printer runs in the realm it prints* (S20) does not bind it.
 *
 * In node there is no frame to hold, so the write is a direct call: the glue is initialised once per realm from the bytes the capability registry read (`initSync`), and the write runs on the calling thread.
 *
 * @see /Users/egildo/Privata/dev/beltype/.claude/plans/the-rust-writer/plan-rust-writer.md (stage 9, and ruling 6 of 2026-11-03)
 * @packageDocumentation
 */

import { capability } from '../capabilities.ts';
import { CapabilityError, CasterError } from '../errors.ts';

import type { DisplayList } from '../displayList.ts';
import type { WriterRecords, WriterResult } from '../displayList/contract.ts';

/** One write in the making, as `src/wasm.rs` exports it. */
export type FormeWriter = {
  blob(key: string, bytes: Uint8Array): void;
  write(listJson: string): { bytes: Uint8Array, records: string };
  free(): void;
};

/** What `vendor/forme.js` exports that this module and the worker call. */
export type FormeGlue = {
  initSync(module: { module: Uint8Array | WebAssembly.Module }): unknown;
  Writer: new () => FormeWriter;
};

/** What the page posts to the worker: the glue's URL, the compiled module, the list's JSON and the blobs by key. */
export type FormeRequest = { glue: string, module: WebAssembly.Module, list: string, blobs: [string, Uint8Array][] };

/** A refusal of forme's as it crosses a realm: its sentence, and the item it names as `[page, item]`. */
export type FormeRefusal = { message: string, listItem?: [number, number] };

/** What the worker posts back: the file and the records' JSON, forme's refusal, or why the worker could not write at all. */
export type FormeReply = { bytes: Uint8Array, records: string } | { refusal: FormeRefusal } | { start: string };

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

/** forme's thrown `Error` as plain data; `emit/formeWorker.ts` makes the same in the worker, by the same rule. */
function refusalOf(error: unknown): FormeRefusal {
  const listItem = (error as { listItem?: [number, number] })?.listItem;
  return { message: String((error as Error)?.message ?? error), ...(listItem ? { listItem } : {}) };
}

/** The refusal as `print()` reads it: a `CasterError` with `listItem` where forme named one. */
function casterErrorOf({ message, listItem }: FormeRefusal): CasterError {
  return new CasterError(message, listItem ? { listItem: { page: listItem[0], item: listItem[1] } } : {});
}

/**
 * Write the list with forme: in a dedicated worker in a page, by a direct call in node.
 *
 * @throws {CasterError} Every refusal of forme's, its validator's first, in forme's sentence, with `listItem` where it names an item.
 * @throws {CapabilityError} The `forme` capability was not loaded (the flag is `writer`), or, in a page, the module could not be compiled or its worker could not start.
 */
export async function writeWithForme(list: DisplayList): Promise<WriterResult> {
  return typeof document === 'undefined' ? writeHere(list) : writeInWorker(list);
}

/** The write on the calling thread, for a realm with no frame. */
function writeHere(list: DisplayList): WriterResult {
  const { Writer } = glue();
  const writer = new Writer();
  try {
    for (const [key, bytes] of Object.entries(list.resources.blobs)) writer.blob(key, bytes);
    let written: { bytes: Uint8Array, records: string };
    try { written = writer.write(listJson(list)); }
    catch (error) { throw casterErrorOf(refusalOf(error)); }
    return { bytes: written.bytes, records: JSON.parse(written.records) as WriterRecords };
  } finally {
    writer.free();
  }
}

/** The module compiled once per realm, for every worker to instantiate. */
let compiled: Promise<WebAssembly.Module> | null = null;

/** The worker's script, beside this module in `dist/src/emit/`. */
const WORKER = new URL('./formeWorker.js', import.meta.url);

/** The glue the worker imports, where the capability registry imported it (`CAPABILITIES.forme.url`, relative to `src/capabilities.js`). */
const GLUE = new URL('../../vendor/forme.js', import.meta.url);

/** The refusal of a worker that could not write at all. */
function cannotStart(why: string): CapabilityError {
  return new CapabilityError(`caster: the 'forme' capability writes in a dedicated worker, and the worker could not start (${why}); the page must allow a module worker from ${WORKER.origin} (its worker-src), and there is no fallback to the main thread. The flag that asked for it is 'writer'.`, { capability: 'forme', flag: 'writer' });
}

/** The write in a fresh dedicated worker, terminated when it answers. */
async function writeInWorker(list: DisplayList): Promise<WriterResult> {
  const { wasm } = capability('forme');
  let module: WebAssembly.Module;
  try { module = await (compiled ??= WebAssembly.compile(wasm as Uint8Array<ArrayBuffer>)); }
  catch (error) {
    compiled = null;
    throw new CapabilityError(`caster: the 'forme' capability could not be compiled in this page (${String(error)}); the page must allow WebAssembly (its script-src, 'wasm-unsafe-eval'), and there is no fallback for it. The flag that asked for it is 'writer'.`, { capability: 'forme', flag: 'writer' });
  }
  let worker: Worker;
  try { worker = new Worker(WORKER, { type: 'module' }); }
  catch (error) { throw cannotStart(String(error)); }
  try {
    const reply = await new Promise<FormeReply>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<FormeReply>) => resolve(event.data);
      worker.onerror = (event: ErrorEvent) => { event.preventDefault(); reject(cannotStart(event.message || `its script ${WORKER.pathname} did not load`)); };
      worker.onmessageerror = () => reject(cannotStart('its answer could not be read'));
      const request: FormeRequest = { glue: GLUE.href, module, list: listJson(list), blobs: Object.entries(list.resources.blobs) };
      worker.postMessage(request);
    });
    if ('start' in reply) throw cannotStart(reply.start);
    if ('refusal' in reply) throw casterErrorOf(reply.refusal);
    return { bytes: reply.bytes, records: JSON.parse(reply.records) as WriterRecords };
  } finally {
    worker.terminate();
  }
}
