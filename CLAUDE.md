# Working on Caster

`@beltype/caster`: the browser-side PDF 2.0 / PDF/UA-2 printer over the pages an engine presented. This file is the working method; the design record is `DESIGN.md` (read from the section a change touches), the usage is `README.md`.

## The document hierarchy

1. **`DESIGN.md`** — the numbered record of why each part is the way it is. Section numbers (`S61`) are cited with the name beside them (*the conservation of words*, S61).
2. **`.specify/memory/constitution.md`** — the engineering constitution.
3. A `SPEC.md` is owed: the shape round writes it from `DESIGN.md`.

Decision records of the BelType project, the editing tools, the CLI and the battery that proves Caster end to end still live in the BelType monorepo (`github.com/egildo/beltype`, `packages/caster` is its own copy until Egildo rules on the two).

## Non-negotiables

- TypeScript `strict` and `erasableSyntaxOnly`; relative imports name `./x.ts`. Node runs the sources directly.
- `node:test`, no framework, no network.
- A mechanical change is proven by zero diff: each emitted `.js` against the `.js` it came from, both minified with comments dropped.
- `src/capabilities.ts` resolves `../vendor/…` and `../profiles/…` against its own URL, so the build copies both into `dist/`; the paths in the code do not change.
- A behaviour question the checker raises goes into `TS-FIXES-FOUND.md`, never into the code.
- TSDoc carries the prose, annotations carry the types; never a type restated in prose.

## What stayed in the monorepo

Twenty-three suites drive the CLI, the editing tools, core's fonts, Paged.js or the read-back helpers (`acceptance*`, `band`, `cast-door`, `cast-checks`, `fixed-repeat`, `kept-frame`, `margins`, `numbers`, `pixels`, `table-repeat`, `pairing`, `displayList`, `pseudo-order`, `preview-unprepared`, `facsimile`, `dom-paths`, `list-markers`, `reify`, `tiling`), with their helpers. This repo's 22 run here.

## Run & verify

```bash
pnpm run check   # keep green
pnpm test        # keep green; vendor-bundles needs Chromium (npx playwright-core install --no-shell chromium)
pnpm run build   # dist/, also run by prepare
```
