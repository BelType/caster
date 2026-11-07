/**
 * The quote marks Chromium renders for `quotes: auto`, by language: open and close at the first depth, then at the second, which every deeper one repeats.
 *
 * @remarks
 * Written by `scripts/quote-marks.ts` from what the pinned build paints in a nested `<q>` inside a `<p lang>`; do not edit by hand. A tag that is not here answers what its tag without the last subtag answers, down to the primary language, and a language that is not here answers {@link BASIC_QUOTES}, as Blink does where ICU has nothing for a locale. Every primary language of two and three letters was asked.
 *
 * @packageDocumentation
 */

/** What Blink paints where the locale has no quote marks of its own: `“ ” ‘ ’`. */
export const BASIC_QUOTES: readonly [string, string, string, string] = ['“', '”', '‘', '’'];

/** Lower-case BCP 47 tags, each with the marks that differ from its shorter tag's. */
export const QUOTE_MARKS: Readonly<Record<string, readonly [string, string, string, string]>> = {
  'am': ['«', '»', '‹', '›'],
  'ar': ['”', '“', '’', '‘'],
  'az-cyrl': ['«', '»', '‹', '›'],
  'bg': ['„', '“', '„', '“'],
  'bs-cyrl': ['„', '“', '‚', '‘'],
  'ca': ['«', '»', '“', '”'],
  'cs': ['„', '“', '‚', '‘'],
  'de': ['„', '“', '‚', '‘'],
  'el': ['«', '»', '“', '”'],
  'es-us': ['«', '»', '“', '”'],
  'et': ['„', '“', '‚', '‘'],
  'fa': ['«', '»', '‹', '›'],
  'fi': ['”', '”', '’', '’'],
  'fr': ['«', '»', '«', '»'],
  'fr-ca': ['«', '»', '”', '“'],
  'fr-ch': ['«', '»', '‹', '›'],
  'he': ['”', '”', '’', '’'],
  'hr': ['„', '“', '‚', '‘'],
  'hu': ['„', '”', '»', '«'],
  'it': ['«', '»', '“', '”'],
  'ja': ['「', '」', '『', '』'],
  'kk-arab': ['»', '«', '›', '‹'],
  'lt': ['„', '“', '„', '“'],
  'nb': ['«', '»', '‘', '’'],
  'nl': ['‘', '’', '‘', '’'],
  'nn': ['«', '»', '‘', '’'],
  'no': ['«', '»', '‘', '’'],
  'pl': ['„', '”', '«', '»'],
  'pt-ao': ['«', '»', '“', '”'],
  'pt-ch': ['«', '»', '“', '”'],
  'pt-cv': ['«', '»', '“', '”'],
  'pt-gq': ['«', '»', '“', '”'],
  'pt-gw': ['«', '»', '“', '”'],
  'pt-lu': ['«', '»', '“', '”'],
  'pt-mo': ['«', '»', '“', '”'],
  'pt-mz': ['«', '»', '“', '”'],
  'pt-pt': ['«', '»', '“', '”'],
  'pt-st': ['«', '»', '“', '”'],
  'pt-tl': ['«', '»', '“', '”'],
  'ro': ['„', '”', '«', '»'],
  'ru': ['«', '»', '„', '“'],
  'sk': ['„', '“', '‚', '‘'],
  'sl': ['„', '“', '‚', '‘'],
  'sr': ['„', '”', '’', '’'],
  'sv': ['”', '”', '’', '’'],
  'ti-er': ['‘', '’', '‘', '’'],
  'uk': ['«', '»', '„', '“'],
  'ur': ['”', '“', '’', '‘'],
  'zh-hant': ['「', '」', '『', '』'],
};
