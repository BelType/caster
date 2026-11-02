/**
 * `colour/colorResources.js` — the document's colour objects (`/Separation`, `/ExtGState`, `/DefaultRGB`, `/OutputIntents`) and the emitter that decides which one each paint reaches.
 *
 * Ported from `harness/src/export/colorResources.ts` in the `browser-to-pdf-experiments` repository (E8, E12E). Guide: `docs/guide/colour.md` §"The PDF objects written", §"Escaping a colourant name", §"The black-text policy", §"`/DefaultRGB` and `/OutputIntents`".
 *
 * WHAT THE PORT CHANGED (PLAN.md P2, D7). pdf-lib arrives through `capability('pdf')`. The harness's `readings` — one row per fixture verify-item, keyed by a fixture case name — is dropped with the other fixture-only fields; `registrations` stays, because what `CSS.registerProperty` did is a fact about the run and not about a fixture.
 *
 * The harness's own header follows.
 *
 * The colour objects of `colour.md` (E8): the document-wide resources a CMYK and spot-ink page needs, and the operators that reach them.
 *
 * Everything here exists because a PDF says colour in two places at once. The content stream carries operands — `0 0 0 1 k`, `/CS0 cs 0.6 scn` — and the page's resource dictionary carries the objects those operands name. A spot ink is not a colour, it is a *colourspace*: a `/Separation` array holding the colourant's name, the space a renderer without that ink falls back to, and the function that converts a tint into it. Two elements printing the same ink have to reach the same object, or a RIP sees two inks with one name and makes two plates.
 *
 * The other half is the story for every colour that is *not* declared. Those stay `rg`, which is device RGB and therefore means nothing on its own, and the file says what they mean twice: `/DefaultRGB` on every page maps device RGB onto an ICC sRGB stream, and the document `/OutputIntents` names the CMYK condition the whole file is destined for. Between them a RIP has everything it needs to convert, and the exporter has carried no colour management module at all — which is the entire point of the experiment.
 *
 * Resource names are allocated in first-use order and nowhere else, so a page's content stream is the same text on every run.
 *
 * @packageDocumentation
 */
import { capability } from '../capabilities.ts';
import { CasterError } from '../errors.ts';

import type { Cmyk, OverprintMode, PredefinedHint, ResolvedColor, SpotHint } from './colorHints.ts';
import type { Fill, ListPlace, PaintOrigin, RectItem, TextItem, WrittenColour, WrittenRunColour, WrittenRunWorklistEntry } from '../displayList.ts';
import type { RunColorOperators } from '../emit/textEmit.ts';
import type { ReportColorElement, ReportColorExtGState, ReportColorSpace, ColorTarget, ReportHintRegistration, ReportOutputIntent, ReportWorklistEntry } from '../report.ts';

/** The colourant name a resolved spot writes into its `/Separation` array. Here and not in `colour/colorHints.js`, which reads computed style, so the writer reaches no DOM to name an ink (moved in stage 2 of `.claude/plans/the-rust-writer/plan-close-the-list.md`). */
export function colorantName(color: SpotHint|PredefinedHint): string {
  return color.kind === 'spot' ? color.name : color.kind === 'all' ? 'All' : 'None';
}

/** One colour operand, written to four decimals: a tint of 0.6 is 0.6, not 0.6000000001. */
const num = (n: number): PDFNumber => capability('pdf').PDFNumber.of(Math.round(n * 10000) / 10000);

/** What the black-text option does with an unhinted `rgb(0 0 0)` text fill. */
export type BlackTextPolicy = 'none' | '100k';

/** The colour half of a run's options: the profiles, the condition, and the two policies. */
export type ColorOptions = {
  /** The CMYK output profile, as committed under `profiles/`. */
  profileBytes: Uint8Array;
  /** The sRGB profile `/DefaultRGB` points at. */
  srgbBytes: Uint8Array;
  /** `/OutputConditionIdentifier`. */
  condition: string;
  /** `/Info`; a human-readable description of the condition. */
  info: string;
  blackText: BlackTextPolicy;
  /** E12E (`colour.md`): the RGB→CMYK conversion tier. Absent — which is the default — every unhinted colour stays `rg` under `/DefaultRGB` and goes on the work list, which is E8 to the byte. Present, a colour the table has an answer for is written as `k` instead and recorded as converted; a colour it has no answer for still stays `rg`, because a tier that silently dropped a colour would be worse than one that converted none. The table is resolved before emission on purpose: both routes are asynchronous and this emitter is not, and a colour that had to be awaited in the middle of a content stream would be a colour the stream's order depended on. */
  convertRgb?: { mode: 'endpoint' | 'wasm', cmykOf: (rgb: readonly number[]) => Cmyk | undefined };
  /** What `CSS.registerProperty` did, recorded by the browser side. */
  registrations?: ReportHintRegistration[];
};

/** The four bytes at offset 12 of an ICC profile: `prtr`, `mntr`, `scnr`, … */
export function iccDeviceClass(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes.subarray(12, 16));
}

/** The data colour space at offset 16: `CMYK`, `RGB `, `GRAY`, … */
export function iccColorSpace(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes.subarray(16, 20));
}

/** `2.1.0` and friends, from the version field at offset 8. */
export function iccVersion(bytes: Uint8Array): string {
  return `${bytes[8]}.${bytes[9] >> 4}.${bytes[9] & 0x0f}`;
}

/**
 * Components an ICC colour space has, which is what a `/N` entry has to say.
 *
 * @throws {CasterError} A colour space other than `CMYK`, `RGB `, `Lab ` or `GRAY`.
 */
function iccComponents(space: string): number {
  if (space === 'CMYK') return 4;
  if (space === 'RGB ' || space === 'Lab ') return 3;
  if (space === 'GRAY') return 1;
  throw new CasterError(`colorResources: no /N for the ICC colour space ${JSON.stringify(space)}`);
}

/**
 * A colourant name, as the bytes of a PDF name.
 *
 * @remarks
 * PDF 2.0 allows UTF-8 in a name and PDF/A-4 6.1.7 t1 requires that what comes out of `#xx` expansion *be* valid UTF-8. pdf-lib's `PDFName.of` escapes by `charCodeAt`, so `Grün` would go in as `Gr#FCn` — Latin-1, and not valid UTF-8 at all. The name is therefore encoded to UTF-8 bytes and escaped here, byte by byte, before pdf-lib sees it; pdf-lib's own escaper leaves an existing `#` followed by two upper-case hex digits alone, so the escaped string survives the round trip byte for byte.
 *
 * The escaped set is PDF's: whitespace, the delimiters `()<>[]{}/%`, `#` itself, and everything outside printable ASCII.
 */
export function escapeColorantName(name: string): string {
  const bytes = new TextEncoder().encode(name);
  let out = '';
  for (const byte of bytes) {
    const regular = byte >= 0x21 && byte <= 0x7e && !'#%()/<>[]{}'.includes(String.fromCharCode(byte));
    out += regular ? String.fromCharCode(byte) : `#${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** One `/Separation` the document has allocated. */
export type Separation = {
  /** The resource name, e.g. `CS0`. */
  resource: string;
  colorant: string;
  /** The colourant as {@link escapeColorantName} writes it. */
  escaped: string;
  alternate: Cmyk;
  ref: PDFRef;
};

/** One `/ExtGState` the document has allocated. */
export type ExtGState = {
  /** The resource name, e.g. `GS0`. */
  resource: string;
  mode: OverprintMode | 'reset';
  /** Overprint for stroking. */
  OP: boolean;
  /** Overprint for non-stroking. */
  op: boolean;
  ref: PDFRef;
};

/**
 * The document's colour objects.
 *
 * @remarks
 * One instance per file. Everything it hands out is allocated on first use and shared afterwards, which is what makes "the same spot name is the same object" true rather than merely intended.
 */
export class ColorResources {
  declare context: PDFContext;
  declare options: ColorOptions;
  declare separations: Map<string, Separation>;
  declare extGStates: Map<string, ExtGState>;
  declare srgb: PDFRef | null;
  /**
   * @throws {CasterError} An output profile that is not CMYK, or whose device class is neither `prtr` nor `mntr` (PDF/A-4 6.2.3 t1); a `/DefaultRGB` profile that is not RGB.
   */
  constructor(context: PDFContext, options: ColorOptions) {
    this.context = context;
    this.options = options;
    this.separations = new Map<any, any>();
    this.extGStates = new Map<any, any>();
    this.srgb = null;

    const space = iccColorSpace(options.profileBytes);
    if (space !== 'CMYK') {
      throw new CasterError(`colorResources: the output profile is ${JSON.stringify(space)}, not CMYK`);
    }
    const deviceClass = iccDeviceClass(options.profileBytes);
    if (deviceClass !== 'prtr' && deviceClass !== 'mntr') {
      throw new CasterError(
        `colorResources: the output profile's device class is ${JSON.stringify(deviceClass)}; PDF/A-4 6.2.3 t1 wants prtr or mntr`,
      );
    }
    if (iccColorSpace(options.srgbBytes) !== 'RGB ') {
      throw new CasterError('colorResources: the /DefaultRGB profile is not an RGB profile');
    }
  }

  /** The black-text policy this document was built with. */
  get blackText(): BlackTextPolicy {
    return this.options.blackText;
  }

  /** The one `/ICCBased` sRGB stream every page's `/DefaultRGB` points at, registered on first use. */
  srgbRef(): PDFRef {
    if (!this.srgb) {
      this.srgb = this.context.register(
        this.context.flateStream(this.options.srgbBytes, { N: iccComponents(iccColorSpace(this.options.srgbBytes)) }),
      );
    }
    return this.srgb;
  }

  /**
   * The `/Separation` object for one spot ink, allocated once per colourant name.
   *
   * @remarks
   * The dedupe key is the name and only the name, because that is what a RIP keys a plate on. A second declaration with a different alternate is therefore not a second object, it is an export error: PDF/A-4 6.2.4.4 t2 says two same-named Separations must share their tint transform and their alternate space, and a file that broke that rule would print one ink two different colours depending on which element the RIP looked at.
   *
   * @throws {CasterError} A colourant already allocated with a different alternate.
   */
  separationRef(color: SpotHint|PredefinedHint): Separation {
    const { PDFName } = capability('pdf');
    const colorant = colorantName(color);
    const existing = this.separations.get(colorant);
    if (existing) {
      if (existing.alternate.join(',') !== color.alternate.join(',')) {
        throw new CasterError(
          `colorResources: the spot ${JSON.stringify(colorant)} is declared with two alternates, ` +
            `device-cmyk(${existing.alternate.join(' ')}) and device-cmyk(${color.alternate.join(' ')})`,
        );
      }
      return existing;
    }
    const escaped = escapeColorantName(colorant);
    const ref = this.context.register(
      this.context.obj([
        PDFName.of('Separation'),
        PDFName.of(escaped),
        PDFName.of('DeviceCMYK'),
        {
          FunctionType: 2,
          Domain: [0, 1],
          C0: [0, 0, 0, 0],
          C1: color.alternate,
          N: 1,
        },
      ]),
    );
    const separation: Separation = { resource: `CS${this.separations.size}`, colorant, escaped, alternate: color.alternate, ref };
    this.separations.set(colorant, separation);
    return separation;
  }

  /**
   * The `/ExtGState` for one overprint mode, allocated once per combination.
   *
   * @remarks
   * `/OPM 1` is the PostScript overprint mode, in which a zero component of a DeviceCMYK colour leaves that plate alone instead of setting it to zero; without it, overprinting black text would knock the box's cyan and magenta out from under itself and the whole exercise would be invisible. The reset state is allocated with it, because a `gs` inside a `BT … ET` cannot be undone by `Q` and has to be undone by another `gs`.
   */
  extGStateRef(mode: OverprintMode): { set: ExtGState; reset: ExtGState; } {
    const reset = this.reset();
    const existing = this.extGStates.get(mode);
    if (existing) return { set: existing, reset };
    const OP = mode === 'stroke' || mode === 'both';
    const op = mode === 'fill' || mode === 'both';
    const ref = this.context.register(this.context.obj({ Type: 'ExtGState', OP, op, OPM: 1 }));
    const state: ExtGState = { resource: `GS${this.extGStates.size}`, mode, OP, op, ref };
    this.extGStates.set(mode, state);
    return { set: state, reset };
  }

  /** `/GS0`: overprint off for both fill and stroke, which is a page's default state. */
  reset(): ExtGState {
    const existing = this.extGStates.get('reset');
    if (existing) return existing;
    const ref = this.context.register(this.context.obj({ Type: 'ExtGState', OP: false, op: false, OPM: 1 }));
    const state: ExtGState = { resource: `GS${this.extGStates.size}`, mode: 'reset', OP: false, op: false, ref };
    this.extGStates.set('reset', state);
    return state;
  }

  /**
   * The operators that set one resolved colour as the non-stroking colour.
   *
   * @throws {CasterError} As {@link ColorResources.separationRef}, for a spot.
   */
  fillOperators(color: ResolvedColor): PDFOperator[] {
    const { PDFName, PDFOperator, PDFOperatorNames: Ops } = capability('pdf');
    if (color.kind === 'cmyk') {
      return [PDFOperator.of(Ops.NonStrokingColorCmyk, color.values.map(num))];
    }
    const separation = this.separationRef(color);
    return [
      PDFOperator.of(Ops.NonStrokingColorspace, [PDFName.of(separation.resource)]),
      PDFOperator.of(Ops.NonStrokingColorN, [num(color.tint)]),
    ];
  }

  /**
   * The same for the stroking colour.
   *
   * @remarks
   * Nothing in the fixture of `colour.md` (E8) strokes — the border of the hinted box is painted as four filled rectangles, because that is how a box decoration is painted at all — so this is the half of the spec that is implemented and recorded rather than exercised.
   *
   * @throws {CasterError} As {@link ColorResources.separationRef}, for a spot.
   */
  strokeOperators(color: ResolvedColor): PDFOperator[] {
    const { PDFName, PDFOperator, PDFOperatorNames: Ops } = capability('pdf');
    if (color.kind === 'cmyk') {
      return [PDFOperator.of(Ops.StrokingColorCmyk, color.values.map(num))];
    }
    const separation = this.separationRef(color);
    return [
      PDFOperator.of(Ops.StrokingColorspace, [PDFName.of(separation.resource)]),
      PDFOperator.of(Ops.StrokingColorN, [num(color.tint)]),
    ];
  }

  /** `/GSn gs`, and the `/GS0 gs` that puts the state back. */
  overprintOperators(mode: OverprintMode): { set: PDFOperator; reset: PDFOperator; setName: string; resetName: string; } {
    const { PDFName, PDFOperator, PDFOperatorNames: Ops } = capability('pdf');
    const { set, reset } = this.extGStateRef(mode);
    return {
      set: PDFOperator.of(Ops.SetGraphicsStateParams, [PDFName.of(set.resource)]),
      reset: PDFOperator.of(Ops.SetGraphicsStateParams, [PDFName.of(reset.resource)]),
      setName: set.resource,
      resetName: reset.resource,
    };
  }

  /**
   * Give one page the colour resources the stream it carries refers to.
   *
   * @remarks
   * Called once per page after emission, because a resource name is allocated on first use and the last page can be the one that uses a spot first. `/DefaultRGB` goes on every page whether or not that page paints any RGB: it is the document's statement about what device RGB *means*, and a page that omitted it would be a page whose greys a RIP is entitled to guess at.
   */
  ensurePageResources(page: PDFPage) {
    const { PDFName } = capability('pdf');
    const resources = page.node.normalizedEntries().Resources;
    const colorSpace = this.context.obj({});
    colorSpace.set(PDFName.of('DefaultRGB'), this.context.obj([PDFName.of('ICCBased'), this.srgbRef()]));
    for (const separation of this.separations.values()) {
      colorSpace.set(PDFName.of(separation.resource), separation.ref);
    }
    resources.set(PDFName.of('ColorSpace'), colorSpace);
    for (const state of this.extGStates.values()) page.node.setExtGState(PDFName.of(state.resource), state.ref);
  }

  /**
   * The document's output intent.
   *
   * @remarks
   * `/S /GTS_PDFX` is the subtype every PDF/A and PDF/X output intent has carried since PDF 1.4 and is what veraPDF's PDF/A-4 profile looks for; the newer `/S /GTS_PDFA1` exists but is not what the A-4 rules key on. The condition identifier is the profile's own description rather than a standard characterisation name, because no characterisation profile is reachable from this environment; the exit notes say so.
   *
   * @returns With `profileSha256` still empty: the digest is asynchronous and {@link ColorEmitter.finish} fills it in.
   */
  addOutputIntent(catalog: PDFDict): ReportOutputIntent {
    const { PDFName, PDFString } = capability('pdf');
    const space = iccColorSpace(this.options.profileBytes);
    const n = iccComponents(space);
    const profileRef = this.context.register(this.context.flateStream(this.options.profileBytes, { N: n }));
    const intent = this.context.obj({
      Type: 'OutputIntent',
      S: 'GTS_PDFX',
      OutputConditionIdentifier: PDFString.of(this.options.condition),
      RegistryName: PDFString.of('http://www.color.org'),
      Info: PDFString.of(this.options.info),
      DestOutputProfile: profileRef,
    });
    catalog.set(PDFName.of('OutputIntents'), this.context.obj([intent]));
    return {
      subtype: 'GTS_PDFX',
      condition: this.options.condition,
      registryName: 'http://www.color.org',
      info: this.options.info,
      n,
      profileBytes: this.options.profileBytes.length,
      profileSha256: '',
      profileClass: iccDeviceClass(this.options.profileBytes),
      profileSpace: space,
      profileVersion: iccVersion(this.options.profileBytes),
    };
  }

  /** The colourspace inventory, in allocation order, for the report and the notes. */
  colorSpaceInventory(): ReportColorSpace[] {
    const spaces: ReportColorSpace[] = [
      {
        name: 'DefaultRGB',
        kind: 'ICCBased',
        alternate: `sRGB ICC, /N ${iccComponents(iccColorSpace(this.options.srgbBytes))}`,
      },
    ];
    for (const separation of this.separations.values()) {
      spaces.push({
        name: separation.resource,
        kind: 'Separation',
        alternate: 'DeviceCMYK',
        colorant: separation.colorant,
        escaped: separation.escaped,
        c1: separation.alternate,
      });
    }
    return spaces;
  }

  /** The ExtGState inventory, in allocation order. */
  extGStateInventory(): ReportColorExtGState[] {
    return [...this.extGStates.values()].map((state) => ({
      name: state.resource,
      mode: state.mode,
      OP: state.OP,
      op: state.op,
      OPM: 1,
    }));
  }
}

/** SHA-256 of some bytes, as lower-case hex; the report records profiles by it. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', (bytes as BufferSource));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The colour half of one emission: what each run and each rectangle is painted with, and the record of it the report carries.
 *
 * @remarks
 * It sits between the emitter and `ColorResources` so the emitter stays the emitter: `structureEmit` asks for a run's operators and gets them, and every decision about which operator that is — a hint, the black-text policy, or plain `rg` — is made here and written down as it is made. The work list falls out of the same pass, because a colour that stayed RGB is exactly a colour the conversion tier would have to convert.
 */
export class ColorEmitter {
  declare resources: ColorResources;
  declare options: ColorOptions;
  declare elements: (ReportColorElement|WrittenRunColour)[];
  declare worklist: Map<string, ReportWorklistEntry|WrittenRunWorklistEntry>;
  declare blackTextRuns: number;
  declare converted: number;
  /**
   * @throws {CasterError} As the {@link ColorResources} constructor, for profiles it refuses.
   */
  constructor(context: PDFContext, options: ColorOptions) {
    this.resources = new ColorResources(context, options);
    this.options = options;
    this.elements = [];
    this.worklist = new Map<any, any>();
    this.blackTextRuns = 0;
    /** E12E (`colour.md`): how many painted things the conversion tier claimed. */
    this.converted = 0;
  }

  /**
   * The CMYK the conversion tier has for one RGB colour, or null.
   *
   * @remarks
   * A colour with no entry stays `rg` and goes on the work list, which is the honest answer: the tier converted what it was given answers for and said so for the rest, rather than inventing a transform of its own.
   */
  convert(rgb: readonly number[]): Cmyk|null {
    if (!this.options.convertRgb) return null;
    return this.options.convertRgb.cmykOf(rgb) ?? null;
  }

  /**
   * The colour a run is painted with, and the record of why.
   *
   * @remarks
   * Three outcomes, in the order they are decided. A parseable hint is the declared ink and wins over everything the browser computed. No hint plus a text fill the browser computed as pure black is the black-text policy's case, and under `blackText: '100k'` it becomes `0 0 0 1 k` — one plate rather than the four a RIP would otherwise lay down for `0 0 0 rg`. Anything else stays `rg` and goes on the work list.
   *
   * The row it records is keyed by the item (`at`) and leaves out what the measurement knows, which `print()` adds: the paragraph's path where the item has no owner, the hint as declared, the ink box, and the run's text.
   *
   * @param at - The item's place in the list.
   */
  runOperators(item: TextItem, at: ListPlace): RunColorOperators {
    const { PDFOperator, PDFOperatorNames: Ops } = capability('pdf');
    const overprint = item.fill.overprint ? this.resources.overprintOperators(item.fill.overprint) : null;
    const hinted = item.fill.ink ? colorOf(item.fill.ink) : undefined;
    const record = (resolved: ReportColorElement['resolved'], operator: string, extra: Pick<ReportColorElement, 'resource' | 'blackTextPolicy' | 'converted'> = {}) => {
      this.elements.push({
        at,
        target: 'fill',
        resolved,
        ...(item.fill.overprint ? { overprint: item.fill.overprint } : {}),
        operator,
        ...extra,
      });
    };

    const wrap = (fill: PDFOperator[]): RunColorOperators => ({
      setup: overprint ? [overprint.set] : [],
      fill,
      reset: overprint ? [overprint.reset] : [],
    });

    if (hinted) {
      const fill = this.resources.fillOperators(hinted);
      record(resolvedOf(hinted), operatorOf(hinted), {
        ...(hinted.kind === 'cmyk' ? {} : { resource: this.resources.separationRef(hinted).resource }),
      });
      return wrap(fill);
    }

    const rgb = item.fill.rgb;
    const black = rgb[0] === 0 && rgb[1] === 0 && rgb[2] === 0;
    if (this.options.blackText === '100k' && black) {
      this.blackTextRuns += 1;
      record({ kind: 'cmyk', values: [0, 0, 0, 1] }, 'k', { blackTextPolicy: true });
      return wrap([PDFOperator.of(Ops.NonStrokingColorCmyk, [0, 0, 0, 1].map(num))]);
    }

    // E12E (`colour.md`): the conversion tier is asked last, after the two decisions the author made — a declared ink and the black-text policy — because both of those outrank a profile.
    const converted = this.convert(rgb);
    if (converted) {
      this.converted += 1;
      record({ kind: 'cmyk', values: converted }, 'k', { converted: true });
      return wrap([PDFOperator.of(Ops.NonStrokingColorCmyk, converted.map(num))]);
    }

    record({ kind: 'rgb', values: rgb }, 'rg');
    this.noteEntry('fill', rgb, { at, target: 'fill', rgb, uses: 1 });
    return wrap([PDFOperator.of(Ops.NonStrokingColorRgb, rgb.map(num))]);
  }

  /**
   * The same for one filled rectangle.
   *
   * @remarks
   * A rectangle is painted outside any text object, so its overprint state could be dropped by the `Q` the paint already carries; the reset operator is returned anyway, because an emitter that relied on `Q` restoring an ExtGState would be relying on something the text path cannot do.
   *
   * The black-text policy is a policy about text and is not applied here: a black rule or a black box is a decision about ink coverage that only the author can make.
   *
   * @param item - A rectangle with its `fill` and its `paint`.
   */
  paintOperators(item: RectItem, rectPt: [number,number,number,number]): RunColorOperators {
    const { PDFOperator, PDFOperatorNames: Ops } = capability('pdf');
    const fill = (item.fill as Fill);
    const paint = (item.paint as PaintOrigin);
    const overprint = fill.overprint ? this.resources.overprintOperators(fill.overprint) : null;
    const target: ColorTarget = paint.target;
    const hinted = fill.ink ? colorOf(fill.ink) : undefined;
    const record = (resolved: ReportColorElement['resolved'], operator: string, resource?: string) => {
      this.elements.push({
        path: paint.path,
        target,
        ...(paint.hint ? { hint: paint.hint } : {}),
        resolved,
        ...(fill.overprint ? { overprint: fill.overprint } : {}),
        operator,
        ...(resource ? { resource } : {}),
        rectPt,
        page: paint.page,
      });
    };
    const wrap = (fill: PDFOperator[]): RunColorOperators => ({
      setup: overprint ? [overprint.set] : [],
      fill,
      reset: overprint ? [overprint.reset] : [],
    });

    if (hinted) {
      const operators = this.resources.fillOperators(hinted);
      record(
        resolvedOf(hinted),
        operatorOf(hinted),
        hinted.kind === 'cmyk' ? undefined : this.resources.separationRef(hinted).resource,
      );
      return wrap(operators);
    }

    const converted = this.convert(fill.rgb);
    if (converted) {
      record({ kind: 'cmyk', values: converted }, 'k');
      this.converted += 1;
      return wrap([PDFOperator.of(Ops.NonStrokingColorCmyk, converted.map(num))]);
    }

    record({ kind: 'rgb', values: fill.rgb }, 'rg');
    this.note(paint.path, target, fill.rgb, paint.color);
    return wrap([PDFOperator.of(Ops.NonStrokingColorRgb, fill.rgb.map(num))]);
  }

  /** One entry per distinct RGB colour: the list the conversion tier converts. */
  note(path: string, target: ColorTarget, rgb: [number,number,number], css: string) {
    this.noteEntry(target, rgb, { path, target, rgb, css, uses: 1 });
  }

  /** The work list's entry for one colour: the first painter's, counted once per use. */
  noteEntry(target: ColorTarget, rgb: [number,number,number], first: ReportWorklistEntry|WrittenRunWorklistEntry) {
    const key = `${target}|${rgb.join(',')}`;
    const hit = this.worklist.get(key);
    if (hit) {
      hit.uses += 1;
      return;
    }
    this.worklist.set(key, first);
  }

  /**
   * Put the resources on the pages, the intent on the catalog, and hand back the writer's colour record, whose text-run rows `print()` completes.
   *
   * @remarks
   * It runs after emission on purpose: a resource name is allocated the first time an element asks for it, and the page that asks first may be the last page in the file.
   */
  async finish(pages: PDFPage[], catalog: PDFDict): Promise<WrittenColour> {
    for (const page of pages) this.resources.ensurePageResources(page);
    const outputIntent = this.resources.addOutputIntent(catalog);
    outputIntent.profileSha256 = await sha256Hex(this.options.profileBytes);
    return {
      elements: this.elements,
      colorSpaces: this.resources.colorSpaceInventory(),
      extGStates: this.resources.extGStateInventory(),
      outputIntent,
      defaultRgbBytes: this.options.srgbBytes.length,
      defaultRgbSha256: await sha256Hex(this.options.srgbBytes),
      blackTextPolicy: this.options.blackText,
      blackTextRuns: this.blackTextRuns,
      ...(this.options.convertRgb ? { convertRgb: this.options.convertRgb.mode, convertedElements: this.converted } : {}),
      worklist: [...this.worklist.values()],
      registrations: this.options.registrations ?? [],
    };
  }
}

/** A text item's declared ink as the resolved colour the emitter reads. */
function colorOf(ink: NonNullable<TextItem['fill']['ink']>): ResolvedColor {
  if ('cmyk' in ink) return { kind: 'cmyk', values: ink.cmyk };
  if (ink.spot === 'All') return { kind: 'all', alternate: ink.alternate, tint: ink.tint };
  if (ink.spot === 'None') return { kind: 'none', alternate: ink.alternate, tint: ink.tint };
  return { kind: 'spot', name: ink.spot, alternate: ink.alternate, tint: ink.tint };
}

/** The operator name one resolved colour is painted with. */
function operatorOf(color: ResolvedColor): string {
  return color.kind === 'cmyk' ? 'k' : 'scn';
}

/** A resolved colour in the report's shape. */
function resolvedOf(color: ResolvedColor): ReportColorElement['resolved'] {
  if (color.kind === 'cmyk') return { kind: 'cmyk', values: color.values };
  return { kind: color.kind, values: color.alternate, name: colorantName(color), tint: color.tint };
}
