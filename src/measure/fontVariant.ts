/**
 * `measure/fontVariant.js` — the `font-variant-*` longhands, read as the OpenType features CSS Fonts 4 §6 names for them.
 *
 * This module exists because the shaper is handed OpenType feature tags, and before it they came from `font-feature-settings` alone. A `font-variant: small-caps` therefore shaped the lowercase glyphs of the face, while Blink painted small capitals at the width of the lowercase letters Caster had measured: the page showed lowercase glyphs with uneven gaps and no refusal, which is the one outcome that *the capability registry never falls back* (S6) forbids.
 *
 * The mapping is a table and not a parser. Each keyword names the features the specification states for it, in the specification's order; a value with no entry is refused by name, never ignored. `normal` is the initial value of every longhand and is silent. `none` is silent only where the table gives it an entry (`font-variant-ligatures`).
 *
 * @packageDocumentation
 */

import { CasterError } from '../errors.ts';

import type { CasterErrorContext } from '../errors.ts';

/** The one reading the mapping needs from a computed style. A `CSSStyleDeclaration` satisfies it, and so does a plain object in a test. */
export type StyleReader = { getPropertyValue: (name: string) => string };

/**
 * The OpenType features each keyword of one longhand names.
 *
 * @remarks
 * `font-variant-caps: all-small-caps` names two features and so does `all-petite-caps`; the specification's order is kept so that a reader can check the table against CSS Fonts 4 §6 line by line. Functional `font-variant-alternates` values (`stylistic()`, `swash()`, `styleset()`, …) are absent on purpose: they name a feature through an `@font-feature-values` rule, which this printer does not read, so they are refused by name instead of guessed.
 */
const FEATURES: ReadonlyMap<string,ReadonlyMap<string,readonly string[]>> = new Map([
    [
        'font-variant-ligatures',
        new Map([
            ['none', ['-liga', '-clig', '-dlig', '-hlig', '-calt']],
            ['common-ligatures', ['liga', 'clig']],
            ['no-common-ligatures', ['-liga', '-clig']],
            ['discretionary-ligatures', ['dlig']],
            ['no-discretionary-ligatures', ['-dlig']],
            ['historical-ligatures', ['hlig']],
            ['no-historical-ligatures', ['-hlig']],
            ['contextual', ['calt']],
            ['no-contextual', ['-calt']],
        ]),
    ],
    [
        'font-variant-caps',
        new Map([
            ['small-caps', ['smcp']],
            ['all-small-caps', ['smcp', 'c2sc']],
            ['petite-caps', ['pcap']],
            ['all-petite-caps', ['pcap', 'c2pc']],
            ['unicase', ['unic']],
            ['titling-caps', ['titl']],
        ]),
    ],
    [
        'font-variant-numeric',
        new Map([
            ['lining-nums', ['lnum']],
            ['oldstyle-nums', ['onum']],
            ['proportional-nums', ['pnum']],
            ['tabular-nums', ['tnum']],
            ['diagonal-fractions', ['frac']],
            ['stacked-fractions', ['afrc']],
            ['ordinal', ['ordn']],
            ['slashed-zero', ['zero']],
        ]),
    ],
    [
        'font-variant-position',
        new Map([
            ['sub', ['subs']],
            ['super', ['sups']],
        ]),
    ],
    [
        'font-variant-east-asian',
        new Map([
            ['jis78', ['jp78']],
            ['jis83', ['jp83']],
            ['jis90', ['jp90']],
            ['jis04', ['jp04']],
            ['simplified', ['smpl']],
            ['traditional', ['trad']],
            ['full-width', ['fwid']],
            ['proportional-width', ['pwid']],
            ['ruby', ['ruby']],
        ]),
    ],
    [
        'font-variant-alternates',
        new Map([['historical-forms', ['hist']]]),
    ],
    // font-variant-emoji has no feature at all: `normal` is its only silent value, and every other value is refused by name.
    ['font-variant-emoji', new Map<any, any>()],
]);

/**
 * The OpenType feature tags the `font-variant-*` longhands of one computed style ask for, in the order CSS Fonts 4 §6 gives them.
 *
 * @remarks
 * The longhands are read one at a time through `getPropertyValue`, because the shorthand is not a computed value in every engine and because a longhand's keywords are what a reader of the stylesheet wrote. A value that is a list of keywords (`common-ligatures no-discretionary-ligatures`) contributes the features of each keyword. The caller combines the result with `font-feature-settings` and letter-spacing: this function knows nothing about the cascade between them.
 *
 * @param context - The element the style belongs to, handed to a refusal so the panel can open its source line.
 * @throws {CasterError} A keyword with no feature mapping: a functional `font-variant-alternates` value, or any non-`normal` `font-variant-emoji`.
 */
export function fontVariantTags(style: StyleReader, context: CasterErrorContext = {}): string[] {
    const tags: string[] = [];
    for (const [property, keywords] of FEATURES) {
        const value = style.getPropertyValue(property).trim();
        if (value === '' || value === 'normal')
            continue;
        for (const keyword of value.split(/\s+/u)) {
            const mapped = keywords.get(keyword);
            if (mapped) {
                tags.push(...mapped);
                continue;
            }
            const why = keyword.includes('(')
                ? `${keyword} is a functional value, which names its feature through an @font-feature-values rule this printer does not read`
                : `${keyword} has no OpenType feature this printer maps`;
            throw new CasterError(`caster: ${property}: ${JSON.stringify(value)} is refused: ${why}. A value this printer cannot shape is refused, never ignored, because the glyphs it would substitute are the wrong ones on the page.`, context);
        }
    }
    // font-kerning: none is `kern` off, as `font-feature-settings: "kern" 0` is; `auto` and `normal` are silent. An author's `"kern" 1` still wins, because it comes later (measured in Blink).
    if (style.getPropertyValue('font-kerning').trim() === 'none')
        tags.push('-kern');
    // text-rendering: optimizeSpeed turns the common ligatures and the contextual alternates off and leaves kerning on, whatever font-kerning says. The author's word beats it, in the longhand or in font-feature-settings alike: `common-ligatures` and `"liga" 1` bring liga and clig back, `contextual` and `"calt" 1` bring calt back (all measured in Blink, on a page of its own for each, because Blink's word cache carries shapes from one style to the next). discretionary and historical ligatures are off by default, and optimizeLegibility, geometricPrecision and auto add nothing.
    if (style.getPropertyValue('text-rendering').trim().toLowerCase() === 'optimizespeed') {
        const asked = style.getPropertyValue('font-variant-ligatures').split(/\s+/u);
        if (!asked.includes('common-ligatures'))
            tags.push('-liga', '-clig');
        if (!asked.includes('contextual'))
            tags.push('-calt');
    }
    return tags;
}
