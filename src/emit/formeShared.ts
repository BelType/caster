/**
 * `emit/formeShared.js` — the shared worker a host keeps alive so that forme stays warm across documents' pages: one instance of the glue, a fresh `Writer` for every write, or, for a host that asks it to keep blobs, one kept `Writer`.
 *
 * @remarks
 * A module script for a `SharedWorker` (*a host may keep the writer warm*, S104). Each port answers each message in turn: the first carries the glue's URL and the module's bytes, which are imported and instantiated once (`initSync`) and kept; later messages reuse that instance and their `wasm` is ignored. Every message makes its own `Writer`, hands it the blobs, writes, and frees it in a `finally`, so the worker keeps the compiled code and the instance's memory between writes and never a document's data. The reply is `emit/forme.ts`'s {@link FormeReply}, the file transferred. It imports no module of Caster's but for types, as `formeWorker.ts` does, and for the same reason (a worker has no import map).
 *
 * **A message marked `keep`** (`emit/forme.ts`'s {@link FormeKeptRequest}, sent when the host passed `formeKeepsBlobs`) is written by one `Writer` kept for the life of the instance, which holds the blobs between writes: the worker answers {@link FormeLacks} with the keys it holds no bytes for, and with `module` where it has no instance and the message brought none, and otherwise writes with `writeKept`, so a blob is hashed by forme on the first write that uses it and not again. A blob that crosses is hashed again, whatever the worker held under its key. The kept blobs are bounded by {@link KEPT_BYTES}, least recently written forgotten first, after each write. A trap drops the instance and the kept writer with it, and the next message is told it lacks everything.
 *
 * @packageDocumentation
 */

import type { FormeGlue, FormeKeptRequest, FormeLacks, FormeReply, FormeSharedRequest, FormeWriter } from './forme.ts';

/** The worker's global scope, as much of it as this module uses. */
const scope = globalThis as unknown as { onconnect: ((event: MessageEvent) => void) | null };

/**
 * The bytes of blobs the kept writer holds after a write: 32 MiB.
 *
 * @remarks
 * The paper specimen's three font programs are 2.7 MB and a bill's blobs some hundreds of kB, so this keeps the fonts and pictures of about ten such documents. A wasm instance's memory grows and never shrinks, so the cap is also what the worker's memory keeps above what the largest write needs.
 */
export const KEPT_BYTES = 32 * 1024 * 1024;

/** The one instance of the glue, or why it could not be made; kept for the life of the worker. */
let ready: Promise<FormeGlue> | null = null;

/** The kept writer of the instance in `ready`, and the bytes of each blob it holds, least recently written first. */
let kept: { writer: FormeWriter, sizes: Map<string, number> } | null = null;

/** The instance, imported from the glue's text and initialised from the module's bytes on first use. */
function instance(glueSource: string, wasm: Uint8Array): Promise<FormeGlue> {
  return ready ??= import(/* @vite-ignore */ URL.createObjectURL(new Blob([glueSource], { type: 'text/javascript' }))).then((module: FormeGlue) => { module.initSync({ module: wasm }); return module; });
}

/** forme's thrown `Error` as the reply carries it; a trap (forme's panic aborts the module) leaves the instance unusable, so the next message instantiates afresh, while a refusal is an ordinary error and keeps it. */
function refusal(error: unknown): FormeReply {
  if (error instanceof WebAssembly.RuntimeError) { ready = null; kept = null; }
  const listItem = (error as { listItem?: [number, number] })?.listItem;
  return { refusal: { message: String((error as Error)?.message ?? error), ...(listItem ? { listItem } : {}) } };
}

/** One kept write: the blobs that crossed handed over, what is still lacking asked for, then the write and the bound. */
async function writeKept(data: FormeKeptRequest, reply: (message: FormeReply | FormeLacks, transfer?: Transferable[]) => void): Promise<void> {
  if (!ready && !data.wasm) { reply({ lacks: data.keys, module: true }); return; }
  let glue: FormeGlue;
  try { glue = await instance(data.glueSource!, data.wasm!); }
  catch (error) {
    ready = null;
    reply({ start: `forme's glue could not be instantiated in the shared worker: ${String(error)}` });
    return;
  }
  kept ??= { writer: new glue.Writer(), sizes: new Map() };
  const { writer, sizes } = kept;
  for (const [key, bytes] of data.blobs) { writer.blob(key, bytes); sizes.set(key, bytes.byteLength); }
  const lacks = writer.lacks(data.keys);
  if (lacks.length > 0) { reply({ lacks }); return; }
  for (const key of data.keys) { const size = sizes.get(key)!; sizes.delete(key); sizes.set(key, size); }
  try {
    const { bytes, records } = writer.writeKept(data.list, data.keys);
    reply({ bytes, records }, [bytes.buffer]);
  } catch (error) {
    reply(refusal(error));
    // forme keeps no blob a refused write had not hashed before.
    if (kept) for (const key of writer.lacks(data.keys)) sizes.delete(key);
  }
  if (!kept) return;
  let held = 0;
  for (const size of sizes.values()) held += size;
  for (const [key, size] of sizes) {
    if (held <= KEPT_BYTES) break;
    writer.forget(key);
    sizes.delete(key);
    held -= size;
  }
}

scope.onconnect = ({ ports }) => {
  const port = ports[0]!;
  port.onmessage = async ({ data }: MessageEvent<FormeSharedRequest | FormeKeptRequest>) => {
    const reply = (message: FormeReply | FormeLacks, transfer: Transferable[] = []) => port.postMessage(message, transfer);
    if ('keep' in data) return writeKept(data, reply);
    let glue: FormeGlue;
    try {
      glue = await instance(data.glueSource, data.wasm);
    } catch (error) {
      ready = null;
      reply({ start: `forme's glue could not be instantiated in the shared worker: ${String(error)}` });
      return;
    }
    const writer = new glue.Writer();
    try {
      for (const [key, bytes] of data.blobs) writer.blob(key, bytes);
      const { bytes, records } = writer.write(data.list);
      reply({ bytes, records }, [bytes.buffer]);
    } catch (error) {
      reply(refusal(error));
    } finally {
      try { writer.free(); } catch { /* a trapped instance cannot free; it is dropped above */ }
    }
  };
};
