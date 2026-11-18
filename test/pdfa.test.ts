/**
 * *The standard is a list* and *an archival claim is kept or refused* (`codeberg.org/BelType/decisions`, 2026-11-17; DESIGN.md S109): under `a-4` a file is PDF/A-4 or it is not printed.
 *
 * @remarks
 * Two fixtures are printed as one host-strip page, as `olderTags.test.ts` prints its own, under the writer the run names (`test/writer.ts`): `fixtures/archival` in RGB alone, under `a-4` alone and under `ua-2` with `a-4`, with no profile, so the output intent is the sRGB one; and `fixtures/archival-cmyk`, the same with a run in a declared CMYK ink, with the test CMYK profile and without one. veraPDF judges each file under `-f 4`, and under `-f ua2` where the file claims PDF/UA-2, where `verapdf` is on the path. The refusals are held to their sentences, through `print()` where a document reaches them and on committed lists where only a hand-made list does. A file that does not ask for `a-4` is byte for byte what the writer wrote before: `displayList.test.ts` replays every committed list against its committed file, and here the archival document under the default carries no claim.
 *
 * @packageDocumentation
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './launch.ts';
import { contentType } from '@beltype/common/mime';
import { WRITER } from './writer.ts';
import { resolveOptions } from '../src/options.ts';
import { checkArchival } from '../src/displayList/validate.ts';

import type { DisplayList } from '../src/displayList.ts';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const DIST = path.join(PACKAGE, 'dist');
const COMMON = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));
const FIXTURES = path.join(PACKAGE, 'fixtures');
const LISTS = path.join(FIXTURES, 'lists');
const IMPORTS = `<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>`;
/** The CMYK profile the corpus's conversion documents pass (Ghostscript's, `test/assets/PROVENANCE.md`). */
const CMYK_PROFILE = fs.readFileSync(path.join(PACKAGE, 'test', 'assets', 'default_cmyk.icc'));

type Printed = { bytes?: Buffer; refused?: string; conformance?: string; archival?: string; list?: DisplayList };

/**
 * Print a fixture file, a path under `fixtures/`, as one host-strip page, with Caster's options and, where given, the CMYK profile.
 *
 * @param inject - HTML added to the end of the body before the print.
 */
async function printDoc(file: string, options: Record<string, unknown>, { profile = false, inject = '' }: { profile?: boolean; inject?: string } = {}): Promise<Printed> {
  const dir = path.posix.dirname(file);
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end(fs.readFileSync(path.join(FIXTURES, file), 'utf8').replace('<head>', `<head>${IMPORTS}<base href="/fixtures/${dir}/">`));
    const [root, rel] = url.pathname.startsWith('/common/') ? [COMMON, url.pathname.slice(8)] : url.pathname.startsWith('/fixtures/') ? [FIXTURES, url.pathname.slice(10)] : [DIST, url.pathname.slice(1)];
    const found = path.join(root, rel);
    if (!found.startsWith(root) || !fs.existsSync(found) || fs.statSync(found).isDirectory()) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': contentType(found) }).end(fs.readFileSync(found));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const browser = await launchBrowser();
  try {
    const tab = await browser.newPage();
    await tab.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    await tab.evaluate(() => document.fonts.ready);
    const out = await tab.evaluate(async ({ writer, options, profile, inject }) => {
      const caster = await import('/src/index.js' as string);
      if (inject) document.body.insertAdjacentHTML('beforeend', inject);
      caster.prepare(document);
      const strip = document.body;
      const box = strip.getBoundingClientRect();
      const pt = (px: number) => Math.round(((px * 72) / 96) * 1000) / 1000;
      try {
        const printed = await caster.print({
          document,
          strip: {
            strip, probeRoot: strip, pageElements: [strip],
            pages: [{ element: strip, index: 0, flow: [...strip.children], flowBox: null, trimBox: null, nominal: { widthPt: pt(box.width), heightPt: pt(box.height) }, declaredPx: { widthPx: box.width, heightPx: box.height }, contentArea: strip, continuations: [] }],
            pageOfNode: new Map(), twinOf: () => null, transparent: () => false, lang: 'en', pageElementOf: () => strip, backgrounds: [],
          },
        }, { writer, ...options, ...(profile ? { profile: Uint8Array.from(atob(profile), (c) => c.charCodeAt(0)) } : {}) });
        let binary = '';
        for (const byte of printed.bytes as Uint8Array) binary += String.fromCharCode(byte);
        const { blobs: _, ...resources } = printed.displayList.resources;
        return { base64: btoa(binary), conformance: printed.report.conformance as string, archival: printed.report.archival as string | undefined, list: JSON.stringify({ ...printed.displayList, resources }) };
      } catch (error) {
        return { refused: String((error as Error)?.message ?? error) };
      }
    }, { writer: WRITER, options, profile: profile ? CMYK_PROFILE.toString('base64') : '', inject });
    if ('refused' in out) return { refused: out.refused };
    return { bytes: Buffer.from(out.base64, 'base64'), conformance: out.conformance, archival: out.archival, list: JSON.parse(out.list) };
  } finally {
    await browser.close();
    server.close();
  }
}

/** veraPDF's failed rules on a file under one flavour, or null where veraPDF is not on the path. */
function verapdf(flavour: string, bytes: Buffer, name: string): string[] | null {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'caster-pdfa-')), `${name}.pdf`);
  fs.writeFileSync(file, bytes);
  const run = spawnSync('verapdf', ['--flavour', flavour, '--format', 'json', file], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (run.error || !run.stdout) return null;
  return JSON.parse(run.stdout).report.jobs.flatMap((job: any) => (job.validationResult ?? [{ details: { ruleSummaries: [{ clause: 'not validated', testNumber: 0, failedChecks: 0 }] } }])
    .flatMap((result: any) => result.details.ruleSummaries.map((rule: any) => `${rule.clause}-${rule.testNumber} (${rule.failedChecks})`)));
}

/** What the file says of its claims, read off its bytes: the two identifications, the Info dictionary, the output intents and the profiles they name, and any image asking to be smoothed. */
function claimsIn(bytes: Buffer) {
  const text = bytes.toString('latin1');
  const trailer = text.slice(text.lastIndexOf('trailer'));
  const intents = [...text.matchAll(/\/S \/(GTS_PDF\w+)[\s\S]*?\/DestOutputProfile (\d+ 0 R)/gu)].map((m) => [m[1], m[2]]);
  return {
    pdfa: text.includes('<pdfaid:part>4</pdfaid:part>') && text.includes('<pdfaid:rev>2020</pdfaid:rev>') && !text.includes('pdfaid:conformance'),
    pdfua: text.includes('<pdfuaid:part>2</pdfuaid:part>'),
    info: /\/Info \d+ 0 R/u.test(trailer),
    id: /\/ID \[ ?<[0-9a-fA-F]{32}> ?<[0-9a-fA-F]{32}> ?\]/u.test(trailer),
    intents: intents.map(([s]) => s).sort(),
    oneProfile: intents.length > 0 && new Set(intents.map(([, ref]) => ref)).size === 1,
    smoothed: /\/Interpolate true/u.test(text),
  };
}

/** A committed list with its blobs, for the refusals only a hand-made list reaches. */
function committed(name: string): DisplayList {
  const list = JSON.parse(fs.readFileSync(path.join(LISTS, `${name}.json`), 'utf8'));
  const corpus = JSON.parse(fs.readFileSync(path.join(LISTS, 'corpus.json'), 'utf8'));
  list.resources.blobs = {};
  for (const hash of corpus.documents.find((d: { name: string }) => d.name === name).list.blobs) list.resources.blobs[hash] = new Uint8Array(fs.readFileSync(path.join(LISTS, 'blobs', hash)));
  return list;
}

const PASSES: string[] = [];

test('the flag is a list of claims: every value accepted before means what it meant, a list is written in the table\'s spelling, and a claim named twice or not at all is refused', () => {
  assert.equal(resolveOptions({}).standard, 'ua-2', 'the default is ua-2 alone');
  assert.equal(resolveOptions({ standard: 'none' }).standard, 'none');
  assert.equal(resolveOptions({ standard: 'a-4' }).standard, 'a-4');
  assert.equal(resolveOptions({ standard: ['a-4', 'ua-2'] }).standard, 'ua-2,a-4', 'a list in any order is the table\'s spelling');
  assert.equal(resolveOptions({ standard: [] }).standard, 'none', 'claiming nothing stays possible');
  assert.throws(() => resolveOptions({ standard: ['ua-2', 'ua-2'] }), /'standard' takes a list of "ua-2" and "a-4", each once; got \["ua-2","ua-2"\]/u);
  assert.throws(() => resolveOptions({ standard: ['ua-1'] as never }), /'standard' takes a list of "ua-2" and "a-4", each once/u);
  assert.throws(() => resolveOptions({ standard: 'a-4,ua-2' as never }), /'standard' takes "ua-2" or "a-4" or "ua-2,a-4" or "none"/u);
  assert.throws(() => resolveOptions({ standard: 'a-4', colour: 'off' }), /`standard` with 'a-4' needs the colour objects/u);
});

for (const standard of [['a-4'], ['ua-2', 'a-4']]) {
  test(`under ${standard.join(' with ')}, a document in RGB prints PDF/A-4 with an sRGB output intent`, async (t) => {
    const printed = await printDoc('archival/index.html', { standard });
    assert.ok(printed.bytes, printed.refused);
    const claims = claimsIn(printed.bytes);
    assert.equal(printed.list?.info.archival, 'pdfa4', 'the list carries the claim');
    assert.equal(printed.archival, 'pdfa4', 'the report names the claim');
    assert.deepEqual({ ...claims, pdfua: undefined }, { pdfa: true, pdfua: undefined, info: false, id: true, intents: ['GTS_PDFA1', 'GTS_PDFX'], oneProfile: true, smoothed: false }, 'the identification, no Info dictionary, both intents on one profile, nothing smoothed');
    assert.equal(claims.pdfua, standard.includes('ua-2'), 'PDF/UA-2 is claimed exactly where it is asked for');
    for (const flavour of standard.includes('ua-2') ? ['4', 'ua2'] : ['4']) {
      const failed = verapdf(flavour, printed.bytes, `archival-${standard.join('-')}`);
      if (failed === null) { t.diagnostic('verapdf is not on the path'); continue; }
      assert.deepEqual(failed, [], `veraPDF -f ${flavour}`);
      PASSES.push(`${standard.join(',')} -f ${flavour}`);
    }
  });
}

test('the default claims PDF/UA-2 alone, and the archival document is then what a file was before the claim', async () => {
  const printed = await printDoc('archival/index.html', {});
  assert.ok(printed.bytes, printed.refused);
  assert.equal(printed.list?.info.archival, undefined, 'the list makes no archival claim');
  assert.equal(printed.archival, undefined, 'and the report names none');
  const claims = claimsIn(printed.bytes);
  assert.deepEqual(claims, { pdfa: false, pdfua: true, info: true, id: true, intents: [], oneProfile: false, smoothed: true }, 'no identification, the Info dictionary, no colour story, the image smoothed as the page asked');
});

test('with a CMYK profile, a run in a CMYK ink prints PDF/A-4 and PDF/UA-2; with none, it is refused by name', async (t) => {
  const printed = await printDoc('archival-cmyk/index.html', { standard: ['ua-2', 'a-4'] }, { profile: true });
  assert.ok(printed.bytes, printed.refused);
  assert.deepEqual(claimsIn(printed.bytes).intents, ['GTS_PDFA1', 'GTS_PDFX']);
  assert.ok(claimsIn(printed.bytes).oneProfile, 'both intents name the CMYK profile');
  for (const flavour of ['4', 'ua2']) {
    const failed = verapdf(flavour, printed.bytes, 'archival-cmyk');
    if (failed === null) { t.diagnostic('verapdf is not on the path'); continue; }
    assert.deepEqual(failed, [], `veraPDF -f ${flavour}`);
    PASSES.push(`cmyk -f ${flavour}`);
  }
  const refused = await printDoc('archival-cmyk/index.html', { standard: ['ua-2', 'a-4'] });
  assert.match(refused.refused ?? '', /^caster: text item \d+ of page 1 is painted in CMYK, and no CMYK profile stands behind it: the output intent is an RGB profile, so the file could not say what the ink means, which PDF\/A-4 asks of every colour \(ISO 19005-4, 6\.2\.4\.3\); pass a CMYK profile as the `profile` option, or print without `a-4` in `standard`$/u);
});

test('a page of another PDF is refused under a-4, naming it', async () => {
  const refused = await printDoc('roads/facsimile.html', { standard: 'a-4' });
  assert.match(refused.refused ?? '', /^caster: the facsimile at object\[0\] is page 2 of http:\/\/127\.0\.0\.1:\d+\/fixtures\/facsimile\/fixture\.pdf, a page of another PDF, which Caster copies as it is and does not read, so it cannot stand behind it under PDF\/A-4; print without `a-4` in `standard`, or place the page as an image$/u);
  const printed = await printDoc('roads/facsimile.html', {});
  assert.ok(printed.bytes, `without the claim it prints: ${printed.refused}`);
});

test('a guessed tag withdraws the PDF/UA-2 claim alone and leaves PDF/A-4 standing', async (t) => {
  const printed = await printDoc('archival/index.html', { standard: ['ua-2', 'a-4'] }, { inject: '<x-aside style="display: block">Guessed by its layout.</x-aside>' });
  assert.ok(printed.bytes, printed.refused);
  assert.equal(printed.conformance, 'tagged', 'the guess withdrew PDF/UA-2');
  assert.equal(printed.archival, 'pdfa4', 'the report still names PDF/A-4');
  const claims = claimsIn(printed.bytes);
  assert.equal(claims.pdfua, false);
  assert.equal(claims.pdfa, true, 'PDF/A-4 still stands');
  const failed = verapdf('4', printed.bytes, 'archival-guessed');
  if (failed === null) t.diagnostic('verapdf is not on the path');
  else assert.deepEqual(failed, [], 'veraPDF -f 4');
});

test('a list that claims PDF/A-4 and cannot keep it is refused by name before a byte is written', () => {
  const claim = (list: DisplayList) => ({ ...list, info: { ...list.info, archival: 'pdfa4' as const } });
  assert.throws(() => checkArchival(claim(committed('photo'))), { message: 'caster: the display list claims PDF/A-4 and carries no colour story, so no output intent would say what its colours mean (ISO 19005-4, 6.2.4.3)' });
  const roads = committed('roads');
  const facsimile = committed('facsimile');
  facsimile.writing = { ...facsimile.writing, colour: roads.writing.colour };
  Object.assign(facsimile.resources.blobs, roads.resources.blobs);
  assert.throws(() => checkArchival(claim(facsimile)), { message: 'caster: the facsimile at object[0] is page 2 of https://print.invalid/facsimile/fixture.pdf, a page of another PDF, which Caster copies as it is and does not read, so it cannot stand behind it under PDF/A-4; print without `a-4` in `standard`, or place the page as an image' });
  const rgb = claim(roads);
  rgb.writing = { ...rgb.writing, colour: { ...rgb.writing.colour!, profiles: { ...rgb.writing.colour!.profiles, cmyk: rgb.writing.colour!.profiles.srgb } } };
  assert.throws(() => checkArchival(rgb), (error: Error & { listItem?: unknown }) => / is painted in CMYK(, by `blackText: '100k'`)?, and no CMYK profile stands behind it: /u.test(error.message) && error.listItem !== undefined);
  assert.doesNotThrow(() => checkArchival(claim(roads)), 'with the CMYK profile behind it, the same list keeps the claim');
  assert.doesNotThrow(() => checkArchival(roads), 'a list that makes no claim is not asked');
});

test.after(() => { if (PASSES.length) console.log(`ℹ veraPDF passed ${WRITER}'s files: ${PASSES.join('; ')}`); });
