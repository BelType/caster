/**
 * The two committed ICC profiles, checked as bytes and read through the exporter's own header readers.
 *
 * `scripts/profiles.sh` is their provenance and `profiles/README.md` states what each is for; this suite is the half of that which `npm test` runs, so a profile that is swapped, truncated or re-fetched from a moved upstream fails here rather than in a RIP. The sums are the script's, verbatim, and the fields are the three `colorResources.js` refuses on: PDF/A-4 6.2.3 t1 wants a `prtr` or `mntr` device class on the destination profile, `/OutputIntents` wants CMYK, `/DefaultRGB` wants RGB, and ICC v2 is what the whole arrangement was measured against.
 *
 * Reading them through `iccDeviceClass`/`iccColorSpace`/`iccVersion` rather than off raw offsets is deliberate: it ties the committed bytes to the code that will refuse them, so the day a reader is rewritten this suite is what says whether the profiles still pass it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { iccColorSpace, iccDeviceClass, iccVersion } from '../src/colour/colorResources.ts';

const profile = ( name: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`../profiles/${name}`, import.meta.url))));
const sha256 = ( bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('the profiles are the bytes scripts/profiles.sh pinned', () => {
  assert.equal(sha256(profile('default_cmyk.icc')), '8472fa1493a024b800b67dee9424835ec0c41ab79490200ae8ec4a689fd1b9a9');
  assert.equal(sha256(profile('srgb.icc')), 'eddaf344b5edea13269e0d20055f335610e5e0b6e33e6e536f2701bc18c5f7d5');
  assert.equal(profile('default_cmyk.icc').byteLength, 187484);
  assert.equal(profile('srgb.icc').byteLength, 2576);
});

test('the CMYK profile is what PDF/A-4 6.2.3 t1 asks of a destination profile', () => {
  const bytes = profile('default_cmyk.icc');
  assert.equal(iccDeviceClass(bytes), 'prtr');
  assert.equal(iccColorSpace(bytes), 'CMYK');
  assert.equal(iccVersion(bytes), '2.1.0');
});

test('the sRGB profile is an RGB profile, v2, for every page’s /DefaultRGB', () => {
  const bytes = profile('srgb.icc');
  // `mntr` is the other class 6.2.3 t1 accepts, which is what a display profile is.
  assert.equal(iccDeviceClass(bytes), 'mntr');
  // Four bytes, space-padded: the signature is `RGB `, never `RGB`.
  assert.equal(iccColorSpace(bytes), 'RGB ');
  assert.equal(iccVersion(bytes), '2.1.0');
});

test('a profile’s declared size is its own first four bytes, so neither file is truncated', () => {
  for (const name of ['default_cmyk.icc', 'srgb.icc']) {
    const bytes = profile(name);
    const declared = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
    assert.equal(declared, bytes.byteLength, `${name}: the ICC header's size field and the file's own length disagree`);
    // `acsp`, the profile file signature, at offset 36.
    assert.equal(String.fromCharCode(...bytes.subarray(36, 40)), 'acsp');
  }
});
