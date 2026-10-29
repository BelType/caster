/**
 * The `font-variant-*` longhands, read as the OpenType features CSS Fonts 4 §6 names for them, and combined with `font-feature-settings` and letter-spacing by `featureTagsFor`.
 *
 * Pure: the style is a plain object with `getPropertyValue`, which is all `fontVariantTags` and `featureTagsFor` read. The rendered result — small capitals on a page — is the acceptance's to show; this suite pins the tags the shaper is handed, and that a value with no mapping is refused rather than shaped as lowercase.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fontVariantTags } from '../src/measure/fontVariant.ts';
import { featureTagsFor, LETTER_SPACED_FEATURES } from '../src/measure/textMeasure.ts';
import { CasterError } from '../src/errors.ts';

/** A computed style with only the properties the test names; every other longhand reads as the empty string, which the mapping treats as silent. */
function styleOf(values: Record<string,string>): CSSStyleDeclaration {
    return ({ getPropertyValue: ( name: string) => values[name] ?? '' } as any);
}

test('font-variant-ligatures: each keyword names its features, and none turns the four off', () => {
    assert.deepEqual(fontVariantTags(styleOf({ 'font-variant-ligatures': 'none' })), ['-liga', '-clig', '-dlig', '-hlig', '-calt']);
    assert.deepEqual(fontVariantTags(styleOf({ 'font-variant-ligatures': 'common-ligatures' })), ['liga', 'clig']);
    assert.deepEqual(fontVariantTags(styleOf({ 'font-variant-ligatures': 'no-common-ligatures' })), ['-liga', '-clig']);
    assert.deepEqual(fontVariantTags(styleOf({ 'font-variant-ligatures': 'discretionary-ligatures' })), ['dlig']);
    assert.deepEqual(fontVariantTags(styleOf({ 'font-variant-ligatures': 'no-discretionary-ligatures' })), ['-dlig']);
    assert.deepEqual(fontVariantTags(styleOf({ 'font-variant-ligatures': 'historical-ligatures' })), ['hlig']);
    assert.deepEqual(fontVariantTags(styleOf({ 'font-variant-ligatures': 'no-historical-ligatures' })), ['-hlig']);
    assert.deepEqual(fontVariantTags(styleOf({ 'font-variant-ligatures': 'contextual' })), ['calt']);
    assert.deepEqual(fontVariantTags(styleOf({ 'font-variant-ligatures': 'no-contextual' })), ['-calt']);
    assert.deepEqual(fontVariantTags(styleOf({ 'font-variant-ligatures': 'common-ligatures no-discretionary-ligatures' })), ['liga', 'clig', '-dlig']);
});

test('font-variant-caps: small-caps is smcp, all-small-caps adds c2sc, and the rest name their own features', () => {
    assert.deepEqual(fontVariantTags(styleOf({ 'font-variant-caps': 'small-caps' })), ['smcp']);
    assert.deepEqual(fontVariantTags(styleOf({ 'font-variant-caps': 'all-small-caps' })), ['smcp', 'c2sc']);
    assert.deepEqual(fontVariantTags(styleOf({ 'font-variant-caps': 'petite-caps' })), ['pcap']);
    assert.deepEqual(fontVariantTags(styleOf({ 'font-variant-caps': 'all-petite-caps' })), ['pcap', 'c2pc']);
    assert.deepEqual(fontVariantTags(styleOf({ 'font-variant-caps': 'unicase' })), ['unic']);
    assert.deepEqual(fontVariantTags(styleOf({ 'font-variant-caps': 'titling-caps' })), ['titl']);
});

test('font-variant-numeric: every keyword maps, and a list of them maps each', () => {
    const table = [
        ['lining-nums', 'lnum'],
        ['oldstyle-nums', 'onum'],
        ['proportional-nums', 'pnum'],
        ['tabular-nums', 'tnum'],
        ['diagonal-fractions', 'frac'],
        ['stacked-fractions', 'afrc'],
        ['ordinal', 'ordn'],
        ['slashed-zero', 'zero'],
    ];
    for (const [keyword, tag] of table)
        assert.deepEqual(fontVariantTags(styleOf({ 'font-variant-numeric': keyword })), [tag], keyword);
    assert.deepEqual(fontVariantTags(styleOf({ 'font-variant-numeric': 'lining-nums tabular-nums' })), ['lnum', 'tnum']);
});

test('font-variant-position: sub and super name subs and sups', () => {
    assert.deepEqual(fontVariantTags(styleOf({ 'font-variant-position': 'sub' })), ['subs']);
    assert.deepEqual(fontVariantTags(styleOf({ 'font-variant-position': 'super' })), ['sups']);
});

test('font-variant-east-asian: every keyword maps to its own feature', () => {
    const table = [
        ['jis78', 'jp78'],
        ['jis83', 'jp83'],
        ['jis90', 'jp90'],
        ['jis04', 'jp04'],
        ['simplified', 'smpl'],
        ['traditional', 'trad'],
        ['full-width', 'fwid'],
        ['proportional-width', 'pwid'],
        ['ruby', 'ruby'],
    ];
    for (const [keyword, tag] of table)
        assert.deepEqual(fontVariantTags(styleOf({ 'font-variant-east-asian': keyword })), [tag], keyword);
});

test('font-variant-alternates: historical-forms is hist, and a functional value is refused by name', () => {
    assert.deepEqual(fontVariantTags(styleOf({ 'font-variant-alternates': 'historical-forms' })), ['hist']);
    for (const value of ['stylistic(alt)', 'swash(flourish)', 'ornaments(x)', 'annotation(y)', 'styleset(z)', 'character-variant(w)']) {
        assert.throws(
            () => fontVariantTags(styleOf({ 'font-variant-alternates': value })),
            (error) => error instanceof CasterError && error.message.includes('font-variant-alternates') && error.message.includes(value.split('(')[0]),
            value,
        );
    }
});

test('font-variant-emoji: normal is silent, and every other value is refused by name', () => {
    assert.deepEqual(fontVariantTags(styleOf({ 'font-variant-emoji': 'normal' })), []);
    for (const value of ['emoji', 'text', 'unicode']) {
        assert.throws(
            () => fontVariantTags(styleOf({ 'font-variant-emoji': value })),
            (error) => error instanceof CasterError && error.message.includes('font-variant-emoji') && error.message.includes(value),
            value,
        );
    }
});

test('normal in every longhand, and an unset style, add no feature', () => {
    const normal = styleOf({
        'font-variant-ligatures': 'normal',
        'font-variant-caps': 'normal',
        'font-variant-numeric': 'normal',
        'font-variant-position': 'normal',
        'font-variant-east-asian': 'normal',
        'font-variant-alternates': 'normal',
        'font-variant-emoji': 'normal',
    });
    assert.deepEqual(fontVariantTags(normal), []);
    assert.deepEqual(fontVariantTags(styleOf({})), []);
});

test('a refusal carries the element it was raised for, as context', () => {
    assert.throws(
        () => featureTagsFor(styleOf({ 'font-variant-emoji': 'emoji' }), 0, { element: 'body>p[0]' }),
        (error) => error instanceof CasterError && error.element === 'body>p[0]',
    );
});

test('font-feature-settings follows font-variant and overrides it', () => {
    // font-variant-ligatures none turns liga off; font-feature-settings turns it back on. The later tag wins in HarfBuzz, so it must come last.
    const tags = featureTagsFor(styleOf({ 'font-variant-ligatures': 'none', 'font-feature-settings': '"liga" 1' }), 0);
    assert.deepEqual(tags, ['-liga', '-clig', '-dlig', '-hlig', '-calt', 'liga']);
    assert.ok(tags.indexOf('liga') > tags.indexOf('-liga'));
});

test('font-variant tags come before font-feature-settings, and letter-spacing tags stay last', () => {
    const tags = featureTagsFor(
        styleOf({ 'font-variant-caps': 'small-caps', 'font-feature-settings': '"ss01" on, "smcp" 0' }),
        0.54,
    );
    assert.deepEqual(tags, ['smcp', 'ss01', '-smcp', ...LETTER_SPACED_FEATURES]);
});

test('letter-spacing adds its off-tags after small-caps, as it does after any other tag', () => {
    const spaced = featureTagsFor(styleOf({ 'font-variant-caps': 'small-caps' }), 0.54);
    assert.deepEqual(spaced, ['smcp', ...LETTER_SPACED_FEATURES]);
    assert.deepEqual(featureTagsFor(styleOf({ 'font-variant-caps': 'small-caps' }), 0), ['smcp']);
});
