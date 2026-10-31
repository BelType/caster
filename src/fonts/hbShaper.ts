/**
 * `fonts/hbShaper.js` — harfbuzzjs: the shaping that reproduces every browser width and every glyph sequence.
 *
 * Ported from `harness/src/shaping/hb-shaper.ts` (E1, E1b, E3, E4). Guide: `docs/guide/shaping.md`.
 *
 * WHAT THE PORT CHANGED (P2). `import * as hb from 'harfbuzzjs'` is gone: the library reaches this module through `capability('harfbuzz')`, so the file evaluates in node with no bundle present and its pure half stays testable, and a run that needs the shaper without it loaded refuses by name rather than falling back — `docs/guide/shaping.md` §"The two tiers" is why that matters, and the refusal lives in `src/capabilities.js`.
 *
 * @packageDocumentation
 */

import { capability } from '../capabilities.ts';
import { CasterError } from '../errors.ts';

import type { Coords } from './axisMap.ts';

/** Per-glyph `[xAdvance, yAdvance, xOffset, yOffset]` in font units. */
export type GlyphPosition = [number, number, number, number];

export type HbRun = {
  widthPx: number;
  gids: number[];
  /** Cluster value per output glyph, in output order. */
  clusters: number[];
  /** Advance per output glyph, in font units. */
  advances: number[];
  /** Full position per output glyph, in font units. */
  positions: GlyphPosition[];
  /** Derived from cluster ordering, see `guessedDirection()`. */
  direction: 'ltr'|'rtl';
};

/** The harfbuzzjs namespace, as the vendored bundle exports it. */
const hb = () => capability('harfbuzz');

/** One harfbuzzjs Face per font file, by key. The handles stay `any`: harfbuzzjs ships no declarations, and a hand-written surface would be a second version to keep in step (`types/vendor.d.ts`). */
const faces: Map<string,{ face: any; upem: number; }> = new Map<any, any>();
/** Keyed on font URL plus the variation settings, see fontKey(). */
const fonts: Map<string,{ font: any; upem: number; }> = new Map<any, any>();
/** A font-cache key. A variable font shaped at two instances needs two hb.Font objects, because setVariations() mutates the font it is called on. */
function fontKey(key: string, variations: Coords|undefined) {
    if (!variations)
        return key;
    const settings = Object.entries(variations)
        .map(([tag, value]) => `${tag}=${value}`)
        .join(',');
    return `${key}|${settings}`;
}
/** Blob/Face are built once per font file and reused for every instance. */
export function loadFont(key: string, bytes: Uint8Array) {
    if (faces.has(key))
        return;
    const face = new (hb().Face)(new (hb().Blob)(bytes));
    faces.set(key, { face, upem: face.upem });
}
/**
 * The hb.Font for one instance of one file, created on first use.
 *
 * @throws {CasterError} Nothing was loaded under `key`.
 */
function fontFor(key: string, variations?: Coords) {
    const cacheKey = fontKey(key, variations);
    const hit = fonts.get(cacheKey);
    if (hit)
        return hit;
    const cachedFace = faces.get(key);
    if (!cachedFace)
        throw new CasterError(`caster: the shaper was asked for a font it was never handed bytes for: ${key}`);
    const font = new (hb().Font)(cachedFace.face);
    // Scale in font units so an advance divided by upem is a fraction of an em.
    font.setScale(cachedFace.upem, cachedFace.upem);
    if (variations) {
        font.setVariations(Object.entries(variations).map(([tag, value]) => new (hb().Variation)(tag, value)));
    }
    const cached = { font, upem: cachedFace.upem };
    fonts.set(cacheKey, cached);
    return cached;
}
/**
 * Units per em of the face loaded under `key`.
 *
 * @throws {CasterError} Nothing was loaded under `key`.
 */
export function upemOf(key: string): number {
    const cached = faces.get(key);
    if (!cached)
        throw new CasterError(`caster: the shaper was asked for a font it was never handed bytes for: ${key}`);
    return cached.upem;
}
/**
 * The advance of one glyph in font units, from the cached font the words were shaped with.
 *
 * @throws {CasterError} Nothing was loaded under `key`.
 */
export function glyphAdvance(key: string, gid: number, variations?: Coords): number {
    return fontFor(key, variations).font.glyphHAdvance(gid);
}
/** The harfbuzzjs version string, as the loaded bundle reports it. */
export function versionString() {
    return hb().versionString();
}
/** harfbuzzjs 1.6.1 exposes no getter for the properties hb_buffer_guess_segment_properties() picked, so the direction is read back off the output instead: HarfBuzz emits RTL runs in visual order, which makes the cluster sequence non-increasing. */
function guessedDirection(clusters: number[]): 'ltr'|'rtl' {
    for (let i = 1; i < clusters.length; i++) {
        if (clusters[i] < clusters[i - 1])
            return 'rtl';
        if (clusters[i] > clusters[i - 1])
            return 'ltr';
    }
    return 'ltr';
}
/**
 * Shape one word. `featureTags` empty means "HarfBuzz script defaults only".
 *
 * @remarks
 * `language` is a BCP 47 tag and is applied *after* guessSegmentProperties(), which would otherwise overwrite it with the language guessed from the text. Nothing in the composition supplies one this round — `textMeasure` reads no `lang` into a shaping call — so `locl` never fires; the parameter is the port's and is what a host that grows a language story would fill.
 *
 * @throws {CasterError} A feature string HarfBuzz rejects; and a key nothing was loaded under.
 */
export function shapeWord(key: string, text: string, sizePx: number, featureTags: readonly string[], language?: string, variations?: Coords): HbRun {
    const cached = fontFor(key, variations);
    const buffer = new (hb().Buffer)();
    buffer.addText(text);
    buffer.guessSegmentProperties();
    if (language)
        buffer.setLanguage(language);
    // harfbuzzjs' Feature constructor takes a raw OpenType tag and a value; it is Feature.fromString that is hb_feature_from_string, so it is the only way to say "-liga" and have it mean "liga=0" rather than a five-character tag.
    const features = featureTags.map(( tag: string) => {
        const feature = hb().Feature.fromString(tag);
        if (!feature)
            throw new CasterError(`caster: harfbuzz rejected the feature string ${tag}`);
        return feature;
    });
    hb().shape(cached.font, buffer, features);
    const infos = buffer.getGlyphInfos();
    const glyphPositions = buffer.getGlyphPositions();
    const gids = infos.map(( i: any) => i.codepoint);
    const clusters = infos.map(( i: any) => i.cluster);
    const advances = glyphPositions.map(( p: any) => p.xAdvance);
    const positions = glyphPositions.map(( p: any) => ([p.xAdvance, p.yAdvance, p.xOffset, p.yOffset] as GlyphPosition));
    const units = advances.reduce(( a: number,  b: number) => a + b, 0);
    return {
        widthPx: (units / cached.upem) * sizePx,
        gids,
        clusters,
        advances,
        positions,
        direction: guessedDirection(clusters),
    };
}
/** hb's own name for an OpenType script tag, e.g. "latn" -> "Latn". */
export function scriptForTag(tag: string): string {
    return hb().otTagToScript(tag);
}
/** Whether the JS API exposes hb_subset. It does not in 1.6.1 — the package ships dist/harfbuzz-subset.wasm but binds nothing to it — and E4 (`font-embedding.md`) needs to know, so the answer is computed rather than asserted from memory. */
export function exposesSubset() {
    return Object.keys(hb()).some(( k: string) => /subset/i.test(k));
}
