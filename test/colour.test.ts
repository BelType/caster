/**
 * The pure half of the colour stage: the value grammar, the ink key, the CMYK gradient hint, and the conversion tier's arithmetic.
 *
 * The grammar is the part a document can get wrong, so every accepted and every refused form of `docs/guide/colour.md` §"The value grammar" is here, and the refusals are checked on their message rather than merely on their throwing: a hint that does not parse is an export error naming the element, the property and the value, and *never* a silent fall back to RGB, because a colour the author demanded and the exporter quietly dropped is the one failure a print job cannot recover from.
 *
 * What is not here is what needs a DOM or a `PDFContext`: `registerHintProperties`, `readHint`, `elementColor`, `hintPaints`, and the whole of `colorResources.js` but `colorantName`, a pure function of a hint that moved there from `colorHints.js` — the Separation allocator, the escaper, the black-text policy and the output intent. Those wait on Agent A's `emit/textEmit.js` and `measure/textMeasure.js`, which `colorResources.js` and `hintPaints.js` import; see `DESIGN.md` §Painting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BORDER_SIDE_PROPERTIES,
  HINT_PROPERTIES,
  HintParseError,
  colorKey,
  parseCmykGradientHint,
  parseColorHint,
  parseOverprint,
} from '../src/colour/colorHints.ts';
import { colorantName } from '../src/colour/colorResources.ts';
import {
  BLACK_POINT_COMPENSATION,
  INTENT,
  UnknownColorError,
  compareRoutes,
  conversionRecord,
  endpointConversion,
  mockConvertColors,
  rgb255,
  rgbKey,
  wasmConversion,
} from '../src/colour/rgbToCmyk.ts';
import { CasterError } from '../src/errors.ts';
import type { CmykTable } from '../src/colour/rgbToCmyk.ts';
import type { ReportWorklistEntry } from '../src/report.ts';

const PATH = 'body>p[0]';

test('the eleven hint properties, in the order the registration snippet lists them', () => {
  assert.deepEqual([...HINT_PROPERTIES], [
    '--pdf-color',
    '--pdf-background-color',
    '--pdf-border-color',
    '--pdf-border-top-color',
    '--pdf-border-right-color',
    '--pdf-border-bottom-color',
    '--pdf-border-left-color',
    '--pdf-fill',
    '--pdf-stroke',
    '--pdf-background',
    '--pdf-overprint',
  ]);
  // PDF-space order: top, right, bottom, left.
  assert.deepEqual([...BORDER_SIDE_PROPERTIES], [
    '--pdf-border-top-color',
    '--pdf-border-right-color',
    '--pdf-border-bottom-color',
    '--pdf-border-left-color',
  ]);
});

test('an absent hint is not an error and not a colour: it is the RGB path', () => {
  assert.equal(parseColorHint('', PATH), null);
  assert.equal(parseColorHint('   ', PATH), null);
  assert.equal(parseOverprint('', PATH), null);
});

test('device-cmyk() accepts every separator CSS Color 5 allows', () => {
  assert.deepEqual(parseColorHint('device-cmyk(0 0 0 1)', PATH), { kind: 'cmyk', values: [0, 0, 0, 1] });
  assert.deepEqual(parseColorHint('device-cmyk(0, 0, 0, 1)', PATH), { kind: 'cmyk', values: [0, 0, 0, 1] });
  assert.deepEqual(parseColorHint('device-cmyk(0.15 0.75 0 0)', PATH), { kind: 'cmyk', values: [0.15, 0.75, 0, 0] });
  // A percentage is a fraction of one.
  assert.deepEqual(parseColorHint('device-cmyk(100% 0% 60% 6%)', PATH), { kind: 'cmyk', values: [1, 0, 0.6, 0.06] });
  // The function name is matched case-insensitively, because the computed value keeps the case the author wrote.
  assert.deepEqual(parseColorHint('DEVICE-CMYK(0 0 0 1)', PATH), { kind: 'cmyk', values: [0, 0, 0, 1] });
  // Chromium preserves internal runs of spaces; the parser does not care.
  assert.deepEqual(parseColorHint('device-cmyk(0   0  0    1)', PATH), { kind: 'cmyk', values: [0, 0, 0, 1] });
  // Components are clamped to 0–1 rather than refused.
  assert.deepEqual(parseColorHint('device-cmyk(2 -1 0 0.5)', PATH), { kind: 'cmyk', values: [1, 0, 0, 0.5] });
});

test('an alpha and a fallback colour are accepted and dropped: a `k` operator has neither', () => {
  assert.deepEqual(parseColorHint('device-cmyk(0 0 0 1 / 0.5)', PATH), { kind: 'cmyk', values: [0, 0, 0, 1] });
  assert.deepEqual(parseColorHint('device-cmyk(0 0 0 1, red)', PATH), { kind: 'cmyk', values: [0, 0, 0, 1] });
  assert.deepEqual(parseColorHint('device-cmyk(0 0 0 1 / 50%, rgb(0 0 0))', PATH), { kind: 'cmyk', values: [0, 0, 0, 1] });
  // A fifth bare token is not a fallback — a fallback is its own comma-separated argument.
  assert.throws(() => parseColorHint('device-cmyk(0 0 0 1 red)', PATH), /needs four numbers or percentages/);
});

test('spot() at each of its three shapes', () => {
  assert.deepEqual(parseColorHint('spot("PANTONE 286 C", device-cmyk(1 0.6 0 0.06))', PATH), {
    kind: 'spot',
    name: 'PANTONE 286 C',
    alternate: [1, 0.6, 0, 0.06],
    tint: 1,
  });
  assert.deepEqual(parseColorHint('spot("PANTONE 286 C", device-cmyk(1 0.6 0 0.06), 60%)', PATH), {
    kind: 'spot',
    name: 'PANTONE 286 C',
    alternate: [1, 0.6, 0, 0.06],
    tint: 0.6,
  });
  // A bare number is already in 0–1.
  assert.equal((parseColorHint("spot('Ink', device-cmyk(0 0 0 1), 0.25)", PATH) as any).tint, 0.25);
  // Backslash escapes inside the quoted name.
  assert.equal((parseColorHint('spot("A\\"B", device-cmyk(0 0 0 1))', PATH) as any).name, 'A"B');
});

test('All and None are the two colourants PDF predefines and need no alternate', () => {
  // Full ink on every plate is what a registration mark means.
  assert.deepEqual(parseColorHint('spot("All")', PATH), { kind: 'all', alternate: [1, 1, 1, 1], tint: 1 });
  assert.deepEqual(parseColorHint('spot("None")', PATH), { kind: 'none', alternate: [0, 0, 0, 0], tint: 1 });
  // A declared alternate on All is honoured; None marks nothing whatever the tint says.
  assert.deepEqual(parseColorHint('spot("All", device-cmyk(1 1 1 1), 50%)', PATH), { kind: 'all', alternate: [1, 1, 1, 1], tint: 0.5 });
  assert.deepEqual(parseColorHint('spot("None", device-cmyk(1 0 0 0))', PATH), { kind: 'none', alternate: [0, 0, 0, 0], tint: 1 });
});

test('every refusal names the element, the property and the value', () => {
  const refuses = (value: string, reason: RegExp, property: string = '--pdf-color') => {
    assert.throws(
      () => parseColorHint(value, PATH, property),
      (error) => {
        assert.ok(error instanceof HintParseError, `${value} throws a HintParseError`);
        assert.ok(error instanceof CasterError, 'and a HintParseError is a CasterError');
        assert.equal(error.path, PATH);
        assert.equal(error.property, property);
        assert.equal(error.value, value);
        assert.equal(error.element, PATH, 'the panel gets the DOM path as context');
        assert.ok(error.message.startsWith(`colorHints: ${PATH} has an unparseable ${property}: ${JSON.stringify(value)} (`), error.message);
        assert.match(error.message, reason);
        return true;
      },
    );
  };

  refuses('device-cmyk(0 0 1)', /needs four numbers or percentages/);
  refuses('device-cmyk(a b c d)', /needs four numbers or percentages/);
  refuses('spot(PANTONE)', /spot\(\) needs a quoted name first/);
  refuses('spot("Ink")', /a named spot needs a device-cmyk\(\) alternate/);
  refuses('spot("Ink", device-cmyk(0 0 0 1), device-cmyk(1 0 0 0))', /spot\(\) carries two alternates/);
  refuses('spot("Ink", device-cmyk(0 0 0 1), 50%, 1)', /spot\(\) takes a name, an alternate and a tint/);
  refuses('spot("Ink", device-cmyk(0 0 0 1), bogus)', /"bogus" is neither an alternate nor a tint/);
  refuses('spot("Ink", device-cmyk(0 0 1))', /the alternate device-cmyk\(\) is malformed/);
  refuses('rgb(20 90 200)', /expected device-cmyk\(…\) or spot\(…\)/);
  refuses('#ff0000', /expected device-cmyk\(…\) or spot\(…\)/);
  // Anything after the closing parenthesis is not part of the call, and a value that carries some is a value the author did not mean.
  refuses('device-cmyk(0 0 0 1) important', /expected device-cmyk\(…\) or spot\(…\)/);
});

test('--pdf-overprint is fill, stroke or both, and nothing else', () => {
  assert.equal(parseOverprint('fill', PATH), 'fill');
  assert.equal(parseOverprint('stroke', PATH), 'stroke');
  assert.equal(parseOverprint('both', PATH), 'both');
  assert.equal(parseOverprint('  BOTH  ', PATH), 'both');
  assert.throws(() => parseOverprint('knockout', PATH), /--pdf-overprint: "knockout" \(expected fill, stroke or both\)/);
});

test('colorKey is equal exactly when two resolved colours are the same ink', () => {
  assert.equal(colorKey(undefined), '');
  const cmyk = (parseColorHint('device-cmyk(0 0 0 1)', PATH) as any);
  const spotFull = (parseColorHint('spot("Ink", device-cmyk(0 0 0 1))', PATH) as any);
  const spotTinted = (parseColorHint('spot("Ink", device-cmyk(0 0 0 1), 60%)', PATH) as any);
  // A spot is not its own alternate, and one tint of a spot is not another.
  assert.notEqual(colorKey(cmyk), colorKey(spotFull));
  assert.notEqual(colorKey(spotFull), colorKey(spotTinted));
  assert.equal(colorKey(cmyk), colorKey((parseColorHint('device-cmyk(0% 0% 0% 100%)', PATH) as any)));
  assert.equal(colorantName(spotFull), 'Ink');
  assert.equal(colorantName((parseColorHint('spot("All")', PATH) as any)), 'All');
  assert.equal(colorantName((parseColorHint('spot("None")', PATH) as any)), 'None');
});

test('a --pdf-background gradient takes device-cmyk() stops, and refuses a mixed one', () => {
  const hint = parseCmykGradientHint('linear-gradient(to right, device-cmyk(1 0 0 0), device-cmyk(0 0 1 0))', PATH);
  assert.ok(hint);
  assert.equal(hint.fn, 'linear-gradient');
  assert.deepEqual(hint.stops, [[1, 0, 0, 0], [0, 0, 1, 0]]);
  // A stop may carry its own position.
  const positioned = parseCmykGradientHint('linear-gradient(device-cmyk(1 0 0 0) 0%, device-cmyk(0 0 1 0) 40%)', PATH);
  assert.deepEqual(positioned?.stops, [[1, 0, 0, 0], [0, 0, 1, 0]]);
  // The on-screen preview a stop resolves to is the naive conversion, and the CMYK rides beside it.
  assert.deepEqual(hint.colorOf('device-cmyk(0 0 0 1)'), { rgb: [0, 0, 0], alpha: 1, cmyk: [0, 0, 0, 1] });

  // A gradient with one RGB stop and one CMYK stop has no honest PDF shading.
  assert.throws(
    () => parseCmykGradientHint('linear-gradient(to right, device-cmyk(1 0 0 0), red)', PATH),
    /mixing colour spaces has no PDF shading/,
  );
  assert.throws(() => parseCmykGradientHint('linear-gradient(red, blue)', PATH), /needs device-cmyk\(\) stops/);
  // Not a gradient at all is not an error: it is not this parser's value.
  assert.equal(parseCmykGradientHint('device-cmyk(0 0 0 1)', PATH), null);
  assert.equal(parseCmykGradientHint('', PATH), null);
  assert.equal(parseCmykGradientHint('none', PATH), null);
});

test('rgbKey and rgb255 are the key both conversion routes agree on', () => {
  assert.equal(rgbKey([0.0784, 0.3529, 0.7843]), '20,90,200');
  assert.deepEqual(rgb255([0.0784, 0.3529, 0.7843]), [20, 90, 200]);
  // The key is the rounded 0–255 triple, so two colours a byte apart in float land on one entry.
  assert.equal(rgbKey([0.07843137, 0.35294117, 0.78431372]), rgbKey([0.0784, 0.3529, 0.7843]));
});

const TABLE: CmykTable = {
  generatedBy: 'tools/e12e-cmyk-table.mjs',
  library: 'little-cms',
  sourceProfile: { file: 'srgb.icc', bytes: 3144, sha256: '', description: 'sRGB' },
  outputProfile: { file: 'default_cmyk.icc', bytes: 190_000, sha256: '', description: 'Artifex CMYK SWOP Profile' },
  intent: INTENT,
  blackPointCompensation: BLACK_POINT_COMPENSATION,
  precision: '1e-6',
  entries: [
    { rgb: [20, 90, 200], key: '20,90,200', cmyk: [0.8471, 0.6157, 0, 0.0863], from: 'lcms' },
    { rgb: [200, 30, 30], key: '200,30,30', cmyk: [0.1424, 0.9999, 1, 0.0461], from: 'lcms' },
  ],
};

test('the endpoint route answers the whole work list in one round trip', async () => {
  const worklist: ReportWorklistEntry[] = [
    { path: 'Document/Sect[2]/P[0]', target: 'fill', rgb: [0.0784, 0.3529, 0.7843], css: 'rgb(20, 90, 200)', uses: 1 },
    { path: 'Document/Sect[3]/P[0]', target: 'fill', rgb: [0.7843, 0.1176, 0.1176], css: 'rgb(200, 30, 30)', uses: 2 },
  ];
  const conversion = await endpointConversion(worklist, 'Artifex CMYK SWOP Profile', mockConvertColors(TABLE), 'e12e-cmyk-table');
  assert.equal(conversion.mode, 'endpoint');
  assert.equal(conversion.entries.length, 2);
  assert.deepEqual(conversion.cmykOf([0.0784, 0.3529, 0.7843]), [0.8471, 0.6157, 0, 0.0863]);
  assert.equal(conversion.endpoint?.entries, 2);
  assert.equal(conversion.entries[1].uses, 2, 'uses says whether converting it is worth a round trip');
  // A colour the tier has no entry for is undefined, never a guess: the caller keeps it as `rg`.
  assert.equal(conversion.cmykOf([0, 1, 0]), undefined);
});

test('a colour the mocked endpoint was never given is an error naming it', async () => {
  const worklist: ReportWorklistEntry[] = [{ path: 'p', target: 'fill', rgb: [0, 1, 0], css: 'rgb(0, 255, 0)', uses: 1 }];
  await assert.rejects(
    () => endpointConversion(worklist, 'condition', mockConvertColors(TABLE), 'e12e-cmyk-table'),
    (error) => {
      assert.ok(error instanceof UnknownColorError);
      assert.ok(error instanceof CasterError);
      assert.deepEqual(error.rgb, [0, 255, 0]);
      assert.match(error.message, /no entry for rgb\(0 255 0\); tools\/e12e-cmyk-table\.mjs lists 2 colour\(s\)/);
      return true;
    },
  );
});

test('an endpoint that answers the wrong number of colours is refused', async () => {
  const worklist: ReportWorklistEntry[] = [
    { path: 'a', target: 'fill', rgb: [0, 0, 0], css: 'black', uses: 1 },
    { path: 'b', target: 'fill', rgb: [1, 1, 1], css: 'white', uses: 1 },
  ];
  await assert.rejects(
    () => endpointConversion(worklist, 'condition', async () => [[0, 0, 0, 1]], 'short'),
    /the endpoint answered 1 colour\(s\) for 2/,
  );
});

test('compareRoutes reports the largest per-channel difference, and the routes agree to 0.000000', async () => {
  const worklist: ReportWorklistEntry[] = [
    { path: 'a', target: 'fill', rgb: [0.0784, 0.3529, 0.7843], css: 'rgb(20, 90, 200)', uses: 1 },
    { path: 'b', target: 'fill', rgb: [0.7843, 0.1176, 0.1176], css: 'rgb(200, 30, 30)', uses: 2 },
  ];
  const endpoint = await endpointConversion(worklist, 'condition', mockConvertColors(TABLE), 'table');
  const sameAnswers = wasmConversion(worklist, {
    convert: (colors) => colors.map((rgb) => (TABLE.entries.find((e) => e.key === rgb.join(',')) as any).cmyk),
    wasmBytes: 315_910,
    loadMs: 130,
    packageName: 'lcms-wasm',
    version: '1.0.5',
  });
  const compared = compareRoutes(endpoint, sameAnswers);
  assert.equal(compared.length, 2);
  for (const entry of compared) assert.equal(entry.maxDelta, 0, 'the same library over the same profiles agrees exactly');

  // One channel moved by a thousandth shows up as a thousandth, rounded to six places.
  const drifted = wasmConversion(worklist, {
    convert: (colors) =>
      colors.map((rgb) => {
        const cmyk = (TABLE.entries.find((e) => e.key === rgb.join(',')) as any).cmyk.slice();
        cmyk[2] += 0.001;
        return cmyk;
      }),
    wasmBytes: 315_910,
    loadMs: 130,
    packageName: 'lcms-wasm',
    version: '1.0.5',
  });
  for (const entry of compareRoutes(endpoint, drifted)) assert.equal(entry.maxDelta, 0.001);
});

test('the conversion record carries the intent and the black-point decision both routes share', async () => {
  const worklist: ReportWorklistEntry[] = [{ path: 'a', target: 'fill', rgb: [0.0784, 0.3529, 0.7843], css: 'rgb(20, 90, 200)', uses: 1 }];
  const conversion = await endpointConversion(worklist, 'Artifex CMYK SWOP Profile', mockConvertColors(TABLE), 'table');
  const record = conversionRecord(conversion, 'Artifex CMYK SWOP Profile', conversion.entries, [{ path: 'img[0]', reason: 'an image is /ICCBased sample data under the output intent' }], 'the endpoint is preferred and the wasm route stays as a fallback');
  assert.equal(record.mode, 'endpoint');
  assert.equal(record.intent, 'relative colorimetric');
  assert.equal(record.blackPointCompensation, true);
  assert.equal(record.untouched.length, 1);
  assert.equal(record.wasm, undefined);
  assert.ok(record.endpoint);
});
