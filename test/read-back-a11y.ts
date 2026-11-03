/**
 * The accessibility check over a written file, for `scripts/compliance.ts`.
 *
 * @remarks
 * PdfCraft's Accessibility Checker (`test/vendor/pdfcraft-a11y/README.md`), Acrobat's full check written by other people in Rust and compiled to WebAssembly, is asked its rules over the file's bytes (*Acrobat's full check runs over every print*, DESIGN.md S85). veraPDF stays the authority on the PDF/UA-2 profile. Ported from the monorepo's `packages/caster/test/read-back-a11y.js` with its module. Nothing here ships: the module is loaded from `test/vendor/pdfcraft-a11y/` by URL, once per process, and `npm test` never loads it.
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';

const VENDOR = new URL('./vendor/pdfcraft-a11y/', import.meta.url);

/** One finding of a rule. */
export type A11yFinding = {
  /** 0-based. */
  page: number | null;
  /** The structure element at fault, as `num gen R`, when the rule names one. */
  object: string | null;
  /** In PDF user space, when the content could be located. */
  bbox: [number, number, number, number] | null;
  message: string;
};

/** One rule's answer. */
export type A11yResult = {
  /** The rule's stable id, `figures-alt-text`. */
  id: string;
  /** One of Acrobat's seven. */
  category: string;
  name: string;
  status: 'pass' | 'fail' | 'manual' | 'skipped';
  findings: A11yFinding[];
};

let module: Promise<{ check(bytes: Uint8Array): string }> | undefined;

/** The full check over `bytes`: one result per rule, in the checker's own order. */
export async function checkAccessibility(bytes: Uint8Array): Promise<A11yResult[]> {
  module ??= (async () => {
    const glue = await import(new URL('pdfcraft_a11y_wasm.js', VENDOR).href);
    await glue.default({ module_or_path: await fs.readFile(new URL('pdfcraft_a11y_wasm_bg.wasm', VENDOR)) });
    return glue;
  })();
  const glue = await module;
  return JSON.parse(glue.check(new Uint8Array(bytes)));
}
