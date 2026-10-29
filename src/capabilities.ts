/**
 * `capabilities.js` — the capability registry: which heavy dependency is loaded, and when (PLAN.md §4).
 *
 * Caster's own; no harness source — the harness imported its libraries statically, and PLAN.md D3 is why the libraries behind this registry are committed bundles rather than package imports. Guide: `docs/guide/README.md` §"The dependency tiers".
 *
 * The answer to "load heavy things only when the document needs them", built in from the first round so it never has to be retrofitted. The tiers are the guide's: `pdf-lib` and `fontkit` are always; `harfbuzzjs` and its subset wasm are the full text tier; `fast-png`, `lcms-wasm` and the two ICC profiles are optional and each has a condition the walk answers.
 *
 * Every URL is relative to this module (`new URL(rel, import.meta.url)`), never a bare specifier, so the registry works under any host that serves the package directory — the editing tools' import map, a headless host later, or a plain static server. That is also why the bundles are committed: `vendor/README.md` says what each is and `scripts/bundle-vendor.js` regenerates them.
 *
 * The rule that matters: `capability(name)` throws when the capability was not loaded, naming it and the flag that would have loaded it. It never falls back (*the capability registry never falls back*, DESIGN.md S6). `docs/guide/shaping.md` §"The two tiers" records why: fontkit produces the right widths and the wrong glyphs on two of three failure modes, so a pipeline that fell back when harfbuzzjs failed to load would pass every width assertion and show the wrong letters.
 *
 * @packageDocumentation
 */

import { CapabilityError } from './errors.ts';
import { colourOn } from './options.ts';

import type { CasterOptions } from './options.ts';
import type { ReportCapability, ReportNeeds } from './report.ts';

/**
 * What `capability(name)` hands back, per registry key — the one structural type of the package, and what makes "never a fallback" checkable: no member is `| undefined`, so a caller cannot write the branch that would be one.
 *
 * @remarks
 * Each member is what `loadOne` builds for its spec's shape: a `url` alone is the module namespace, a `wasm` alone is the bytes, both are `{ module, wasm }`, `files` is the bytes by basename. `pdf` and `fastPng` point at the declarations their packages ship, which the vendored bundles re-export whole (`scripts/bundle-vendor.js`; keep in step with `package.json`'s pins, as `types/vendor.d.ts` says). The inline `typeof import('…')` is the one place the house convention cannot avoid it: a namespace has no name to `@import`. `fontkit`, `harfbuzz`, `lcms`'s glue and `woff2` stay `any` on purpose — fontkit's shipped declarations describe its node build and the browser bundle exports only `create`, harfbuzzjs and wawoff2 ship none, and a hand-written surface would be a second version to keep in step (`types/vendor.d.ts`, `types/fontkit.d.ts`). `localFonts` is `never`: a reserved door is refused by `load` and can never have been loaded, so `capability('localFonts')` only ever throws.
 */
export type CapabilityMap = {
  /** pdf-lib, whole. */
  pdf: typeof import('pdf-lib');
  /** fontkit's browser build; `create` is read off the namespace (*fontkit's browser bundle has no default export*, DESIGN.md S1). */
  fontkit: any;
  /** harfbuzzjs, initialised at module top level. */
  harfbuzz: any;
  /** The subset wasm's bytes, which `fonts/hbSubset.js` instantiates itself (*the subset wasm is not glue-bound*, DESIGN.md S4). */
  hbSubset: Uint8Array;
  /** fast-png, whole. */
  fastPng: typeof import('fast-png');
  /** lcms-wasm's glue and the wasm it is handed. */
  lcms: { module: any, wasm: Uint8Array };
  /** wawoff2 as `vendor/wawoff2.js` patches it (*BelType ships faces of its own, and WOFF2 is decoded*, DESIGN.md S46). */
  woff2: any;
  /** The ICC profiles by basename: `srgb.icc`, `default_cmyk.icc`. */
  profiles: Record<string, Uint8Array>;
  /** Reserved, not built (PLAN.md D2). */
  localFonts: never;
};

export type CapabilityName = keyof CapabilityMap;

/** One registry row: where a capability's bytes are, and when a run needs them. */
export type CapabilitySpec = {
  /** A module to import, relative to this file. */
  url?: string;
  /** A `.wasm` to fetch as bytes, relative to this file. */
  wasm?: string;
  /** Plain files to fetch as bytes, relative to this file. */
  files?: string[];
  /** Loaded on every run. */
  always?: boolean;
  /** Whether this run needs it, given what the walk found and the flags it was made with. */
  when?: (needs: ReportNeeds, options: CasterOptions) => boolean;
  /** The option a refusal names. */
  flag?: string;
  /** A door that is visible and not built: the loader refuses with this sentence. */
  reserved?: string;
};

/** The registry. Keyed by exactly the names of {@link CapabilityMap}: a row with no member there, or a member with no row here, fails the check. */
export const CAPABILITIES: Record<keyof CapabilityMap,CapabilitySpec> = {
  pdf: { url: '../vendor/pdf-lib.js', always: true },
  fontkit: { url: '../vendor/fontkit.js', always: true },
  harfbuzz: { url: '../vendor/harfbuzz.js', when: (needs, o) => o.shaper === 'harfbuzz', flag: 'shaper' },
  hbSubset: { wasm: '../vendor/harfbuzz-subset.wasm', when: (needs, o) => o.subset === 'hb', flag: 'subset' },
  fastPng: { url: '../vendor/fast-png.js', when: (needs, o) => Boolean(needs.forcedPngDecode) && o.pngDecoder === 'fast-png', flag: 'pngDecoder' },
  lcms: { url: '../vendor/lcms.js', wasm: '../vendor/lcms.wasm', when: (needs, o) => o.convertRgb === 'wasm', flag: 'convertRgb' },
  // *BelType ships faces of its own, and WOFF2 is decoded* (DESIGN.md S46). Loaded only for a descriptor whose only source is a WOFF2 — a CSSOM read, no byte fetched, the same shape as `forcedPngDecode`. `src: url(x.woff2), url(x.woff)` still takes the WOFF and never loads this, which is what keeps KaTeX's twenty-odd faces from paying 307 kB for a decode nobody needed. There is no flag: nothing the operator can set selects it, so a WOFF2 that reaches `decodeWoff2` without it still refuses by name through `capability()`, the way every other capability does.
  woff2: { url: '../vendor/wawoff2.js', when: (needs) => Boolean(needs.woff2Only) },
  profiles: { files: ['../profiles/srgb.icc', '../profiles/default_cmyk.icc'], when: (needs, o) => colourOn(needs, o), flag: 'colour' },
  localFonts: { reserved: 'Local Font Access — not built this round. D2: the printer embeds programs, so every face must reach it as bytes; a system font a tab cannot read is an export error naming the family.' }
};

/**
 * What has been loaded in this realm, by name.
 *
 * @remarks
 * `value` is `any` on purpose: its shape is the spec's, and {@link CapabilityMap} types it at the one place it is read, `capability()`.
 */
const loaded: Map<string,{ value: any; bytes: number; ms: number; }> = new Map<any, any>();

/**
 * Forget every loaded capability, for a fresh run.
 *
 * @remarks
 * `print()` does not clear the registry between runs within one realm — a bundle imported once stays imported — but a test may, and the panel gets a fresh registry per export anyway, because the printer runs in the realm it prints and this module is injected into each new print frame (*the printer runs in the realm it prints*, DESIGN.md S20).
 */
export function clearCapabilities() { loaded.clear(); }

/**
 * The capabilities a run needs, given what the walk found and the flags it was made with.
 *
 * @param needs - What the walk and the font table found, before any load.
 * @param options - The resolved flags.
 * @returns In registry order — which puts the `always` rows first — so the report reads in a stable order. A reserved door is never among them.
 */
export function neededCapabilities(needs: ReportNeeds, options: CasterOptions): CapabilityName[] {
  const out = ([] as CapabilityName[]);
  for (const [name, spec] of Object.entries(CAPABILITIES)) {
    if (spec.reserved) continue;
    if (spec.always || (spec.when && spec.when(needs, options))) out.push((name as CapabilityName));
  }
  return out;
}

/**
 * Load the named capabilities in parallel, reporting each as it lands.
 *
 * @param onProgress - Called once per capability, as each lands and not in `names` order.
 * @returns One entry per name, in `names` order, with what each cost.
 * @throws {CapabilityError} A name the registry does not hold; a reserved door (`localFonts`); a `wasm` or `files` entry the realm can neither fetch nor read, or whose fetch answers other than 2xx.
 */
export async function load(names: CapabilityName[], onProgress?: (entry: ReportCapability) => void): Promise<ReportCapability[]> {
  const entries = await Promise.all(names.map((name) => loadOne(name, onProgress)));
  return entries;
}

/**
 * Load one capability, or answer from the registry where it already stands.
 *
 * @returns `ms: 0` and `reason: 'already loaded'` for a capability an earlier run in this realm loaded.
 * @throws {CapabilityError} As {@link load}.
 */
async function loadOne(name: CapabilityName, onProgress?: (entry: ReportCapability) => void): Promise<ReportCapability> {
  const spec = CAPABILITIES[name];
  if (!spec) throw new CapabilityError(`caster: no capability named '${name}'.`, { capability: name });
  if (spec.reserved) throw new CapabilityError(`caster: the '${name}' capability is a reserved door, not built. ${spec.reserved}`, { capability: name });
  const already = loaded.get(name);
  if (already) {
    const entry = { name, bytes: already.bytes, ms: 0, loaded: true, reason: 'already loaded' };
    onProgress?.(entry);
    return entry;
  }
  const started = now();
  let bytes = 0;
  // `any` until it is stored: the shape is decided by which of `url`, `wasm` and `files` the spec has, and `CapabilityMap` names it per key at the read.
  let value: any;
  if (spec.url) value = await import(/* @vite-ignore */ new URL(spec.url, import.meta.url).href);
  if (spec.wasm) {
    const wasm = await fetchBytes(new URL(spec.wasm, import.meta.url), name);
    bytes += wasm.byteLength;
    value = spec.url ? { module: value, wasm } : wasm;
  }
  if (spec.files) {
    const files: Record<string,Uint8Array> = {};
    for (const rel of spec.files) {
      const url = new URL(rel, import.meta.url);
      const data = await fetchBytes(url, name);
      bytes += data.byteLength;
      files[rel.split('/').pop() ?? rel] = data;
    }
    value = files;
  }
  const ms = now() - started;
  loaded.set(name, { value, bytes, ms });
  const entry = { name, bytes, ms: Math.round(ms * 10) / 10, loaded: true };
  onProgress?.(entry);
  return entry;
}

/**
 * The loaded capability, or a refusal naming it and the flag that would have loaded it. Never a fallback.
 *
 * @remarks
 * The return type has no `| undefined` and that is the rule made checkable: a caller cannot test for absence, so it cannot take a second road. A module that legitimately has two asks {@link hasCapability} first. Guide: `docs/guide/shaping.md` §"The two tiers".
 *
 * @throws {CapabilityError} The capability was not loaded — carrying `capability`, and `flag` where an option selects it.
 */
export function capability<K extends keyof CapabilityMap>(name: K): CapabilityMap[K] {
  const entry = loaded.get(name);
  if (!entry) {
    const spec = CAPABILITIES[name];
    const flag = spec?.flag ? ` The flag that loads it is '${spec.flag}'.` : '';
    throw new CapabilityError(`caster: the '${name}' capability was not loaded, and there is no fallback for it.${flag}`, { capability: name, flag: spec?.flag });
  }
  return entry.value;
}

/** Whether a capability is loaded, for a module that legitimately has two roads (the PNG decoder does; the shaper does not). */
export function hasCapability(name: CapabilityName) { return loaded.has(name); }

/**
 * The bytes behind a `wasm` or a `files` entry.
 *
 * @remarks
 * Node refuses `fetch` on a `file:` URL, so a run under `node --test` that reached a wasm door — the subsetter, lcms, the two ICC profiles — would fail on the transport rather than on anything about the capability (Agent B's finding, recorded as DESIGN.md P15 and *`fetchBytes` reads a `file:` URL*, DESIGN.md S17). The door is a browser door and that is by design; a node-side caller with the bytes already in hand passes them in (`fonts/hbSubset.js`'s `loadSubsetter(bytes)` is the shape). This still reads a `file:` URL where the platform can, so a node-side test that wants the real profile bytes gets them instead of a transport error, and the message names the transport where it cannot.
 *
 * @param name - The capability the bytes are for, which the refusal names.
 * @throws {CapabilityError} A `file:` URL this realm can neither fetch nor read; a fetch that answers other than 2xx.
 */
async function fetchBytes(url: URL, name: string) {
  if (url.protocol === 'file:') {
    try {
      const fs = await import(/* @vite-ignore */ 'node:fs/promises');
      return new Uint8Array(await fs.readFile(url));
    } catch (error) {
      throw new CapabilityError(`caster: the '${name}' capability is at ${url.href}, and this realm can neither fetch a file: URL nor read one (${String(error)}). The capability doors are browser doors; a node-side caller hands the bytes over directly.`, { capability: name });
    }
  }
  const response = await fetch(url.href);
  if (!response.ok) throw new CapabilityError(`caster: the '${name}' capability could not fetch ${url.pathname} (${response.status}).`, { capability: name });
  return new Uint8Array(await response.arrayBuffer());
}

function now() { return typeof performance === 'object' ? performance.now() : Date.now(); }
