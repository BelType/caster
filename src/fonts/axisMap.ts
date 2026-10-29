/**
 * `fonts/axisMap.js` — CSS to variation axes: what coordinate the browser is painting a run at.
 *
 * Ported from `harness/src/export/axisMap.ts` (E4). Guide: `docs/guide/font-embedding.md` §"Instancing".
 *
 * The harness's own header follows.
 *
 * CSS to variation axes: what coordinate the browser is painting a run at.
 *
 * A PDF carries no variable fonts — `fvar`, `gvar`, `CFF2` and `HVAR` are ignored by every viewer — so every variable face has to be frozen into a static instance at exactly the coordinate Chromium used, and the coordinate has to be derived from the computed style rather than from the CSS the author wrote, because the cascade, the clamping and the defaults have all already happened by then.
 *
 * The mapping is CSS Fonts 4 §6: `font-weight` is `wght`, `font-stretch` is `wdth` as a percentage, `font-style: oblique <angle>` is `slnt` negated (CSS measures the slope clockwise, the axis measures it counter-clockwise), `font-style: italic` sets `ital` to 1 where the axis exists, and `font-optical-sizing: auto` sets `opsz` to the used font size in CSS pixels. `font-variation-settings` then overrides any of them, which is what makes it the escape hatch it is meant to be. Every axis the font declares and the style does not mention stays at its default.
 *
 * Every value is clamped into the axis range before it is used. That is not a convenience: `hb_font_set_variations` clamps, `hb_subset_input_pin_axis_location` does not, so an unclamped coordinate would produce an instance the shaper never measured. Chromium clamps too, and E2 (`font-fallback.md`) already proved the `wght` half of that against browser widths.
 *
 * @packageDocumentation
 */

/** One axis of an `fvar` table. */
export type AxisRange = {
  min: number;
  default: number;
  max: number;
};

/** Instance coordinates by axis tag. Empty for a static face, which is what keeps a static document free of every instancing branch. */
export type Coords = Record<string, number>;

/** Clamp into the axis range, as `hb_font_set_variations` and Chromium both do (see the module header). */
const clamp = ( value: number,  axis: AxisRange): number => Math.min(axis.max, Math.max(axis.min, value));
/** `"wght" 800, "opsz" 20` as the computed style spells it. */
export function parseVariationSettings(value: string): Coords {
    const out: Coords = {};
    if (!value || value === 'normal')
        return out;
    for (const match of value.matchAll(/["']([A-Za-z0-9 ]{4})["']\s*([-\d.eE+]+)/g)) {
        out[match[1]] = Number(match[2]);
    }
    return out;
}
/** `oblique 14deg` to 14; `oblique` alone to the CSS default of 14; anything else to null. */
export function obliqueAngle(fontStyle: string): number|null {
    if (!fontStyle.startsWith('oblique'))
        return null;
    const match = /(-?[\d.]+)deg/.exec(fontStyle);
    return match ? Number(match[1]) : 14;
}
/**
 * The instance coordinates for one run.
 *
 * @remarks
 * `axes` is the face's own `fvar`, so a static face produces `{}` and nothing downstream has to special-case it: an empty coordinate set is the same face, the same subset and the same instance key it always was.
 */
export function instanceCoords(style: CSSStyleDeclaration, axes: Record<string,AxisRange>): Coords {
    const tags = Object.keys(axes);
    if (tags.length === 0)
        return {};
    const coords: Coords = {};
    for (const tag of tags)
        coords[tag] = axes[tag].default;
    if (axes.wght)
        coords.wght = clamp(parseFloat(style.fontWeight), axes.wght);
    if (axes.wdth) {
        const stretch = style.fontStretch;
        coords.wdth = clamp(stretch.endsWith('%') ? parseFloat(stretch) : 100, axes.wdth);
    }
    const oblique = obliqueAngle(style.fontStyle);
    if (axes.slnt && oblique !== null)
        coords.slnt = clamp(-oblique, axes.slnt);
    if (axes.ital && style.fontStyle === 'italic')
        coords.ital = clamp(1, axes.ital);
    if (axes.opsz) {
        // `auto` is the CSS default, and Chromium's reading of it is the used font size in CSS pixels. The fixture of `font-embedding.md` (E4) proved the value against browser widths rather than taking the specification's word for it.
        const optical = style.getPropertyValue('font-optical-sizing').trim() || 'auto';
        coords.opsz = optical === 'none' ? axes.opsz.default : clamp(parseFloat(style.fontSize), axes.opsz);
    }
    for (const [tag, value] of Object.entries(parseVariationSettings(style.getPropertyValue('font-variation-settings')))) {
        if (axes[tag])
            coords[tag] = clamp(value, axes[tag]);
    }
    return coords;
}
/** `wght=650,opsz=14`: the coordinate part of an instance key, in tag order. */
export function coordsKey(coords: Coords): string {
    const tags = Object.keys(coords).sort();
    return tags.map((tag) => `${tag}=${round(coords[tag])}`).join(',');
}
/** One instance of one face: the key every font resource and every subset is named by. */
export function instanceKeyOf(faceId: string, coords: Coords): string {
    const key = coordsKey(coords);
    return key === '' ? faceId : `${faceId}|${key}`;
}
/** Axis values are written into a key and into a font name, so they are pinned to three decimals. */
const round = ( n: number): number => Math.round(n * 1000) / 1000;
/** Coordinates as the shaper wants them: `hb_font_set_variations` takes the same record. */
export const shaperVariations = ( coords: Coords): Record<string,number>|undefined => Object.keys(coords).length === 0 ? undefined : coords;
