/**
 * `vectors/vectorEmit.js` — the vector emitter of `vector-painting.md` (E9): measured geometry in, content-stream operators out.
 *
 * Ported from `harness/src/export/vectorEmit.ts` (E9, E10, E12B, E12C). Guide: `docs/guide/vector-painting.md` §"The emitter rule table".
 *
 * WHAT THE PORT CHANGED (P2). pdf-lib arrives through `capability('pdf')`, so the operator names are destructured at the top of each function that writes operators rather than imported once. The pdf-lib values are typed by the globals `types/vendor.d.ts` points at pdf-lib's own declarations — `PDFContext`, `PDFPage`, `PDFRef`, `PDFNumber`, `PDFOperator` — and no `any` is left.
 *
 * The harness's own header follows.
 *
 * The vector emitter of `vector-painting.md` (E9): measured geometry in, content-stream operators out.
 *
 * Everything it is handed is already in page points, so nothing here measures, transforms or decides where anything goes. What it decides is *how* a shape reaches the page:
 *
 *   flat fill            path, then `f` or `f*`
 *   flat stroke          `w J j M d`, path, then `S`
 *   both                 one path, then `B` or `B*`; with a stroke alpha below one, the path filled and then the path stroked
 *   gradient fill        `q` path `W n` `cm` `/Shn sh` `Q` — a clip, never a pattern
 *   gradient stroke      `/Pattern CS /Pn SCN` and `S`, with the page-space matrix folded into the pattern's own `/Matrix`
 *   constant alpha       `/GTn gs` with `/ca` and `/CA`
 *   varying alpha        the same, with `/SMask <</S /Luminosity /G form>>`
 *   a group              a form XObject with `/Group <</S /Transparency>>`
 *   anything else        a raster through the image writer of `images.md` (E7), with the reason
 *
 * The one rule worth stating twice: a gradient *fill* is `sh` inside a clip, not a shading pattern. `sh` paints the current clip in the current transformation matrix, which is exactly "this gradient, in this shape, here", and it needs no pattern space at all. A gradient *stroke* has no such option, because the region a stroke covers is not a path any operator can clip to, so that one case becomes a pattern — and then the matrix has to be the whole page-space one, because pattern space is the page's default space and takes no notice of the `cm` in force when the pattern is used. Getting that backwards is the classic way a gradient stroke lands in the corner of the page, which is why the node checker asserts the pattern's `/Matrix` against the report rather than trusting it.
 *
 * @packageDocumentation
 */
import { capability } from '../capabilities.ts';
import { CasterError } from '../errors.ts';

import type { EmbeddedImage, ImageContext } from '../images/imageEmbed.ts';
import type { ReportPaint, ReportShadingParams } from '../report.ts';
import type { ShadingBuilder } from './shading.ts';
import type { TransparencyBuilder, GraphicsStateParams } from './transparency.ts';
import type { Path } from './pathData.ts';
import type { ShadingSpec } from './vector.ts';
import type { ClipPath, Gradient, Paint, PathItem, PlacedVector, Resources, VectorItem } from '../displayList.ts';

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** A number as a PDF operand, at the emitter's three decimals. */
const num = (n: number): PDFNumber => capability('pdf').PDFNumber.of(round3(n));

/**
 * The resources one content stream refers to.
 *
 * @remarks
 * A form XObject has its own `/Resources`, and a name inside a form means what the form's dictionary says it means rather than what the page's does — so a scope is kept per stream and the names, which are allocated once per object for the whole document, are recorded into whichever scopes used them.
 */
export class ResourceScope {
  declare shadings: Map<string, PDFRef>;
  declare patterns: Map<string, PDFRef>;
  declare extGStates: Map<string, PDFRef>;
  declare xobjects: Map<string, PDFRef>;
  constructor() {
    this.shadings = new Map<any, any>();
    this.patterns = new Map<any, any>();
    this.extGStates = new Map<any, any>();
    this.xobjects = new Map<any, any>();
  }

  /** The `/Resources` dictionary a form XObject carries. */
  dictionary(context: PDFContext): Record<string,unknown> {
    const entry = (map: Map<string,PDFRef>): Record<string,PDFRef> => Object.fromEntries(map);
    return {
      ...(this.shadings.size > 0 ? { Shading: context.obj(entry(this.shadings)) } : {}),
      ...(this.patterns.size > 0 ? { Pattern: context.obj(entry(this.patterns)) } : {}),
      ...(this.extGStates.size > 0 ? { ExtGState: context.obj(entry(this.extGStates)) } : {}),
      ...(this.xobjects.size > 0 ? { XObject: context.obj(entry(this.xobjects)) } : {}),
    };
  }

  /** Put the same names on a page, beside whatever else the page already carries. */
  applyToPage(context: PDFContext, page: PDFPage) {
    const { PDFDict, PDFName } = capability('pdf');
    const resources = page.node.normalizedEntries().Resources;
    const put = (key: string, map: Map<string,PDFRef>) => {
      if (map.size === 0) return;
      const existing = resources.get(PDFName.of(key));
      const dict = existing instanceof PDFDict ? existing : context.obj({});
      for (const [name, ref] of map) dict.set(PDFName.of(name), ref);
      resources.set(PDFName.of(key), dict);
    };
    put('Shading', this.shadings);
    put('Pattern', this.patterns);
    put('XObject', this.xobjects);
    // ExtGState goes through pdf-lib's own helper, which merges rather than replaces, because the overprint states of `colour.md` (E8) are already in that dictionary.
    for (const [name, ref] of this.extGStates) page.node.setExtGState(PDFName.of(name), ref);
  }
}

/** What the emitter writes into, shared across every page of one file. */
export type VectorEmitContext = {
  context: PDFContext;
  shadings: ShadingBuilder;
  transparency: TransparencyBuilder;
  /** The image writer of `images.md` (E7), for the raster fallbacks. */
  images: ImageContext;
  /** The XObject each raster was embedded as, keyed by the raster's index in `resources.rasters`. */
  rasters: Map<number, EmbeddedImage>;
  /** The list's forms and raster fallbacks, which an item names by key. */
  resources: Pick<Resources, 'forms' | 'rasters'>;
  /** Everything painted, recorded for the report. */
  records: ReportPaint[];
  /** The document's sRGB profile as a colour space, for the group a blend mixes in; absent with no colour story, where `/DeviceRGB` stands. */
  blendingSpace?: () => unknown;
};

/**
 * Whether an item's blend mode reaches past it to a backdrop outside: its own blend mode, or one under a group that is no transparency group (Egildo's ruling 15a of the Rust writer).
 *
 * @remarks
 * A blend composites into its parent group in the parent's blending colour space (ISO 32000-2, 11.3.4), and a non-isolated group has none of its own (11.7.2), so the isolated group or the page that holds such an item is where the blend happens: that group names the document's sRGB profile as its `/CS`, the page its `/Group`, so the blend is the one the author saw under a CMYK output intent.
 */
export function holdsOpenBlend(item: VectorItem): boolean {
  if (item.blend) return true;
  return item.kind === 'group' && !item.isolated && item.items.some(holdsOpenBlend);
}

/**
 * Every operator one vector item contributes to a page.
 *
 * @param scope - The page's scope, which records every resource name the operators use.
 * @param artifact - Whether the item is painted as an artifact, for the records.
 * @throws {CasterError} A raster node reached the emitter without having been embedded.
 */
export function vectorOperators(item: PlacedVector, ctx: VectorEmitContext, scope: ResourceScope, artifact: boolean): PDFOperator[] {
  const out: PDFOperator[] = [];
  const from = ctx.records.length;
  emitItem(item, ctx, scope, out, { item, artifact });
  // Every record this item produced was written under the item's chain, form XObjects included, so the six numbers go on all of them rather than on the one node that happens to carry the field.
  const cm = item.transform;
  if (cm) {
    const rounded = cm.map(round3);
    for (let i = from; i < ctx.records.length; i++) ctx.records[i].chainCm = rounded;
  }
  return out;
}

/** What every node under one item is emitted on behalf of. */
export type EmitInfo = {
  item: PlacedVector;
  artifact: boolean;
};

/** `m`, `l`, `c`, `h` for one path. */
function pathOperators(path: Path): PDFOperator[] {
  const { PDFOperator, PDFOperatorNames: Ops } = capability('pdf');
  const out: PDFOperator[] = [];
  for (const segment of path) {
    if (segment.op === 'm') out.push(PDFOperator.of(Ops.MoveTo, segment.to.map(num)));
    else if (segment.op === 'l') out.push(PDFOperator.of(Ops.LineTo, segment.to.map(num)));
    else if (segment.op === 'c') out.push(PDFOperator.of(Ops.AppendBezierCurve, [...segment.c1, ...segment.c2, ...segment.to].map(num)));
    else out.push(PDFOperator.of(Ops.ClosePath));
  }
  return out;
}

/** A clip: the path, then `W n` or `W* n`. */
export function clipOperators(clip: ClipPath): PDFOperator[] {
  const { PDFOperator, PDFOperatorNames: Ops } = capability('pdf');
  return [...pathOperators(clip.path), PDFOperator.of(clip.rule === 'evenodd' ? Ops.ClipEvenOdd : Ops.ClipNonZero), PDFOperator.of(Ops.EndPath)];
}

/** The bounds of a path, as a PDF rectangle. */
function boundsOf(path: Path): [number,number,number,number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const segment of path) {
    const points = segment.op === 'c' ? [segment.c1, segment.c2, segment.to] : segment.op === 'h' ? [] : [segment.to];
    for (const [x, y] of points) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (!Number.isFinite(minX)) return [0, 0, 0, 0];
  return [minX, minY, maxX, maxY];
}

/** The shading params the report records, and the resource names they got. */
function shadingRecord(spec: ShadingSpec, shadingName: string, domain: [number,number], patternName?: string): ReportShadingParams {
  return {
    type: spec.type,
    coords: spec.coords.map(round3),
    coordsPt: spec.coordsPt.map(round3),
    extend: spec.extend,
    domain,
    stops: spec.stops.map((stop) => ({
      offset: Math.round(stop.offset * 10000) / 10000,
      rgb: (stop.rgb.map((c) => Math.round(c * 10000) / 10000) as [number, number, number]),
      ...(stop.cmyk
        ? { cmyk: (stop.cmyk.map((c) => Math.round(c * 10000) / 10000) as [number, number, number, number]) }
        : {}),
      alpha: Math.round(stop.alpha * 10000) / 10000,
    })),
    colorSpace: spec.colorSpace,
    matrix: spec.matrix.map(round3),
    spread: spec.spread,
    periods: spec.periods,
    shading: shadingName,
    ...(patternName ? { pattern: patternName } : {}),
    source: spec.source,
  };
}

/** The `gs` for the one `/ExtGState` an item's alpha, blend mode and mask ask for, or nothing when they ask for none. */
function stateFor(node: VectorItem, ctx: VectorEmitContext, scope: ResourceScope, info: EmitInfo, extra: { smaskForm?: PDFRef; smaskType?: 'luminosity'|'alpha'; backdrop?: number[]; } = {}): PDFOperator[] {
  const { PDFName, PDFOperator, PDFOperatorNames: Ops } = capability('pdf');
  const params: GraphicsStateParams = {};
  if (node.opacity !== undefined) params.ca = node.opacity;
  if (node.strokeOpacity !== undefined) params.CA = node.strokeOpacity;
  if (node.blend !== undefined) params.BM = node.blend;
  if (extra.smaskForm) {
    params.smask = { form: extra.smaskForm, type: extra.smaskType === 'alpha' ? 'Alpha' : 'Luminosity', ...(extra.backdrop ? { backdrop: extra.backdrop } : {}) };
  }
  if (params.ca === undefined && params.CA === undefined && params.BM === undefined && !params.smask) return [];
  const state = ctx.transparency.state(params);
  scope.extGStates.set(state.name, state.ref);
  ctx.records.push({
    path: node.origin.domPath,
    owner: info.item.owner,
    kind: params.smask ? 'smask' : 'group',
    label: `${node.origin.label}:state`,
    page: info.item.origin.page,
    paintIndex: info.item.origin.paintIndex,
    artifact: info.artifact,
    extGState: state.name,
    params: { ...state.params },
  });
  return [PDFOperator.of(Ops.SetGraphicsStateParams, [PDFName.of(state.name)])];
}

/**
 * A soft mask's own transparency group, painted into a form XObject.
 *
 * @returns The form, or null for an item with no soft mask.
 * @throws {CasterError} From the emission of the mask's content, as {@link vectorOperators} names.
 */
function softMaskForm(node: VectorItem, ctx: VectorEmitContext, info: EmitInfo): PDFRef|null {
  if (!node.softMask) return null;
  const inner = new ResourceScope();
  const operators: PDFOperator[] = [];
  for (const child of node.softMask.items) emitItem(child, ctx, inner, operators, info);
  const content = operators.map((op) => op.toString()).join('\n');
  const form = ctx.transparency.form(node.softMask.bbox, content, inner.dictionary(ctx.context));
  ctx.records.push({
    path: node.origin.domPath,
    owner: info.item.owner,
    kind: 'smask',
    label: `${node.origin.label}:mask`,
    page: info.item.origin.page,
    paintIndex: info.item.origin.paintIndex,
    artifact: info.artifact,
    geometry: node.softMask.bbox.map(round3),
    reason: node.origin.maskReason,
    form: form.name,
  });
  return form.ref;
}

/**
 * The soft mask a gradient's alpha stops need.
 *
 * @remarks
 * The same geometry, painted as a `/DeviceGray` shading of the stop alphas, into a transparency-group form; the form is then the `/G` of an `/SMask <</S /Luminosity>>`. Grey 1 is opaque and grey 0 is not, and the backdrop is black, the default `/BC` left unwritten, so that anything outside the form's `/BBox` is masked out entirely rather than left at whatever the page's luminosity happened to be.
 */
function alphaMaskForm(spec: ShadingSpec, path: Path, evenOdd: boolean, ctx: VectorEmitContext, info: EmitInfo, label: string, domPath: string): PDFRef {
  const { PDFName, PDFOperator, PDFOperatorNames: Ops } = capability('pdf');
  const inner = new ResourceScope();
  const alpha = ctx.shadings.alphaShading(spec);
  inner.shadings.set(alpha.name, alpha.ref);
  const bbox = boundsOf(path);
  const operators = [
    PDFOperator.of(Ops.PushGraphicsState),
    ...pathOperators(path),
    PDFOperator.of(evenOdd ? Ops.ClipEvenOdd : Ops.ClipNonZero),
    PDFOperator.of(Ops.EndPath),
    PDFOperator.of(Ops.ConcatTransformationMatrix, spec.matrix.map(num)),
    PDFOperator.of(Ops.ShadingFill, [PDFName.of(alpha.name)]),
    PDFOperator.of(Ops.PopGraphicsState),
  ];
  const form = ctx.transparency.form(bbox, operators.map((op) => op.toString()).join('\n'), inner.dictionary(ctx.context));
  ctx.records.push({
    path: domPath,
    owner: info.item.owner,
    kind: 'smask',
    label: `${label}:alpha-stops`,
    page: info.item.origin.page,
    paintIndex: info.item.origin.paintIndex,
    artifact: info.artifact,
    geometry: bbox.map(round3),
    reason: 'the gradient has stops with alpha below one',
    form: form.name,
    params: shadingRecord(spec, alpha.name, alpha.domain),
  });
  return form.ref;
}

/** `w J j M d` for one stroke. */
function strokeStateOperators(style: NonNullable<PathItem['stroke']>): PDFOperator[] {
  const { PDFNumber, PDFOperator, PDFOperatorNames: Ops } = capability('pdf');
  const out = [
    PDFOperator.of(Ops.SetLineWidth, [num(style.width)]),
    PDFOperator.of(Ops.SetLineCapStyle, [PDFNumber.of(style.cap)]),
    PDFOperator.of(Ops.SetLineJoinStyle, [PDFNumber.of(style.join)]),
    PDFOperator.of(Ops.SetLineMiterLimit, [num(style.miterLimit)]),
  ];
  const dash = style.dash.map((d) => round3(d)).join(' ');
  out.push(PDFOperator.of(Ops.SetLineDashPattern, [`[${dash}]`, num(style.dashPhase)]));
  return out;
}

/** Set a flat colour as the non-stroking or stroking colour. */
function colorOperators(paint: Paint, stroking: boolean): PDFOperator[] {
  const { PDFOperator, PDFOperatorNames: Ops } = capability('pdf');
  if ('rgb' in paint) {
    return [PDFOperator.of(stroking ? Ops.StrokingColorRgb : Ops.NonStrokingColorRgb, paint.rgb.map(num))];
  }
  if ('cmyk' in paint) {
    return [PDFOperator.of(stroking ? Ops.StrokingColorCmyk : Ops.NonStrokingColorCmyk, paint.cmyk.map(num))];
  }
  return [];
}

/** A gradient as the shading builder reads it: the list says `axial` and `radial` where the PDF dictionary says 2 and 3. */
function shadingOf(gradient: Gradient): ShadingSpec {
  return { ...gradient, type: gradient.type === 'axial' ? 2 : 3 };
}

/**
 * One item, and everything under it.
 *
 * @param out - Where the operators are appended.
 * @throws {CasterError} A raster item's pixels were never embedded.
 */
function emitItem(node: VectorItem, ctx: VectorEmitContext, scope: ResourceScope, out: PDFOperator[], info: EmitInfo) {
  const { PDFName, PDFOperator, PDFOperatorNames: Ops } = capability('pdf');
  const origin = node.origin;
  const maskType = node.softMask?.type;
  out.push(PDFOperator.of(Ops.PushGraphicsState));
  // The in-page CTM chain goes down before the clips, not after: an element's own `clip-path`, an `<svg>`'s viewport and every path under the item were all measured with the HTML ancestors' transforms neutralised, so they are in the untransformed page space and the transform lives entirely in these six numbers, exactly as it does for a line of text.
  if (node.transform) out.push(PDFOperator.of(Ops.ConcatTransformationMatrix, node.transform.map(num)));
  for (const [at, clip] of (node.clips ?? []).entries()) {
    for (const op of clipOperators(clip)) out.push(op);
    ctx.records.push({
      path: origin.domPath,
      owner: info.item.owner,
      kind: 'clip',
      label: `${origin.label}:clip`,
      page: info.item.origin.page,
      paintIndex: info.item.origin.paintIndex,
      artifact: info.artifact,
      geometry: boundsOf(clip.path).map(round3),
      reason: origin.clipReasons?.[at],
      evenOdd: clip.rule === 'evenodd',
    });
  }

  const smaskRef = softMaskForm(node, ctx, info);

  if (node.kind === 'group') {
    if (node.isolated) {
      const inner = new ResourceScope();
      const operators: PDFOperator[] = [];
      for (const child of node.items) emitItem(child, ctx, inner, operators, info);
      const space = ctx.blendingSpace && node.items.some(holdsOpenBlend) ? ctx.blendingSpace() : undefined;
      const form = ctx.transparency.form(node.bbox, operators.map((op) => op.toString()).join('\n'), inner.dictionary(ctx.context), space);
      scope.xobjects.set(form.name, form.ref);
      out.push(
        ...stateFor(
          node,
          ctx,
          scope,
          info,
          smaskRef ? { smaskForm: smaskRef, smaskType: maskType, backdrop: node.softMask?.backdrop } : {},
        ),
      );
      out.push(PDFOperator.of(Ops.DrawObject, [PDFName.of(form.name)]));
      ctx.records.push({
        path: origin.domPath,
        owner: info.item.owner,
        kind: 'group',
        label: origin.label,
        page: info.item.origin.page,
        paintIndex: info.item.origin.paintIndex,
        artifact: info.artifact,
        geometry: node.bbox.map(round3),
        reason: origin.isolatedReason,
        form: form.name,
        params: { opacity: node.opacity ?? 1, blend: node.blend ?? 'Normal', children: node.items.length },
      });
    } else {
      out.push(
        ...stateFor(
          node,
          ctx,
          scope,
          info,
          smaskRef ? { smaskForm: smaskRef, smaskType: maskType, backdrop: node.softMask?.backdrop } : {},
        ),
      );
      for (const child of node.items) emitItem(child, ctx, scope, out, info);
    }
    out.push(PDFOperator.of(Ops.PopGraphicsState));
    return;
  }

  if (node.kind === 'form') {
    const definition = ctx.resources.forms[node.form];
    // One XObject per key: the content is built for the first item that names it and every later placement is a matrix and a `Do`.
    const form = ctx.transparency.sharedForm(node.form, definition.bbox, () => {
      const inner = new ResourceScope();
      const operators: PDFOperator[] = [];
      for (const child of definition.items) emitItem(child, ctx, inner, operators, info);
      return { content: operators.map((op) => op.toString()).join('\n'), resources: inner.dictionary(ctx.context) };
    });
    scope.xobjects.set(form.name, form.ref);
    out.push(...stateFor(node, ctx, scope, info, smaskRef ? { smaskForm: smaskRef, smaskType: maskType } : {}));
    out.push(
      PDFOperator.of(Ops.ConcatTransformationMatrix, node.matrix.map(num)),
      PDFOperator.of(Ops.DrawObject, [PDFName.of(form.name)]),
    );
    ctx.records.push({
      path: origin.domPath,
      owner: info.item.owner,
      kind: 'form',
      label: origin.label,
      page: info.item.origin.page,
      paintIndex: info.item.origin.paintIndex,
      artifact: info.artifact,
      geometry: definition.bbox.map(round3),
      ctm: node.matrix.map(round3),
      reason: origin.reason,
      form: form.name,
      params: { key: node.form, reused: form.reused },
    });
    out.push(PDFOperator.of(Ops.PopGraphicsState));
    return;
  }

  if (node.kind === 'raster') {
    const raster = ctx.resources.rasters[node.source];
    const embedded = ctx.rasters.get(node.source);
    if (!embedded) {
      throw new CasterError(`vectorEmit: the raster for ${origin.domPath} (${raster.feature}) was never embedded`, {
        element: origin.domPath,
      });
    }
    scope.xobjects.set(embedded.name.asString().slice(1), embedded.ref);
    out.push(...stateFor(node, ctx, scope, info, smaskRef ? { smaskForm: smaskRef, smaskType: maskType } : {}));
    out.push(PDFOperator.of(Ops.ConcatTransformationMatrix, raster.cm.map(num)), PDFOperator.of(Ops.DrawObject, [embedded.name]));
    ctx.records.push({
      path: origin.domPath,
      owner: info.item.owner,
      kind: 'raster',
      label: origin.label,
      page: info.item.origin.page,
      paintIndex: info.item.origin.paintIndex,
      artifact: info.artifact,
      geometry: raster.rectPt.map(round3),
      ctm: raster.cm.map(round3),
      reason: raster.reason,
      feature: raster.feature,
      dpi: raster.dpi,
      xobject: embedded.name.asString().slice(1),
      hasSMask: embedded.info.hasSMask,
    });
    out.push(PDFOperator.of(Ops.PopGraphicsState));
    return;
  }

  // A path. The state goes on first so it covers both the fill and the stroke.
  const stateExtra = smaskRef ? { smaskForm: smaskRef, smaskType: maskType, backdrop: node.softMask?.backdrop } : {};
  out.push(...stateFor(node, ctx, scope, info, stateExtra));

  const fill = node.fill;
  const stroke = node.stroke;
  const fillIsShading = fill !== undefined && 'gradient' in fill;
  const strokeIsShading = stroke !== undefined && 'gradient' in stroke.paint;
  const evenOdd = node.rule === 'evenodd';
  const bounds = boundsOf(node.path);

  if (fillIsShading) {
    const spec = shadingOf((fill as { gradient: Gradient }).gradient);
    const shading = ctx.shadings.colorShading(spec);
    scope.shadings.set(shading.name, shading.ref);
    const alphaForm = spec.hasAlpha ? alphaMaskForm(spec, node.path, evenOdd, ctx, info, origin.label, origin.domPath) : null;
    out.push(PDFOperator.of(Ops.PushGraphicsState));
    if (alphaForm) {
      const state = ctx.transparency.state({
        smask: { form: alphaForm, type: 'Luminosity', backdrop: [0] },
        ...(node.opacity !== undefined ? { ca: node.opacity } : {}),
      });
      scope.extGStates.set(state.name, state.ref);
      out.push(PDFOperator.of(Ops.SetGraphicsStateParams, [PDFName.of(state.name)]));
    }
    out.push(
      ...pathOperators(node.path),
      PDFOperator.of(evenOdd ? Ops.ClipEvenOdd : Ops.ClipNonZero),
      PDFOperator.of(Ops.EndPath),
      PDFOperator.of(Ops.ConcatTransformationMatrix, spec.matrix.map(num)),
      PDFOperator.of(Ops.ShadingFill, [PDFName.of(shading.name)]),
      PDFOperator.of(Ops.PopGraphicsState),
    );
    ctx.records.push({
      path: origin.domPath,
      owner: info.item.owner,
      kind: 'shading',
      label: origin.label,
      page: info.item.origin.page,
      paintIndex: info.item.origin.paintIndex,
      artifact: info.artifact,
      geometry: bounds.map(round3),
      ctm: spec.matrix.map(round3),
      params: shadingRecord(spec, shading.name, shading.domain),
      reason: 'a gradient fill is `sh` inside a clip, never a shading pattern',
      evenOdd,
    });
  } else if (fill !== undefined) {
    out.push(...colorOperators(fill, false));
  }

  const flatFill = fill !== undefined && !fillIsShading;
  const strokes = stroke !== undefined;

  if (strokes) {
    out.push(...strokeStateOperators(stroke));
    if (strokeIsShading) {
      const spec = shadingOf((stroke.paint as { gradient: Gradient }).gradient);
      const pattern = ctx.shadings.pattern(spec);
      scope.patterns.set(pattern.name, pattern.ref);
      out.push(
        PDFOperator.of(Ops.StrokingColorspace, [PDFName.of('Pattern')]),
        PDFOperator.of(Ops.StrokingColorN, [PDFName.of(pattern.name)]),
      );
      ctx.records.push({
        path: origin.domPath,
        owner: info.item.owner,
        kind: 'stroke',
        label: `${origin.label}:gradient-stroke`,
        page: info.item.origin.page,
        paintIndex: info.item.origin.paintIndex,
        artifact: info.artifact,
        geometry: bounds.map(round3),
        ctm: spec.matrix.map(round3),
        params: shadingRecord(spec, ctx.shadings.colorShading(spec).name, ctx.shadings.colorShading(spec).domain, pattern.name),
        reason: 'a gradient stroke is a shading pattern whose /Matrix is the page-space CTM',
      });
    } else {
      out.push(...colorOperators(stroke.paint, true));
      ctx.records.push({
        path: origin.domPath,
        owner: info.item.owner,
        kind: 'stroke',
        label: origin.label,
        page: info.item.origin.page,
        paintIndex: info.item.origin.paintIndex,
        artifact: info.artifact,
        geometry: bounds.map(round3),
        params: {
          widthPt: round3(stroke.width),
          cap: stroke.cap,
          join: stroke.join,
          miterLimit: stroke.miterLimit,
          dashPt: stroke.dash.map(round3),
          nonScaling: (origin.nonScaling as boolean),
        },
      });
    }
  }

  if (flatFill || strokes) {
    for (const op of pathOperators(node.path)) out.push(op);
    if (flatFill && strokes && node.strokeFirst) {
      // `B` fills and then strokes, and there is no operator that does it the other way round. `paint-order: stroke` writes the path twice — stroke, then fill — which is exactly what the browser draws and what the marker case below already does with two nodes.
      out.push(PDFOperator.of(Ops.StrokePath));
      for (const op of pathOperators(node.path)) out.push(op);
      out.push(PDFOperator.of(evenOdd ? Ops.FillEvenOdd : Ops.FillNonZero));
    }
    else if (flatFill && strokes && node.strokeOpacity !== undefined) {
      // `B` paints its fill and its stroke as one non-isolated knockout group (ISO 32000-2, 11.7.4.4), so a stroke that is not opaque composites with the backdrop under the fill and not with the fill, where SVG and CSS composite a stroke over its own fill. With a stroke alpha below one the path is written twice, filled and then stroked, which is what the browser draws.
      out.push(PDFOperator.of(evenOdd ? Ops.FillEvenOdd : Ops.FillNonZero));
      for (const op of pathOperators(node.path)) out.push(op);
      out.push(PDFOperator.of(Ops.StrokePath));
    }
    else if (flatFill && strokes) out.push(PDFOperator.of(evenOdd ? Ops.FillEvenOddAndStroke : Ops.FillNonZeroAndStroke));
    else if (flatFill) out.push(PDFOperator.of(evenOdd ? Ops.FillEvenOdd : Ops.FillNonZero));
    else out.push(PDFOperator.of(Ops.StrokePath));
  }

  if (flatFill) {
    ctx.records.push({
      path: origin.domPath,
      owner: info.item.owner,
      kind: origin.label.startsWith('decoration:') ? 'decoration' : 'fill',
      label: origin.label,
      page: info.item.origin.page,
      paintIndex: info.item.origin.paintIndex,
      artifact: info.artifact,
      geometry: bounds.map(round3),
      evenOdd,
      params: { rgb: 'rgb' in fill ? fill.rgb.map((c) => round3(c)) : undefined, opacity: round3(node.opacity ?? 1) },
    });
  }

  out.push(PDFOperator.of(Ops.PopGraphicsState));
}
