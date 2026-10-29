/**
 * The colour-cluster rules: which clusters are pictures, where they split, and what the record calls them.
 *
 * `docs/guide/images.md` §"Emoji and colour clusters (E12A)" states the set — `\p{RGI_Emoji}` under the `v` flag, which is one property rather than four hand-written rules for a single emoji, a ZWJ sequence, a flag as a pair of regional indicators and a base with a skin-tone modifier — and it states the split: one raster per emoji cluster, and every run of ordinary text held together, because the shaper's unit is the word and splitting a word into graphemes would break every ligature in it.
 *
 * The four functions checked here are the module's pure half, and they are pure precisely because `Intl.Segmenter` and `\p{RGI_Emoji}` are the platform's answers rather than a second implementation of UAX #29. The measuring and rasterising halves need a canvas and belong to the browser acceptance test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clusterKindOf, clustersOf, codePointsOf, isColorCluster, splitForRaster } from '../src/measure/emoji.ts';

test('the colour set is RGI emoji, and ordinary text is not in it', () => {
  assert.equal(isColorCluster('😀'), true);
  assert.equal(isColorCluster('👩‍👩‍👧'), true);
  assert.equal(isColorCluster('🇮🇹'), true);
  assert.equal(isColorCluster('👍🏽'), true);
  assert.equal(isColorCluster('a'), false);
  assert.equal(isColorCluster('é'), false);
  assert.equal(isColorCluster(''), false);
  // A lone regional indicator is half a flag and no picture: it is text and goes through the shaper.
  assert.equal(isColorCluster('🇮'), false);
});

test('a cluster is a grapheme cluster, offsets and all', () => {
  const clusters = clustersOf('a😀b');
  assert.deepEqual(clusters.map((c) => c.text), ['a', '😀', 'b']);
  assert.deepEqual(clusters.map((c) => [c.start, c.end]), [[0, 1], [1, 3], [3, 4]]);
  assert.deepEqual(clusters.map((c) => c.emoji), [false, true, false]);
  // A ZWJ family is ONE cluster of eight code units, not three emoji.
  const family = clustersOf('👩‍👩‍👧');
  assert.equal(family.length, 1);
  assert.equal(family[0].end, '👩‍👩‍👧'.length);
});

test('splitForRaster keeps words whole and gives every emoji its own picture', () => {
  const parts = splitForRaster('Hello 😀😀 world');
  assert.deepEqual(parts.map((p) => [p.text, p.emoji]), [
    ['Hello ', false],
    ['😀', true],
    ['😀', true],
    [' world', false],
  ]);
  // The offsets address the original string, so the caller's Range can be asked about them.
  assert.deepEqual(parts.map((p) => [p.start, p.end]), [[0, 6], [6, 8], [8, 10], [10, 16]]);
  assert.equal(parts[3].text, ' world');
});

test('splitForRaster carries the offset it was given', () => {
  const parts = splitForRaster('a😀', 100);
  assert.deepEqual(parts.map((p) => [p.start, p.end]), [[100, 101], [101, 103]]);
});

test('a run with no emoji in it is one part, and an empty run is none', () => {
  assert.deepEqual(splitForRaster('plain text').map((p) => p.text), ['plain text']);
  assert.deepEqual(splitForRaster(''), []);
});

test('codePointsOf spells a cluster the way the record reads it', () => {
  assert.deepEqual(codePointsOf('😀'), ['U+1F600']);
  assert.deepEqual(codePointsOf('🇮🇹'), ['U+1F1EE', 'U+1F1F9']);
  assert.deepEqual(codePointsOf('👍🏽'), ['U+1F44D', 'U+1F3FD']);
  assert.deepEqual(codePointsOf('a'), ['U+0061']);
});

test('clusterKindOf names the four shapes off the code points, not off a lookup', () => {
  assert.equal(clusterKindOf('🇮🇹'), 'flag (regional indicators)');
  assert.equal(clusterKindOf('👩‍👩‍👧'), 'ZWJ sequence');
  assert.equal(clusterKindOf('👍🏽'), 'skin-tone modifier sequence');
  assert.equal(clusterKindOf('❤️'), 'emoji presentation selector');
  assert.equal(clusterKindOf('😀'), 'single emoji');
});
