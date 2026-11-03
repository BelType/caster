/**
 * The pure half of the image stage: the passthrough table decided from headers alone, and the opaque-photo rule's four gates.
 *
 * Everything here runs in node with no browser, because the claim it checks is exactly that the decision needs no decoder — `parsePng` and `parseJpeg` read markers and chunks, `canPassThroughIdat` is three predicates over what they found, and `photoVerdict` is arithmetic over samples. What is NOT here is every claim that needs a rasteriser: the canvas decoder's losses, the JPEG re-encode's PSNR, the placement of a real element. Those are the browser acceptance test's (`docs/guide/images.md` §"Acceptance checks to port").
 *
 * The fixtures are `test/assets/`, copied from the experiments with their provenance; the numbers the gates are pinned at are the guide's frozen ones — `250 000` px, ratio `0.3`, run `64`, quality `0.85`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { canPassThroughIdat, colourKeyMask, parsePng, PngColorType } from '../src/images/png.ts';
import { unpackSubByte } from '../src/images/png.ts';
import { borderRadii, fitRect } from '../src/images/imagePlace.ts';
import { jpegColorSpaceName, parseJpeg, subsamplingOf } from '../src/images/jpeg.ts';
import {
  PHOTO_PIXEL_THRESHOLD,
  PHOTO_PSNR_TARGET,
  PHOTO_QUALITIES,
  PHOTO_RUN_THRESHOLD,
  PHOTO_UNIQUE_RATIO_THRESHOLD,
  photoVerdict,
  psnr,
} from '../src/images/photoRule.ts';
import type { PhotoVerdict } from '../src/images/photoRule.ts';

const asset = (name: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`./assets/${name}`, import.meta.url))));

test('parsePng reads the IHDR, the ancillary chunks and the IDAT extent', () => {
  const rgb = parsePng(asset('rgb.png'));
  assert.equal(rgb.width, 240);
  assert.equal(rgb.height, 160);
  assert.equal(rgb.bitDepth, 8);
  assert.equal(rgb.colorType, PngColorType.Rgb);
  assert.equal(rgb.channels, 3);
  assert.equal(rgb.interlace, 0);
  assert.equal(rgb.hasAlphaChannel, false);
  assert.ok(rgb.iccpDeflated && rgb.iccpDeflated.length > 0, 'rgb.png carries an iCCP profile');
  assert.ok(rgb.idat.length > 0);
  assert.ok(rgb.chunks.includes('IHDR') && rgb.chunks.includes('IDAT') && rgb.chunks.includes('IEND'));

  const gray = parsePng(asset('gray.png'));
  assert.equal(gray.colorType, PngColorType.Gray);
  assert.equal(gray.channels, 1);
  // A gAMA with no iCCP and no sRGB is recorded and deliberately not acted on; Chromium ignores it too.
  assert.notEqual(gray.gama, null);
  assert.equal(gray.iccpDeflated, null);
  assert.equal(gray.srgbIntent, null);

  const sixteen = parsePng(asset('rgb16.png'));
  assert.equal(sixteen.bitDepth, 16);
  assert.equal(sixteen.colorType, PngColorType.Rgb);

  const palette = parsePng(asset('palette-trns.png'));
  assert.equal(palette.colorType, PngColorType.Palette);
  assert.equal(palette.channels, 1);
  assert.ok(palette.palette && palette.palette.length % 3 === 0);
  assert.ok(palette.trns && palette.trns.length > 0);

  const interlaced = parsePng(asset('interlaced.png'));
  assert.equal(interlaced.interlace, 1);
});

test('canPassThroughIdat is the whole passthrough decision for a PNG', () => {
  // Everything else — gray, RGB, palette, 8-bit or 16-bit — passes through: the IDAT *is* the /FlateDecode stream under /Predictor 15.
  for (const name of ['rgb.png', 'gray.png', 'rgb16.png', 'logo.png', 'tile.png']) {
    assert.equal(canPassThroughIdat(parsePng(asset(name))), true, `${name} passes through`);
  }
  // Three things stop it, and only three.
  assert.equal(canPassThroughIdat(parsePng(asset('interlaced.png'))), false, 'Adam7 forces a decode');
  assert.equal(canPassThroughIdat(parsePng(asset('palette-trns.png'))), false, 'a palette with tRNS forces a decode');
  assert.equal(canPassThroughIdat({ ...parsePng(asset('rgb.png')), hasAlphaChannel: true }), false, 'an alpha channel forces a decode');
});

test('parseJpeg reads the frame, the component count, APP14, APP1 and APP2', () => {
  const baseline = parseJpeg(asset('baseline.jpg'));
  assert.equal(baseline.width, 240);
  assert.equal(baseline.height, 160);
  assert.equal(baseline.components, 3);
  assert.equal(baseline.precision, 8);
  assert.equal(baseline.sofMarker, 0xc0);
  assert.equal(baseline.progressive, false);
  assert.equal(baseline.arithmetic, false);
  assert.equal(baseline.unsupportedFrame, false);
  assert.equal(baseline.exifOrientation, 1);
  assert.equal(baseline.adobe, false);
  assert.equal(baseline.iccProfile, null);

  const progressive = parseJpeg(asset('progressive.jpg'));
  assert.equal(progressive.sofMarker, 0xc2);
  assert.equal(progressive.progressive, true);
  assert.equal(progressive.unsupportedFrame, false, 'the scan structure is the reader’s business');

  // Four components plus an APP14 Adobe marker is the entire signal that the samples are inverted, and /Decode is the entire remedy.
  const cmyk = parseJpeg(asset('cmyk.jpg'));
  assert.equal(cmyk.components, 4);
  assert.equal(cmyk.adobe, true);
  assert.equal(jpegColorSpaceName(cmyk.components), 'DeviceCMYK');

  // The orientation is folded into the placement matrix, never into the pixels; stored 160x240 displays as 240x160.
  const exif = parseJpeg(asset('exif6.jpg'));
  assert.equal(exif.exifOrientation, 6);
  assert.equal(exif.width, 160);
  assert.equal(exif.height, 240);

  const p3 = parseJpeg(asset('p3.jpg'));
  assert.ok(p3.iccProfile && p3.iccProfile.length > 0, 'the APP2 profile is reassembled');
  assert.equal(p3.components, 3);

  // Chromium has no arithmetic decoder, so there is no canvas route and the entropy-coded data goes to /DCTDecode unread.
  const arith = parseJpeg(asset('arith.jpg'));
  assert.equal(arith.arithmetic, true);
  assert.equal(arith.sofMarker, 0xc9);
  assert.equal(arith.unsupportedFrame, false);
});

test('jpegColorSpaceName is the SOF component count, and refuses anything else', () => {
  assert.equal(jpegColorSpaceName(1), 'DeviceGray');
  assert.equal(jpegColorSpaceName(3), 'DeviceRGB');
  assert.equal(jpegColorSpaceName(4), 'DeviceCMYK');
  assert.throws(() => jpegColorSpaceName(2), /2 components has no PDF colour space/);
});

test('subsamplingOf reads the frame’s sampling factors', () => {
  assert.equal(subsamplingOf(({ samplingFactors: [] } as any)), 'unknown');
  assert.equal(subsamplingOf(({ samplingFactors: [[1, 1]] } as any)), 'grayscale');
  assert.equal(subsamplingOf(({ samplingFactors: [[1, 1], [1, 1], [1, 1]] } as any)), '4:4:4');
  assert.equal(subsamplingOf(({ samplingFactors: [[2, 2], [1, 1], [1, 1]] } as any)), '4:2:0');
  assert.equal(subsamplingOf(({ samplingFactors: [[2, 1], [1, 1], [1, 1]] } as any)), '4:2:2');
  assert.equal(subsamplingOf(({ samplingFactors: [[1, 2], [1, 1], [1, 1]] } as any)), '4:4:0');
  assert.equal(subsamplingOf(({ samplingFactors: [[3, 1], [1, 1], [2, 2]] } as any)), '3x1 1x1 2x2');
  // The browser's own encoder is 4:2:0 at every quality, which is a thing to measure rather than to look up; this is the reader that measures it.
  assert.equal(subsamplingOf(parseJpeg(asset('baseline.jpg'))), '4:2:0');
});

test('the photo rule’s thresholds are the guide’s frozen four', () => {
  assert.equal(PHOTO_PIXEL_THRESHOLD, 250_000);
  assert.equal(PHOTO_UNIQUE_RATIO_THRESHOLD, 0.3);
  assert.equal(PHOTO_RUN_THRESHOLD, 64);
  assert.deepEqual([...PHOTO_QUALITIES], [0.85, 0.9, 0.95]);
  assert.equal(PHOTO_PSNR_TARGET, 40);
});

/** A photograph, in the only sense the rule has: mostly distinct pixels and no long identical run. */
function noise(width: number, height: number): Uint8Array {
  const rgb = new Uint8Array(width * height * 3);
  let a = 0x1234abcd >>> 0;
  for (let i = 0; i < rgb.length; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    rgb[i] = (t ^ (t >>> 14)) & 0xff;
  }
  return rgb;
}

/** A screenshot, in the only sense the rule has: flat bands of colour, and runs the width of the image. */
function flatBands(width: number, height: number): Uint8Array {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const level = (Math.floor(y / 40) * 17) & 0xff;
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      rgb[at] = level;
      rgb[at + 1] = level;
      rgb[at + 2] = level;
    }
  }
  return rgb;
}

test('the four gates, each refused on its own', () => {
  const width = 700;
  const height = 500; // 350 000 px, over the threshold
  const rgb = noise(width, height);

  const photo = photoVerdict({ width, height, rgb, hasAlpha: false });
  assert.equal(photo.isPhoto, true);
  assert.equal(photo.reason, 'photographic');
  assert.equal(photo.pixels, 350_000);
  assert.ok(photo.uniqueRatio > PHOTO_UNIQUE_RATIO_THRESHOLD, `unique ratio ${photo.uniqueRatio}`);
  assert.ok(photo.longestRun <= PHOTO_RUN_THRESHOLD, `longest run ${photo.longestRun}`);

  // Gate 1: JPEG has no alpha.
  assert.deepEqual(pick(photoVerdict({ width, height, rgb, hasAlpha: true })), { isPhoto: false, reason: 'has an alpha channel' });
  // Gates 2 and 3: palettised and grayscale are excluded by kind, not by measurement.
  assert.deepEqual(pick(photoVerdict({ width, height, rgb, hasAlpha: false, palettised: true })), { isPhoto: false, reason: 'palettised' });
  assert.deepEqual(pick(photoVerdict({ width, height, rgb, hasAlpha: false, grayscale: true })), { isPhoto: false, reason: 'grayscale' });

  // Gate 4: below a quarter of a million pixels nothing is worth losing. 500 x 500 is 250 000, which the rule refuses AT the threshold.
  const small = photoVerdict({ width: 500, height: 500, rgb: noise(500, 500), hasAlpha: false });
  assert.equal(small.isPhoto, false);
  assert.match(small.reason, /^250000 pixels, at or below the 250000 threshold$/);
  assert.equal(small.uniqueRatio, 0, 'a gate that closes before the measurement reports no measurement');
});

test('a screenshot is refused on the unique-colour ratio, and would have been on the run test too', () => {
  const width = 900;
  const height = 600;
  const verdict = photoVerdict({ width, height, rgb: flatBands(width, height), hasAlpha: false });
  assert.equal(verdict.isPhoto, false);
  assert.match(verdict.reason, /^unique-colour ratio /);
  assert.ok(verdict.uniqueRatio <= PHOTO_UNIQUE_RATIO_THRESHOLD, `ratio ${verdict.uniqueRatio}`);
  // The run test is measured even when the ratio refuses first, and on flat bands it is the width of the image.
  assert.equal(verdict.longestRun, width);
});

test('a long identical run refuses an image whose colours are otherwise distinct', () => {
  const width = 700;
  const height = 500;
  const rgb = noise(width, height);
  // Paint one flat band across every row: a run of 200 is above the threshold of 64, and the ratio stays high because the rest is noise.
  for (let y = 0; y < height; y++) {
    for (let x = 100; x < 300; x++) {
      const at = (y * width + x) * 3;
      rgb[at] = 200;
      rgb[at + 1] = 200;
      rgb[at + 2] = 200;
    }
  }
  const verdict = photoVerdict({ width, height, rgb, hasAlpha: false });
  assert.equal(verdict.isPhoto, false);
  assert.match(verdict.reason, /^an identical-pixel run of \d+, above 64$/);
  assert.ok(verdict.longestRun > PHOTO_RUN_THRESHOLD);
  assert.ok(verdict.uniqueRatio > PHOTO_UNIQUE_RATIO_THRESHOLD, 'the ratio gate was not what refused it');
});

test('the sampler is seeded, so two runs of the heuristic reach the same verdict', () => {
  const rgb = noise(600, 500);
  const first = photoVerdict({ width: 600, height: 500, rgb, hasAlpha: false });
  const second = photoVerdict({ width: 600, height: 500, rgb, hasAlpha: false });
  assert.deepEqual(first, second);
});

test('psnr is infinite on an exact match and refuses planes of different sizes', () => {
  const a = noise(40, 40);
  assert.equal(psnr(a, a), Number.POSITIVE_INFINITY);
  const b = a.slice();
  b[0] = b[0] ^ 0xff;
  assert.ok(Number.isFinite(psnr(a, b)) && psnr(a, b) > 40);
  assert.throws(() => psnr(a, a.subarray(0, 10)), /4800 samples against 10/);
});

test('an XMP APP1 after the Exif one does not overwrite the orientation', () => {
  // Photoshop, Lightroom and most cameras write the XMP packet as a SECOND APP1, after the Exif segment. Every APP1 was being read as Exif, so the last of them decided and the file came back as orientation 1 — the picture printed sideways with nothing in the report to say so.
  const original = asset('exif6.jpg');
  const identifier = 'http://ns.adobe.com/xap/1.0/\0';
  const packet = new TextEncoder().encode(`${identifier}<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>`);
  const segment = new Uint8Array(4 + packet.length);
  segment[0] = 0xff; segment[1] = 0xe1;
  segment[2] = ((packet.length + 2) >> 8) & 0xff;
  segment[3] = (packet.length + 2) & 0xff;
  segment.set(packet, 4);
  // Spliced in right after the SOI, which is where a writer that appends a packet puts it: before the Exif segment it would win on file order, after it, on read order. Either way the guard is what decides.
  const spliced = new Uint8Array(original.length + segment.length);
  spliced.set(original.subarray(0, 2), 0);
  spliced.set(segment, 2);
  spliced.set(original.subarray(2), 2 + segment.length);
  const info = parseJpeg(spliced);
  assert.equal(info.exifOrientation, 6);
  assert.equal(info.width, 160);
});

test('a Gray or RGB tRNS becomes a /Mask colour key, and a palette tRNS does not', () => {
  // The chunk names one fully transparent sample value rather than an alpha plane, and PDF says the same thing with min/max pairs. Dropped, every transparent pixel printed opaque.
  assert.deepEqual(colourKeyMask({ ...header(PngColorType.Gray), trns: new Uint8Array([0x00, 0xff]) }), [255, 255]);
  assert.deepEqual(
    colourKeyMask({ ...header(PngColorType.Rgb), trns: new Uint8Array([0, 255, 0, 0, 0, 255]) }),
    [255, 255, 0, 0, 255, 255],
  );
  assert.equal(colourKeyMask({ ...header(PngColorType.Gray), trns: null }), null);
  // A palette's tRNS is a per-entry alpha table and needs a lookup, which is why it does not pass through at all.
  assert.equal(colourKeyMask({ ...header(PngColorType.Palette), trns: new Uint8Array([0, 128, 255]) }), null);
  assert.equal(canPassThroughIdat({ ...header(PngColorType.Palette), trns: new Uint8Array([0]) }), false);
});

test('a sub-byte row unpacks to one sample per byte, padding at the end of each row', () => {
  // fast-png keeps depth < 8 packed and every byte was read as one index: the image was garbage and the tRNS SMask came out at half the length its own stream declared.
  // Three 4-bit pixels per row over two rows: each row is two bytes, and the low nibble of the second byte is padding.
  const unpacked = unpackSubByte(new Uint8Array([0x12, 0x30, 0x45, 0x60]), 4, 3, 2);
  assert.deepEqual([...unpacked], [1, 2, 3, 4, 5, 6]);
  assert.equal(unpacked.length, 3 * 2, 'one byte per pixel, which is what the SMask length is asserted against');
  // 1-bit, nine pixels: the ninth is the top bit of the row's second byte.
  assert.deepEqual([...unpackSubByte(new Uint8Array([0b10110001, 0b10000000]), 1, 9, 1)], [1, 0, 1, 1, 0, 0, 0, 1, 1]);
});

/** The IHDR half of a `PngInfo`, for the two readers that only look at it. */
function header(colorType: number) {
  return ({ width: 4, height: 4, bitDepth: 8, colorType, interlace: 0, channels: 1, hasAlphaChannel: false, palette: null, trns: null } as any);
}

function pick(verdict: PhotoVerdict) {
  return { isPhoto: verdict.isPhoto, reason: verdict.reason };
}

test('object-position reads the calc a four-value declaration computes to, and overflow is tested on all four edges', () => {
  const box = { x: 0, y: 0, w: 100, h: 100 };
  // `object-position: right 10px bottom 20px` COMPUTES to `calc(100% - 10px) calc(100% - 20px)`. Read as a plain length it gave NaN, which fell to 0 and pinned the image to the top-left corner.
  const pinned = fitRect(box, 40, 40, 'none', 'calc(100% - 10px) calc(100% - 20px)');
  assert.equal(pinned.rect.x, 50, 'x is 60% of the 60 px of free space, less ten');
  assert.equal(pinned.rect.y, 40, 'and y is the same arithmetic against the other free edge');
  assert.equal(pinned.overflows, false, 'a smaller image inside its box does not overflow it');
  // A plus is legal in the same production and reaches past the right edge, which is an overflow the left-and-top-only test could not see.
  const past = fitRect(box, 40, 40, 'none', 'calc(100% + 30px) 50%');
  assert.equal(past.rect.x, 90);
  assert.equal(past.overflows, true, 'hanging off the right edge is an overflow');
  assert.equal(fitRect(box, 40, 40, 'none', '50% calc(100% + 30px)').overflows, true, 'and so is hanging off the bottom');
  // The keywords and the plain percentage are unchanged.
  assert.deepEqual([fitRect(box, 40, 40, 'none', 'right bottom').rect.x, fitRect(box, 40, 40, 'none', 'right bottom').rect.y], [60, 60]);
});

test('a corner radius has two tokens, and the box an image is clipped to is inside the border', () => {
  const box = { x: 0, y: 0, w: 200, h: 100 };
  /**
   * @param [rest]
   */
  const style = (tl: string, rest: string = '0px') => ({
    borderTopLeftRadius: tl, borderTopRightRadius: rest, borderBottomRightRadius: rest, borderBottomLeftRadius: rest,
  } as any);
  // `border-radius: 20px / 10px` computes each corner to two tokens; only the first was read, so an elliptical corner was drawn at its horizontal radius alone.
  assert.deepEqual(borderRadii(style('20px 10px'), box), [10, 0, 0, 0]);
  // A percentage on the vertical half resolves against the box's HEIGHT, not its width.
  assert.deepEqual(borderRadii(style('50% 10%'), box), [10, 0, 0, 0]);
  // The radius is declared on the border box and the image is clipped to the content box, so the inner radius is the outer one less the border and the padding on each of the corner's two sides, floored at zero.
  assert.deepEqual(borderRadii(style('20px'), box, { top: 4, right: 4, bottom: 4, left: 6 }), [14, 0, 0, 0]);
  assert.deepEqual(borderRadii(style('3px'), box, { top: 4, right: 4, bottom: 4, left: 4 }), [0, 0, 0, 0], 'a radius smaller than the border rounds nothing');
});
