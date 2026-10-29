# Changelog

## 0.1.0 — 2026-10-29

- **Caster leaves the BelType monorepo.** `src/` moves from `packages/caster` of `github.com/egildo/beltype` (source: `main` at b46e5806, branch `round/the-caster-port`) into this repository, as TypeScript, by the org drill's codemod. The port is mechanical: each of the 74 emitted `.js` files reads the same as the `.js` it came from once both are minified with comments dropped. The code is unchanged.
- **Two codemod gaps closed on the way**: a cast whose closing parenthesis follows a line break (`as` may not follow one), and a stray `* ` before an `@property` tag.
- **`dist/` carries `vendor/` and `profiles/`**, because `capabilities` finds them relative to itself. `capabilities` is emitted by a second pass without `rewriteRelativeImportExtensions` (`tsconfig.capabilities.json` says why).
- **Faces**: `.` and the unstable `./internal/*`, which the editing tools use for the types of `options`, `report` and `adapters/strip`.
- **Tests**: 22 suites on `node:test` from `.ts`, 197 tests, the count they had in the monorepo. `vendor-bundles` serves the built `dist/` and launches Chromium through `test/launch.ts`, a copy of the monorepo's launcher. The other 23 stay in the monorepo with their helpers.
