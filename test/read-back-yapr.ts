/**
 * Reading a PDF back out with yapr, the second reader, for `scripts/compare.ts`.
 *
 * @remarks
 * mupdf reads every file the gate compares; this asks yapr (`test/vendor/yapr/README.md`), a renderer written by other people from the same specification, so that a habit of one reader cannot pass for a fact about the file (*a second reader is asked the same question*, DESIGN.md S83). Ported from the monorepo's `packages/caster/test/read-back-yapr.js` with its module. Nothing here ships: the module is loaded from `test/vendor/yapr/` by URL, once per process, and `npm test` never loads it.
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';

const VENDOR = new URL('./vendor/yapr/', import.meta.url);

/** yapr's viewer: `page_count()`, `page_sizes()`, `render(page, scale)` with `width()` and `height()`, and `text(page)`. yapr ships no types. */
export type Yapr = {
  page_count(): number;
  page_sizes(): Float32Array;
  render(page: number, scale: number): Uint8Array;
  width(): number;
  height(): number;
  text(page: number): string;
  free(): void;
};

let module: Promise<{ Viewer: new (bytes: Uint8Array, password: string) => Yapr }> | undefined;

/** Open `bytes` as a yapr viewer. */
export async function openYapr(bytes: Uint8Array): Promise<Yapr> {
  module ??= (async () => {
    const glue = await import(new URL('yapr_wasm.js', VENDOR).href);
    await glue.default({ module_or_path: await fs.readFile(new URL('yapr_wasm_bg.wasm', VENDOR)) });
    return glue;
  })();
  const glue = await module;
  return new glue.Viewer(new Uint8Array(bytes), '');
}

/**
 * Every glyph one page draws, in content order: its text and its pen origin on the baseline, in points from the top left of the displayed page, as yapr's `text(page)` gives them.
 */
export function pageGlyphs(viewer: Yapr, index: number): { c: string, x: number, y: number }[] {
  const glyphs: [string, number, number, number, number, number, number, number, number][] = JSON.parse(viewer.text(index));
  return glyphs.map(([c, , , , , , , x, y]) => ({ c, x, y }));
}
