/**
 * `measure/measure.js` — the smoke measurement: a container's paragraphs as lines with origins, which is the shape the very first checker read.
 *
 * Ported from `harness/src/export/measure.ts` (E0). Guide: `docs/guide/verification.md`.
 *
 * WHAT THE PORT CHANGED (D7). `sidecarVersion` and `fixture` are gone with the sidecar's fixture-only fields; what is left is `{ page, elements }`, which is exactly the two keys of the report this fills in.
 *
 * @packageDocumentation
 */
import { CasterError } from '../errors.ts';

import type { ReportElement } from '../report.ts';

/** CSS px to PDF pt. 96 px/in vs 72 pt/in. */
const PX_TO_PT = 0.75;
/** Round to three decimals. */
const round = (n: number) => Math.round(n * 1000) / 1000;
/**
 * Descent below the baseline, in px, for the given font at the given px size.
 *
 * @remarks
 * Measured off an offscreen canvas so it reflects the real loaded face rather than a guess from font metrics tables.
 *
 * @throws {CasterError} The canvas has no 2d context, or its metrics carry no `fontBoundingBoxDescent`.
 */
function measureDescentPx(fontFamily: string, fontSizePx: number, sample: string): number {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx)
        throw new CasterError('caster: 2d canvas context unavailable');
    ctx.font = `${fontSizePx}px ${fontFamily}`;
    const m = ctx.measureText(sample);
    const descent = m.fontBoundingBoxDescent;
    if (typeof descent !== 'number' || Number.isNaN(descent)) {
        throw new CasterError('caster: fontBoundingBoxDescent unavailable');
    }
    return descent;
}
/**
 * Turn the rendered container into the measurement sidecar.
 *
 * @remarks
 * The exporter never reads expectations from the fixture; it only reports what the browser laid out.
 *
 * @throws {CasterError} A paragraph has no client rects, or the descent cannot be measured.
 */
export function measure(container: HTMLElement, fontFamily: string, postScriptName: string): { page: { widthPt: number; heightPt: number; }; elements: ReportElement[]; } {
    const containerRect = container.getBoundingClientRect();
    const pageWidthPt = round(containerRect.width * PX_TO_PT);
    const pageHeightPt = round(containerRect.height * PX_TO_PT);
    const elements: ReportElement[] = [];
    const paragraphs = Array.from(container.querySelectorAll('p'));
    paragraphs.forEach((p, index) => {
        const style = getComputedStyle(p);
        const fontSizePx = parseFloat(style.fontSize);
        const text = p.textContent ?? '';
        const range = document.createRange();
        range.selectNodeContents(p);
        const rects = Array.from(range.getClientRects());
        if (rects.length === 0)
            throw new CasterError(`caster: no client rects for paragraph ${index}`);
        const descentPx = measureDescentPx(fontFamily, fontSizePx, text);
        const lines = rects.map((rect) => {
            const xPt = round((rect.left - containerRect.left) * PX_TO_PT);
            // Baseline sits descent above the bottom of the line box, then y is flipped so the sidecar speaks PDF's bottom-left origin.
            const baselineFromTopPx = rect.bottom - containerRect.top - descentPx;
            const baselinePt = round(pageHeightPt - baselineFromTopPx * PX_TO_PT);
            return {
                originPt: ([xPt, baselinePt] as [number, number]),
                widthPt: round(rect.width * PX_TO_PT),
                baselinePt,
                font: postScriptName,
                sizePt: round(fontSizePx * PX_TO_PT),
            };
        });
        elements.push({
            path: `body>p[${index}]`,
            tag: p.tagName,
            text,
            lines,
        });
    });
    return {
        page: { widthPt: pageWidthPt, heightPt: pageHeightPt },
        elements,
    };
}
