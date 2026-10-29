/**
 * The one place BelType launches headless Chromium.
 *
 * @remarks
 * Before this package existed, `engine-pagedjs`'s PDF export and the essay's proof battery each launched a browser independently, each accepting whatever `^25.3.0` happened to resolve. It already drifted — this repo's own install resolved `25.3.0` (`Chrome/150.0.7871.24`), the essay's prior standalone repo resolved `25.4.0` — two different Chromium builds silently underwriting two different sets of claims. `CHROMIUM_BASELINE` below is measured, not assumed: it is the version string this package's pinned browser actually produced on this machine.
 *
 * **ONE PACKAGE DRIVES AND NAMES THE BUILD: `playwright-core`, pinned exactly** (2026-09-21). What is pinned here is a BUILD — the oracle for every print reference in packages/essay is Chromium's own print, and a different Chromium build is a different oracle. `playwright-core`'s `browsers.json` names exactly one Chrome for Testing build per release, so an exact version pin on the dependency is a pin on the binary: one package, one version number, one binary on disk. `npx playwright-core install --no-shell chromium` is the one command that puts it there — the full build and never the headless shell, because the shell is the OLD headless mode and the print it makes is not the print the records were taken against. The one exception is asked for by name, `launchBrowser({ shell: true })`, by a caller that never calls Chromium's print (`beltype cast`, 2026-10-28); `npx playwright-core install chromium-headless-shell` fetches it. `playwright-core` rather than `playwright` because `playwright` exists to download browsers at install time and we want none downloaded until somebody asks.
 *
 * **How it came to be one package, because the scar is worth a paragraph.** Until 2026-09-07 puppeteer drove and fetched. That day the DRIVER moved to Playwright and the BROWSER deliberately did not: `puppeteer@25.3.0` stayed as an optional dependency whose whole job was to download and name Chrome for Testing 150.0.7871.24, launched by Playwright through `executablePath`, so that no standing record had to be re-measured for a driver's sake. Playwright's own build was measured then too (Chromium 141, a thirteen-seed spot check) and refused as the basis for a corpus. On 2026-09-21 the second dependency was dropped on purpose and at its price: the baseline moved to Playwright's 153.0.8010.12 and **the whole battery was run against it before the move was kept** — what it found is in packages/essay's RESULTS.md and the CHANGELOG entry of that date. From here the baseline moves whenever `playwright-core` is bumped, which is a deliberate act that takes a battery run, exactly as a puppeteer bump was.
 *
 * **What consumers see is Playwright's own page API**, not a wrapper. This package owns the LAUNCH — which browser, under which flags, asserted against which baseline — and nothing else; a shim that re-exported `setViewport` and `networkidle0` over Playwright would be a second driver nobody maintains, and would hide exactly the differences a reader of a test needs to see.
 *
 * **This file needs `node` types, and every program that reaches it is a node program — except one, which is kept out on purpose.** Measured 2026-09-21: the editing tools' TAB program (`lib: dom`, `types: []`) reaches this module through `engine-pagedjs/seam/index.js`'s lazy `import('../src/render-pdf.ts')`. A `/// <reference types="node" />` here would have made it check, and would have been program-wide, handing that tab program `process` and `Buffer` in its own files; instead the tab's `jsconfig.json` maps the Paged.js seam to a declaration of the one name it imports (`editing-tools/assets/types/pagedjs-seam.d.ts`), so the tab program never follows the chain this far, the realm guard holds, and this file is checked only where it runs.
 *
 * @see .claude/decisions/project/types-live-beside-the-code.md
 * @packageDocumentation
 */

import type * as playwright from 'playwright-core';

/** Playwright's own types, re-exported so a consumer types what it holds from THIS package and the driver's version is pinned in one `package.json` and no second one. A consumer writes `@import { Page } from '@egildo/beltype-browser-chromium'`. */
export type Browser = playwright.Browser;

export type BrowserType = playwright.BrowserType;

export type Page = playwright.Page;

export type BrowserContext = playwright.BrowserContext;

export type LaunchOptions = {
  /** Add the flags a measurement instrument needs and a plain render does not: `--font-render-hinting=none` and `--force-device-scale-factor=1` (I5's render-identical-conditions law), plus the three background-throttling flags. A plain render is harmless under them too — they only pin font hinting, DPR and whether an unwatched page is allowed to be slowed down — so they stay on by default rather than forking into two launch shapes. Default `true`. */
  deterministic?: boolean;
  /** The caller's own switches, seated LAST, after every flag the launcher guarantees. Default `[]`. */
  args?: string[];
  /** An injectable override of the driver (`playwright-core`'s `chromium` by default) — the seam that lets the error translation be tested with a fake `{ launch }` object instead of a real browser. A caller that hands one in is not given the pinned build's path. */
  driver?: Pick<BrowserType, 'launch'>;
  /** An injectable override of the binary; the pinned build's path by default. */
  executablePath?: string;
  /** Send every connection the browser makes to this proxy, an `http://` URL on an IP address, and to nothing else: no host is bypassed, loopback included (`<-loopback>`), no host name is resolved but the proxy's own address, and WebRTC sends no UDP outside it (`disable_non_proxied_udp`). For a caller whose page must reach no network, which hands in a proxy that forwards nothing: `beltype cast`, whose routes do not see a worker's WebSocket or a shared worker's requests (measured 2026-10-29). Default none, which adds no switch. */
  proxy?: string;
  /** Launch Playwright's bare headless shell (`chromium-headless-shell`) of the pinned build instead of the full binary. For a caller that never calls Chromium's print: `beltype cast` lays nothing out with it and prints through Caster, so only where the engine cuts must hold, and that is layout, the same Blink in both binaries. The essay keeps the full binary, because its oracle IS Chromium's print. Default `false`. */
  shell?: boolean;
};

import fs from 'node:fs';
import { BuildError } from '@beltype/common/errors';

/** The exact Chromium build `package.json`'s pinned `playwright-core` version names — measured, not guessed (`browser.version()` on this machine, 2026-09-21). A battery run asserting against this baseline extends "green must be green for a reason somebody can name" to the browser binary itself. */
export const CHROMIUM_BASELINE = 'Chrome/153.0.8010.12';

/**
 * The three flags that stop Chromium throttling a page nobody is looking at.
 *
 * @remarks
 * A headless browser still runs the whole backgrounding machinery: a tab that is not the foreground one gets its timers clamped, its renderer deprioritized, and — when the window is treated as occluded — very nearly frozen. That is invisible while a run drives ONE page at a time, which is why nothing here ever needed them; it stops being invisible the moment a runner keeps several pages in flight (packages/essay's differential pool), where every page but one is by definition in the background and a measurement taken under a clamped timer is a measurement of the clamp.
 *
 * **Both drivers already pass all three** — verified by reading the launched process's own argv under each, not by trusting either one's documentation. They are stated here anyway because the guarantee belongs to the LAUNCHER and not to whichever driver is under it: these conditions are as much a part of a measurement's pinned setup as `--font-render-hinting=none` is, and the driver swap this file has just been through is exactly the event that could have removed them silently.
 */
const NO_THROTTLE = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];

/**
 * The two PDF switches a BelType print needs, of which Playwright passes one — named here so the print never depends on a driver's defaults (puppeteer passed both, which is how the second was found missing when the driver moved).
 *
 * @remarks
 * `--export-tagged-pdf` Playwright does pass; `--generate-pdf-document-outline` it does not, and `engine-pagedjs`'s `renderPdf` asks for `outline: true` because print's reading layer is the PDF reader and the heading structure is its navigation. Naming both here rather than relying on a default is the same rule as the throttling flags: what a BelType PDF contains is this launcher's to guarantee, not the driver's to decide.
 */
const PDF_SWITCHES = ['--export-tagged-pdf', '--generate-pdf-document-outline'];

/**
 * The two switches a root process needs before Chromium will start at all, and nothing for anybody else.
 *
 * @remarks
 * Chromium refuses to start as root unless the sandbox is disabled, and — the part that costs an hour — it does not refuse *quickly*: the launch sits waiting for a browser that will never report itself ready, so every browser-driven suite hangs instead of failing. Agent containers run as root, so this was met by a hand-written preload shim that patched the driver's `launch`, gitignored, rewritten per session, and documented in packages/essay's `book/PLAN.md` as an open question about whether this function should learn the flag.
 *
 * It should, and this is it: the condition is checkable (`process.getuid() === 0`, and `BELTYPE_NO_SANDBOX=1` for a container that reaches the same state another way), and a hang nobody can read is the worst possible answer to a condition the process can simply ask about. Nothing is loosened for an ordinary user — a non-root process never takes this branch, and `getuid` is absent on Windows, where the question does not arise.
 *
 * @internal
 */
function sandboxArgs(): string[] {
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  return asRoot || process.env.BELTYPE_NO_SANDBOX === '1' ? ['--no-sandbox', '--disable-setuid-sandbox'] : [];
}

/**
 * The driver: `playwright-core`'s `chromium`, loaded lazily so importing this module costs nothing until a browser is actually wanted.
 *
 * @throws {BuildError} when `playwright-core` — an optional dependency — is not installed, naming the install command.
 */
export async function loadDriver(): Promise<BrowserType> {
  try {
    const { chromium } = await import('playwright-core');
    return chromium;
  } catch {
    throw new BuildError(
      'This needs Playwright, which is not installed. ' +
        'Install it with: npm install playwright-core'
    );
  }
}

/**
 * Where the pinned build sits on this machine — answered by `playwright-core`, which is what defines it: its `browsers.json` names one Chrome for Testing build per release, and the dependency is pinned exactly.
 *
 * @remarks
 * Playwright answers with the path the build WOULD have, downloaded or not, so existence is checked here: a refusal is the missing-browser refusal, worded as the fetch instruction, because that is the only thing the caller can act on.
 *
 * @throws {BuildError} when the pinned build was never fetched, worded as the one fetch command.
 */
export async function pinnedExecutablePath(): Promise<string> {
  const binary = (await loadDriver()).executablePath();
  if (!binary || !fs.existsSync(binary)) throw new BuildError(browserMissing);
  return binary;
}

/** The refusal for a missing headless shell: the other binary, and so the other fetch command. */
const shellMissing =
  'No Chromium headless shell available. Fetch it once with:\n\n' +
  '  npx playwright-core install chromium-headless-shell\n\n' +
  '(195 MB on disk, measured 2026-10-28, stored in Playwright\'s own cache: the same pinned build as the full binary).';

const browserMissing =
  'No Chromium available. Fetch it once with:\n\n' +
  '  npx playwright-core install --no-shell chromium\n\n' +
  '(~170 MB, stored in Playwright\'s own cache). BelType installs skip the browser download on purpose — the cost is paid once, knowingly, by whoever actually needs a browser, never silently at install time.';

/**
 * Launch headless Chromium — the pinned build, under the pinned flags — and translate a browser-not-found crash into the honest refusal naming the one fetch command.
 *
 * @remarks
 * The sandbox flags are NOT part of `deterministic`: they answer a property of the process (running as root), not of the measurement, so they ride every launch that needs them and no launch that does not. The PDF switches are not either, for the mirror reason: they are what a BelType PDF is, under every caller.
 *
 * @returns Playwright's own browser: consumers use its API, and this package deliberately wraps none of it.
 * @throws {BuildError} when the driver or the browser is missing, naming the command that fetches it; any other launch failure is rethrown as the driver raised it.
 */
export async function launchBrowser({ deterministic = true, args = [], driver, executablePath, shell = false, proxy }: LaunchOptions = {}): Promise<Browser> {
  const chromium = driver ?? (await loadDriver());
  const detArgs = deterministic ? ['--font-render-hinting=none', '--force-device-scale-factor=1', ...NO_THROTTLE] : [];
  const proxyArgs = proxy ? [`--proxy-server=${proxy}`, '--proxy-bypass-list=<-loopback>', `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${new URL(proxy).hostname}`, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] : [];
  // Resolved before the launch rather than inside it, so a missing browser refuses with the fetch command rather than with whatever the driver says about a path it was handed. The shell is named by no path: Playwright launches `chromium-headless-shell` itself when it is handed none and `headless` is true, and its public API answers only the full binary's path, so a missing shell is caught as the driver's own "Executable doesn't exist" below and refused with the shell's fetch command.
  const binary = executablePath ?? (driver || shell ? undefined : await pinnedExecutablePath());
  try {
    return await chromium.launch({ headless: true, executablePath: binary, args: [...detArgs, ...PDF_SWITCHES, ...proxyArgs, ...sandboxArgs(), ...args] });
  } catch (error) {
    // `error` is `unknown`: a caller's own driver may throw anything, `null` included, so the message is read only off an `Error`, and whatever else was thrown is rethrown as it came.
    // More than Playwright's own "Executable doesn't exist": a caller may hand in a `driver` or an `executablePath` of its own, and the older phrasings are what such a launch says.
    if (error instanceof Error && /Could not find Chrome|could not be found|Executable doesn't exist|no usable sandbox|Browser was not found/i.test(error.message)) {
      throw new BuildError(shell ? shellMissing : browserMissing);
    }
    throw error;
  }
}

/**
 * Refuse to trust a battery run against a different Chromium build than the one every standing record was taken against — the same "check something that can fail" discipline `gates/PIN.json` already applies to the engine's source. Call once, at the top of a full run; a plain render (`renderPdf`) doesn't need it.
 *
 * @remarks
 * Playwright's `browser.version()` answers the bare build (`153.0.8010.12`); the recorded string keeps the `Chrome/` prefix every record since the first has been written with, so a bare version is read as the build it names and a baseline can still be compared with its own history.
 *
 * @param browser - Asked for its version and nothing else, and the answer is awaited: Playwright's `Browser` answers a string outright, and a double may answer a promise of one.
 * @throws {BuildError} when the live build is not {@link CHROMIUM_BASELINE}, naming both strings.
 */
export async function assertChromiumBaseline(browser: { version: () => string|Promise<string>; }) {
  const reported = await browser.version();
  const actual = reported.includes('/') ? reported : `Chrome/${reported}`;
  if (actual !== CHROMIUM_BASELINE) {
    throw new BuildError(
      `Chromium build mismatch: this machine's pinned browser is '${actual}', but every standing record was measured against '${CHROMIUM_BASELINE}'. ` +
        'Either the pinned playwright-core version drifted (check package.json — its browsers.json is what names the build) or a caller launched a binary of its own. Fetch the pinned one with: npx playwright-core install --no-shell chromium'
    );
  }
}
