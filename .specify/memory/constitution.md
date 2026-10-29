# Caster Constitution

Version 0.1.0, ratified 2026-10-29 at Caster's move out of the BelType monorepo. It governs how Caster is built; `DESIGN.md` governs what it means. The shape round writes `SPEC.md` and the articles that cite it.

## Principles

1. **The port is mechanical.** A change of language is proven by zero diff: each emitted `.js` against the `.js` before, both minified with comments dropped. No renaming, merging, splitting or un-exporting rides along.
2. **A behaviour question the checker raises is recorded, not fixed**, in `TS-FIXES-FOUND.md`.
3. **TypeScript `strict`, `erasableSyntaxOnly`, run by Node directly.** Relative imports name `./x.ts`.
4. **`node:test`, no framework, no network.**
5. **TSDoc carries the prose and annotations carry the types.** A type is never restated in prose.
6. **The `.js` the package ships is what the page loads.** `vendor/` and `profiles/` travel into `dist/` beside `src/`.

## Standing exceptions

- `noUncheckedIndexedAccess` is off, as in Cicero; the shape round turns it on.
- The suites that need the CLI, the editing tools, core's fonts or Paged.js run in the BelType monorepo.
