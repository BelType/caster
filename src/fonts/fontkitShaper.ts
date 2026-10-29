/**
 * `fonts/fontkitShaper.js` — the simple shaping tier, behind three pre-checks.
 *
 * Ported from `harness/src/shaping/fontkit-shaper.ts` (E1, E1b). Guide: `docs/guide/shaping.md` §"The two tiers".
 *
 * WHAT THE PORT CHANGED (P2; *fontkit's browser bundle has no default export*, S1). `import { create } from 'fontkit'` is gone: the library reaches this module through `capability('fontkit')`, and the browser bundle has no default export, so `create` is read off the namespace. `FONTKIT_VERSION` came from a `node_modules` package.json import Vite resolved; the version is a build fact a browser module cannot read, so it is the pinned string and `scripts/bundle-vendor.js` is what keeps it true.
 *
 * The tier is never a silent fallback. Two of its three failure modes produce the right width and the wrong glyphs, so a pipeline that fell back when harfbuzzjs failed to load would pass every width assertion in the suite and show the wrong letters. Under `shaper: 'fontkit'` the three pre-checks run per run — the text is already NFC; no `frac`, `numr` or `dnom` is on; the face is static or pinned to its default instance — and a failing run refuses by name.
 *
 * @packageDocumentation
 */

import { capability } from '../capabilities.ts';
import { CasterError } from '../errors.ts';

import type { Coords } from './axisMap.ts';
import type { GlyphPosition } from './hbShaper.ts';

export type FontkitRun = {
  widthPx: number;
  gids: number[];
  /** Full position per output glyph, in font units. */
  positions: GlyphPosition[];
  /** Every feature fontkit's shaping plan enabled for the run. */
  featuresApplied: string[];
  /** OpenType script tag(s) fontkit ended up using. */
  script: string|string[];
};

const create = ( bytes: Uint8Array) => capability('fontkit').create(bytes);

/** The version `packages/caster/package.json` pins and `scripts/bundle-vendor.js` bundled. A browser module cannot read a package.json, so this is a constant a bump has to move. */
export const FONTKIT_VERSION = '2.0.4';

/** The base fonts, by key. A fontkit font stays `any`: fontkit's shipped declarations describe its node build, not the browser bundle (`types/vendor.d.ts`). */
const fonts: Map<string,any> = new Map<any, any>();
/** Non-default variable-font instances, keyed on URL plus settings. */
const instances: Map<string,any> = new Map<any, any>();
/** Parse a face once and keep it under `key`; a second load of the same key is a no-op. */
export function loadFont(key: string, bytes: Uint8Array) {
    if (!fonts.has(key))
        fonts.set(key, create(bytes));
}
/**
 * The base font loaded under `key`.
 *
 * @throws {CasterError} Nothing was loaded under `key`.
 */
export function fontOf(key: string): any {
    const font = fonts.get(key);
    if (!font)
        throw new CasterError(`caster: the fontkit tier was asked for a font it was never handed bytes for: ${key}`);
    return font;
}
/** The font instance to shape with. getVariation() returns a whole new font whose layout() applies HVAR advance deltas and the GDEF item-variation-store deltas to GPOS, so it is built once per instance and cached like the base font rather than rebuilt per word. */
function instanceOf(key: string, variations?: Coords): any {
    if (!variations)
        return fontOf(key);
    const settings = Object.entries(variations)
        .map(([tag, value]) => `${tag}=${value}`)
        .join(',');
    const cacheKey = `${key}|${settings}`;
    const hit = instances.get(cacheKey);
    if (hit)
        return hit;
    const instance = fontOf(key).getVariation(variations);
    instances.set(cacheKey, instance);
    return instance;
}
/**
 * Shape one word.
 *
 * @remarks
 * Signature in 2.0.4 is layout(string, features, script, language, direction); `script` is an OpenType tag, not an ISO 15924 code, and `language` is an OpenType language-system tag which fontkit pads to four characters itself. A fresh array is passed every call because layout() mutates the features argument in place, writing the whole resolved plan back into it.
 */
export function shapeWord(key: string, text: string, sizePx: number, featureTags: readonly string[], scriptTag?: string, language?: string, variations?: Coords): FontkitRun {
    const font = instanceOf(key, variations);
    const run = font.layout(text, [...featureTags], scriptTag, language);
    return {
        widthPx: (run.advanceWidth / font.unitsPerEm) * sizePx,
        gids: run.glyphs.map(( g: any) => g.id),
        positions: run.positions.map(( p: any) => ([p.xAdvance, p.yAdvance, p.xOffset, p.yOffset] as GlyphPosition)),
        featuresApplied: Object.keys(run.features),
        script: run.script,
    };
}
/** What fontkit detects on its own when `script` is left undefined. */
export function detectScript(key: string, text: string): string[] {
    const script = fontOf(key).layout(text, []).script;
    return Array.isArray(script) ? script : [script];
}
