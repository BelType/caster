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
  /** Default `300`. Basis: the emoji rasters land at 300 dpi to within 6; six of 108 vector paints use it. */
  rasterDpi: number;
  /** Default `'css'` since 2026-09-08. It was `'dom'` because `'css'` moves every block background before every word — a background at paint index 45 of 350 with its own text at 298 — so switching re-records every stream, and not re-recording the experiments' streams was worth more than an ordering nothing they measured exercised. It is not worth more here: a `<th>` with a shaded row and a `<code>` with a rounded box are ordinary, and under `'dom'` each background is emitted after the words it sits behind and paints them out — measured on a three-page report whose whole header row and every inline code span came out blank. `'dom'` stays, as the flag that reproduces a recorded stream. */
  paintOrder: 'dom'|'css';
  /** Default `false`. Basis: turning it on repaints any recorded stream with a dotted or dashed border; the arithmetic itself is exact. */
  styledBorders: boolean;
  /** Default `'none'`. Basis: on for print — without it, `0 0 0 rg` lands ink on all four process plates. */
  blackText: 'none'|'100k';
  /** Default `'none'`. Basis: a compliant RIP handed `/DefaultRGB` and an output intent lands within one 255th of the conversion anyway. `'endpoint'` refuses here: BelType serves no colour endpoint (§10.2). */
  convertRgb: 'none'|'endpoint'|'wasm';
  /** Default `true`. Basis: 34.2% of a body-size underline is removed; a continuous line strikes through every descender. */
  skipInk: boolean;
  /** Caster's own (D8). Default `'auto'`: on when any `--pdf-*` colour hint is declared or `blackText`/`convertRgb` is set. Decides whether the objects of `colour.md` (E8) — `/DefaultRGB`, `/OutputIntents`, the two ICC profiles — are written at all. PDF/UA-2 does not require them (the E5 run of `structure-tree.md` was clean without), and fetching 192 kB of profiles for a document with no colour story is exactly the download the capability registry exists to avoid. */
  colour: 'auto'|'on'|'off';
  /** Caster's own (*the printer guesses, says so, and withdraws the claim*, S90). Default `'infer'` (the decision chose `'refuse'`; flipped the same day at Egildo's call, so a document the other engines print prints here too): a custom element the walk's table does not name is walked as CSS laid it out, the way a `<span>` or a `<div>` is, every guess is listed in `report.inferred` and the warnings, and the file no longer claims PDF/UA-2 in its XMP, since a tag the printer guessed is not a claim it can stand behind. Measured on the bench's determina specimen: four `<dm-variable>` elements, each with no meaning a tag could name, refused the whole document. Under `'refuse'` it refuses the print by name, as every element the walk cannot name always has. A `bt-` or `beltype-` element is refused under both. */
  unknownElements: 'refuse'|'infer';
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
  rasterDpi: { values: null, default: 300 },
  paintOrder: { values: ['css', 'dom'], default: 'css' },
  styledBorders: { values: [true, false], default: false },
  blackText: { values: ['none', '100k'], default: 'none' },
  convertRgb: { values: ['none', 'endpoint', 'wasm'], default: 'none' },
  skipInk: { values: [true, false], default: true },
  colour: { values: ['auto', 'on', 'off'], default: 'auto' },
  unknownElements: { values: ['refuse', 'infer'], default: 'infer' }
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
 * @throws {CasterError} An unknown option, a non-positive or non-finite `rasterDpi`, or a value outside a flag's set — carrying `flag`.
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
  if (title !== undefined) out['title'] = title;
  if (lang !== undefined) out['lang'] = lang;
  return (out as CasterOptions);
}

/**
 * Whether this run writes the colour objects — PLAN.md D8's `colour` flag, with `auto` resolved.
 *
 * @remarks
 * `auto` is on when the document declares a `--pdf-*` colour hint, or when a policy that produces device colour (`blackText`, `convertRgb`) is on.
 *
 * @param needs - What the walk found; only `colourHints` is read.
 */
export function colourOn(needs: { colourHints?: boolean; }, options: CasterOptions) {
  if (options.colour === 'on') return true;
  if (options.colour === 'off') return false;
  return Boolean(needs?.colourHints) || options.blackText !== 'none' || options.convertRgb !== 'none';
}
