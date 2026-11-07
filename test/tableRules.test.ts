/**
 * A collapsed table Cicero divided across pages draws its rules where the presented pages draw them: once each, at their place.
 *
 * @remarks
 * Cicero presents a divided table as clones, one real `<table>` per page, each laid out by Blink on its own, so each page's grid is that clone's own collapsed grid. The oracle is the presented page: its screenshot and the file rendered by mupdf at the same scale, read for the long grey lines each holds, across and down. Measured 2026-11-07 on `fixtures/cast-divided-row/` before the fix: every rule on pages 2 and 3 drawn twice, a device pixel or two apart, because the clones' cells reached the per-cell route and each painted its own four sides.
 *
 * @packageDocumentation
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mupdf from 'mupdf';
import { castDocument, geometryInPage, screenshots } from './cast-checks.ts';

/** The rules of a picture along one axis: each run of rows (or columns) more than `share` of whose pixels are a rule's grey, as its ink-weighted centre in device pixels. */
function rules(pixmap: mupdf.Pixmap, axis: 'rows' | 'columns', share: number): number[] {
  const [w, h, n, s] = [pixmap.getWidth(), pixmap.getHeight(), pixmap.getNumberOfComponents(), pixmap.getPixels()];
  const [lines, along] = axis === 'rows' ? [h, w] : [w, h];
  const weights: number[] = [];
  // The outermost device pixels are the page box's own edge in the screenshot, not ink.
  for (let a = 0; a < lines; a++) {
    if (a < 3 || a > lines - 4) { weights.push(0); continue; }
    let count = 0, ink = 0, sum = 0;
    for (let b = 0; b < along; b++) {
      const o = ((axis === 'rows' ? a * w + b : b * w + a)) * n;
      const l = (s[o]! + s[o + 1]! + s[o + 2]!) / 3;
      if (l < 235) { count++; sum += l; ink += 255 - l; }
    }
    // A rule is grey; a line of text is dark, so its mean tells it apart.
    weights.push(count > along * share && sum / count > 100 ? ink : 0);
  }
  const centres: number[] = [];
  for (let a = 0; a < lines; a++) {
    if (!weights[a]) continue;
    let [mass, moment] = [0, 0];
    for (; a < lines && weights[a]; a++) { mass += weights[a]!; moment += weights[a]! * a; }
    centres.push(moment / mass);
  }
  return centres;
}

/** Page 1 holds the table's head copy, its header row straddling the cut: the page clips it at the flow's foot and shows the top rule and the stubs of the column rules, and the file draws the whole row below the cut, its words included. R5 is a wholly-outside test (*R5's head is the page box and its foot is the cut*, DESIGN.md S69), and a clip that cuts a box in two is the geometric clip on the placement S69 leaves open; it is the text's as much as the rules', so it is not drawn here. */
const STRADDLES = 'the head copy\'s header row straddles the cut on page 1, and the file draws it whole below the cut (DESIGN.md S69\'s open geometric clip)';

test('a divided collapsed table draws each rule once, where the presented page draws it', { timeout: 300000 }, async (t) => {
  const cast = await castDocument({ name: 'cast-divided-row/index.html', inspect: { cut: async (page) => ({ shots: await screenshots(page, (await page.evaluate(geometryInPage, [])).boxes) }) } });
  const doc = mupdf.Document.openDocument(new Uint8Array(cast.bytes), 'application/pdf');
  const shots = cast.inspected.cut.shots as { png: Buffer }[];
  assert.equal(doc.countPages(), shots.length);
  let compared = 0;
  for (let k = 0; k < shots.length; k++) {
    const shown = new mupdf.Image(shots[k]!.png).toPixmap().convertToColorSpace(mupdf.ColorSpace.DeviceRGB);
    const drawn = doc.loadPage(k).toPixmap(mupdf.Matrix.scale(2 * 96 / 72, 2 * 96 / 72), mupdf.ColorSpace.DeviceRGB, false);
    await t.test(`page ${k + 1}`, { todo: k === 0 ? STRADDLES : false }, () => {
      for (const [axis, share] of [['rows', 0.4], ['columns', 0.5]] as const) {
        const [want, got] = [rules(shown, axis, share), rules(drawn, axis, share)];
        const at = `page ${k + 1}, ${axis}: the page draws rules at ${want.map((c) => c.toFixed(1))} and the file at ${got.map((c) => c.toFixed(1))}`;
        assert.equal(got.length, want.length, at);
        want.forEach((c, i) => assert.ok(Math.abs(c - got[i]!) <= 1.5, at));
        if (k > 0) compared += want.length;
      }
    });
  }
  assert.ok(compared >= 10, `the control: the pages draw the table's rules (${compared} compared)`);
});
