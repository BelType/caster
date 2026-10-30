# Changelog

## 0.1.1 — 2026-10-30

- **Three marker fixes carried from the monorepo** (the Press's review rounds five to eight, BelType `main` at 42b348b5), in `adapters/reify`:
  - **An item whose marker the author hid still counts.** The list's items are taken before any path changes the item's `display`, so `none, 2., 3.` prints as Blink paints it, where it printed `none, 1., 2.`.
  - **`::marker { content: none }` makes nothing.** It generates no marker box, so the item is reified as one whose marker text is empty; a disc list so styled no longer prints bullets Blink does not paint.
  - **A hanging bullet keeps its lead at a page's top.** Its `margin-top` is written `!important`, since Cicero zeroes the top margin of the box a page resumes at and of its first child.
- **`DESIGN.md`** takes the monorepo's amendments to S91.
- **Proof**: zero-diff against the monorepo's `packages/caster/src` at 42b348b5, 74 of 74 same. The suites that exercise these fixes run in a browser and stay in the monorepo, where they pass; here, 197 of 197 and check 0 errors.

## 0.1.0 — 2026-10-29

- **Caster leaves the BelType monorepo.** `src/` moves from `packages/caster` of `github.com/egildo/beltype` (source: `main` at b46e5806, branch `round/the-caster-port`) into this repository, as TypeScript, by the org drill's codemod. The port is mechanical: each of the 74 emitted `.js` files reads the same as the `.js` it came from once both are minified with comments dropped. The code is unchanged.
- **Two codemod gaps closed on the way**: a cast whose closing parenthesis follows a line break (`as` may not follow one), and a stray `* ` before an `@property` tag.
- **`dist/` carries `vendor/` and `profiles/`**, because `capabilities` finds them relative to itself. `capabilities` is emitted by a second pass without `rewriteRelativeImportExtensions` (`tsconfig.capabilities.json` says why).
- **Faces**: `.` and the unstable `./internal/*`, which the editing tools use for the types of `options`, `report` and `adapters/strip`.
- **Tests**: 22 suites on `node:test` from `.ts`, 197 tests, the count they had in the monorepo. `vendor-bundles` serves the built `dist/` and launches Chromium through `test/launch.ts`, a copy of the monorepo's launcher. The other 23 stay in the monorepo with their helpers.
