/**
 * `options.js` — the flag table, the defaults, and the validation.
 *
 * Caster's own; no harness source — the harness read its flags off each fixture, and the table is the guide's. Guide: `docs/guide/README.md` §"The feature flags".
 *
 * Every row of the guide's flag table exists here with the guide's default and, as the JSDoc comment, the measured basis the guide gives for it. Nothing is invented: where the guide says "new — the harness runs both and compares", the flag is new to the library and the behaviour is the experiments'. The one addition is `colour` (PLAN.md D8), which is Caster's and is stated as such.
 *
 * The rule the guide closes that section with, and the reason this file is worth its own module: *every optional capability arrives behind a flag whose absence reproduces the previous behaviour exactly*. That is what made it possible to add colour, vectors, containers, tables and six loose ends to a working exporter with every earlier content stream staying byte-identical.
 *
 * A value outside a flag's set is a `CasterError` naming the flag and what it accepts — never a silent coercion to the default, which would print a document nobody asked for.
 *
 * @packageDocumentation
 */

import { defineFlags } from '@beltype/common/flags';
import { FlagError } from '@beltype/common/errors';
import { CasterError } from './errors.ts';

export type CasterOptions = {
  /** Default `'harfbuzz'`. Basis: fontkit gets 97% and 82% of two blocks' glyph sequences wrong at zero width error, so a fallback would pass every width assertion and show the wrong letters. Under `'fontkit'` the three pre-checks run per run and a failing run refuses by name. */
  shaper: 'harfbuzz'|'fontkit';
  /** Default `'hb'`. Basis: pdf-lib cannot show a glyph the shaper chose, cannot instance, cannot read WOFF2, has no `/ActualText` mechanism and writes no subset tag. `'pdf-lib'` is a documented refusal in this port (P3). */
  subset: 'hb'|'pdf-lib';
  /** Default `'bare'`. Basis: both validate identically; the OpenType wrapper is 141 kB of dead weight on a CJK subset. */
  cffContainer: 'bare'|'opentype';
  /** Default `3`. Basis: three decimals is the spec's rule; integers cost up to half a thousandth of an em per glyph. */
  widthDecimals: 0|3;
  /** Default `'fast-png'`. Basis: 64 094 of 65 280 low-alpha pixels wrong through a canvas, worst channel out by 127; 83 217 unrepresentable 16-bit samples. */
  pngDecoder: 'fast-png'|'canvas';
  /** Default `true`. Basis: 3 826 435 B of PNG becomes 130 207 B of JPEG at 43.90 dB — 3.4%. */
  photoRule: boolean;
  /** Default `true`, flipped on as `styledBorders` was: no image in the corpus prints above 450 ppi (its highest is 323.9), so no recorded byte moves (Egildo's ruling 2 of 2026-11-03). An image placed above `imageResolution × downsampleThreshold` is reduced to `imageResolution` before the list. Basis: a 36 MP photograph in a 6-inch box is a 953 365-byte JPEG today and 105 199 bytes reduced to 300 ppi first, at the same quality, with no visible change at print size. */
  downsampleImages: boolean;
  /** Default `300`, in pixels per inch, positive. Basis: print-ready practice (Ghostscript's `/printer` preset and Adobe's press presets) and the corpus's own highest placement, 323.9 ppi. */
  imageResolution: number;
  /** Default `1.5`, from 1 to 10, outside refused naming the flag (Distiller reverts it silently). Basis: Distiller's and Ghostscript's own default, so an image is reduced only above 450 ppi at the default resolution; reducing a 330 ppi image to 300 buys little and costs a resample. */
  downsampleThreshold: number;
  /** Default `'bicubic'`: Catmull-Rom, computed by Caster's own arithmetic (`images/resample.js`), whose bytes are the same in every engine. Basis: against a Lanczos-3 yardstick a JavaScript Catmull-Rom scored 54.35 dB and the canvas's smoothing 51.50 dB on the 36 MP photograph, and the canvas's bytes depend on whether it is accelerated. `'average'` is the area average and `'subsample'` the nearest pixel. */
  downsampleType: 'bicubic'|'average'|'subsample';
  /** Default `300`. Basis: the emoji rasters land at 300 dpi to within 6; six of 108 vector paints use it. */
  rasterDpi: number;
  /** Default `'css'` since 2026-09-08. It was `'dom'` because `'css'` moves every block background before every word — a background at paint index 45 of 350 with its own text at 298 — so switching re-records every stream, and not re-recording the experiments' streams was worth more than an ordering nothing they measured exercised. It is not worth more here: a `<th>` with a shaded row and a `<code>` with a rounded box are ordinary, and under `'dom'` each background is emitted after the words it sits behind and paints them out — measured on a three-page report whose whole header row and every inline code span came out blank. `'dom'` stays, as the flag that reproduces a recorded stream. */
  paintOrder: 'dom'|'css';
  /** Default `true`. Basis: a dotted or dashed border prints as the author wrote it; `false` is the opt-out, which paints every border solid. Flipped from `false` on 2026-11-02 at Egildo's ruling: none of the corpus's eight documents has a styled border, so no recorded byte moves. */
  styledBorders: boolean;
  /** Default `'none'`. Basis: on for print — without it, `0 0 0 rg` lands ink on all four process plates. */
  blackText: 'none'|'100k';
  /** Default `'none'`. Basis: a compliant RIP handed `/DefaultRGB` and an output intent lands within one 255th of the conversion anyway. `'wasm'` converts the fill of every run the author declared no ink for, and the black-text policy has not claimed, through the vendored lcms-wasm (Caster's two profiles, relative colorimetric with black-point compensation) before the list is built; the list then carries each as the CMYK ink it already says, so no writer reads the flag. Backgrounds, borders and vectors are not converted. `'endpoint'` refuses here: BelType serves no colour endpoint (§10.2). */
  convertRgb: 'none'|'endpoint'|'wasm';
  /** Default `true`. Basis: 34.2% of a body-size underline is removed; a continuous line strikes through every descender. */
  skipInk: boolean;
  /** Caster's own (D8). Default `'auto'`: on when any `--pdf-*` colour hint is declared or `blackText`/`convertRgb` is set. Decides whether the objects of `colour.md` (E8) — `/DefaultRGB`, `/OutputIntents`, the two ICC profiles — are written at all. PDF/UA-2 does not require them (the E5 run of `structure-tree.md` was clean without), and fetching 192 kB of profiles for a document with no colour story is exactly the download the capability registry exists to avoid. */
  colour: 'auto'|'on'|'off';
  /** Caster's own (*the printer guesses, says so, and withdraws the claim*, S90). Default `'infer'` (the decision chose `'refuse'`; flipped the same day at Egildo's call, so a document the other engines print prints here too): a custom element the walk's table does not name is walked as CSS laid it out, the way a `<span>` or a `<div>` is, every guess is listed in `report.inferred` and the warnings, and the file no longer claims PDF/UA-2 in its XMP, since a tag the printer guessed is not a claim it can stand behind. Measured on the bench's determina specimen: four `<dm-variable>` elements, each with no meaning a tag could name, refused the whole document. Under `'refuse'` it refuses the print by name, as every element the walk cannot name always has. A `bt-` or `beltype-` element is refused under both. */
  unknownElements: 'refuse'|'infer';
  /** Default `'none'`, so an image keeps its own colour and late binding stays the default (Egildo's ruling 4 of 2026-11-03). `'cmyk'` converts every RGB or grey image to `DeviceCMYK` in the image pass, after the reduction, through the vendored lcms-wasm from the image's own profile (else sRGB) to the output intent's CMYK, relative colorimetric with black-point compensation, and the list carries the CMYK samples (version 7). A CMYK JPEG is left alone, and a converted image travels as Flate samples, since the browser writes no CMYK JPEG. Needs the colour objects: it is refused with `colour: 'off'`, and turns `colour: 'auto'` on. Basis: 8.3 MP converts in about 220 ms with the default optimisation, so it runs after the reduction and not before. */
  convertImages: 'none'|'cmyk';
  /** Caster's own (*PDF/UA-2 is a flag, not a given*, S103; Egildo's ruling of 2026-11-03, after Typst's `--pdf-standard`, WeasyPrint's `--pdf-variant` and Prince's `--pdf-profile`). Default `'ua-2'`: the file claims PDF/UA-2 in its XMP, and forme adds both Well-Tagged PDF declarations beside it, and a word gap in a face with no space glyph is refused by name, since it would be glyph 0, `.notdef`, which PDF/UA-2 forbids a file to show (ISO 14289-2, 8.4.5.9). Basis: the Rust writer's cff2 fixture, HarfBuzz's test subset of Source Serif 4 Variable, has no space glyph, and forme's file showed `.notdef` in every gap under a claim veraPDF's `ua2`, `wt1a` and `wt1r` all failed. Under `'none'` the file is tagged as ever and claims nothing, and such a gap is written as positioning with no glyph. A guess under `unknownElements: 'infer'` still withdraws a `'ua-2'` claim (S90), the one road on which the claim asked for is softened. */
  standard: 'ua-2'|'none';
  /** Default `'pdf-lib'`. Which writer turns the display list into the file: `'pdf-lib'`, the TypeScript writer (`emit/structureEmit.ts`, through pdf-lib and HarfBuzz's subsetter), or `'forme'`, the Rust writer vendored as a WebAssembly module (`vendor/forme_bg.wasm`, loaded only under this value), which in a page writes in a dedicated worker (`emit/forme.ts`). Both read the same list and return the same `WriterResult`; forme is held to the oracle's files by every reader of *the same list prints the same bytes* (S102). The default stays the oracle's until Egildo has read the Rust writer's stage 9 gate. */
  writer: 'pdf-lib'|'forme';
  /** The document title for `/Title` and the XMP; the panel fills it from the document. */
  title?: string;
  /** The catalog `/Lang`, when the DOM declares none. */
  lang?: string;
};

/** The names {@link FLAGS} holds: every option but the two free strings the panel fills from the document. */
export type FlagName = Exclude<keyof CasterOptions, 'title' | 'lang'>;

/** One row of the flag table, typed from the option it validates. */
export type FlagSpec<K extends FlagName> = {
  /** Every value the flag accepts; `null` where it takes a positive number instead. */
  values: readonly CasterOptions[K][] | null;
  default: CasterOptions[K];
};

/**
 * The flag table: name → `{ values, default }`.
 *
 * @remarks
 * The `@satisfies` is the compile-time assertion that this table and {@link CasterOptions} name the same flags: a row with no option, an option with no row, or a default or value the option does not accept each fail the check. `values` is `null` where the flag is a number.
 */
export const FLAGS = (({
  shaper: { values: ['harfbuzz', 'fontkit'], default: 'harfbuzz' },
  subset: { values: ['hb', 'pdf-lib'], default: 'hb' },
  cffContainer: { values: ['bare', 'opentype'], default: 'bare' },
  widthDecimals: { values: [0, 3], default: 3 },
  pngDecoder: { values: ['fast-png', 'canvas'], default: 'fast-png' },
  photoRule: { values: [true, false], default: true },
  downsampleImages: { values: [true, false], default: true },
  imageResolution: { values: null, default: 300 },
  downsampleThreshold: { values: null, default: 1.5 },
  downsampleType: { values: ['bicubic', 'average', 'subsample'], default: 'bicubic' },
  convertImages: { values: ['none', 'cmyk'], default: 'none' },
  rasterDpi: { values: null, default: 300 },
  paintOrder: { values: ['css', 'dom'], default: 'css' },
  styledBorders: { values: [true, false], default: true },
  blackText: { values: ['none', '100k'], default: 'none' },
  convertRgb: { values: ['none', 'endpoint', 'wasm'], default: 'none' },
  skipInk: { values: [true, false], default: true },
  colour: { values: ['auto', 'on', 'off'], default: 'auto' },
  unknownElements: { values: ['refuse', 'infer'], default: 'infer' },
  standard: { values: ['ua-2', 'none'], default: 'ua-2' },
  writer: { values: ['pdf-lib', 'forme'], default: 'pdf-lib' }
} as const) satisfies { [K in FlagName]: FlagSpec<K> });

/**
 * The flag table in `@beltype/common`'s shape — `casterFlags.table` is {@link FLAGS}, and the command line reads it from here.
 */
export const casterFlags = defineFlags('caster', FLAGS);

/**
 * Every flag at its default — the options a run gets when it asks for nothing.
 *
 * @remarks
 * `defineFlags` answers its defaults keyed by the table; the value is asserted back to {@link CasterOptions} through `unknown`, which is sound because `FLAGS`'s `@satisfies` proves every flag has a row whose default its option accepts.
 */
export const DEFAULTS = (casterFlags.defaults as unknown) as CasterOptions;

/**
 * Fill in the defaults and refuse anything the table does not name.
 *
 * @param given - An `undefined` member is absent, so a panel may pass every field it has.
 * @throws {CasterError} An unknown option, a non-positive or non-finite `rasterDpi` or `imageResolution`, a `downsampleThreshold` outside 1 to 10, or a value outside a flag's set — carrying `flag`.
 */
export function resolveOptions(given: Partial<CasterOptions> = {}): CasterOptions {
  const { title, lang, ...flags } = given;
  let out: Record<string,unknown>;
  try { out = { ...casterFlags.resolve(flags as never) }; }
  catch (e) {
    // The table refuses with a FlagError; Caster's one family is CasterError, so the refusal crosses as that, message and flag unchanged.
    if (e instanceof FlagError) throw new CasterError(e.message, { flag: e.flag });
    throw e;
  }
  // The table says a positive number; the range is this flag's own, and Distiller's: from 1 to 10, refused here where Adobe reverts silently.
  const threshold = out['downsampleThreshold'] as number;
  if (threshold < 1 || threshold > 10) throw new CasterError(`caster: 'downsampleThreshold' takes a number from 1 to 10; got ${JSON.stringify(threshold)}.`, { flag: 'downsampleThreshold' });
  if (out['convertImages'] === 'cmyk' && out['colour'] === 'off') throw new CasterError("caster: `convertImages: 'cmyk'` writes DeviceCMYK samples under the output intent, which `colour: 'off'` does not write; set `colour` to 'auto' or 'on', or `convertImages` to 'none'.", { flag: 'convertImages' });
  if (title !== undefined) out['title'] = title;
  if (lang !== undefined) out['lang'] = lang;
  return (out as CasterOptions);
}

/**
 * Whether this run writes the colour objects — PLAN.md D8's `colour` flag, with `auto` resolved.
 *
 * @remarks
 * `auto` is on when the document declares a `--pdf-*` colour hint, or when a policy that produces device colour (`blackText`, `convertRgb`, `convertImages`) is on.
 *
 * @param needs - What the walk found; only `colourHints` is read.
 */
export function colourOn(needs: { colourHints?: boolean; }, options: CasterOptions) {
  if (options.colour === 'on') return true;
  if (options.colour === 'off') return false;
  return Boolean(needs?.colourHints) || options.blackText !== 'none' || options.convertRgb !== 'none' || options.convertImages !== 'none';
}

/**
 * Refuse a flag value whose tier this port does not build, by name, before any module fails on it later.
 *
 * @remarks
 * Each names the flag, and the modules behind the endpoint tier and the fontkit shaper stay: they are what a host that grows the tier would call, and their own suites keep them honest. `convertRgb: 'wasm'` is built (2026-11-04); `'endpoint'` is the one value of that flag still refused. `pngDecoder: 'canvas'` has no module at all: the registry only declined to load fast-png under it, so a PNG that needed its samples decoded refused by blaming the flag that had been set (found 2026-11-02 by printing every flag from the command line).
 *
 * @throws {CasterError} carrying `flag`.
 */
export function refuseUnbuiltTiers(options: CasterOptions): void {
  if (options.shaper === 'fontkit') {
    throw new CasterError("caster: `shaper: 'fontkit'` is not composed in this port. `measure/textMeasure.js` imports HarfBuzz's shaper directly, so under this flag the registry skips the harfbuzz load and the first word throws \"never handed bytes\" — and the tier itself is a documented wrong-glyph route (S6, `docs/guide/shaping.md` §\"The two tiers\"): fontkit gets 97% and 82% of two test blocks' glyph sequences wrong at zero width error, so a printer that fell back to it would pass every width assertion and show the wrong letters.", { flag: 'shaper' });
  }
  if (options.convertRgb === 'endpoint') {
    throw new CasterError("caster: `convertRgb: 'endpoint'` needs a gateway with a `convertColors` method, and BelType serves no colour endpoint. Use `convertRgb: 'wasm'` (lcms-wasm, measured at 0.000000 against the endpoint) or `'none'` (a compliant RIP lands within one 255th anyway).", { flag: 'convertRgb' });
  }
  if (options.subset === 'pdf-lib') {
    throw new CasterError("caster: `subset: 'pdf-lib'` is a documented refusal in this port (docs/guide/font-embedding.md §\"The two tiers\"). pdf-lib's own embedder re-lays-out the string with fontkit, so it cannot show a glyph the shaper chose, cannot instance a variable face, cannot read WOFF2, has no /ActualText mechanism and writes no subset tag. It pairs only with `shaper: 'fontkit'` and inherits all three of that tier's pre-checks.", { flag: 'subset' });
  }
  if (options.pngDecoder === 'canvas') {
    throw new CasterError("caster: `pngDecoder: 'canvas'` is not composed in this port. No canvas decoder is built: fast-png is the only one, and the flag's basis is why — through a canvas, 64 094 of 65 280 low-alpha pixels came out wrong, the worst channel by 127, and 16-bit samples cannot be represented at all.", { flag: 'pngDecoder' });
  }
}
