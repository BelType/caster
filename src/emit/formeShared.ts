/**
 * `emit/formeShared.js` — the shared worker a host keeps alive so that forme stays warm across documents' pages: one instance of the glue, a fresh `Writer` for every write.
 *
 * @remarks
 * A module script for a `SharedWorker` (*a host may keep the writer warm*, S104). Each port answers each message in turn: the first carries the glue's URL and the module's bytes, which are imported and instantiated once (`initSync`) and kept; later messages reuse that instance and their `wasm` is ignored. Every message makes its own `Writer`, hands it the blobs, writes, and frees it in a `finally`, so the worker keeps the compiled code and the instance's memory between writes and never a document's data. The reply is `emit/forme.ts`'s {@link FormeReply}, the file transferred. It imports no module of Caster's but for types, as `formeWorker.ts` does, and for the same reason (a worker has no import map).
 *
 * @packageDocumentation
 */

import type { FormeGlue, FormeReply, FormeSharedRequest } from './forme.ts';

/** The worker's global scope, as much of it as this module uses. */
const scope = globalThis as unknown as { onconnect: ((event: MessageEvent) => void) | null };

/** The one instance of the glue, or why it could not be made; kept for the life of the worker. */
let ready: Promise<FormeGlue> | null = null;

scope.onconnect = ({ ports }) => {
  const port = ports[0]!;
  port.onmessage = async ({ data }: MessageEvent<FormeSharedRequest>) => {
    const reply = (message: FormeReply, transfer: Transferable[] = []) => port.postMessage(message, transfer);
    let glue: FormeGlue;
    try {
      glue = await (ready ??= import(/* @vite-ignore */ URL.createObjectURL(new Blob([data.glueSource], { type: 'text/javascript' }))).then((module: FormeGlue) => { module.initSync({ module: data.wasm }); return module; }));
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
      // A trap (forme's panic aborts the module) leaves the instance unusable, so the next message instantiates afresh; a refusal is an ordinary error and keeps it.
      if (error instanceof WebAssembly.RuntimeError) ready = null;
      const listItem = (error as { listItem?: [number, number] })?.listItem;
      reply({ refusal: { message: String((error as Error)?.message ?? error), ...(listItem ? { listItem } : {}) } });
    } finally {
      try { writer.free(); } catch { /* a trapped instance cannot free; it is dropped above */ }
    }
  };
};
