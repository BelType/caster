/**
 * `index.js` — `print(input, options)`: the composition the experiments never did.
 *
 * Caster's own; no harness source — each fixture composed the proven modules itself, `harness/tests/browser/e10-export.ts` the fullest of them (E10). Guide: `docs/guide/README.md`.
 *
 * Thirteen experiments settled every capability one by one and left a guide written for exactly this port. What they did not do is compose one pipeline: each fixture composed the proven modules itself, `harness/tests/browser/e10-export.ts` being the fullest example. This is that composition, done once, over an engine's presented pages, behind a capability registry that loads the heavy dependencies only when a document needs them.
 *
 * **The order inside is that of E10 (`coordinates-and-pages.md`) and it is load-bearing.** `beginFrame` first, because every coordinate after it is page-local. The page geometries next, because the vector modules convert to points through them. Then one `beginChains` for the whole export — a second call would capture the `transform: none` the first one wrote and find no chain at all. Then the geometry collectors and the text measurement inside that one neutralised window. Then emission.
 *
 * PLAN.md §3's eleven steps, in order: precheck, adapt, needs and capability load, frame, page geometry, fonts, walk, measure, images, emit, report.
 *
 * @packageDocumentation
 */

import { CasterError, FontUnavailableError } from './errors.ts';
import { resolveOptions, colourOn } from './options.ts';
import { createReport, recordProblem, stage } from './report.ts';
import { load, neededCapabilities, capability } from './capabilities.ts';
import { lock, precheck } from './precheck.ts';
import { createGateway } from './host/gateway.ts';
import { buildFontTable, declaredFaces, refuseFamily, unreadableFamilies } from './host/fonts.ts';
import { adaptCicero } from './adapters/cicero.ts';
import { adaptPagedjs, STRIP_SELECTOR as PAGEDJS_STRIP } from './adapters/pagedjs.ts';
import { prepare } from './adapters/prepare.ts';
import { reify } from './adapters/reify.ts';
import { beginFrame, endFrame, toLocalOn } from './coordinates/frame.ts';
import { clearPageGeometry, geometryOfPage, pageGeometries, pageGeometryFor, setPageGeometry, xToPt, yToPt } from './coordinates/pageGeometry.ts';
import { beginChains } from './coordinates/ctm.ts';
import { walkStructure } from './walk/structure.ts';
import { paintOrderOf } from './walk/paintOrder.ts';
import { defaultIntrinsics, domPathOf, holdDomPaths, measureText, releaseDomPaths } from './measure/textMeasure.ts';
import { assertConserved, assertGeneratedConserved } from './measure/conservation.ts';
import { assertTiled } from './measure/tiling.ts';
import { deriveIntervals } from './adapters/intervals.ts';
import { buildToUnicode } from './fonts/toUnicode.ts';
import { instanceCoords } from './fonts/axisMap.ts';
import { loadFont as loadHbFont } from './fonts/hbShaper.ts';
import { registerBytes as registerVarBytes } from './fonts/varShaper.ts';
import { loadSubsetter } from './fonts/hbSubset.ts';
import { SUBSET_FONT_PROFILE } from './fonts/fontEmbed.ts';
import { emitStructure } from './emit/structureEmit.ts';
import { buildDisplayList, tableSidecar } from './displayList/build.ts';
import { listSegments } from './emit/textEmit.ts';
import { imageRecord } from './images/imageEmbed.ts';
import { pageLabelRuns } from './emit/pageLabels.ts';
import { PX_TO_PT, round3 } from './coordinates/units.ts';
import { PAGE_LABEL_PROPERTY } from './emit/pageLabels.ts';
import { collectCssBoxes, decorationOf, textDecorationVectors } from './vectors/cssBoxes.ts';
import { walkDecorations } from './vectors/decorations.ts';
import { BAND_INSET_PX, BLINK_SOURCE, MAX_DILATION_PX, glyphsOfRun, skipInkUnderlines, underlinesOf } from './vectors/skipInk.ts';
import { collectTableBorders } from './vectors/tableBorders.ts';
import { MARKS_PROPERTY, pageMarksOf, parseMarks } from './coordinates/printMarks.ts';
import { collectSvg } from './vectors/svgGeometry.ts';
import { collectListMarkers } from './vectors/listMarkers.ts';
import { registerHintProperties, elementColor } from './colour/colorHints.ts';
import { parsePng } from './images/png.ts';
import { parseJpeg } from './images/jpeg.ts';
import { rasterizeSvg } from './images/canvasDecode.ts';
import { inlineSvgImages } from './images/svgInline.ts';
import { loadFacsimiles } from './images/facsimile.ts';

import type { CasterOptions } from './options.ts';
import type { Report, ReportCapability, ReportEmission, ReportImage, ReportNeeds, ReportPageBox, ReportSkipInk, ReportStructure, ReportWord } from './report.ts';
import type { WordRecord } from './emit/textEmit.ts';
import type { ImageUse } from './emit/structureEmit.ts';
import type { PageMarks } from './coordinates/printMarks.ts';
import type { PageStrip } from './adapters/strip.ts';
import type { DisplayList } from './displayList.ts';
import type { ChainContext } from './coordinates/ctm.ts';
import type { ImageIntrinsics, MeasuredImage, MeasuredRun, MeasureResult } from './measure/textMeasure.ts';
import type { FaceRequest } from './fonts/fontResolve.ts';
import type { FontTable } from './host/fonts.ts';
import type { Gateway } from './host/gateway.ts';
import type { WalkImage } from './walk/structure.ts';

/** What `print` is handed. */
export type PrintInput = {
  /** The print frame's document, after the engine's `run()` resolved. D1: it is CASTER's frame, never the author's live preview. */
  document: Document;
  /** *`print()` takes a strip from its host* (S62): the pages, where the host knows them better than the two built-in adapters could — anything that is not Cicero's `<beltype-root>` or Paged.js's `.pagedjs_pages`. Absent, the document is read for the root one of those engines wrote. */
  strip?: PageStrip;
  /** The gateway's asset manifest. Same-origin needs none. */
  manifest?: ReadonlyMap<string, string>;
  /** Progress, per capability, as it lands. */
  onCapability?: (entry: ReportCapability) => void;
  /** Progress, per pipeline step. */
  onStage?: (stage: string) => void;
};

/** The file, the report, and each page's content stream. */
export type PrintResult = {
  bytes: Uint8Array;
  report: Report;
  /** One content stream's text per page, for a checker. */
  pageStreams: string[];
  /** The page as plain data, built beside the file (stage 1 of `.claude/plans/the-display-list/executors.md`); the writer does not read it yet. */
  displayList: DisplayList;
  /** What building it took. */
  displayListMs: number;
};

/**
 * Print the pages an engine has presented.
 *
 * @remarks
 * Every refusal the modules it composes make reaches the caller as the `CasterError` subclass that made it — `ZoomError`, `RotationError`, `NonUniformScaleError` and `PerspectiveError` from the frame and the chains, `CrossOriginImageError` from the gateway, `FontUnavailableError`, `CapabilityError` from the registry, `UnknownElementError` from the walk, `ColorHintError` — each naming the element (P5).
 *
 * @param given - Validated by `resolveOptions`.
 * @throws {CasterError} The document has no window; not Blink; a print already running; an engine's DOM the adapter cannot read; a flag this port does not compose (`shaper: 'fontkit'`, `convertRgb` other than `'none'`, `subset: 'pdf-lib'`); a word rendered and never measured (*the conservation of words*, DESIGN.md S61).
 * @throws {FontUnavailableError} The document declares no `@font-face`, or a run resolves to a family nothing supplies bytes for (D2).
 */
export async function print(input: PrintInput, given: Partial<CasterOptions> = {}): Promise<PrintResult> {
  const options = resolveOptions(given);
  const report = createReport(((options as unknown) as Record<string, unknown>));
  const doc = input.document;
  const view = (doc.defaultView as (Window & typeof globalThis)|null);
  if (!view) throw new CasterError('caster: the document handed to print() has no window, so nothing in it can be measured');

  // 1 — precheck. Blink, one export at a time, the DPR warning.
  const checked = precheck(view);
  report.warnings.push(...checked.warnings);
  const release = lock();
  let chains: ChainContext|null = null;
  let t = now();
  const step = ( name: string) => { stage(report, name, now() - t); t = now(); input.onStage?.(name); };

  try {
    // 1b — every page built. Cicero builds a page's content only as the reader nears it and in idle time (*only the pages near the reader are built*, 2026-10-12), and the printer reads all of them; an engine with no such door (Paged.js) has built every page already, and a host's own strip is its own.
    if (!input.strip) await ((view as unknown) as { __beltypeCicero?: { buildAll?: () => Promise<unknown> } }).__beltypeCicero?.buildAll?.();
    // 2 — adapt. The engine's DOM becomes a `PageStrip` (§5) — or the host hands one over (*`print()` takes a strip from its host*, S62), because a strip is a fact about a DOM and not about an engine: a row of sized boxes nobody paginated is one. Otherwise which engine is read off the document — each leaves one root that the other never writes — and the printer refuses a document carrying both or neither by name rather than measuring the first thing it finds.
    const strip = input.strip ?? adaptStrip(doc);
    report.page = { widthPt: strip.pages[0].nominal.widthPt, heightPt: strip.pages[0].nominal.heightPt };
    // THE TILING INVARIANT (S71), beside the conservation of words (which still runs after the measurement): each word of the source on exactly one page. Both adapters derive the record; a host's own strip gets it derived here, every node its own source.
    const intervals = strip.intervals ?? (input.strip ? deriveIntervals(strip) : null);
    if (intervals) assertTiled(intervals, strip);
    else report.warnings.push('caster: the pages carry no interval record, so the tiling invariant was not asked — under Paged.js the record is derived against the source `prepare()` keeps, and `prepare()` did not run on this document through this printer');
    step('adapt');

    // The gateway is the one thing that decides whether a URL may be read at all.
    const gateway = createGateway(input.manifest ?? new Map<any, any>());

    // 3 — needs and capability load. The walk's facts and the options decide which bundles to import; the loads run in parallel.
    const needs: ReportNeeds = surveyNeeds(doc, strip.strip, options);
    report.needs = needs;
    report.capabilities = await load(neededCapabilities(needs, options), input.onCapability);
    step('capabilities');

    // The registered properties, before anything is read off a computed style. The four geometry ones are `prepare()`'s, already registered in this realm; registering them twice throws `InvalidModificationError` and there is nothing to catch, so the call is gone. The colour hints are the colour module's own table.
    report.color = ({ registrations: registerHintProperties() } as any);

    // 4 — frame. The three probes, the refusals, the page rectangles. The probes go where the adapter says the pages are laid out — Cicero's is `<beltype-root>`'s shadow root, because a probe in its light DOM would be assigned to no slot (§5 R1; *Cicero's pages stack vertically*, DESIGN.md S9).
    const frame = beginFrame(strip.probeRoot, strip.pageElements);
    report.container = {
      scaleRecovered: frame.scale,
      scaleFromHeight: frame.scaleFromHeight,
      scaleFromWidthRatio: frame.scaleFromWidthRatio,
      scaleFromHeightRatio: frame.scaleFromHeightRatio,
      linear: frame.linear,
      offAxisPx: frame.offAxisPx,
      cornersAxisAligned: frame.cornersAxisAligned,
      pageRectPx: frame.pages.map((p) => ([p.left, p.top, p.paintedWidthPx, p.paintedHeightPx] as [number, number, number, number])),
      untransformedWidthPx: frame.pages.map((p) => p.widthPx),
      offsetWidthPx: frame.pages.map((p) => p.offsetWidthPx),
      widthSource: frame.widthSource,
      zoomSeen: frame.zoomSeen,
      scrollPx: { windowX: view.scrollX, windowY: view.scrollY, ancestorX: 0, ancestorY: 0 },
      devicePixelRatio: checked.devicePixelRatio,
      warnings: [],
      errors: []
    };
    step('frame');

    // 5 — page geometry. The nominal size comes from the adapter (R2); the `--pdf-*` hints from the document root (*the page-level `--pdf-*` properties are read from the document root*, S12).
    const rootStyle = view.getComputedStyle(doc.documentElement);
    const geometries = frame.pages.map((page, index) => {
      const trimChild = strip.pages[index].trimBox;
      const local = trimChild ? toLocalOn(trimChild.getBoundingClientRect(), index) ?? undefined : undefined;
      return geometryOfPage(page, local, { widthPt: strip.pages[index].nominal.widthPt, heightPt: strip.pages[index].nominal.heightPt, style: rootStyle });
    });
    setPageGeometry(geometries);
    // The crop and registration marks of `coordinates-and-pages.md` (E12d), read where, given *Chromium's `@page` parser discards a custom property* (S11), the page-level properties can be read at all: the document root. `parseMarks` refuses an unparsable value by name, which is the refusal the README has always promised and nothing was ever asking for.
    const marks = parseMarks(rootStyle.getPropertyValue(MARKS_PROPERTY));
    const bleedPx = Number.parseFloat(rootStyle.getPropertyValue('--pdf-bleed')) || 0;
    const printMarks = marks.crop || marks.cross
      ? { pages: geometries.map((g, index) => pageMarksOf(index, g, marks, bleedPx)) }
      : null;
    // The `/PageLabels` of `coordinates-and-pages.md` (E12F), from the root declaration and from nowhere else. `readPageLabels` asks each page element for its own, and there is no such thing: measured again for this round, a sheet whose `@page` block declares `--pdf-page-label: lower-roman` serialises back from the CSSOM as `@page { size: a4; }` with the property gone, registered or not, and the root declaration computes on the root alone because it is registered `inherits: false` — `''` on the body, `''` on every descendant. So one label style governs the whole document, as one run from page 0, and a per-page label waits on the same Cicero stamp that *the page-level `--pdf-*` properties are read from the document root* (S12) names: the engine's own capture reads `@page` before Chromium's parser discards it, and a `data-pdf-page-label` on the page host is the channel that would exist.
    const rootLabel = rootStyle.getPropertyValue(PAGE_LABEL_PROPERTY).trim();
    const pageLabels = rootLabel === '' ? [] : strip.pages.map((_, index) => (index === 0 ? rootLabel : ''));
    report.pageBoxes = geometries.map((g) => ({
      nominal: g.nominal,
      media: ([0, 0, g.widthPt, g.heightPt] as [number, number, number, number]),
      ...(g.trimPt ? { trim: g.trimPt } : {}),
      ...(g.bleedPt ? { bleed: g.bleedPt } : {}),
      measuredWidthPx: g.measuredWidthPx,
      measuredHeightPx: g.measuredHeightPx
    }));
    step('geometry');

    // 6 — fonts. The descriptor table out of the CSSOM, the bytes through the gateway, WOFF decoded by hand and WOFF2 through the decoder that *BelType ships faces of its own, and WOFF2 is decoded* (S46) made settle.
    const table = await buildFontTable(doc, gateway);
    report.warnings.push(...table.warnings);
    for (const [url, bytes] of table.bytesByUrl) {
      const shaperStarted = now();
      if (options.shaper === 'harfbuzz') loadHbFont(url, bytes);
      registerVarBytes(url, bytes);
      const load = table.loads.get(url);
      if (load) load.shaperMs = Math.round((now() - shaperStarted) * 1000) / 1000;
    }
    const subsetterStarted = now();
    if (options.subset === 'hb') await loadSubsetter();
    report.fontTiming = { declareMs: table.declareMs, declared: table.declared.length, fontFaces: table.fontFaces, fontFaceStatuses: table.fontFaceStatuses, unmatched: table.unmatched, ...(table.unmatched.length ? { faceKeys: table.faceKeys } : {}), unloaded: table.unloaded.length, faces: [...table.loads.values()], subsetterMs: Math.round((now() - subsetterStarted) * 1000) / 1000 };
    // The two flag tiers this composition does not build, refused by name rather than left to fail three modules later. Each names the flag, and the modules behind them stay: they are what a host that grows the tier would call, and their own suites are what keep them honest.
    if (options.shaper === 'fontkit') {
      throw new CasterError("caster: `shaper: 'fontkit'` is not composed in this port. `measure/textMeasure.js` imports HarfBuzz's shaper directly, so under this flag the registry skips the harfbuzz load and the first word throws \"never handed bytes\" — and the tier itself is a documented wrong-glyph route (S6, `docs/guide/shaping.md` §\"The two tiers\"): fontkit gets 97% and 82% of two test blocks' glyph sequences wrong at zero width error, so a printer that fell back to it would pass every width assertion and show the wrong letters.", { flag: 'shaper' });
    }
    if (options.convertRgb !== 'none') {
      throw new CasterError(`caster: \`convertRgb: '${options.convertRgb}'\` is not composed in this port. \`colorResources.js\` expects a transform — a \`{ mode, cmykOf }\` pair — and the flag is a string; no transform is built here, and the endpoint tier is a service BelType does not serve. \`colour/rgbToCmyk.js\` holds both routes and its own suite; nothing in the pipeline reaches them this round.`, { flag: 'convertRgb' });
    }
    if (options.subset === 'pdf-lib') {
      throw new CasterError("caster: `subset: 'pdf-lib'` is a documented refusal in this port (docs/guide/font-embedding.md §\"The two tiers\"). pdf-lib's own embedder re-lays-out the string with fontkit, so it cannot show a glyph the shaper chose, cannot instance a variable face, cannot read WOFF2, has no /ActualText mechanism and writes no subset tag. It pairs only with `shaper: 'fontkit'` and inherits all three of that tier's pre-checks.", { flag: 'subset' });
    }
    if (table.descriptors.length === 0) {
      throw new FontUnavailableError('caster: no @font-face in this document reached the printer as bytes, so there are no font programs to embed. The printer embeds programs — it cannot embed a system font a tab cannot read. BelType\'s addendum declares print faces of its own — Source Serif 4, Source Sans 3, Source Code Pro and Noto Emoji — so a document it dresses always has faces to embed; this one was rendered without the addendum, or none of the faces it declares could be fetched. Link BelType\'s addendum, or declare an @font-face in the venue\'s own stylesheet and serve the file beside the document.');
    }
    report.needs.faces = table.descriptors.length;
    step('fonts');

    // 7 — walk. Over the strip's per-page flow, page by page, never over the light DOM directly (R3) — which the comment claimed and the call did not do until *M4 was three defects* (S43): `container.children` holds the unassigned originals too, and the composed mode makes every block one.
    const container = strip.strip;
    // The walk writes nothing to the tree, so its addresses are held too (`holdDomPaths`), and released before `inlineSvgImages` moves an element.
    holdDomPaths();
    const walk = walkStructure(container, {
      pageIndexOf: (element) => indexOfPage(strip, element),
      // R4: the adapter paired every clone with the original it is a fragment of and verified the whole set (*the engine stopped showing the original*, S47); the walk adopts rather than tags. R8: the adapter names the engine's own marks inside content; the walk names no class.
      twinOf: strip.twinOf,
      transparentOf: strip.transparent,
      // Which elements the engine actually put on a page (*the engine stopped showing the original*, S47). A divided block's original is on none of them since the first fragment is constructed, so it gives the tree its element and its first fragment gives that element its ink.
      renders: (element) => strip.pageElementOf(element) !== null,
      unknownElements: options.unknownElements
    });
    // *The printer guesses, says so, and withdraws the claim* (S90): every guess the walk made is in the report twice, as a list and as a warning per guess, so every host that shows warnings shows them; and a file with a guess in it no longer claims PDF/UA-2.
    report.inferred = walk.inferred;
    report.conformance = walk.inferred.length > 0 ? 'tagged' : 'pdfua2';
    report.warnings.push(...walk.warnings);
    // The image bytes, before the measurement rather than after it. The order of `coordinates-and-pages.md` (E10) puts everything that is not a measurement outside the neutralised window, and this is outside it in both directions: fetching reads no layout at all. It has to happen first because only the file says what an image's stored pixel size and EXIF orientation are — `naturalWidth` is the size after the engine applied the orientation, so a sideways-stored JPEG measured from the DOM was placed with the identity orientation and printed on its side, with the file's own tag in the report saying otherwise.
    const imageBytes = await fetchImages(walk.images, gateway);
    // A facsimile (DESIGN.md S80) is a page of another PDF: fetched, opened and refused here, before the measurement, because the measurement places it by the page's own size.
    const facsimiles = await loadFacsimiles(walk.images, gateway);

    // An `<img>` whose file is an SVG leaves the raster road here (*an SVG that arrives through an `<img>` is a drawing*, S44), before anything reads paint order, because the drawing it becomes has to be in the document the two collectors and the measurement all walk. The structure element the walk already made for it — a `Figure` with the `alt`, or an artifact for `alt=""` — is what owns it either way; only the collector changes.
    releaseDomPaths();
    report.svgImages = inlineSvgImages(walk, imageBytes);

    // From here to the end nothing adds, removes or moves an element under the strip, so every address is counted once again (`holdDomPaths`).
    holdDomPaths();
    const order = paintOrderOf(container);

    // One `beginChains` for the whole export. A second would capture the `transform: none` the first wrote. Declared outside the `try` so the `finally` can restore it however the export ends.
    // R5's clip, measured once per page before the chains are opened, page-local. The foot is the flow box's bottom, which is the cut's extent and so the boundary a straddling block's tail is clipped at (*R5's clip boundary is `.flow`, not `.content-area`*, S22). The head is the page box — the page element's own top, which is where page-local px begin — because that is the engine's clip there: ink above the page area and inside the page box is painted, ink above the page box is not (*R5's head is the page box and its foot is the cut*, S69).
    const contentAreas: ({ topPx: number; bottomPx: number; }|null)[] = strip.pages.map((page) => {
      // An engine that moves the overflow rather than clipping it (Paged.js) names no flow box, and every rectangle a page owns is then the page's own.
      if (!page.flowBox) return null;
      const local = toLocalOn(page.flowBox.getBoundingClientRect(), page.index);
      return local ? { topPx: 0, bottomPx: local.yPx + local.hPx } : null;
    });

    // Margin content (*the margins are lifted into the light DOM*, S57) sits outside the content area by construction — a running head above it, a folio below — so it is never a straddler's clipped tail and R5 does not apply to it.
    const clipToPage = ( page: number,  element: Element) => (strip.inMargin?.(element) ? null : contentAreas[page] ?? null);
    chains = beginChains(container, strip.pageElementOf);
    // The collapsed-border resolver of `tables.md` (E11), before the boxes: under `border-collapse: collapse` the border between two cells is one border resolved from up to six declarations and painted on the grid line, so every part of such a table keeps its background and loses its four sides, and `tableBorders` paints what is actually there. BelType's addendum collapses every table, so without this every table printed through the per-cell route — two strips of ink on each shared edge, at the declared width rather than the resolved one, with `empty-cells: hide` ignored.
    const grid = collectTableBorders({ container, tables: walk.tables, order, chains });
    const boxes = collectCssBoxes({
      container,
      order,
      decorated: walk.decorated,
      chains,
      styledBorders: options.styledBorders,
      suppressBorders: (element) => grid.borderSuppressed.has(element) || grid.decorationSuppressed.has(element),
      rectsOf: (element) => (grid.gridBoxes.has(element) ? [(grid.gridBoxes.get(element) as DOMRect)] : null)
    });
    // `clipToPage` is the same R5 clip the measurement takes: a drawing inside a straddling block's clipped tail is painted by the continuation clone that carries it, not by the source (*a drawing inside a continuation was painted on no page*, S40).
    const svg = collectSvg({ container, order, roots: walk.svgs, chains, clipToPage });
    // Blink paints the disc, circle and square markers as shapes, not glyphs; each is drawn under the `Lbl` the walk gave it (`vectors/listMarkers.js`).
    const markers = collectListMarkers(walk.markerShapes, { order, chains, container });
    walk.artifacts.push(...boxes.artifacts, ...svg.artifacts, ...grid.artifacts);
    step('walk');

    // 8 — measure, inside the one neutralised window.
    const measurement = measureText(container, table.descriptors, {
      blocks: walk.blocks,
      ownerOf: walk.ownerOf,
      paints: walk.paints,
      images: walk.images.map((i) => ({ path: i.path, element: i.element, box: i.box })),
      describe: walk.describe,
      vectors: [...boxes.requests, ...grid.requests, ...svg.requests, ...markers.requests],
      svgTexts: svg.texts,
      paintIndexOf: (element, kind) => (kind === 'decoration' ? order.decoration.get(element) : order.content.get(element)),
      colorOf: (parent) => elementColor(parent, domPathOf(parent, container)),
      // The decorations of `vector-painting.md` (E9). Runs split on the answer, and the run is what a decoration rectangle spans; the walk up for the propagated line is `decorationOf`'s, because `text-decoration` propagates rather than inherits and a descendant's computed style says `none` while the line is plainly there.
      decorationOf: (parent) => decorationOf(parent, container) ?? undefined,
      familyOf: (parent, request) => familyFor(parent, request, table, container),
      // The instancing of `font-embedding.md` (E4). A PDF carries no variable font, so a variable face has to be frozen at exactly the coordinate Chromium painted, and the coordinate is derived from the computed style — the cascade, the clamping and the defaults have all happened by then. Unwired, every variable face was shaped, measured and embedded at its default master under the browser's own rectangles, with no refusal anywhere to say so.
      coordsOf: (parent, face) => instanceCoords(getComputedStyle(parent), face.axes ?? {}),
      pageElementOf: strip.pageElementOf,
      imageIntrinsicsOf: (request, index) => {
        // A facsimile is CONTAINED in its element's box, centred, as the preview's canvas is (`object-fit: contain`, set by the presenter on the canvas, not on the element — the element shows fallback content and is not a replaced element, so its own computed `object-fit` is not the fit). When the box has the page's ratio, contain and fill are the same rectangle.
        const loaded = facsimiles.get(walk.images[index].src);
        if (loaded) return { storedIntrinsic: [loaded.widthPt, loaded.heightPt], exifOrientation: 1, objectFit: 'contain' };
        return intrinsicsOf(request, imageBytes) ?? defaultIntrinsics(request);
      },
      // Which page the engine assigned a block to (*a rectangle belongs to the page its node was assigned to*, S27). The clip below can only do its work once the rectangle is expressed against the block's own page — read off its own origin, a straddler's tail lands inside a later page's band, passes that page's clip, and prints again on every page it reaches down through.
      pageIndexOf: (element) => indexOfPage(strip, element),
      // R5: a line the engine laid out and then clipped belongs to the continuation clone on the next page, and the clone emits it. The area is measured through the same hub as everything else, so it is already page-local and already unscaled.
      clipToPage,
      chains
    });
    chains.end();
    // THE CONSERVATION OF WORDS (S61). Ink is a by-product of tagging here, so a text node the walk never classified is simply absent; the census asks the DOM rather than the tagger, and refuses the file that would show a cell's border around the hole where its words were.
    assertConserved(measurement.claimed, strip);
    // And the words a pseudo-element paints, which no text node holds (*a pseudo that reads a value the engine delivers is made real after the run*, S79).
    assertGeneratedConserved(strip);
    report.timing = {
      pages: measurement.pageCount,
      words: measurement.segments.length,
      rectsRead: measurement.segments.length * 2 + measurement.images.length,
      ms: Math.round((now() - t) * 100) / 100,
      wordsPerSecond: Math.round((measurement.segments.length / Math.max(0.001, (now() - t) / 1000)) * 10) / 10
    };
    step('measure');

    // 8b — the decorations, which are a second vector emission and have to be. The underline, overline and strike of `vector-painting.md` (E9) are rectangles positioned from the face's own `post` table at the line's baseline, so nothing about them can be computed before the measurement has produced lines — while `measureText` consumes its `vectors` option on the way in. So the requests are built here and appended to `measurement.vectors` with the paragraph's own DOM index, which is exactly what the interleaving would have given them: the emitter orders every item on `domIndex` with `paintIndex` ahead of it under `css`, and a decoration's paint index is its paragraph's plus a half, so the line goes on top of the text it decorates whichever order is in force. Nothing else about the emitter had to change.
    //
    // The face metrics come from fontkit rather than from a hand-rolled `post` reader: fontkit is an always capability, it is already loaded, and its `underlinePosition`, `underlineThickness`, `ascent`, `xHeight` and `unitsPerEm` are the five numbers `textDecorationVectors` asks for, read off the same tables a reader of our own would have read. The instance is the run's own, so a variable face is measured at the coordinates it is painted at.
    const fontkitCache: Map<string,any> = new Map<any, any>();
    const fontFor = (url: string, coords: Record<string,number>): any => {
      const key = `${url}|${JSON.stringify(coords ?? {})}`;
      const held = fontkitCache.get(key);
      if (held) return held;
      const bytes = table.bytesByUrl.get(url);
      if (!bytes) throw new CasterError(`caster: the decoration pass has no font bytes for ${url}; the face was declared but its programme never reached the table`);
      const base = capability('fontkit').create(bytes);
      const font = coords && Object.keys(coords).length > 0 ? base.getVariation(coords) : base;
      fontkitCache.set(key, font);
      return font;
    };
    const runByInstance: Map<string,MeasuredRun> = new Map<any, any>();
    for (const line of measurement.lines) for (const run of line.runs) if (!runByInstance.has(run.instanceKey)) runByInstance.set(run.instanceKey, run);
    const decorations = textDecorationVectors(
      measurement.lines,
      measurement.paragraphs,
      (paragraph) => measurement.paragraphs[paragraph]?.paintIndex ?? 0,
      (instanceKey) => {
        const run = runByInstance.get(instanceKey);
        if (!run) throw new CasterError(`caster: no measured run carries the instance ${instanceKey}, so a decoration cannot be positioned from its face`);
        const font = fontFor(run.url, run.coords);
        return { upem: font.unitsPerEm, underlinePosition: font.underlinePosition, underlineThickness: font.underlineThickness, ascent: font.ascent, xHeight: font.xHeight };
      }
    );
    const walkedDecorations = walkDecorations(measurement.lines, decorations.records);
    let skipInk: ReportSkipInk|undefined;
    if (options.skipInk && decorations.records.length > 0) {
      // E12F (`structure-tree.md`): Blink clips the underline against the intercepts of the glyph outlines over a band, so the line is cut where a descender crosses it. The band, the half-pixel inset and the 13 px dilation cap are the pinned Chromium source's; the line painted through the gaps is E9's own thickness, which is the face's `post` value rather than Blink's resolved one, and the two are deliberately kept apart.
      const cut = skipInkUnderlines(underlinesOf(measurement.lines, measurement.paragraphs, decorations.records, (run) => glyphsOfRun(run, fontFor)));
      // `textDecorationVectors` pushed one deferral per decoration that asked for skip-ink, in the walk's own order, so the flagged subsequence is what those deferrals are parallel to. It is taken before anything is cleared, because clearing is what makes half of them untrue.
      const flagged = walkedDecorations.filter((entry) => entry.record.skipInkIgnored);
      decorations.deferred = decorations.deferred.filter((_, index) => flagged[index]?.kind !== 'underline');
      for (const [index, request] of decorations.requests.entries()) {
        const path = cut.pathsByOwner.get(request.owner);
        if (!path || request.node.kind !== 'path') continue;
        request.node.path = path;
        // The record said skip-ink was asked for and ignored, which is what `underlinesOf` selects on and what it stopped being the moment the line was cut. An overline under the same declaration keeps both the flag and its deferral, because only the underline is cut.
        decorations.records[index].skipInkIgnored = false;
      }
      skipInk = { maxDilationPx: MAX_DILATION_PX, bandInsetPx: BAND_INSET_PX, source: BLINK_SOURCE, runs: cut.records };
    }
    measurement.vectors.push(...decorations.requests.map((request, index) => ({
      ...request,
      domIndex: measurement.paragraphs[walkedDecorations[index].line.paragraph]?.domIndex ?? 0
    })));
    walk.artifacts.push(...decorations.artifacts);

    // 9–10 — images and emit. `emitStructure` embeds the fonts, writes the content streams, the structure tree, the parent tree, the colour resources, the vectors, the images and the XMP.
    //
    // The raster fallbacks of `vector-painting.md` (E9), drawn. A collector that met a blur, a conic gradient or a background PDF has no operator for wrote a `RasterSpec` carrying the isolated SVG document to draw it from; `rasterizeSvg` is what turns that into pixels, and `emitStructure` embeds each one through the writer of `images.md` (E7). After `chains.end()` deliberately: the drawing reads no layout — it draws a serialised document into an offscreen canvas — so it has no business inside the neutralised window, and the order of E10 puts everything that is not a measurement after it.
    const rasterSamples = new Map<any, any>();
    for (const spec of [...boxes.rasters, ...svg.rasters]) {
      rasterSamples.set(spec, await rasterizeSvg(spec.svg, spec.rectPt[2], spec.rectPt[3], spec.dpi));
    }
    const listStart = now();
    const { list: displayList, origins } = await buildDisplayList(measurement, walk, {
      title: options.title ?? doc.title ?? 'Untitled',
      paintOrder: options.paintOrder,
      ...(strip.backgrounds.length ? { pageBackgrounds: strip.backgrounds } : {}),
      ...(printMarks ? { printMarks } : {}),
      outline: true,
      pageLabels,
      rasterSpecs: [...rasterSamples.keys()],
      rasterSamples,
      fonts: {
        bytesByUrl: table.bytesByUrl,
        familyOf: (instanceKey) => table.descriptors.find((d) => instanceKey.startsWith(d.id))?.family ?? '',
        sourceFormatOf: (url) => table.sourceFormatByUrl.get(url) ?? 'ttf'
      },
      images: {
        bytesOf: (src) => imageBytes.get(src),
        facsimileOf: (src) => facsimiles.get(src)
      }
    });
    const displayListMs = now() - listStart;
    const emitted = await emitStructure(displayList, {
      photoRule: options.photoRule,
      originOf: (page, index) => origins[page][index],
      baseUri: doc.baseURI,
      // The flags reach the profile. `widthDecimals` and `cffContainer` were accepted, reported, and then overridden by the constant on the next line.
      fontProfile: { ...SUBSET_FONT_PROFILE, widthDecimals: options.widthDecimals, cffContainer: options.cffContainer },
      toUnicode: buildToUnicode(listSegments(displayList, (page, index) => origins[page][index])),
      ...(strip.backgrounds.length ? { pageBackgrounds: strip.backgrounds } : {}),
      container: report.container,
      timing: report.timing,
      smallItems: { ...(skipInk ? { skipInk } : {}) },
      tables: { collapsedEdges: grid.edges, computedWidths: grid.computedWidths, gridLineSpreadPx: grid.gridLineSpreadPx },
      ...(colourOn(needs, options) ? { color: colourOptions(options) } : {}),
      vector: {
        paintOrder: options.paintOrder,
        rasterDpi: options.rasterDpi,
        order: order.order,
        deferred: [...boxes.deferred, ...grid.deferred, ...svg.deferred, ...decorations.deferred],
        stackingContexts: order.contexts,
        decorations: decorations.records,
        ctmReadings: svg.readings,
        figures: walk.svgs.map((s) => ({ path: s.domPath, tag: s.tag, alt: s.alt ?? '' }))
      }
    });
    step('emit');

    // 11 — report. The writer read the list and nothing else, so what the report keeps of the measurement and of the walk is added here: the trailing letter-spacing samples and the baseline probes, each paragraph's text beside the marked content it was written under, the headings, the tables, the languages, and the page-label record.
    emitted.report.emission = {
      ...(emitted.report.emission as ReportEmission),
      marginPt: pageGeometryFor(0).marginPt,
      pageWidthPt: pageGeometryFor(0).widthPt,
      pageHeightPt: pageGeometryFor(0).heightPt,
      trailingLetterSpacing: measurement.trailingLetterSpacing,
      trailingSamples: measurement.trailingSamples.map((s) => ({
        block: s.block,
        text: s.text,
        glyphs: s.glyphs,
        letterSpacingPx: s.letterSpacingPx,
        ratio: Math.round(s.ratio * 1e6) / 1e6
      })),
      baselineAgreementPt: round3(measurement.baselineAgreementPx * PX_TO_PT),
      usableProbes: measurement.usableProbes,
      probeMoved: measurement.probeMovedCount,
      probeOffLine: measurement.probeOffLineCount,
      probeBeforeOffLine: measurement.probeBeforeOffLineCount,
      containerScrollWidthPx: measurement.containerScrollWidthPx,
      paragraphs: measurement.paragraphs.map((p, index) => ({ block: p.block, path: p.path, text: p.text, mcids: emitted.paragraphMcids.get(index) ?? [] })),
      words: joinWords(emitted.wordRecords, measurement)
    };
    emitted.report.page = { widthPt: pageGeometryFor(0).widthPt, heightPt: pageGeometryFor(0).heightPt };
    emitted.report.pageBoxes = pageBoxRecords(measurement.pageCount, printMarks?.pages ?? []);
    emitted.report.structure = { ...(emitted.report.structure as ReportStructure), headings: walk.headings };
    const tableRecords = tableSidecar(walk.tables, grid.edges);
    Object.assign(emitted.report, {
      ...(tableRecords.length > 0 ? { tables: tableRecords, idTree: emitted.idTree } : {}),
      ...(pageLabels.length > 0 ? { pageLabels: pageLabelRuns(pageLabels).records } : {}),
      ...(emitted.imageUses.length > 0 ? { images: imageRecords(emitted.imageUses, measurement, displayList), xobjects: emitted.xobjects } : {}),
      ...(walk.langs.length > 0 ? { langs: walk.langs } : {})
    });
    Object.assign(report, emitted.report);
    report.options = ((options as unknown) as Record<string, unknown>);
    report.bytes = emitted.bytes.length;
    report.warnings.push(...unreadableFamilies(table).map((f) => `the family ${JSON.stringify(f)} is declared but its bytes could not be read; nothing resolved to it in this document, so the export continued`));
    return { bytes: emitted.bytes, report, pageStreams: emitted.pageStreams, displayList, displayListMs };
  } catch (error) {
    recordProblem(report, error);
    throw error;
  } finally {
    // `end()` is idempotent and restores every inline transform the chain builder wrote. It ran only on the happy path, so a throw anywhere in the collectors or the measurement left `transform: none` on the author's own elements — contained today because the print frame is discarded after an export, and a leak the moment anything prints from a live document.
    chains?.end();
    endFrame();
    clearPageGeometry();
    releaseDomPaths();
    release();
  }
}

/**
 * The report's `images`: what each painted image became in the file, joined to where the measurement placed it.
 *
 * @remarks
 * The join is the image's walk index, which the item names as `source` and the measurement's `index` carries.
 */
function imageRecords(uses: ImageUse[], measurement: MeasureResult, list: DisplayList): ReportImage[] {
  const placed = new Map(measurement.images.map((image) => [image.index, image]));
  return uses.map((use) => imageRecord((placed.get(use.source) as MeasuredImage), list.resources.images[use.source], use.embedded, use.name));
}

/**
 * One page's boxes, as the file carries them.
 *
 * @param marks - The marks of `coordinates-and-pages.md` (E12d): a page that grew to hold its print marks carries the grown media box, so the record is what a reader would read rather than what the geometry alone would have said.
 */
function pageBoxRecords(pageCount: number, marks: PageMarks[]): ReportPageBox[] {
  const geometries = pageGeometries();
  const records: ReportPageBox[] = [];
  for (let page = 0; page < pageCount; page++) {
    const g = geometries[Math.min(page, geometries.length - 1)];
    const grown = marks.find((m) => m.page === page && m.growthPt > 0);
    records.push({
      nominal: g.nominal,
      media: grown ? grown.mediaAfter : [0, 0, round3(g.widthPt), round3(g.heightPt)],
      ...(g.trimPt ? { trim: g.trimPt } : {}),
      ...(g.bleedPt ? { bleed: g.bleedPt } : {}),
      ...(g.trimFromChildPt ? { trimFromChild: g.trimFromChildPt } : {}),
      ...(g.bleedFromChildPt ? { bleedFromChild: g.bleedFromChildPt } : {}),
      ...(g.measuredWidthPx !== undefined ? { measuredWidthPx: g.measuredWidthPx } : {}),
      ...(g.measuredHeightPx !== undefined ? { measuredHeightPx: g.measuredHeightPx } : {}),
    });
  }
  return records;
}

/**
 * The report's `words`: what the writer knew of each word (where it aimed the pen, the space it wrote, the adjustment) joined to the measurement's segment for the rest.
 *
 * @remarks
 * The join is the run's index and the segment's place in the run, which the text item carries as `origin.run` and the order of `segments`. The measurement's pixels become points here by the expressions the writer used, so the record is the one the writer used to write.
 */
function joinWords(records: WordRecord[], measurement: MeasureResult): ReportWord[] {
  const runs: Map<number,MeasuredRun> = new Map<any, any>();
  for (const line of measurement.lines) for (const run of line.runs) runs.set(run.index, run);
  return records.map((record) => {
    const segment = (runs.get(record.runIndex) as MeasuredRun).segments[record.ordinal];
    const { page } = record;
    return {
      page,
      mcid: record.mcid,
      runIndex: record.runIndex,
      block: segment.block,
      text: segment.text,
      xPt: record.xPt,
      rightPt: xToPt(segment.rightPx, page),
      topPt: yToPt(segment.topPx, page),
      baselineMeasureTextPt: yToPt(segment.baselineAscentPx, page),
      baselineProbePt: yToPt(segment.baselineProbePx, page),
      baselineProbeBeforePt: yToPt(segment.baselineProbeBeforePx, page),
      probeMoved: segment.probeMoved,
      probeOffLine: segment.probeOffLine,
      probeBeforeOffLine: segment.probeBeforeOffLine,
      gids: segment.gids,
      clusters: segment.clusters,
      advancePt: segment.advanceUnits.map((a) => round3((a / segment.upem) * segment.sizePx * PX_TO_PT)),
      advanceWidthPt: round3(segment.advanceWidthPx * PX_TO_PT),
      spaceBefore: segment.spaceBefore,
      spaceEmitted: record.spaceEmitted,
      emittedAdj: record.emittedAdj
    };
  });
}

// The prepare-then-paginate half of D1, for a host that drives the frame itself. The editing tools' panel calls `prepare` and `run()` on its own so it can report progress between them, and the CLI's door calls `prepare` before `preview()` (`engine-pagedjs/src/render-pdf.js`, *`beltype build <target> --pdf --printer caster`*, DESIGN.md S65).
export { prepare };

// The reification primitive on its own (*reification is one primitive with two moments*, DESIGN.md S49): what `prepare` runs over the author's content before pagination, callable again over what a paginator made — margin cells, footnote calls and bodies — after it. Whole-document, idempotent.
export { reify };

/**
 * What the document needs, before any bundle is loaded.
 *
 * @remarks
 * Everything here is a DOM read: a PNG's own bytes are not fetched to decide whether `fast-png` is needed, because the answer that matters — is there any raster at all — is visible without one, and a document with no `<img>` and no background image never loads the decoder whatever its files turn out to hold.
 *
 * @throws {CasterError} An element declares a colour hint this round's painting does not read.
 */
export function surveyNeeds(doc: Document, container: HTMLElement, options: CasterOptions): ReportNeeds {
  const view = doc.defaultView ?? window;
  const images = [...container.querySelectorAll('img')];
  // A URL test, and it is what it is: the survey runs before a byte is fetched, deliberately (a document with no raster at all must never pay for the decoder). A `data:` PNG, a background-image PNG or an extension-less one is not counted here, and `imageEmbed.js` refuses by name when a decode is reached without the capability rather than blaming this flag.
  const forcedPngDecode = images.some((img) => /\.png(\?|#|$)/i.test(img.currentSrc || img.src));
  let colourHints = false;
  const root = view.getComputedStyle(doc.documentElement);
  // Only `--pdf-marks` counts as a colour story among the page-level properties, and it counts because a registration mark is drawn in the `/All` separation, which needs the profiles. `--pdf-bleed`, `--pdf-trim-inset` and `--pdf-page-label` say nothing about ink, and counting them made a bleed-only document download 186 kB of profiles and gain `/OutputIntents` and `/DefaultRGB` it had no use for — which contradicts *`colour` is Caster's own flag* (S7), the flag's own reason for existing.
  const marks = root.getPropertyValue('--pdf-marks').trim();
  if (marks !== '' && marks !== 'none') colourHints = true;
  if (!colourHints) {
    for (const element of container.querySelectorAll('*')) {
      const style = view.getComputedStyle(element);
      // The three the painting reads. `--pdf-background-color`, `--pdf-border-color`, `--pdf-fill` and `--pdf-stroke` are not here: nothing in the walk reads them, so surveying them fetched the profiles for a document whose declared inks were then quietly painted from the RGB computed style — the one failure this printer says it never commits. They refuse by name below instead.
      if (['--pdf-color', '--pdf-background', '--pdf-overprint'].some((n) => style.getPropertyValue(n).trim() !== '')) { colourHints = true; break; }
      const unread = ['--pdf-background-color', '--pdf-border-color', '--pdf-fill', '--pdf-stroke'].find((n) => style.getPropertyValue(n).trim() !== '');
      if (unread) {
        throw new CasterError(`caster: ${domPathOf(element, container)} declares ${unread}, and this round's painting does not read it — the box would be painted from its RGB computed style instead, which is the colour the author demanded and the exporter quietly dropped. The hints the printer reads are --pdf-color, --pdf-background and --pdf-overprint.`, { element: domPathOf(element, container) });
      }
    }
  }
  return {
    forcedPngDecode,
    // A CSSOM read, no byte fetched — the same discipline as `forcedPngDecode` above, and for the same reason: the WOFF2 decoder is 307 kB and a document that has another road to every one of its faces must never pay for it. `url(x.woff2), url(x.woff)` is therefore not woff2-only, because the WOFF behind it is what `buildFontTable` will take. BelType's own default faces are, which is what loads it for a document that declares nothing of its own.
    woff2Only: declaredFaces(doc).some((face) => face.sources.length > 0 && face.sources.every((source) => source.format === 'woff2' || /\.woff2(\?|#|$)/i.test(source.url))),
    colourHints,
    hasTables: container.querySelector('table') !== null,
    hasSvg: container.querySelector('svg') !== null,
    hasEmoji: /\p{Extended_Pictographic}/u.test(container.textContent ?? '')
  };
}

/**
 * Which CSS family a run's face is matched in: the first family of the element's own computed `font-family` that this document actually declares an `@font-face` for.
 *
 * @remarks
 * A stack that falls all the way through to a generic is D2's refusal, raised here, where the element is known.
 *
 * @throws {FontUnavailableError} No family in the stack has bytes (D2).
 */
function familyFor(parent: Element, request: FaceRequest, table: FontTable, container: HTMLElement) {
  const declared = new Set(table.descriptors.map((d) => d.family));
  for (const family of request.families) {
    if (declared.has(family)) return family;
  }
  if (request.families.length > 0) {
    refuseFamily(request.families[request.families.length - 1] ?? '(none)', domPathOf(parent, container), table);
  }
  refuseFamily('(none)', domPathOf(parent, container), table);
}

/**
 * Every image's bytes, through the gateway, keyed by the source the walker recorded.
 *
 * @throws {CrossOriginImageError} An image the gateway may not read.
 * @throws {CasterError} An image the gateway could not fetch or identify.
 */
async function fetchImages(images: WalkImage[], gateway: Gateway) {
  const out: Map<string,{ bytes: Uint8Array; mimeType: string; }> = new Map<any, any>();
  for (const image of images) {
    if (out.has(image.src) || image.src.startsWith('canvas:') || image.kind === 'facsimile') continue;
    const fetched = await gateway.getBytes(image.src);
    out.set(image.src, { bytes: fetched.bytes, mimeType: fetched.mimeType });
  }
  return out;
}

/**
 * One image's stored pixel size and its EXIF orientation, from the file's own header.
 *
 * @remarks
 * Neither can be read off the DOM. `naturalWidth`/`naturalHeight` are the size after the engine applied the orientation, and a background has no intrinsic size in the DOM at all; the orientation tag lives in the file and nowhere else. A `<canvas>` has no file, so its own dimensions are the truth and `defaultIntrinsics`' answer stands.
 */
function intrinsicsOf(request: { element: HTMLElement; }, bytesBySrc: Map<string,{ bytes: Uint8Array; mimeType: string; }>): ImageIntrinsics|undefined {
  const element = request.element;
  if (!(element instanceof HTMLImageElement)) return undefined;
  const source = bytesBySrc.get(element.currentSrc || element.src);
  if (!source) return undefined;
  if (source.mimeType === 'image/jpeg') {
    const info = parseJpeg(source.bytes);
    return { storedIntrinsic: [info.width, info.height], exifOrientation: info.exifOrientation };
  }
  if (source.mimeType === 'image/png') {
    const info = parsePng(source.bytes);
    return { storedIntrinsic: [info.width, info.height], exifOrientation: 1 };
  }
  return undefined;
}

/**
 * D8: the objects of `colour.md` (E8), when the document has a colour story.
 *
 * @remarks
 * The two ICC profiles come from the `profiles` capability the registry loaded.
 *
 * @throws {CapabilityError} The `profiles` capability was not loaded.
 */
function colourOptions( options: CasterOptions) {
  const files = capability('profiles');
  return {
    profileBytes: files['default_cmyk.icc'],
    srgbBytes: files['srgb.icc'],
    condition: 'Artifex CMYK SWOP Profile',
    info: 'Ghostscript default CMYK profile, standing in for a press characterisation',
    blackText: options.blackText,
    ...(options.convertRgb !== 'none' ? { convertRgb: options.convertRgb } : {})
  };
}

/**
 * The adapter for the engine that presented this document, chosen by the one root each engine writes: Cicero's `<beltype-root>`, Paged.js's `.pagedjs_pages`.
 *
 * @param options - Handed to the adapter.
 * @throws {CasterError} Both engines' roots are present, or the chosen adapter refuses what it reads.
 */
export function adaptStrip(doc: Document, options?: Parameters<typeof adaptCicero>[1]): PageStrip {
  const cicero = doc.querySelector('beltype-root');
  const paged = doc.querySelector(PAGEDJS_STRIP);
  if (cicero && paged) throw new CasterError('caster: the document holds both a <beltype-root> and a .pagedjs_pages, so two engines have presented it and the printer cannot tell whose pages to read');
  if (paged) return adaptPagedjs(doc, options);
  return adaptCicero(doc, options);
}

/** Which page an element is on, for the `/ID` names a table's cells carry. */
function indexOfPage(strip: PageStrip, element: Element) {
  const page = strip.pageElementOf(element);
  // M4's case, and it is no longer a defect to refuse on (*the engine stopped showing the original*, S47). An element the engine assigned to no page is a divided block's original — since the first fragment is constructed, every divided block has one, where before this round only a composed block or a fixed box did. It gives the tree its element and gives no rectangle, and the walk's `renders` option is what routes every reader of a rectangle to the fragment that has one. What is left for this answer is a table's `/ID` name, whose own contract already says an unanswered page means the first one and whose counter is what keeps the ids apart.
  return page ? strip.pageElements.indexOf(page) : 0;
}

function now() { return typeof performance === 'object' ? performance.now() : Date.now(); }

export { PX_TO_PT } from './coordinates/units.ts';
export { CasterError } from './errors.ts';
export { CAPABILITIES } from './capabilities.ts';
export { FLAGS, DEFAULTS, resolveOptions } from './options.ts';
export { adaptCicero } from './adapters/cicero.ts';
export { deriveIntervals } from './adapters/intervals.ts';
export { sourceSnapshotOf, SOURCE_ATTRIBUTE } from './adapters/prepare.ts';
export { renderedTextNodes } from './measure/conservation.ts';
export { tileOf, assertTiled } from './measure/tiling.ts';
