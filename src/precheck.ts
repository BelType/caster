/**
 * `precheck.js` — the three things that are true before a print starts, or the print does not start.
 *
 * Caster's own; no harness source — the lock is PLAN.md P4's and the Blink refusal PLAN.md D5's. Step 1 of PLAN.md §3's pipeline, and the module that makes P4 safe. Several ported modules keep module-scope state exactly where the harness has it — `coordinates/frame.js`'s `current`, `coordinates/pageGeometry.js`'s installed table, `fonts/hbShaper.js`'s face and font caches, `fonts/varShaper.js`'s byte registry — because moving it would have been a redesign rather than a port. The lock below is what makes that state a property of one export rather than a race between two: `print` takes it and releases it in a `finally`, and a second `print` while one runs refuses by name rather than quietly measuring against the first one's frame.
 *
 * **D5, Blink only.** Every frozen number in the guide is Chromium's: Blink's 1/64 px `LayoutUnit`, its dash arithmetic, its underline offset, `kBoldThreshold` at 600, `kItalicSlopeValue` at 14, `kDecorationClipMaxDilation` at 13. A printer that ran in another engine would produce a file whose every claim was measured somewhere else, so it refuses by name rather than produce one.
 *
 * **The DPR warning, not a refusal.** E10 (`coordinates-and-pages.md`) state 6 proved measurement survives a `devicePixelRatio` other than 1 — the probes recover the scale and the coordinates come out the same — so a retina screen is not an error. What it is, is a condition the cuts were decided under, and the report says so in Cicero's own words: the pagination is valid for this screen and not for print.
 *
 * @packageDocumentation
 */

import { CasterError } from './errors.ts';

/** The one lock. Module-scope on purpose: it guards module-scope state, and a lock in a closure would guard nothing. */
let printing = false;

/** Whether an export is running right now. */
export function isPrinting() { return printing; }

/**
 * Take the lock, or refuse.
 *
 * @returns The release, to be called in a `finally`; calling it twice releases once.
 * @throws {CasterError} A print is already running.
 */
export function lock(): () => void {
  if (printing) {
    throw new CasterError('caster: one export at a time. A print is already running, and the frame, the page geometry and the shaper caches are all module-scope state a second run would measure against the first one\'s. Wait for the first to settle.');
  }
  printing = true;
  let released = false;
  return () => { if (!released) { released = true; printing = false; } };
}

/**
 * Is this a Blink realm?
 *
 * @remarks
 * Measured rather than sniffed from the user agent: `CSS.registerProperty`, `Range.getClientRects`, `OffscreenCanvas` and `webkitRequestFileSystem` are all present in Chromium and the combination is not present anywhere else this printer has been measured in. The user-agent string is a claim; a capability is a fact. The fourth is Blink's alone, no other engine shipped it, and it is measured present in both binaries of the pinned build, the full one and Playwright's headless shell, on a plain `http://` origin as on a secure one: neither the branded browser's `chrome` global nor a secure-context API would do (CHANGELOG 2026-10-28, *The Press*). It is deprecated: a Chromium bump that removes it refuses loudly here, at the bump, which is a deliberate act with a battery run behind it.
 */
export function isBlink(view: Window&typeof globalThis) {
  const css = (view as any).CSS;
  return typeof css?.registerProperty === 'function'
    && typeof view.Range?.prototype?.getClientRects === 'function'
    && typeof ((view as any).OffscreenCanvas) === 'function'
    && typeof ((view as any).webkitRequestFileSystem) === 'function';
}

export type PrecheckResult = {
  devicePixelRatio: number;
  warnings: string[];
};

/**
 * Run the precheck against the realm the print will happen in.
 *
 * @param view - The print frame's window.
 * @throws {CasterError} The realm is not Blink (D5).
 */
export function precheck(view: Window&typeof globalThis): PrecheckResult {
  if (!isBlink(view)) {
    throw new CasterError('caster: this printer runs in a Chromium-based browser and refuses anywhere else. Every number it is built on was measured in Blink — the 1/64 px layout quantum, the dash and gap ratios, the underline offset, the bold and italic synthesis thresholds, the skip-ink dilation cap — so a file produced in another engine would carry claims nothing measured.');
  }
  const warnings: string[] = [];
  const dpr = view.devicePixelRatio;
  if (dpr !== 1) {
    // E10 (`coordinates-and-pages.md`) state 6: measurement survives it, so this is a condition rather than a fault.
    warnings.push(`caster: devicePixelRatio is ${dpr}. The measurement survives it — the frame's probes recover the container scale whatever it is — but the engine decided these cuts on this screen, so the pagination is valid for this screen rather than for print. Cicero says the same thing on every run of its own.`);
  }
  return { devicePixelRatio: dpr, warnings };
}
