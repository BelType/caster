/**
 * `vectors/shading.js` — the shadings of `vector-painting.md` (E9): a list of colour stops as a PDF gradient.
 *
 * Ported from `harness/src/export/shading.ts` (E9, E12E). Guide: `docs/guide/vector-painting.md` §"The emitter rule table" — the stitching function, the `/Domain`, the `/Bounds` nudge and the pattern's page-space matrix.
 *
 * WHAT THE PORT CHANGED. pdf-lib arrives through `capability('pdf')` (P2); `PDFContext` and `PDFRef` are the globals `types/vendor.d.ts` points at pdf-lib's own declarations.
 *
 * The harness's own header follows.
 *
 * The shadings of `vector-painting.md` (E9): a list of colour stops as a PDF gradient.
 *
 * PDF has no gradient. It has a *shading*: a colour space, a geometry — two points for an axis, two circles for a radial — and a function from one parameter to a colour. So every gradient in the document, CSS or SVG, arrives here as the same three things and leaves as a `/ShadingType 2` or `3` dictionary over a `/FunctionType 3` stitching function whose segments are `/FunctionType 2` exponential interpolations between neighbouring stops.
 *
 * Two details are decisions rather than transcription. The parameter domain is the stops' own range rather than `[0 1]`: a gradient whose first stop sits at 20% keeps its geometry and moves its `/Domain`, which is exact, where rewriting the coordinates would be arithmetic that has to be undone to check it. And alpha never enters the colour function. A stop's alpha becomes a *second* shading, in `/DeviceGray`, painted into a transparency-group form that an `/SMask <</S /Luminosity>>` points at — because a PDF colour has no alpha channel and the only place transparency lives is the graphics state.
 *
 * Objects are shared by value. Two boxes with the same gradient are one shading, one function and one soft mask, which is what keeps a page of repeated decoration from writing the same dictionary twenty times.
 *
 * @packageDocumentation
 */
import { capability } from '../capabilities.ts';
import { CasterError } from '../errors.ts';

import type { GradientStop, ShadingSpec } from './vector.ts';

/** One shading in the file, with the resource name every scope refers to it by. */
export type EmittedShading = {
  name: string;
  ref: PDFRef;
  /** The `/Domain` the dictionary carries. */
  domain: [number, number];
};

/** One tiling-free shading pattern, for a gradient stroke. */
export type EmittedPattern = {
  name: string;
  ref: PDFRef;
  matrix: number[];
};

const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * The colour components one stop contributes, in the shading's own space.
 *
 * @throws {CasterError} A `DeviceCMYK` shading reached a stop with no `device-cmyk()` colour.
 */
function componentsOf(stop: GradientStop, space: 'DeviceRGB'|'DeviceCMYK'|'DeviceGray'): number[] {
  if (space === 'DeviceGray') return [round4(stop.alpha)];
  if (space === 'DeviceCMYK') {
    if (!stop.cmyk) throw new CasterError('shading: a DeviceCMYK shading has a stop with no device-cmyk() colour');
    return stop.cmyk.map(round4);
  }
  return stop.rgb.map(round4);
}

/** A key that is equal exactly when two shadings are the same object. */
function keyOf(spec: ShadingSpec, space: string): string {
  return [
    space,
    spec.type,
    spec.coords.map(round4).join(','),
    spec.extend.join(','),
    spec.stops
      .map((s) => `${round4(s.offset)}:${s.rgb.map(round4).join('/')}:${s.cmyk?.map(round4).join('/') ?? ''}:${round4(s.alpha)}`)
      .join(';'),
  ].join('|');
}

/**
 * The document's shadings, functions, patterns and alpha masks.
 *
 * @remarks
 * One instance per file. Nothing is written until something asks for it, and everything is shared by value, so the object count in the finished file is the number of *distinct* gradients rather than the number of uses.
 */
export class ShadingBuilder {
  declare context: PDFContext;
  declare shadings: Map<string, EmittedShading>;
  declare patterns: Map<string, EmittedPattern>;
  constructor(context: PDFContext) {
    this.context = context;
    this.shadings = new Map<any, any>();
    this.patterns = new Map<any, any>();
  }

  /** How many distinct shading dictionaries the file carries. */
  get count() {
    return this.shadings.size;
  }

  /** How many distinct shading patterns the file carries. */
  get patternCount() {
    return this.patterns.size;
  }

  /**
   * The colour shading of one gradient.
   *
   * @throws {CasterError} As {@link ShadingBuilder.shading} does.
   */
  colorShading(spec: ShadingSpec): EmittedShading {
    return this.shading(spec, spec.colorSpace);
  }

  /**
   * The `/DeviceGray` shading of the same gradient's stop alphas.
   *
   * @throws {CasterError} As {@link ShadingBuilder.shading} does.
   */
  alphaShading(spec: ShadingSpec): EmittedShading {
    return this.shading(spec, 'DeviceGray');
  }

  /**
   * One shading dictionary over its stitching function, in `space`, shared by value.
   *
   * @throws {CasterError} The gradient has fewer than two stops, or a `DeviceCMYK` stop has no CMYK colour.
   */
  shading(spec: ShadingSpec, space: 'DeviceRGB'|'DeviceCMYK'|'DeviceGray'): EmittedShading {
    const { PDFName } = capability('pdf');
    const key = keyOf(spec, space);
    const existing = this.shadings.get(key);
    if (existing) return existing;

    const stops = [...spec.stops].sort((a, b) => a.offset - b.offset);
    if (stops.length < 2) throw new CasterError('shading: a gradient needs at least two stops');
    const t0 = stops[0].offset;
    let t1 = stops[stops.length - 1].offset;
    if (t1 - t0 < 1e-9) t1 = t0 + 1e-6;

    // A hard stop is two stops at one offset, and it is the whole of what a stripe is. `/Bounds` has to be strictly increasing, so the second of the pair is nudged by a millionth of the domain rather than dropped: the edge stays an edge, and no renderer can see a millionth of a gradient.
    const epsilon = (t1 - t0) * 1e-6;
    const offsets = stops.map((stop) => stop.offset);
    for (let i = 1; i < offsets.length - 1; i++) {
      if (offsets[i] <= offsets[i - 1]) offsets[i] = offsets[i - 1] + epsilon;
    }

    const segments = [];
    const bounds: number[] = [];
    const encode: number[] = [];
    for (let i = 0; i + 1 < stops.length; i++) {
      // CSS Images 4 §3.4.5 and SVG both interpolate gradients in premultiplied space, and the visible consequence is one rule: a fully transparent stop contributes no colour of its own, so it takes the colour of its opaque neighbour on the side being interpolated toward. `linear-gradient(red, transparent)` is red fading out; interpolated unpremultiplied it runs red → black and prints a dark band through the middle, which is what this did. The alpha itself is the soft mask's and is unaffected either way.
      const from = componentsOf(stops[i].alpha === 0 ? { ...stops[i + 1], offset: stops[i].offset, alpha: 0 } : stops[i], space);
      const to = componentsOf(stops[i + 1].alpha === 0 ? { ...stops[i], offset: stops[i + 1].offset, alpha: 0 } : stops[i + 1], space);
      segments.push(this.context.obj({ FunctionType: 2, Domain: [0, 1], C0: from, C1: to, N: 1 }));
      encode.push(0, 1);
      if (i > 0) bounds.push(round6(offsets[i]));
    }

    // A single segment needs no stitching, but writing one anyway keeps every shading in the file the same shape, which is what a checker reads back.
    const functionRef = this.context.register(
      this.context.obj({
        FunctionType: 3,
        Domain: [round6(t0), round6(t1)],
        Functions: segments,
        Bounds: bounds,
        Encode: encode,
      }),
    );

    const ref = this.context.register(
      this.context.obj({
        ShadingType: spec.type,
        ColorSpace: PDFName.of(space),
        Coords: spec.coords.map(round4),
        Domain: [round6(t0), round6(t1)],
        Extend: spec.extend,
        Function: functionRef,
      }),
    );

    const emitted: EmittedShading = { name: `Sh${this.shadings.size}`, ref, domain: [round6(t0), round6(t1)] };
    this.shadings.set(key, emitted);
    return emitted;
  }

  /**
   * A shading pattern for a gradient stroke.
   *
   * @remarks
   * A stroke cannot be painted with `sh`: `sh` fills the current clip, and the clip a stroke would need is the stroke itself, which PDF has no operator to compute. So the gradient becomes a `/PatternType 2` pattern set as the stroking colour — and because pattern space is the page's *default* user space rather than the space in force when the pattern is used, the whole page-space matrix goes into the pattern's own `/Matrix`.
   *
   * @throws {CasterError} As {@link ShadingBuilder.shading} does.
   */
  pattern(spec: ShadingSpec): EmittedPattern {
    const shading = this.colorShading(spec);
    const matrix = spec.matrix.map(round4);
    const key = `${shading.name}|${matrix.join(',')}`;
    const existing = this.patterns.get(key);
    if (existing) return existing;
    const ref = this.context.register(this.context.obj({ Type: 'Pattern', PatternType: 2, Shading: shading.ref, Matrix: matrix }));
    const emitted: EmittedPattern = { name: `P${this.patterns.size}`, ref, matrix };
    this.patterns.set(key, emitted);
    return emitted;
  }
}
