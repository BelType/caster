/**
 * `colour/hintPaints.js` — the minimal box painter of `colour.md` (E8) for hinted backgrounds and borders; unwired.
 *
 * Ported from `harness/src/export/hintPaints.ts` in the `browser-to-pdf-experiments` repository (E8). Guide: `docs/guide/colour.md` §"The PDF objects written".
 *
 * WHAT THE PORT CHANGED (*sixteen small wrongs*, DESIGN.md S30). The module is unwired, and recorded as such. Nothing imports it, not even a suite — `test/colour.test.js` lists `hintPaints` among what needs a DOM or a `PDFContext` and is not exercised there: `print()` reads `--pdf-color`, `--pdf-background` and `--pdf-overprint` through `colorHints.js` and paints everything else from the RGB computed style. The four properties this module exists for — `--pdf-background-color`, `--pdf-border-*-color`, `--pdf-fill`, `--pdf-stroke` — refuse by name in `surveyNeeds` rather than being surveyed and then silently dropped. Wiring it is a design round of its own: a hinted box paint is not an element the structure walker knows about, so it arrives at the measurement already measured, and deciding where it sits in paint order beside the collectors' own boxes is the question. The module and its suite stay because they are what that round will start from. Its refusals are `CasterError`s (PLAN.md P5).
 *
 * The harness's own header follows.
 *
 * The minimal box painter of `colour.md` (E8): the smallest thing that can put a hinted colour on a rectangle.
 *
 * E5 (`structure-tree.md`) paints exactly two kinds of rectangle — the `hr` and an element the fixture marked `data-pdf-artifact="layout"` — and it takes their colour off the computed style. Neither is enough for E8 (`colour.md`), which has to prove that a declared CMYK background and a declared CMYK border reach the plates, and that black text overprinting them leaves what is underneath alone. A general box-decoration painter — corners, radii, images, per-side styles, the painting order of a background under a border — is the whole job of E9 (`vector-painting.md`) and is not attempted here. What is here is the two rectangles E8's assertions need: the padding box for a background, and one rectangle per side for a border.
 *
 * Every rectangle is a Layout artifact. It has to be: PDF/UA-2 forbids content outside a marked-content sequence, a decorative box is not part of the reading order, and the structure walker has no element for something it never saw. The descriptors travel back with the rectangles so the caller can hand both to the emitter.
 *
 * Ordering is the one subtle part. A background painted after the text it sits behind would cover it, so each rectangle takes the DOM index of the first block inside its element, minus half a step: before that block's text, after everything the document painted earlier.
 *
 * @packageDocumentation
 */
import { elementColor, readHint, BORDER_SIDE_PROPERTIES } from './colorHints.ts';
import { domOrderOf, domPathOf, pageRectOf } from '../measure/textMeasure.ts';
import { CasterError } from '../errors.ts';

import type { ElementColor } from './colorHints.ts';
import type { ArtifactDescriptor } from '../walk/structure.ts';
import type { MeasuredPaint, PaintRequest } from '../measure/textMeasure.ts';

/**
 * `rgb(204, 0, 0)` and friends, as PDF `rg` operands.
 *
 * @throws {CasterError} A value with fewer than three numbers in it.
 */
function parseRgb(color: string): [number,number,number] {
  const numbers = color.match(/[\d.]+/g);
  if (!numbers || numbers.length < 3) throw new CasterError(`hintPaints: cannot parse colour ${color}`);
  return [Number(numbers[0]) / 255, Number(numbers[1]) / 255, Number(numbers[2]) / 255];
}

/** The rectangles the hints asked for, already measured, and the artifact each is. */
export type HintPaintResult = {
  paints: MeasuredPaint[];
  /** One descriptor per rectangle, so the emitter can find its owner. */
  artifacts: ArtifactDescriptor[];
};

/** The four border widths the engine computed, in PDF-space order. */
function borderWidths(style: CSSStyleDeclaration): [number,number,number,number] {
  return [
    parseFloat(style.borderTopWidth) || 0,
    parseFloat(style.borderRightWidth) || 0,
    parseFloat(style.borderBottomWidth) || 0,
    parseFloat(style.borderLeftWidth) || 0,
  ];
}

/**
 * Hint-gated background and border rectangles for every element in the container that declares one.
 *
 * @remarks
 * `blocks` and `paints` are the sets `measureText` will be handed, and they are passed in rather than rediscovered so the DOM index a rectangle carries is on the same scale as the one a paragraph carries. An element that declares a hint but contains no measured block has nothing to sit behind and is an error rather than a rectangle at an invented position.
 *
 * @throws {CasterError} An element that declares a hint and contains no measured block; a computed colour {@link parseRgb} cannot read.
 */
export function hintPaints(container: HTMLElement, blocks: HTMLElement[], paints: PaintRequest[]): HintPaintResult {
  const containerRect = container.getBoundingClientRect();
  const order = domOrderOf(container, [...blocks, ...paints.map((p) => p.element)]);
  const alreadyPainted: Set<Element> = new Set(paints.map((p) => p.element));

  const out: HintPaintResult = { paints: [], artifacts: [] };

  for (const element of container.querySelectorAll('*')) {
    if (alreadyPainted.has(element)) continue;
    const path = domPathOf(element, container);
    const background = elementColor(element, path, '--pdf-background-color');
    const sides = BORDER_SIDE_PROPERTIES.map((property) => {
      const own = elementColor(element, path, property);
      return own.color ? own : elementColor(element, path, '--pdf-border-color');
    });
    if (!background.color && sides.every((side) => !side.color)) continue;

    const indices = [...order].filter(([node]) => element.contains(node)).map(([, index]) => index);
    if (indices.length === 0) {
      throw new CasterError(`hintPaints: ${path} declares a colour hint but contains nothing the exporter measures`, { element: path });
    }
    const domIndex = Math.min(...indices) - 0.5;

    const style = getComputedStyle(element);
    const [top, right, bottom, left] = borderWidths(style);
    const rect = element.getBoundingClientRect();

    /** One hinted rectangle and its Layout artifact; a box with no area paints nothing. */
    const push = (suffix: string, target: 'background'|'border', color: ElementColor, box: DOMRect, cssColor: string) => {
      if (box.width <= 0 || box.height <= 0) return;
      const artifactPath = `artifact:${path}#${suffix}`;
      out.artifacts.push({ path: artifactPath, kind: 'layout', type: 'Layout' });
      out.paints.push({
        path: artifactPath,
        domIndex,
        ...pageRectOf(box, containerRect),
        rgb: parseRgb(cssColor),
        color: cssColor,
        target,
        ...(color.declared ? { hint: color.declared } : {}),
        ...(color.color ? { colorHint: color.color } : {}),
        ...(color.overprint ? { overprint: color.overprint } : {}),
      });
    };

    if (background.color) {
      push(
        'background',
        'background',
        background,
        new DOMRect(rect.left + left, rect.top + top, rect.width - left - right, rect.height - top - bottom),
        style.backgroundColor,
      );
    }

    const sideBoxes: [string,DOMRect,string][] = [
      ['border-top', new DOMRect(rect.left, rect.top, rect.width, top), style.borderTopColor],
      ['border-right', new DOMRect(rect.right - right, rect.top, right, rect.height), style.borderRightColor],
      ['border-bottom', new DOMRect(rect.left, rect.bottom - bottom, rect.width, bottom), style.borderBottomColor],
      ['border-left', new DOMRect(rect.left, rect.top, left, rect.height), style.borderLeftColor],
    ];
    sideBoxes.forEach(([suffix, box, cssColor], index) => {
      const side = sides[index];
      if (side.color) push(suffix, 'border', side, box, cssColor);
    });
  }

  return out;
}

/**
 * Attach the hints declared on the elements E5 (`structure-tree.md`) already paints.
 *
 * @remarks
 * The `hr` is the case the spec asks for: it is a Layout artifact with a rectangle the walker already built, and `spot("All")` on it is a rule printed in registration ink. Nothing new is measured; the request the walker made grows a resolved colour.
 *
 * @throws {CasterError} One rectangle hinted both as a background and as a border.
 */
export function applyPaintHints(paints: PaintRequest[], container: HTMLElement): PaintRequest[] {
  return paints.map((request) => {
    const path = domPathOf(request.element, container);
    const border = elementColor(request.element, path, '--pdf-border-color');
    const background = elementColor(request.element, path, '--pdf-background-color');
    if (border.color && background.color) {
      throw new CasterError(`hintPaints: ${path} declares both a background and a border hint for one rectangle`, { element: path });
    }
    const chosen = border.color ? border : background;
    const style = getComputedStyle(request.element);
    return {
      ...request,
      color: readHint(request.element, '--pdf-border-color') !== '' ? style.borderTopColor : style.backgroundColor,
      target: border.color ? ('border' as const) : ('background' as const),
      ...(chosen.declared ? { hint: chosen.declared } : {}),
      ...(chosen.color ? { colorHint: chosen.color } : {}),
      ...(chosen.overprint ? { overprint: chosen.overprint } : {}),
    };
  });
}
