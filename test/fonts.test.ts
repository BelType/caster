/**
 * The font stage's pure readers: the `@font-face` descriptor parsers and the glyph→text map every `/ToUnicode` entry comes out of.
 *
 * Nothing here needs a browser, which is the point — each of these was wrong in a way no width assertion could see, and each is arithmetic or string work over values a CSSOM hands out.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildFontTable, localUrlsOf, parseWeightDescriptor, refuseFamily } from '../src/host/fonts.ts';
import { load } from '../src/capabilities.ts';
import { isClusterStart, segmentViews, textForGlyph } from '../src/emit/textEmit.ts';
import { decodeWoff, isWoff, isWoff2 } from '../src/fonts/woff.ts';
import { buildToUnicode } from '../src/fonts/toUnicode.ts';
import { sha256Bytes, sha256Hex, textColumns } from '../src/displayList/build.ts';
import { matchFace } from '../src/fonts/fontResolve.ts';
import { programStats, sfntEntries } from '../src/fonts/fontProgram.ts';
import { loadSubsetter, subsetFace } from '../src/fonts/hbSubset.ts';
import { CasterError, FontUnavailableError } from '../src/errors.ts';

test('a weight descriptor reads the two keywords CSS Fonts 4 allows, and refuses the two it does not', () => {
  assert.deepEqual(parseWeightDescriptor('400'), [400, 400]);
  assert.deepEqual(parseWeightDescriptor('100 900'), [100, 900]);
  // The pair that was silently filed at 400: a face declaring `bold` embedded the regular program for every bold run.
  assert.deepEqual(parseWeightDescriptor('bold'), [700, 700]);
  assert.deepEqual(parseWeightDescriptor('normal'), [400, 400]);
  assert.deepEqual(parseWeightDescriptor('normal bold'), [400, 700]);
  assert.deepEqual(parseWeightDescriptor(''), [400, 400]);
  // `bolder` and `lighter` are relative to an inherited weight, and a descriptor has none to be relative to.
  for (const keyword of ['bolder', 'lighter']) {
    assert.throws(() => parseWeightDescriptor(keyword), CasterError, `${keyword} refuses by name`);
  }
});

test('a src descriptor answers with every url() it holds, in order, with its format hint', () => {
  const base = 'https://example.test/styles/venue.css';
  const sources = localUrlsOf('url("../fonts/x.woff2") format("woff2"), url(../fonts/x.woff) format("woff"), local("X")', base);
  assert.deepEqual(sources, [
    { url: 'https://example.test/fonts/x.woff2', format: 'woff2' },
    { url: 'https://example.test/fonts/x.woff', format: 'woff' },
  ]);
  // Resolution is against the SHEET, not the document: the same descriptor read against a different base names different files.
  assert.equal(localUrlsOf('url(x.ttf)', 'https://example.test/a/b/c.css')[0].url, 'https://example.test/a/b/x.ttf');
  // No format() at all is the ordinary case and is not a reason to skip a source.
  assert.deepEqual(localUrlsOf("url('x.ttf')", base), [{ url: 'https://example.test/styles/x.ttf', format: '' }]);
  assert.deepEqual(localUrlsOf('local("Georgia")', base), []);
});

test('a family with no bytes refuses by saying where the stack came from, now that BelType ships print faces of its own', () => {
  const table = ({ descriptors: [{ family: 'Source Serif 4' }] } as any);
  assert.throws(() => refuseFamily('Georgia', 'body > p', table), ( error: any) => {
    assert.ok(error instanceof FontUnavailableError);
    // Until 2026-09-14 the addendum's stack ended in a system family and the message said so; it declares four faces now (.claude/decisions/project/print-default-faces.md), so the stack that refused came from some other sheet.
    assert.doesNotMatch(error.message, /system family/);
    assert.match(error.message, /BelType's addendum declares print faces of its own — Source Serif 4, Source Sans 3, Source Code Pro and Noto Emoji/);
    assert.match(error.message, /"Source Serif 4"/, 'it names the families the document does declare');
    return true;
  });
});

test('a face whose only readable road is a WOFF2 that did not decode says so, and never that no browser decodes one (S46)', async () => {
  const rule = { type: 5, style: { getPropertyValue: ( name: string) => ({ 'font-family': 'Probe', src: 'url("x.woff2") format("woff2")' })[name] ?? '' } };
  const doc = ({ baseURI: 'https://example.test/', styleSheets: [{ href: 'https://example.test/s.css', cssRules: [rule] }], adoptedStyleSheets: [] } as any);
  const gateway = ({ allows: () => true, getBytes: async () => ({ bytes: new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0]) }) } as any);
  const table = await buildFontTable(doc, gateway);   // the woff2 capability is not loaded here, so the decode refuses and joins the attempts
  assert.equal(table.descriptors.length, 0);
  assert.equal(table.warnings.length, 1);
  assert.doesNotMatch(table.warnings[0], /no decoder/);
  assert.match(table.warnings[0], /is declared `format\("woff2"\)`, so it is decoded only after every other source in the descriptor failed/);
  assert.match(table.warnings[0], /is a WOFF2 that could not be decoded/);
});

test('a declared face the browser never loaded is not read: the table takes `document.fonts` as its word (S88)', async () => {
  const rule = (family: string, src: string) => ({ type: 5, style: { getPropertyValue: ( name: string) => ({ 'font-family': `"${family}"`, src })[name] ?? '' } });
  await load(['fontkit']);   // `axesOf` reads the face through fontkit; the registry opens a `file:` URL in node (S17)
  const sfnt = new Uint8Array(readFileSync(new URL('../fixtures/specimen/fonts/CrimsonText-Regular.ttf', import.meta.url)));
  const fetched: string[] = [];
  const gateway = ({ allows: () => true, getBytes: async ( url: string) => { fetched.push(url); return { bytes: sfnt, url }; } } as any);
  const styleSheets = [{ href: 'https://example.test/s.css', cssRules: [rule('Painted', 'url("painted.ttf")'), rule('Declared Only', 'url("declared.ttf")')] }];
  // The browser's own record: the first face was needed by layout, the second never was.
  const fonts = [
    { family: 'Painted', weight: 'normal', style: 'normal', stretch: 'normal', unicodeRange: 'U+0-10FFFF', status: 'loaded' },
    { family: 'Declared Only', weight: 'normal', style: 'normal', stretch: 'normal', unicodeRange: 'U+0-10FFFF', status: 'unloaded' }
  ];
  const doc = ({ baseURI: 'https://example.test/', styleSheets, adoptedStyleSheets: [], fonts } as any);
  const table = await buildFontTable(doc, gateway);
  assert.deepEqual(fetched, ['https://example.test/painted.ttf'], 'only the face the browser loaded is fetched');
  assert.deepEqual(table.descriptors.map((d) => d.family), ['Painted']);
  assert.deepEqual(table.unloaded.map((d) => d.family), ['Declared Only'], 'and the one it did not is recorded, not refused');
  assert.equal(table.declared.length, 2, 'both rules were found');

  // A document that keeps no such record (no `fonts`) is read whole, as before.
  const all = await buildFontTable(({ baseURI: 'https://example.test/', styleSheets, adoptedStyleSheets: [] } as any), gateway);
  assert.equal(all.descriptors.length, 2);
  assert.equal(all.unloaded.length, 0);
});

/** A segment stub carrying only what `textForGlyph` reads. */
const run = (text: string, clusters: number[]) => ({ text, clusters, gids: clusters.map((_, i) => i + 1) } as any);

test('a glyph takes its cluster’s text, and a later member of the same cluster takes none', () => {
  // LTR, base + combining mark + base: the mark adds no characters of its own, and slicing to the next glyph's cluster gave it an empty string AND stole the base's second character.
  const marks = run('áb', [0, 1, 2]);
  assert.equal(textForGlyph(marks, 0), 'a');
  assert.equal(textForGlyph(marks, 1), '́');
  assert.equal(textForGlyph(marks, 2), 'b');

  const twoGlyphCluster = run('áb', [0, 0, 2]);
  assert.equal(textForGlyph(twoGlyphCluster, 0), 'á');
  assert.equal(textForGlyph(twoGlyphCluster, 1), '');
  assert.equal(textForGlyph(twoGlyphCluster, 2), 'b');
  assert.ok(isClusterStart(twoGlyphCluster, 0));
  assert.ok(!isClusterStart(twoGlyphCluster, 1));

  // A ligature: one glyph over three characters, and the two after it in the run carry their own.
  const ligature = run('ffice', [0, 3, 4]);
  assert.equal(textForGlyph(ligature, 0), 'ffi');
  assert.equal(textForGlyph(ligature, 1), 'c');
  assert.equal(textForGlyph(ligature, 2), 'e');

  // RTL comes back in VISUAL order, so the clusters descend. Every glyph but the first was empty before, and `toUnicode` refused the whole document blaming the font's coverage.
  const rtl = run('אבג', [2, 1, 0]);
  assert.equal(textForGlyph(rtl, 0), 'ג');
  assert.equal(textForGlyph(rtl, 1), 'ב');
  assert.equal(textForGlyph(rtl, 2), 'א');
});

// --- `fonts/woff.js` --------------------------------------------------------

const CRIMSON = fileURLToPath(new URL('../fixtures/specimen/fonts/CrimsonText-Regular.ttf', import.meta.url));
const JETBRAINS = fileURLToPath(new URL('../fixtures/specimen/fonts/JetBrainsMono-Regular.ttf', import.meta.url));

/**
 * A WOFF built around a real SFNT, so the decoder is checked against a font rather than against a shape.
 *
 * Every table is deflated with `CompressionStream`, which is the same codec `decodeWoff` inflates with; a table that comes out no smaller is stored uncompressed, which is what the format says and what exercises the decoder's other branch.
 */
async function buildWoff(sfnt: Uint8Array): Promise<Uint8Array> {
  const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const flavour = view.getUint32(0);
  const entries = sfntEntries(sfnt);
  const deflate = async (bytes: Uint8Array) => {
    const stream = new Blob([((bytes as unknown) as BlobPart)]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  const tables = [];
  for (const [index, entry] of entries.entries()) {
    const original = sfnt.subarray(entry.offset, entry.offset + entry.length);
    const packed = await deflate(original);
    const compressed = packed.length < original.length;
    // The directory's own checksum, which `sfntEntries` does not carry and which the decoder verifies every table against.
    const checksum = view.getUint32(12 + index * 16 + 4);
    tables.push({ tag: entry.tag, data: compressed ? packed : original, origLength: original.length, checksum });
  }
  const directory = 44 + tables.length * 20;
  let cursor = directory;
  const offsets = tables.map((table) => { const at = cursor; cursor += Math.ceil(table.data.length / 4) * 4; return at; });
  const out = new Uint8Array(cursor);
  const write = new DataView(out.buffer);
  write.setUint32(0, 0x774f4646);           // 'wOFF'
  write.setUint32(4, flavour);
  write.setUint32(8, cursor);
  write.setUint16(12, tables.length);
  tables.forEach((table, index) => {
    const at = 44 + index * 20;
    for (let i = 0; i < 4; i++) out[at + i] = table.tag.charCodeAt(i);
    write.setUint32(at + 4, offsets[index]);
    write.setUint32(at + 8, table.data.length);
    write.setUint32(at + 12, table.origLength);
    write.setUint32(at + 16, table.checksum);
    out.set(table.data, offsets[index]);
  });
  return out;
}

test('a WOFF decodes back to the SFNT it was built from, table for table', async () => {
  const sfnt = new Uint8Array(readFileSync(CRIMSON));
  assert.ok(!isWoff(sfnt) && !isWoff2(sfnt), 'a bare TTF is neither');
  const woff = await buildWoff(sfnt);
  assert.ok(isWoff(woff));
  assert.ok(!isWoff2(woff));
  assert.ok(woff.length < sfnt.length, `the compressed file is smaller (${woff.length} against ${sfnt.length})`);

  const decoded = await decodeWoff(woff);
  assert.equal(decoded.checksumsOk, true, 'every rebuilt table checksums to what its own directory entry claims');
  const before = new Map(sfntEntries(sfnt).map((entry) => [entry.tag, sfnt.subarray(entry.offset, entry.offset + entry.length)]));
  const after = sfntEntries(decoded.bytes);
  assert.equal(after.length, before.size, 'every table came back');
  // The output order is alphabetical by tag, which is what an SFNT directory requires and what the data order of the original never told us.
  assert.deepEqual(after.map((entry) => entry.tag), [...after.map((entry) => entry.tag)].sort());
  for (const entry of after) {
    const original = (before.get(entry.tag) as Uint8Array);
    assert.ok(original, `${entry.tag} was in the original`);
    assert.equal(entry.length, original.length, `${entry.tag} is its original length`);
    assert.deepEqual([...decoded.bytes.subarray(entry.offset, entry.offset + entry.length)], [...original], `${entry.tag} is byte for byte the original`);
  }

  // A directory whose declared original length disagrees with what the table decodes to is a refusal naming the table, never a silent short read.
  const broken = await buildWoff(sfnt);
  new DataView(broken.buffer).setUint32(44 + 12, 7);
  await assert.rejects(() => decodeWoff(broken), CasterError);
  await assert.rejects(() => decodeWoff(sfnt), CasterError, 'and bytes that are not a WOFF at all refuse by name');
});

// --- `fonts/toUnicode.js` ---------------------------------------------------

/** A measured segment stub carrying only what the map reads off it. */
let segmentIndex = 0;
const segment = (instanceKey: string, text: string, gids: number[], clusters: number[]) =>
  ({ index: segmentIndex++, instanceKey, text, gids, clusters, blockPath: 'Document/P[0]' } as any);

test('the ToUnicode map takes the majority string for an ambiguous CID, and wraps the minority in /ActualText', () => {
  // One CID used for two different strings: the ligature glyph stands for "fi" nine times and for "ﬁ" once. The CMap says what most of the document extracts as, and the odd occurrence carries a span.
  const segments = [
    ...Array.from({ length: 9 }, () => segment('crimson', 'fi', [7], [0])),
    segment('crimson', 'ﬁ', [7], [0]),
  ];
  const built = buildToUnicode(segments);
  const map = (built.byInstance.get('crimson') as any);
  assert.equal(map.text.get(7), 'fi', 'the CMap carries the majority');
  assert.equal(built.actualTextFor(segments[0], 0), null, 'a majority occurrence needs no span');
  assert.equal(built.actualTextFor(segments[9], 0), 'ﬁ', 'and the minority one names its own string');
  assert.equal(built.actualTextOccurrences, 1);
});

test('a glyph that maps to nothing refuses, and a later member of a cluster mapping to nothing does not', () => {
  // A cluster's whole text rides on its first glyph, so an empty string for a mark is what the design says and not an error.
  const mark = segment('crimson', 'á', [5, 6], [0, 0]);
  const built = buildToUnicode([mark]);
  assert.equal((built.byInstance.get('crimson') as any).text.get(5), 'á');
  assert.ok(!(built.byInstance.get('crimson') as any).text.has(6), 'the second glyph of the cluster contributes no entry');
  // `.notdef` is a glyph a reader cannot map at all, and it names the block it was painted in.
  assert.throws(() => buildToUnicode([segment('crimson', 'x', [0], [0])]), CasterError);
});

// --- the text item's columns (`displayList/build.js`, `emit/textEmit.js`) ---------

test('a text item gives its segments back: what the shaper clustered, the writer and the ToUnicode map read again', () => {
  const word = (text: string, clusters: number[], xPx: number, spaceBefore: boolean) =>
    ({ text, clusters, gids: clusters.map((_, i) => 10 + i), advanceUnits: clusters.map((_, i) => 500 + i), upem: 1024, xPx, spaceBefore, blockPath: 'Document/P[0]' } as any);
  // A base and its mark, a two-glyph cluster, a ligature, and an RTL word whose glyphs came back in visual order.
  const segments = [
    word('áb', [0, 1, 2], 0, false),
    word('áb', [0, 0, 2], 40, true),
    word('ffice', [0, 3, 4], 90, true),
    word('אבג', [2, 1, 0], 130, false),
  ];
  const run = ({ segments } as any);
  const { text, glyphs, segments: columns } = textColumns(run, true, 0);
  assert.equal(text, ' áb áb ffice' + 'אבג', 'a space first, a space between two words DOM whitespace separated, none between two it did not');
  assert.equal(glyphs.clusters.length, glyphs.ids.length, 'a cluster value to a glyph');
  const item: any = { text, glyphs, segments: columns, font: 'f' };
  const views = segmentViews(item, 1024, 'Document/P[0]');
  assert.deepEqual(views.map((v) => [v.text, v.clusters, v.gids, v.advanceUnits, v.spaceBefore]), segments.map((v) => [v.text, v.clusters, v.gids, v.advanceUnits, v.spaceBefore]));
  for (const [i, view] of views.entries()) {
    segments[i].gids.forEach(( _: number,  j: number) => {
      assert.equal(textForGlyph(view, j), textForGlyph(segments[i], j), `segment ${i}, glyph ${j}: the same text`);
      assert.equal(isClusterStart(view, j), isClusterStart(segments[i], j), `segment ${i}, glyph ${j}: the same cluster start`);
    });
  }
  // A glyph's value is where its cluster begins in the run's string: the ligature's glyph at its segment's start, the next glyph three characters on.
  const first = columns.firstGlyph[2];
  assert.deepEqual(glyphs.clusters.slice(first, first + 3), [columns.start[2], columns.start[2] + 3, columns.start[2] + 4], 'the ligature’s glyph begins at the segment, the next glyph after its three characters');
});

test('the blobs’ hash without crypto.subtle is the hash with it, at every padding boundary', async () => {
  for (const length of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 70000]) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 31 + 7) & 255);
    const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    assert.deepEqual([...sha256Bytes(bytes)], [...expected], `${length} bytes`);
  }
  assert.equal(await sha256Hex(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'the empty string’s known digest');
});

// --- `fonts/fontResolve.js` -------------------------------------------------

/**
 * @param [extra]
 */
const face = (id: string, weight: [number,number], extra: any = {}) => ({
  id, family: 'Crimson Text', url: `/${id}.ttf`, weight, style: 'normal', stretch: [100, 100], platformFamily: 'Crimson Text', ...extra,
} as any);

/**
 * @param [extra]
 */
const wants = (weight: number, extra: any = {}) => ({
  families: ['Crimson Text'], weight, style: 'normal', stretch: 100, synthesis: { weight: true, style: true }, ...extra,
} as any);

test('the weight ladder is CSS Fonts 4 §5.2, and synthesis is decided over the whole family', () => {
  const table = [face('regular', [400, 400]), face('bold', [700, 700]), face('light', [300, 300])];
  assert.equal((matchFace(table, 'Crimson Text', wants(400)) as any).face.id, 'regular');
  assert.equal((matchFace(table, 'Crimson Text', wants(700)) as any).face.id, 'bold');
  // Below 400, the ladder goes DOWN first and only then up.
  assert.equal((matchFace(table, 'Crimson Text', wants(350)) as any).face.id, 'light');
  // At 400 exactly there is no candidate below to prefer; 500 with no 500 face looks up from 400 first.
  assert.equal((matchFace(table, 'Crimson Text', wants(500)) as any).face.id, 'regular');
  // Above 500 the ladder goes up first.
  assert.equal((matchFace(table, 'Crimson Text', wants(600)) as any).face.id, 'bold');
  assert.equal(matchFace(table, 'Nothing Declared', wants(400)), undefined, 'a family with no face has no match');

  // A family whose maximum weight reaches 700 synthesises nothing at 700, even where the matched face is lighter — Blink tests the FAMILY's aggregate capabilities, not the face the match landed on.
  assert.equal((matchFace(table, 'Crimson Text', wants(900)) as any).synthesis.bold, false);
  const oneFace = [face('regular', [400, 400])];
  assert.equal((matchFace(oneFace, 'Crimson Text', wants(700)) as any).synthesis.bold, true, 'a single-weight family fakes it');
  assert.equal(
    (matchFace(oneFace, 'Crimson Text', wants(700, { synthesis: { weight: false, style: true } })) as any).synthesis.bold,
    false,
    'unless `font-synthesis` forbade it, which is what the specimen declares',
  );

  // A variable face is instanced at the request CLAMPED into its own declared range, and that axis is what reaches the shaper.
  const variable = [face('pro', [200, 900], { axes: { wght: { min: 200, default: 400, max: 900 } } })];
  assert.deepEqual((matchFace(variable, 'Crimson Text', wants(700)) as any).axes, [{ tag: 'wght', value: 700 }]);
  assert.deepEqual((matchFace(variable, 'Crimson Text', wants(1000)) as any).axes, [{ tag: 'wght', value: 900 }]);
  assert.deepEqual((matchFace([face('static', [400, 400])], 'Crimson Text', wants(400)) as any).axes, [], 'a static face names no axis');
});

// --- `fonts/fontEmbed.js`'s outline check, and the face that made it fire (M10, S45) ---

test("a face's own empty glyph is not a subset that dropped one: JetBrains Mono's ligature spacer", async () => {
  const bytes = new Uint8Array(readFileSync(JETBRAINS));
  const fontkit = (await import('fontkit') as any);
  const font = (fontkit.create ?? fontkit.default.create)(bytes);

  // What the shaper chooses. JetBrains Mono builds its arrows out of `calt`: every character but the last becomes ONE glyph, and the last one's glyph draws the whole ligature backwards over them.
  const spacers = new Set(['->', '=>', '!=', '<='].map(( text: string) => font.layout(text).glyphs[0].id));
  assert.deepEqual([...spacers], [1751], `all four ligatures open on the same glyph: ${JSON.stringify([...spacers])}`);

  // And that glyph has NO OUTLINE IN THE FILE — a zero-length `loca` entry, which is how the monospace advance is kept while nothing is drawn. This is the fact the refusal was reading as its own failure.
  const stats = programStats(bytes);
  assert.equal(stats.outline, 'glyf');
  assert.equal(stats.nonEmptyGids.includes(1751), false, 'glyph 1751 is empty in the face itself');
  assert.equal(stats.nonEmptyGids.includes(841), true, 'while the glyph that draws the arrow is not');

  // So a subset that keeps it empty kept exactly what it was handed, and the check has to ask the DIFFERENCE rather than the output: a glyph the input could draw and the output cannot.
  await loadSubsetter(new Uint8Array(readFileSync(fileURLToPath(new URL('../vendor/harfbuzz-subset.wasm', import.meta.url)))));
  const subset = programStats(subsetFace({ bytes, gids: [1751, 841], label: 'JetBrains Mono ligature' }).bytes);
  assert.equal(subset.nonEmptyGids.includes(1751), false, 'the subset leaves it empty, as the face does');
  assert.equal(subset.nonEmptyGids.includes(841), true, 'and carries the outline the ligature is actually drawn from');
  assert.deepEqual(
    [1751, 841].filter((gid) => !subset.nonEmptyGids.includes(gid) && stats.nonEmptyGids.includes(gid)),
    [],
    'nothing the face draws was left without an outline, which is what `embedFace` refuses on',
  );
});
