/**
 * `coordinates/units.js` — the unit constant, and the fallback page the harness's fixtures were laid out on.
 *
 * Ported from the five constants of `harness/src/export/e3-fixture.ts` (E3). Guide: `docs/guide/README.md`.
 *
 * WHAT THE PORT CHANGED (P3). In `browser-to-pdf-experiments` these five constants live in the fixture module, and thirteen ported modules import `PX_TO_PT` from there. PLAN.md P3 says fixture modules are not ported, so the constants get a home of their own rather than a fixture's — this module. Nothing here is a fixture fact except by inheritance: `PX_TO_PT` is the frozen number `docs/guide/README.md` lists first ("CSS px to PDF pt"), and the other four are the geometry every no-frame fallback path in the harness falls back to; `coordinates/pageGeometry.js`'s `DEFAULT_GEOMETRY` is built from them.
 *
 * **Caster never takes those fallback paths.** The engine's adapter installs a frame (`coordinates/frame.js`) and a page geometry per page (`coordinates/pageGeometry.js`) before anything is measured, so `pageGeometryFor` always answers with a real page and `pageIndexAt` always answers with a real index. The fallbacks are kept because keeping them is a smaller and safer port than cutting them — every content stream from E3 (`text-emission.md`) through E9 (`vector-painting.md`) was measured through those branches, and a port that removed them would be a port whose output no experiment ever checked. They are dead weight with a receipt, and the day the last one is proved unreachable is the day they go.
 *
 * @packageDocumentation
 */

/** CSS px to PDF pt. 96 px/in against 72 pt/in. */
export const PX_TO_PT = 0.75;

/** One column: the CSS pixel width of an A4 page. */
export const COLUMN_WIDTH_PX = 794;

/** Column height: the CSS pixel height of an A4 page. */
export const CONTAINER_HEIGHT_PX = 1123;

/** Margin the exporter adds around the column on every side, in the fallback geometry. */
export const MARGIN_PT = 48;

/** The fallback page's width: the column and a margin on each side. */
export const PAGE_WIDTH_PT = COLUMN_WIDTH_PX * PX_TO_PT + 2 * MARGIN_PT;
/** The fallback page's height: the column and a margin above and below. */
export const PAGE_HEIGHT_PT = CONTAINER_HEIGHT_PX * PX_TO_PT + 2 * MARGIN_PT;

/** Round to three decimals, the precision every number the writer puts in a content stream carries. */
export const round3 = (n: number): number => Math.round(n * 1000) / 1000;
