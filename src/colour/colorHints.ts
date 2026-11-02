/**
 * `colour/colorHints.js` — the `--pdf-*` colour hints: their registration, and the grammar a hint is read with.
 *
 * Ported from `harness/src/export/colorHints.ts` in the `browser-to-pdf-experiments` repository (E8, E9, E12E). Guide: `docs/guide/colour.md` §"The value grammar", §"The frozen rules".
 *
 * WHAT THE PORT CHANGED (PLAN.md P5). The harness's `HintParseError extends Error`; here it extends `ColorHintError`, which is a `CasterError`, so the name and the message survive and the panel gets the `{ element }` context the port adds.
 *
 * The harness's own header follows.
 *
 * The hints of `colour.md` (E8): the custom properties an author writes to name a colour the browser cannot represent, and the grammar the exporter reads them with.
 *
 * The whole point of a hint is that the engine ignores it. `--pdf-color` is a custom property, so Blink parses it as an untyped token stream, paints nothing differently, and hands the text back verbatim through `getComputedStyle`. The exporter is then free to define a value space CSS has no colour for — a DeviceCMYK quadruple that must survive to the plate unconverted, or a spot ink with a name, an alternate and a tint — without touching what the reader sees on screen.
 *
 * Registration is what makes the mechanism safe rather than merely convenient. A plain custom property inherits, so `--pdf-color` set on a section would silently claim every paragraph, every emphasis and every link inside it, and an element whose own `color` says otherwise would still be painted in the ancestor's ink. `CSS.registerProperty` with `inherits: false` is the only way to say "this element and no descendant", which is exactly the scope a paint hint needs. `syntax: '*'` keeps the value an untyped token stream, so the grammar below is the exporter's and the engine never rejects a value it does not understand.
 *
 * Nothing here reads the DOM beyond one `getComputedStyle` call, and nothing here emits. The parser's whole contract is: a hint that is absent means the RGB path, a hint that parses means the CMYK or spot path, and a hint that does not parse is an export error naming the element and the value — never a silent fall back to RGB, because a colour the author demanded and the exporter quietly dropped is the one failure a print job cannot recover from.
 *
 * @packageDocumentation
 */
import { ColorHintError } from '../errors.ts';

/** The registered hint properties, in the order the registration snippet lists them. */
export const HINT_PROPERTIES = ([
  '--pdf-color',
  '--pdf-background-color',
  '--pdf-border-color',
  '--pdf-border-top-color',
  '--pdf-border-right-color',
  '--pdf-border-bottom-color',
  '--pdf-border-left-color',
  '--pdf-fill',
  '--pdf-stroke',
  '--pdf-background',
  '--pdf-overprint',
] as const);

/** One of the registered hint property names. */
export type HintProperty = (typeof HINT_PROPERTIES)[number];

/** The four per-side border hints, in PDF-space order: top, right, bottom, left. */
export const BORDER_SIDE_PROPERTIES = ([
  '--pdf-border-top-color',
  '--pdf-border-right-color',
  '--pdf-border-bottom-color',
  '--pdf-border-left-color',
] as const);

/** What one `CSS.registerProperty` call did, recorded rather than assumed. */
export type HintRegistration = {
  name: string;
  /** Whether the property is registered at all after the call. */
  registered: boolean;
  /** Whether `initialValue: ''` was accepted; false means the call was retried without it. */
  emptyInitialValue: boolean;
  /** What the first attempt threw, when it threw. */
  error?: string;
};

/**
 * Register every hint property as a non-inheriting untyped token stream.
 *
 * @remarks
 * `initialValue: ''` is what the plan's snippet asks for and it is what makes an unset property read back as the empty string rather than as the guaranteed-invalid value. Whether Chromium accepts an empty initial value for the universal syntax is a question the experiment answers rather than assumes, so a rejection is caught, the call is retried without the key, and both outcomes are recorded.
 *
 * Registering the same name twice throws, which is what makes this idempotent: a second call on a document that already has the properties reports them as registered and changes nothing.
 */
export function registerHintProperties(): HintRegistration[] {
  return HINT_PROPERTIES.map((name) => {
    try {
      CSS.registerProperty({ name, syntax: '*', inherits: false, initialValue: '' });
      return { name, registered: true, emptyInitialValue: true };
    } catch (error) {
      const message = String(error);
      // InvalidModificationError means the name is already registered, which is the idempotent case rather than a failure.
      if (message.includes('InvalidModification') || message.includes('already been registered')) {
        return { name, registered: true, emptyInitialValue: true, error: message };
      }
      try {
        CSS.registerProperty({ name, syntax: '*', inherits: false });
        return { name, registered: true, emptyInitialValue: false, error: message };
      } catch (second) {
        return { name, registered: false, emptyInitialValue: false, error: `${message}; ${String(second)}` };
      }
    }
  });
}

/** The computed value of one hint on one element; the empty string when unset. */
export function readHint(element: Element, name: string): string {
  return getComputedStyle(element).getPropertyValue(name).trim();
}

/** A DeviceCMYK quadruple, in the order the `k` operator takes them. */
export type Cmyk = [number, number, number, number];

/** `device-cmyk(…)`: process ink, written as `k` unconverted. */
export type CmykHint = {
  kind: 'cmyk';
  values: Cmyk;
};

/** `spot("name", device-cmyk(…), tint)`: a named ink, written as a `/Separation`. */
export type SpotHint = {
  kind: 'spot';
  name: string;
  /** The alternate space's colour at full tint, i.e. the `/C1` of the tint transform. */
  alternate: Cmyk;
  /** 0–1; the operand of `scn`. */
  tint: number;
};

/** `spot("All")` and `spot("None")`: the two colourant names PDF predefines. */
export type PredefinedHint = {
  kind: 'all' | 'none';
  alternate: Cmyk;
  tint: number;
};

/** A hint that parsed: the ink the author named. */
export type ResolvedColor = CmykHint | SpotHint | PredefinedHint;

/** Which paint operations `--pdf-overprint` sets overprint for. */
export type OverprintMode = 'fill' | 'stroke' | 'both';

/** What one element asked for, as the measurement and the emitter carry it. */
export type ElementColor = {
  /** The hint verbatim, as the computed style returned it; empty when unset. */
  declared: string;
  color?: ResolvedColor;
  overprint?: OverprintMode;
};

/**
 * An unparseable hint.
 *
 * @remarks
 * The message carries the element path and the value verbatim, because those two things are the whole of what an author needs to fix it, and because the failing test asserts on both.
 */
export class HintParseError extends ColorHintError {
  declare path: string;
  declare property: string;
  declare value: string;
  /**
   * @param path - The element's DOM path.
   * @param property - The hint property that carried the value.
   * @param value - The value verbatim.
   * @param reason - What in it the grammar could not read.
   */
  constructor(path: string, property: string, value: string, reason: string) {
    super(`colorHints: ${path} has an unparseable ${property}: ${JSON.stringify(value)} (${reason})`, { element: path });
    this.name = 'HintParseError';
    this.path = path;
    this.property = property;
    this.value = value;
  }
}

/** `/All` at full tint puts ink on every plate, which is what a registration mark is. */
const ALL_ALTERNATE = ([1, 1, 1, 1] as Cmyk);

/** `/None` marks nothing on any plate, whatever the tint says. */
const NONE_ALTERNATE = ([0, 0, 0, 0] as Cmyk);

/** Clamp to the closed interval [0, 1]. */
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** One `<number>` or `<percentage>` component, as a fraction of one. */
function component(token: string): number|null {
  const percent = /^([+-]?(?:\d+\.?\d*|\.\d+))%$/.exec(token);
  if (percent) return clamp01(Number(percent[1]) / 100);
  const number = /^([+-]?(?:\d+\.?\d*|\.\d+))$/.exec(token);
  if (number) return clamp01(Number(number[1]));
  return null;
}

/** The text between the parentheses of `name(...)`, or null when it is not that call. */
function callBody(text: string, name: string): string|null {
  if (!text.toLowerCase().startsWith(`${name}(`)) return null;
  let depth = 0;
  for (let i = name.length; i < text.length; i++) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        // Anything after the closing parenthesis is not part of the call, and a value that carries some is a value the author did not mean.
        return text.slice(i + 1).trim() === '' ? text.slice(name.length + 1, i) : null;
      }
    }
  }
  return null;
}

/**
 * Split on commas that are not inside a nested call.
 *
 * @remarks
 * `spot("PANTONE 286 C", device-cmyk(1 0.6 0 0.06), 60%)` has three arguments and four commas; only the ones at depth zero separate arguments.
 */
function topLevelArgs(body: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (quote) {
      current += char;
      if (char === '\\' && i + 1 < body.length) {
        current += body[++i];
        continue;
      }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  args.push(current.trim());
  return args;
}

/** A quoted `<string>`, with backslash escapes, or null when the token is not one. */
function quotedString(token: string): string|null {
  const quote = token[0];
  if ((quote !== '"' && quote !== "'") || token[token.length - 1] !== quote || token.length < 2) return null;
  let out = '';
  for (let i = 1; i < token.length - 1; i++) {
    const char = token[i];
    if (char === '\\' && i + 1 < token.length - 1) {
      out += token[++i];
      continue;
    }
    if (char === quote) return null;
    out += char;
  }
  return out;
}

/**
 * `device-cmyk(c m y k)`, with everything CSS Color 5 adds accepted and ignored.
 *
 * @remarks
 * The four components may be separated by whitespace or by commas; `/ alpha` ends the component list, and a fifth comma-separated argument is the CSS fallback colour. Neither reaches a PDF: a `k` operator has four operands and no alpha, and the fallback exists for renderers that have no CMYK at all, which a print PDF is not.
 */
function parseDeviceCmyk(body: string): Cmyk|null {
  // Anything after a slash is the alpha, which the exporter accepts and drops.
  const beforeSlash = body.split('/')[0];
  const args = topLevelArgs(beforeSlash);
  const tokens = args.flatMap((arg) => arg.split(/\s+/).filter((t) => t !== ''));
  if (tokens.length < 4) return null;
  const values: number[] = [];
  for (let i = 0; i < 4; i++) {
    const value = component(tokens[i]);
    if (value === null) return null;
    values.push(value);
  }
  // A fifth token is only legal as the CSS fallback colour, which arrives as its own comma-separated argument rather than as a fifth number.
  if (tokens.length > 4 && args.length < 2) return null;
  return (values as Cmyk);
}

/** `<tint>`: a percentage, or a bare number already in 0–1. */
function parseTint(token: string): number|null {
  return component(token);
}

/**
 * One colour hint, parsed.
 *
 * @remarks
 * An empty value is not an error and not a colour: it is the absence of a hint, which is the RGB path, and it is what an unset registered property computes to.
 *
 * @param path - The element's DOM path, for the error.
 * @param property - The property the value came from, for the error.
 * @returns Null for an empty value.
 * @throws {HintParseError} Anything that is neither a well-formed `device-cmyk(…)` nor a well-formed `spot(…)`, including a named spot with no alternate.
 */
export function parseColorHint(value: string, path: string, property: string = '--pdf-color'): ResolvedColor|null {
  const text = value.trim();
  if (text === '') return null;

  const cmykBody = callBody(text, 'device-cmyk');
  if (cmykBody !== null) {
    const values = parseDeviceCmyk(cmykBody);
    if (!values) throw new HintParseError(path, property, value, 'device-cmyk() needs four numbers or percentages');
    return { kind: 'cmyk', values };
  }

  const spotBody = callBody(text, 'spot');
  if (spotBody !== null) {
    const args = topLevelArgs(spotBody);
    const name = quotedString(args[0] ?? '');
    if (name === null) throw new HintParseError(path, property, value, 'spot() needs a quoted name first');
    if (args.length > 3) throw new HintParseError(path, property, value, 'spot() takes a name, an alternate and a tint');

    let alternate: Cmyk|null = null;
    let tint = 1;
    for (const arg of args.slice(1)) {
      const nested = callBody(arg, 'device-cmyk');
      if (nested !== null) {
        if (alternate) throw new HintParseError(path, property, value, 'spot() carries two alternates');
        alternate = parseDeviceCmyk(nested);
        if (!alternate) throw new HintParseError(path, property, value, 'the alternate device-cmyk() is malformed');
        continue;
      }
      const parsed = parseTint(arg);
      if (parsed === null) throw new HintParseError(path, property, value, `${JSON.stringify(arg)} is neither an alternate nor a tint`);
      tint = parsed;
    }

    if (name === 'All') return { kind: 'all', alternate: alternate ?? ALL_ALTERNATE, tint };
    if (name === 'None') return { kind: 'none', alternate: NONE_ALTERNATE, tint };
    if (!alternate) throw new HintParseError(path, property, value, 'a named spot needs a device-cmyk() alternate');
    return { kind: 'spot', name, alternate, tint };
  }

  throw new HintParseError(path, property, value, 'expected device-cmyk(…) or spot(…)');
}

/**
 * `--pdf-overprint: fill | stroke | both`; empty means no overprint.
 *
 * @throws {HintParseError} Any other keyword.
 */
export function parseOverprint(value: string, path: string): OverprintMode|null {
  const text = value.trim().toLowerCase();
  if (text === '') return null;
  if (text === 'fill' || text === 'stroke' || text === 'both') return text;
  throw new HintParseError(path, '--pdf-overprint', value, 'expected fill, stroke or both');
}

/**
 * A key that is equal exactly when two resolved colours are the same ink.
 *
 * @remarks
 * Runs split on it, so it has to distinguish a spot from its own alternate and one tint of a spot from another; nothing else about it matters.
 */
export function colorKey(color: ResolvedColor|undefined): string {
  if (!color) return '';
  if (color.kind === 'cmyk') return `cmyk:${color.values.join(',')}`;
  const name = color.kind === 'spot' ? color.name : color.kind === 'all' ? 'All' : 'None';
  return `${color.kind}:${name}:${color.alternate.join(',')}:${color.tint}`;
}

/**
 * The colour and the overprint one element declares, read off the computed style.
 *
 * @param property - Which hint is read, because the same grammar backs the text colour, the background and the border, and the caller knows which of the three it is asking about.
 * @throws {HintParseError} As {@link parseColorHint} and {@link parseOverprint}.
 */
export function elementColor(element: Element, path: string, property: HintProperty|string = '--pdf-color'): ElementColor {
  const declared = readHint(element, property);
  const color = parseColorHint(declared, path, property);
  const overprint = parseOverprint(readHint(element, '--pdf-overprint'), path);
  return {
    declared,
    ...(color ? { color } : {}),
    ...(overprint ? { overprint } : {}),
  };
}

/**
 * A `--pdf-background` gradient whose stops are `device-cmyk()`.
 *
 * @remarks
 * E8 (`colour.md`) registered the property and left it unparsed: a gradient is not a colour, and a flat-colour grammar had nothing to say about one. E9 (`vector-painting.md`) needs it, because a CMYK shading is the one thing a `/DeviceCMYK` colour space parameter on a shading dictionary can be proved with, so the grammar grows exactly one rule — the gradient functions CSS already writes, with `device-cmyk()` where a colour would be.
 *
 * The stops all have to be CMYK. A gradient with one RGB stop and one CMYK stop has no honest PDF shading: a stitching function has one output arity, and converting either end would be the colour management module E8 (`colour.md`) exists to avoid. That case is an export error naming the element and the value, exactly like every other hint the parser cannot read.
 */
export type CmykGradientHint = {
  /** The value as written, which is what the geometry parser reads. */
  normalized: string;
  /** The gradient function's name, e.g. `linear-gradient`. */
  fn: string;
  /** One entry per stop, in order. */
  stops: Cmyk[];
  /** Reads one stop's colour, for the shared CSS gradient geometry parser. */
  colorOf: (text: string) => { rgb: [number, number, number], alpha: number, cmyk?: Cmyk };
};

/** The gradient functions a `--pdf-background` hint may be written with. */
const GRADIENT_FUNCTION = /^(repeating-)?(linear|radial|conic)-gradient$/i;

/** The naive conversion a CMYK stop's on-screen preview is drawn with. */
function cmykPreview(values: Cmyk): [number,number,number] {
  const [c, m, y, k] = values;
  return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
}

/**
 * A `--pdf-background` value, read as a gradient of `device-cmyk()` stops.
 *
 * @returns Null for an empty value or one that is not a gradient function at all.
 * @throws {HintParseError} A gradient with no `device-cmyk()` stop, a malformed one, or a stop in any other colour space; `colorOf` throws the same for a stop it cannot read.
 */
export function parseCmykGradientHint(value: string, path: string): CmykGradientHint|null {
  const text = value.trim();
  if (text === '') return null;
  const call = /^([a-z-]+)\((.*)\)$/is.exec(text);
  if (!call || !GRADIENT_FUNCTION.test(call[1])) return null;

  // Arguments split on commas that are not inside a nested call, so the four components of a `device-cmyk()` stay together.
  const args = topLevelArgs(call[2]);
  const stops: Cmyk[] = [];
  let sawOther = false;
  for (const arg of args) {
    const body = callBody(arg.replace(/\s+(-?[\d.]+(?:%|px|em|rem|pt)?)\s*$/i, ''), 'device-cmyk');
    if (body === null) {
      // The first argument may be the direction (`to right`, `45deg`); anything else that is not a device-cmyk() stop is a colour of another kind.
      if (arg === args[0] && !/\bdevice-cmyk\b/i.test(arg)) continue;
      sawOther = true;
      continue;
    }
    const parsed = parseDeviceCmyk(body);
    if (!parsed) throw new HintParseError(path, '--pdf-background', value, 'a stop’s device-cmyk() is malformed');
    stops.push(parsed);
  }
  if (stops.length === 0) {
    throw new HintParseError(path, '--pdf-background', value, 'a --pdf-background gradient needs device-cmyk() stops');
  }
  if (sawOther) {
    throw new HintParseError(path, '--pdf-background', value, 'every stop of a hinted gradient has to be device-cmyk(); mixing colour spaces has no PDF shading');
  }

  return {
    normalized: text,
    fn: call[1].toLowerCase(),
    stops,
    colorOf: (stopText) => {
      const body = callBody(stopText.trim(), 'device-cmyk');
      const parsed = body === null ? null : parseDeviceCmyk(body);
      if (!parsed) throw new HintParseError(path, '--pdf-background', stopText, 'expected a device-cmyk() stop');
      return { rgb: cmykPreview(parsed), alpha: 1, cmyk: parsed };
    },
  };
}
