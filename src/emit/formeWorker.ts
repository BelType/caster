/**
 * `emit/formeWorker.js` — the dedicated worker forme writes in, in a page: one request, one answer, and the page terminates it.
 *
 * @remarks
 * The request is `emit/forme.ts`'s {@link FormeRequest}: the glue's URL, the module the page compiled, the list's JSON and the blobs. The worker imports the glue, instantiates the compiled module with `initSync` (no fetch and no second compile), writes, and answers with the file, transferred, and the records' JSON; or with forme's refusal as plain data, its sentence and `listItem`; or, where the glue cannot be imported or instantiated, with why, which the page refuses by name. It reads no DOM and needs none (*the writer reads only the display list*, S94). It imports no module of Caster's but for types, since a worker has no import map and `errors.ts` names `@beltype/common` bare; so the refusal is made plain here by the rule `forme.ts`'s `refusalOf` keeps for node.
 *
 * @packageDocumentation
 */

import type { FormeGlue, FormeReply, FormeRequest } from './forme.ts';

/** The worker's global scope, as much of it as this module uses; the package's checker reads the DOM's library, not the worker's. */
const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<FormeRequest>) => void) | null, postMessage(message: FormeReply, transfer?: Transferable[]): void };

scope.onmessage = async ({ data }) => {
  let glue: FormeGlue;
  try {
    glue = await import(/* @vite-ignore */ data.glue);
    glue.initSync({ module: data.module });
  } catch (error) {
    scope.postMessage({ start: `forme's glue could not be instantiated in the worker: ${String(error)}` });
    return;
  }
  const writer = new glue.Writer();
  try {
    for (const [key, bytes] of data.blobs) writer.blob(key, bytes);
    const { bytes, records } = writer.write(data.list);
    scope.postMessage({ bytes, records }, [bytes.buffer]);
  } catch (error) {
    const listItem = (error as { listItem?: [number, number] })?.listItem;
    scope.postMessage({ refusal: { message: String((error as Error)?.message ?? error), ...(listItem ? { listItem } : {}) } });
  } finally {
    writer.free();
  }
};
