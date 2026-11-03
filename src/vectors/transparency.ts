/**
 * `vectors/transparency.js` — the transparency of `vector-painting.md` (E9): the graphics states and the group form XObjects that carry everything PDF keeps outside a colour.
 *
 * Ported from `harness/src/export/transparency.ts` (E9, E12C). Guide: `docs/guide/vector-painting.md` §"The emitter rule table" and §"The PDF objects written" — `/ca`, `/CA`, `/BM`, `/SMask`, and the group criteria.
 *
 * WHAT THE PORT CHANGED. pdf-lib arrives through `capability('pdf')` (P2), and the two TypeScript casts the harness needed for its literal types are gone with the types.
 *
 * The harness's own header follows.
 *
 * The transparency of `vector-painting.md` (E9): the graphics states and the group form XObjects that carry everything PDF keeps outside a colour.
 *
 * A PDF colour has three or four components and no fourth-or-fifth one for alpha. Constant opacity lives in the graphics state as `/ca` and `/CA`, a blend mode lives there as `/BM`, and a varying opacity — a gradient with alpha stops, an SVG `<mask>` — lives there as `/SMask`, which points at a whole *form XObject* whose luminosity or alpha is read back as the mask. So a transparent shape is never one operator; it is a state, sometimes a form, and a `Q` that puts the state back.
 *
 * The group criteria are the spec's, and they exist because `ca` on a group of shapes and `ca` on each shape separately are different pictures. Two circles at 50% each show the overlap darker; the same two circles composited first and then faded to 50% do not. So: opacity below one over more than one painting child, or over a fill and a stroke that overlap, becomes a transparency group painted once with `/ca`; a single leaf gets `/ca` directly and no form at all; and a blend mode makes a group whatever else is true, because a blend mode needs a backdrop to blend against and a group is what defines one.
 *
 * Everything is shared by value: one `/ExtGState` object per distinct parameter set, which is what keeps a page of half-transparent shapes from writing the same two-entry dictionary forty times.
 *
 * @packageDocumentation
 */
import { capability } from '../capabilities.ts';

/** The parameters one graphics-state dictionary carries. */
export type GraphicsStateParams = {
  /** Non-stroking constant alpha. */
  ca?: number;
  /** Stroking constant alpha. */
  CA?: number;
  /** A PDF blend-mode name, e.g. `Multiply`. */
  BM?: string;
  /** A soft-mask dictionary's form, or absent for `/SMask /None`. */
  smask?: { form: PDFRef, type: 'Luminosity' | 'Alpha', backdrop?: number[] };
};

/**
 * A soft mask's `/BC` entry: none for a black backdrop, the default, and otherwise one number per component of the mask group's `/DeviceRGB`.
 *
 * @remarks
 * ISO 32000-2, Table 142: the array "shall consist of n numbers", the components of the group's colour space, and black is the default. A grey backdrop of one number is spread over the three RGB components. Egildo's ruling 18 of the Rust writer, 2026-11-03.
 */
function backdropEntry(backdrop: number[] | undefined): { BC?: number[] } {
  if (!backdrop || backdrop.every((v) => v === 0)) return {};
  return { BC: backdrop.length === 1 ? [backdrop[0], backdrop[0], backdrop[0]] : backdrop };
}

/** One `/ExtGState` in the file, with the resource name every scope refers to it by. */
export type EmittedState = {
  name: string;
  ref: PDFRef;
  /** What went in, for the report. */
  params: { ca?: number, CA?: number, BM?: string, smask?: string };
};

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * The document's `/ExtGState` and transparency-group objects.
 *
 * @remarks
 * The name prefix is `GT` rather than `GS` on purpose: the colour resources of `colour.md` (E8) allocate `/GS0`, `/GS1` and so on for overprint, and two subsystems that numbered their own dictionaries into one namespace would collide the first time a fixture used both.
 */
export class TransparencyBuilder {
  declare context: any;
  declare states: Map<string, EmittedState>;
  declare shared: Map<string, { ref: PDFRef, name: string }>;
  declare forms: number;
  constructor(context: PDFContext) {
    /** `any` on purpose: the dictionaries this builder hands `obj()` and `flateStream()` are `Record<string, unknown>`, and the `LiteralObject` pdf-lib's declarations want is not exported to name. */
    this.context = context;
    this.states = new Map<any, any>();
    this.shared = new Map<any, any>();
    this.forms = 0;
  }

  /** How many distinct `/ExtGState` dictionaries the file carries. */
  get stateCount() {
    return this.states.size;
  }

  /** How many transparency-group forms were written; each is its own, never shared. */
  get formCount() {
    return this.forms;
  }

  /** How many shared forms exist, which for `vector-painting.md` (E12c) is how many markers are defined. */
  get sharedFormCount() {
    return this.shared.size;
  }

  /** One `/ExtGState`, shared by value. */
  state(params: GraphicsStateParams): EmittedState {
    const { PDFName } = capability('pdf');
    const key = [
      params.ca === undefined ? '' : round4(params.ca),
      params.CA === undefined ? '' : round4(params.CA),
      params.BM ?? '',
      params.smask ? `${params.smask.type}:${String(params.smask.form)}:${params.smask.backdrop?.join(',') ?? ''}` : '',
    ].join('|');
    const existing = this.states.get(key);
    if (existing) return existing;

    const dict: Record<string,unknown> = { Type: 'ExtGState' };
    if (params.ca !== undefined) dict.ca = round4(params.ca);
    if (params.CA !== undefined) dict.CA = round4(params.CA);
    if (params.BM !== undefined) dict.BM = PDFName.of(params.BM);
    if (params.smask) {
      dict.SMask = this.context.obj({
        Type: 'Mask',
        S: PDFName.of(params.smask.type),
        G: params.smask.form,
        ...backdropEntry(params.smask.backdrop),
      });
    } else if (params.ca !== undefined || params.CA !== undefined || params.BM !== undefined) {
      // A state that sets alpha or a blend mode but no mask says so, rather than inheriting whatever mask an enclosing state left behind.
      dict.SMask = PDFName.of('None');
    }

    const ref = this.context.register(this.context.obj(dict));
    const emitted: EmittedState = {
      name: `GT${this.states.size}`,
      ref,
      params: {
        ...(params.ca !== undefined ? { ca: round4(params.ca) } : {}),
        ...(params.CA !== undefined ? { CA: round4(params.CA) } : {}),
        ...(params.BM !== undefined ? { BM: params.BM } : {}),
        ...(params.smask ? { smask: params.smask.type } : {}),
      },
    };
    this.states.set(key, emitted);
    return emitted;
  }

  /**
   * A plain form XObject, shared by key: the same key answers with the same object and the builder is never called twice.
   *
   * @remarks
   * Plain rather than a transparency group, because a marker is not a compositing unit — it is a stamp. Giving it a `/Group` would isolate every arrowhead from the page it is drawn on, which changes nothing when the marker is opaque and is a lie when it is not.
   */
  sharedForm(key: string, bbox: [number,number,number,number], build: () => { content: string; resources: Record<string,unknown>; }): { ref: PDFRef; name: string; reused: boolean; } {
    const existing = this.shared.get(key);
    if (existing) return { ...existing, reused: true };
    const { content, resources } = build();
    const name = `Fx${this.shared.size}`;
    const ref = this.context.register(
      this.context.flateStream(content, {
        Type: 'XObject',
        Subtype: 'Form',
        FormType: 1,
        BBox: bbox.map(round4),
        Resources: resources,
      }),
    );
    const made = { ref, name };
    this.shared.set(key, made);
    return { ...made, reused: false };
  }

  /**
   * A transparency-group form XObject.
   *
   * @remarks
   * `colourSpace` is the group's blending space, `/DeviceRGB` unless the caller names one: the isolation boundary of a blend names the document's sRGB profile (Egildo's ruling 15a of the Rust writer).
   *
   * `/I true` — an isolated group — is what makes the group composite against a transparent backdrop rather than against whatever is already on the page, which is the difference between "these shapes, then faded" and "these shapes blended with the page, then faded". `/K false` is non-knockout, which is what a group of overlapping shapes means everywhere outside a print workflow.
   */
  form(bbox: [number,number,number,number], content: string, resources: Record<string,unknown>, colourSpace?: unknown): { ref: PDFRef; name: string; } {
    const { PDFName } = capability('pdf');
    const name = `Fm${this.forms++}`;
    const ref = this.context.register(
      this.context.flateStream(content, {
        Type: 'XObject',
        Subtype: 'Form',
        FormType: 1,
        BBox: bbox.map(round4),
        Group: { S: 'Transparency', I: true, K: false, CS: colourSpace ?? PDFName.of('DeviceRGB') },
        Resources: resources,
      }),
    );
    return { ref, name };
  }
}
