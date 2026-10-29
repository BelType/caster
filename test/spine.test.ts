/**
 * The spine's pure readers, none of which any suite imported before: the coordinate hub's matrix algebra, the page geometry's bleed and trim arithmetic, the frame's page lookup, the gateway's magic-byte table, the variable-font instance map, the one-export-at-a-time lock, and the Blink test.
 *
 * Every one of these runs in node with no browser, and the reason to have them here rather than only inside the acceptance is that the acceptance prints ONE document: a rule these modules get wrong on a shape the specimen does not have is invisible there and obvious here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { invert, isIdentityMatrix, pixelsToPage, toPdfMatrix } from '../src/coordinates/ctm.ts';
import { DEFAULT_GEOMETRY, NOMINAL_SIZES, clearPageGeometry, geometryOfPage, pageGeometryFor, setPageGeometry } from '../src/coordinates/pageGeometry.ts';
import { sniffMimeType, backgroundUrlOf } from '../src/host/gateway.ts';
import { coordsKey, instanceCoords, instanceKeyOf, obliqueAngle, parseVariationSettings } from '../src/fonts/axisMap.ts';
import { isBlink, isPrinting, lock } from '../src/precheck.ts';
import { CasterError } from '../src/errors.ts';

test('a matrix inverts, and the identity is recognised as one', () => {
  assert.ok(isIdentityMatrix([1, 0, 0, 1, 0, 0]));
  assert.ok(!isIdentityMatrix([1, 0, 0, 1, 0, 0.0001]));
  // A translate-then-scale, undone.
  const m = ([2, 0, 0, 3, 10, 20] as [number, number, number, number, number, number]);
  const back = invert(m);
  assert.deepEqual(back.map((v) => Math.round(v * 1e6) / 1e6 + 0), [0.5, 0, 0, 1 / 3, -5, -20 / 3].map((v) => Math.round(v * 1e6) / 1e6));
  // A singular matrix has no inverse and refuses rather than answering with infinities.
  assert.throws(() => invert([0, 0, 0, 0, 0, 0]), CasterError);
});

test('pixels reach page points through a flip, and a chain composes with it', () => {
  const geometry = { ...DEFAULT_GEOMETRY, widthPt: 595.276, heightPt: 841.89, marginPt: 0 };
  const toPage = pixelsToPage(geometry);
  // 0.75 pt per px, y measured DOWN from the page's top and up from its bottom in the file.
  assert.equal(toPage[0], 0.75);
  assert.equal(toPage[3], -0.75);
  assert.equal(toPage[5], 841.89);
  // The identity chain leaves the page matrix alone.
  const same = toPdfMatrix([1, 0, 0, 1, 0, 0], geometry);
  assert.deepEqual(same, [1, 0, 0, 1, 0, 0]);
});

test('a page geometry reads its bleed and trim in points, and refuses a size it does not know', () => {
  /** A frame page with just what `geometryOfPage` reads. */
  const framePage = (w: number, h: number) => ({ element: null, widthPx: w, heightPx: h, nominal: '' } as any);
  /** A computed-style stand-in for the two registered lengths. */
  const style = (bleed: string, inset: string) => ({ getPropertyValue: ( name: string) => (name === '--pdf-bleed' ? bleed : name === '--pdf-trim-inset' ? inset : '') } as any);

  const plain = geometryOfPage(framePage(793.701, 1121.52), undefined, { widthPt: 595.276, heightPt: 841.89, style: style('0px', '0px') });
  assert.equal(plain.widthPt, 595.276);
  assert.equal(plain.trimPt, undefined);
  assert.equal(plain.bleedPt, undefined);

  // The guide's own frozen number: 6mm arrives from a registered `<length>` as 22.6772px, which is 17.008 pt.
  const trimmed = geometryOfPage(framePage(793.701, 1121.52), undefined, { widthPt: 595.276, heightPt: 841.89, style: style('11.3386px', '22.6772px') });
  assert.ok(trimmed.trimPt, 'a trim inset produces a TrimBox');
  assert.ok(Math.abs((trimmed.trimPt as number[])[0] - 17.008) < 0.01, `the inset is 6mm in points: ${trimmed.trimPt}`);
  assert.ok(trimmed.bleedPt, 'and a bleed produces a BleedBox');

  // A named size the table does not carry refuses rather than guessing A4.
  assert.throws(() => geometryOfPage({ ...framePage(100, 100), nominal: 'B7' }, undefined, { style: style('0px', '0px') }), CasterError);
  assert.ok(NOMINAL_SIZES.a4, 'the table names a4, lower-cased the way `data-pdf-size` spells it');
});

test('the installed geometry is what every coordinate converts through, and it clears', () => {
  clearPageGeometry();
  assert.equal(pageGeometryFor(0), DEFAULT_GEOMETRY, 'with none installed the default answers');
  const one = { ...DEFAULT_GEOMETRY, widthPt: 100 };
  setPageGeometry([one]);
  assert.equal(pageGeometryFor(0), one);
  // A page past the end takes the last one rather than throwing: a mark or a margin box may be asked for beyond the strip.
  assert.equal(pageGeometryFor(9), one);
  clearPageGeometry();
});

test('the mime table sniffs by magic bytes and refuses what it cannot name', () => {
  assert.equal(sniffMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), 'image/png');
  assert.equal(sniffMimeType(new TextEncoder().encode('GIF89a…')), 'image/gif');
  // Not a guess: an unknown header is an error, because a wrong guess is a stream declaring a filter the bytes do not use.
  assert.throws(() => sniffMimeType(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])), CasterError);
});

test('a background url() is read off the computed style, and `none` is not one', () => {
  const style = ( value: string) => ({ backgroundImage: value, getPropertyValue: () => '' } as any);
  assert.equal(backgroundUrlOf(style('url("a/b.png")')), 'a/b.png');
  assert.equal(backgroundUrlOf(style('none')), null);
  assert.equal(backgroundUrlOf(style('linear-gradient(red, blue)')), null);
});

test('a variable instance takes the axes the face has and clamps to their ranges', () => {
  const style = (declarations: Record<string,string>) => ({
    fontWeight: declarations.fontWeight ?? '400',
    fontStretch: declarations.fontStretch ?? '100%',
    fontStyle: declarations.fontStyle ?? 'normal',
    fontSize: declarations.fontSize ?? '16px',
    getPropertyValue: ( name: string) => declarations[name] ?? '',
  } as any);
  // A static face answers with no coordinates at all, which is what keeps every static instance key what it was.
  assert.deepEqual(instanceCoords(style({}), {}), {});

  const axes = { wght: { min: 100, default: 400, max: 900 }, opsz: { min: 8, default: 14, max: 144 } };
  assert.deepEqual(instanceCoords(style({ fontWeight: '700', fontSize: '11px' }), axes), { wght: 700, opsz: 11 });
  // Out of range clamps to the face's own limits rather than asking the shaper for an instance that does not exist.
  assert.deepEqual(instanceCoords(style({ fontWeight: '1000', fontSize: '4px' }), axes), { wght: 900, opsz: 8 });
  // `font-optical-sizing: none` is the author saying to leave the axis at its default.
  assert.deepEqual(instanceCoords(style({ fontWeight: '400', fontSize: '48px', 'font-optical-sizing': 'none' }), axes), { wght: 400, opsz: 14 });
  // An explicit `font-variation-settings` wins over the mapping, and an axis the face does not have is ignored.
  assert.deepEqual(instanceCoords(style({ 'font-variation-settings': '"wght" 250, "GRAD" 90' }), axes), { wght: 250, opsz: 16 });

  assert.equal(obliqueAngle('oblique 14deg'), 14);
  assert.equal(obliqueAngle('italic'), null);
  assert.deepEqual(parseVariationSettings('"wght" 650, "opsz" 14'), { wght: 650, opsz: 14 });
  // The key is tag-sorted so two runs at the same instance share one subset.
  assert.equal(coordsKey({ opsz: 14, wght: 650 }), 'opsz=14,wght=650');
  assert.equal(instanceKeyOf('Face#1', {}), instanceKeyOf('Face#1', {}));
  assert.notEqual(instanceKeyOf('Face#1', { wght: 700 }), instanceKeyOf('Face#1', { wght: 400 }));
});

test('one export at a time, and the lock releases once', () => {
  assert.equal(isPrinting(), false);
  const release = lock();
  assert.equal(isPrinting(), true);
  // A second export while one is running would share the module-scope frame and the page geometry, which is exactly what P4 says the lock is for.
  assert.throws(() => lock(), CasterError);
  release();
  assert.equal(isPrinting(), false);
  // Releasing twice is harmless: the `finally` that calls it may run after the caller already did.
  release();
  assert.equal(isPrinting(), false);
});

test('a Blink realm is told by four capabilities, and the branded browser\'s `chrome` global is not one of them', () => {
  // Playwright's headless shell is the same Blink of the same build with no `chrome` global (measured 2026-10-29, the Press round); the full binary has one. Both pass, and a realm short of any of the four does not.
  const blink = () => ({ CSS: { registerProperty() {} }, Range: { prototype: { getClientRects() {} } }, OffscreenCanvas: function OffscreenCanvas() {}, webkitRequestFileSystem() {} } as any);
  assert.ok(isBlink(blink()), 'the headless shell: no `chrome`');
  assert.ok(isBlink({ ...blink(), chrome: {} }), 'the full binary');
  assert.ok(!isBlink({ ...blink(), webkitRequestFileSystem: undefined }), 'no `webkitRequestFileSystem`: not Blink');
  const noRegister = blink();
  delete noRegister.CSS.registerProperty;
  assert.ok(!isBlink(noRegister));
  assert.ok(!isBlink({ ...blink(), OffscreenCanvas: undefined }));
  const noRects = blink();
  delete noRects.Range.prototype.getClientRects;
  assert.ok(!isBlink(noRects), 'no `Range.getClientRects`: not Blink');
});
