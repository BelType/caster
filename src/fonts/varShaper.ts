/**
 * `fonts/varShaper.js` — shaping at a named variable-font instance.
 *
 * Ported from `harness/src/export/varShaper.ts` (E2, E4). Guide: `docs/guide/font-fallback.md`, `docs/guide/shaping.md`.
 *
 * WHAT THE PORT CHANGED (P2, P4). harfbuzzjs is a capability handle. The module-scope byte registry stays where the harness has it, and `precheck.js`'s lock is what makes it safe.
 *
 * The harness's own header follows.
 *
 * Shaping at a named variable-font instance.
 *
 * E1's `src/shaping/hb-shaper.ts` shapes each font file at its default instance, which is the right answer for every static face and the wrong one for a variable face: Chromium sets the `wght` axis from the computed `font-weight`, so a request for 550 is painted at `wght=550` and a shaper left at the file's default 400 misses every advance. That shaper's signatures are frozen, so the instanced path lives here instead and delegates back to it whenever there is no axis to set — E1's shaper stays the one doing the work for everything it can already do.
 *
 * The fixture pins `font-optical-sizing: none`, so `opsz` is deliberately not set: harfbuzzjs resets every axis a call omits to its default, which is exactly what Chromium does with optical sizing off.
 *
 * @packageDocumentation
 */
import { capability } from '../capabilities.ts';
import { CasterError } from '../errors.ts';
import * as hbs from './hbShaper.ts';

const hb = () => capability('harfbuzz');

export type AxisSetting = {
  tag: string;
  value: number;
};

export type ShapedRun = {
  widthPx: number;
  gids: number[];
};

/** One harfbuzzjs Font per `(file, axis setting)`. The handle stays `any`: harfbuzzjs ships no declarations (`types/vendor.d.ts`). */
const instances: Map<string,{ font: any; upem: number; }> = new Map<any, any>();
const bytesByUrl: Map<string,Uint8Array> = new Map<any, any>();
/** Remember the bytes so an instance can be built lazily, per axis setting; other bytes under a held URL forget its instances, as `hbShaper.js`'s `loadFont` does. */
export function registerBytes(url: string, bytes: Uint8Array) {
    const held = bytesByUrl.get(url);
    if (held && hbs.sameBytes(held, bytes))
        return;
    if (held)
        for (const key of instances.keys())
            if (key === url || key.startsWith(`${url}|`))
                instances.delete(key);
    bytesByUrl.set(url, bytes);
}
/** Stable cache key for one file at one instance. */
export function instanceKey(url: string, axes: AxisSetting[]): string {
    return axes.length === 0 ? url : `${url}|${axes.map(( a: AxisSetting) => `${a.tag}=${a.value}`).join(',')}`;
}
/**
 * The Font for one instance of one registered file, built on first use.
 *
 * @throws {CasterError} No bytes were registered for `url`.
 */
function instanceFor(url: string, axes: AxisSetting[]): { font: any; upem: number; } {
    const key = instanceKey(url, axes);
    const cached = instances.get(key);
    if (cached)
        return cached;
    const bytes = bytesByUrl.get(url);
    if (!bytes)
        throw new CasterError(`caster: bytes not registered for ${url}`);
    const face = new (hb().Face)(new (hb().Blob)(bytes));
    const font = new (hb().Font)(face);
    font.setScale(face.upem, face.upem);
    font.setVariations(axes.map(( a: AxisSetting) => new (hb().Variation)(a.tag, a.value)));
    const instance = { font, upem: face.upem };
    instances.set(key, instance);
    return instance;
}
/**
 * Shape one run at one instance; no axes means `hbShaper.js` (E1) answers directly.
 *
 * @throws {CasterError} No bytes were registered for `url`, or none loaded into `hbShaper.js` (E1) under it.
 */
export function shapeAt(url: string, axes: AxisSetting[], text: string, sizePx: number): ShapedRun {
    if (axes.length === 0) {
        const run = hbs.shapeWord(url, text, sizePx, []);
        return { widthPx: run.widthPx, gids: run.gids };
    }
    const { font, upem } = instanceFor(url, axes);
    const buffer = new (hb().Buffer)();
    buffer.addText(text);
    buffer.guessSegmentProperties();
    hb().shape(font, buffer, []);
    const gids = buffer.getGlyphInfos().map(( i: any) => i.codepoint);
    const units = buffer.getGlyphPositions().reduce(( sum: number,  p: any) => sum + p.xAdvance, 0);
    return { widthPx: (units / upem) * sizePx, gids };
}
