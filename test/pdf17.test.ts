/**
 * *The PDF 1.7 family joins the list* and the three rulings beside it (`codeberg.org/BelType/decisions`, 2026-11-18; DESIGN.md S111): `ua-1`, `a-2b`, `a-2u`, `a-2a` and `pdf-1.7` print a PDF 1.7 file, each claim kept, lowered, withdrawn or refused as its ruling says.
 *
 * @remarks
 * Fixtures are printed as one host-strip page, as `pdfa.test.ts` prints its own, or as the pages Paged.js presented, through its adapter (`older-tags-pagedjs`, the one fixture with a footnote and its call), under the writer the run names (`test/writer.ts`). veraPDF judges each file under every profile its claims name, where `verapdf` is on the path; a bare `pdf-1.7` file is held to `qpdf --check` and to veraPDF's PDF/UA-1 profile, which it must fail on the missing identification alone. A list with no 1.7 member prints the bytes it printed before: `displayList.test.ts` replays every committed list against its committed file.
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
import { headingBreaks } from '../src/walk/structure.ts';
import { validateList } from '../src/displayList/validate.ts';

import type { DisplayList, StructElement } from '../src/displayList.ts';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const DIST = path.join(PACKAGE, 'dist');
const COMMON = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));
const FIXTURES = path.join(PACKAGE, 'fixtures');
const LISTS = path.join(FIXTURES, 'lists');
/** The CMYK profile the corpus's conversion documents pass (Ghostscript's, `test/assets/PROVENANCE.md`). */
const CMYK_PROFILE = fs.readFileSync(path.join(PACKAGE, 'test', 'assets', 'default_cmyk.icc'));
const IMPORTS = `<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>`;

type Printed = { bytes?: Buffer; refused?: string; conformance?: string; archival?: string; version?: string; warnings?: string[]; list?: DisplayList };

/**
 * Print a fixture file, a path under `fixtures/`, as one host-strip page, or through the Paged.js adapter, with Caster's options.
 *
 * @param inject - HTML added to the end of the body before the print.
 */
async function printDoc(file: string, options: Record<string, unknown>, { inject = '', engine = 'strip', profile = false }: { inject?: string; engine?: 'strip' | 'pagedjs'; profile?: boolean } = {}): Promise<Printed> {
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
    const out = await tab.evaluate(async ({ writer, given, inject, engine, profile }) => {
      const caster = await import('/src/index.js' as string);
      const options = { ...given, ...(profile ? { profile: Uint8Array.from(atob(profile), (c) => c.charCodeAt(0)) } : {}) };
      try {
        let printed;
        if (engine === 'pagedjs') {
          const { adaptPagedjs } = await import('/src/adapters/pagedjs.js' as string);
          printed = await caster.print({ document, strip: adaptPagedjs(document) }, { writer, ...options });
        } else {
          if (inject) document.body.insertAdjacentHTML('beforeend', inject);
          caster.prepare(document);
          const strip = document.body;
          const box = strip.getBoundingClientRect();
          const pt = (px: number) => Math.round(((px * 72) / 96) * 1000) / 1000;
          printed = await caster.print({
            document,
            strip: {
              strip, probeRoot: strip, pageElements: [strip],
              pages: [{ element: strip, index: 0, flow: [...strip.children], flowBox: null, trimBox: null, nominal: { widthPt: pt(box.width), heightPt: pt(box.height) }, declaredPx: { widthPx: box.width, heightPx: box.height }, contentArea: strip, continuations: [] }],
              pageOfNode: new Map(), twinOf: () => null, transparent: () => false, lang: 'en', pageElementOf: () => strip, backgrounds: [],
            },
          }, { writer, ...options });
        }
        let binary = '';
        for (const byte of printed.bytes as Uint8Array) binary += String.fromCharCode(byte);
        const { blobs: _, ...resources } = printed.displayList.resources;
        const { conformance, archival, version, warnings } = printed.report;
        return { base64: btoa(binary), conformance, archival, version, warnings, list: JSON.stringify({ ...printed.displayList, resources }) };
      } catch (error) {
        return { refused: String((error as Error)?.message ?? error) };
      }
    }, { writer: WRITER, given: options, inject, engine, profile: profile ? CMYK_PROFILE.toString('base64') : '' });
    if ('refused' in out) return { refused: out.refused };
    return { bytes: Buffer.from(out.base64, 'base64'), conformance: out.conformance, archival: out.archival, version: out.version, warnings: out.warnings, list: JSON.parse(out.list) };
  } finally {
    await browser.close();
    server.close();
  }
}

/** veraPDF's failed rules on a file under one flavour, or null where veraPDF is not on the path. */
function verapdf(flavour: string, bytes: Buffer, name: string): string[] | null {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'caster-pdf17-')), `${name}.pdf`);
  fs.writeFileSync(file, bytes);
  const run = spawnSync('verapdf', ['--flavour', flavour, '--format', 'json', file], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (run.error || !run.stdout) return null;
  return JSON.parse(run.stdout).report.jobs.flatMap((job: any) => (job.validationResult ?? [{ details: { ruleSummaries: [{ clause: 'not validated', testNumber: 0, failedChecks: 0 }] } }])
    .flatMap((result: any) => result.details.ruleSummaries.map((rule: any) => `${rule.clause}-${rule.testNumber} (${rule.failedChecks})`)));
}

/** `qpdf --check`'s verdict, or null where qpdf is not on the path. */
function qpdfCheck(bytes: Buffer, name: string): { ok: boolean; out: string } | null {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'caster-pdf17-')), `${name}.pdf`);
  fs.writeFileSync(file, bytes);
  const run = spawnSync('qpdf', ['--check', file], { encoding: 'utf8' });
  if (run.error) return null;
  return { ok: run.status === 0, out: run.stdout + run.stderr };
}

/** What the file says of itself, read off its bytes. */
function claimsIn(bytes: Buffer) {
  const text = bytes.toString('latin1');
  const trailer = text.slice(text.lastIndexOf('trailer'));
  return {
    header: text.slice(0, 8),
    version20: text.includes('/Version /2.0'),
    namespaces: /\/Namespaces|\/NS \d/u.test(text),
    ref: /\/Ref \[/u.test(text),
    ua1: text.includes('<pdfuaid:part>1</pdfuaid:part>'),
    ua2: text.includes('<pdfuaid:part>2</pdfuaid:part>'),
    wtpdf: text.includes('wtpdf'),
    pdfa: /<pdfaid:part>(\d)<\/pdfaid:part>(?:\s*<pdfaid:conformance>([BUA])<\/pdfaid:conformance>)?/u.exec(text)?.slice(1, 3).filter(Boolean).join('') ?? '',
    extension: text.includes('<pdfaSchema:prefix>pdfuaid</pdfaSchema:prefix>'),
    info: /\/Info \d+ 0 R/u.test(trailer),
    intents: [...text.matchAll(/\/S \/(GTS_PDF\w+)/gu)].map((m) => m[1]).sort(),
    smoothed: /\/Interpolate true/u.test(text),
  };
}

/** The profiles a list of claims names, in veraPDF's spelling. */
const profilesOf = (standard: string): string[] => standard.split(',').flatMap((claim) => (claim === 'ua-1' ? ['ua1'] : claim.startsWith('a-2') ? [`2${claim.slice(3)}`] : []));

const PASSES: string[] = [];

test('the list takes the five members of the PDF 1.7 family, in any order and as a string, and refuses two versions or two PDF/A members by name', () => {
  for (const member of ['ua-1', 'a-2b', 'a-2u', 'a-2a', 'pdf-1.7'] as const) assert.equal(resolveOptions({ standard: [member] }).standard, member);
  assert.equal(resolveOptions({ standard: ['a-2a', 'ua-1'] }).standard, 'ua-1,a-2a', 'a list in any order is the table\'s spelling');
  assert.equal(resolveOptions({ standard: 'a-2a,ua-1' as never }).standard, 'ua-1,a-2a', 'and so is a string that spells one');
  assert.equal(resolveOptions({ standard: 'pdf-1.7,a-2b' as never }).standard, 'a-2b,pdf-1.7', 'pdf-1.7 beside another member is accepted');
  assert.equal(resolveOptions({}).standard, 'ua-2', 'the default stays ua-2 alone');
  assert.throws(() => resolveOptions({ standard: ['ua-2', 'ua-1'] }), /caster: 'standard' names "ua-2", a claim on PDF 2.0, beside "ua-1", a member of the PDF 1.7 family, and a file has one version; name the members of one version\.$/u);
  assert.throws(() => resolveOptions({ standard: 'a-4,pdf-1.7' as never }), /names "a-4", a claim on PDF 2.0, beside "pdf-1\.7"/u);
  assert.throws(() => resolveOptions({ standard: ['a-2b', 'a-2a'] }), /caster: 'standard' names two PDF\/A members, "a-2b" and "a-2a", and a file carries one PDF\/A identification; name one\.$/u);
  assert.throws(() => resolveOptions({ standard: ['a-2u', 'ua-1', 'a-2b'] }), /two PDF\/A members, "a-2b" and "a-2u"/u);
  assert.throws(() => resolveOptions({ standard: 'a-2b', colour: 'off' }), /caster: `standard` with 'a-2b' needs the colour objects, an output intent that says what every colour means \(ISO 19005-2, 6\.2\.4\.3\)/u);
});

for (const standard of ['ua-1', 'a-2b', 'a-2u', 'a-2a', 'ua-1,a-2a', 'pdf-1.7']) {
  test(`under ${standard}, the archival document prints a PDF 1.7 file that keeps every claim it makes`, async (t) => {
    const printed = await printDoc('archival/index.html', { standard });
    assert.ok(printed.bytes, printed.refused);
    const ua1 = standard.includes('ua-1');
    const level = /a-2(\w)/u.exec(standard)?.[1];
    assert.equal(printed.version, '1.7', 'the report names the version');
    assert.equal(printed.list?.info.pdf, '1.7', 'and the list carries it');
    assert.equal(printed.conformance, ua1 ? 'pdfua1' : 'tagged');
    assert.equal(printed.archival, level ? `pdfa2${level}` : undefined);
    const claims = claimsIn(printed.bytes);
    assert.deepEqual(claims, {
      header: '%PDF-1.7', version20: false, namespaces: false, ref: false, ua1, ua2: false, wtpdf: false,
      pdfa: level ? `2${level.toUpperCase()}` : '', extension: ua1 && level !== undefined, info: true,
      intents: level ? ['GTS_PDFA1', 'GTS_PDFX'] : [], smoothed: !level,
    }, 'the header, no namespace, no /Ref, the identifications, the extension schema, the Info dictionary kept, the intents, nothing smoothed under PDF/A-2');
    if (standard === 'pdf-1.7') {
      const checked = qpdfCheck(printed.bytes, 'pdf17');
      if (checked === null) t.diagnostic('qpdf is not on the path');
      else assert.ok(checked.ok, checked.out);
      const failed = verapdf('ua1', printed.bytes, 'pdf17');
      if (failed === null) t.diagnostic('verapdf is not on the path');
      else assert.deepEqual(failed, ['5-1 (1)'], 'a bare 1.7 file fails PDF/UA-1 on its missing identification alone');
      return;
    }
    for (const flavour of profilesOf(standard)) {
      const failed = verapdf(flavour, printed.bytes, `archival-${standard}`);
      if (failed === null) { t.diagnostic('verapdf is not on the path'); continue; }
      assert.deepEqual(failed, [], `veraPDF -f ${flavour}`);
      PASSES.push(`archival ${standard} -f ${flavour}`);
    }
  });
}

/** The tree read as `Type` names, a kid's shape `Type(kid kid)`, for the assertions' messages. */
function shape(elements: StructElement[], at = 0): string {
  const e = elements[at];
  const kids = e.children.filter((c): c is number => typeof c === 'number');
  return `${e.type}${kids.length ? `(${kids.map((k) => shape(elements, k)).join(' ')})` : ''}`;
}

for (const [fixture, engine] of [['older-tags', 'strip'], ['older-tags-pagedjs', 'pagedjs']] as const) {
  test(`under ua-1 with a-2a, ${fixture} reads the tag table backwards: the 1.7 types by name, no namespace, a link's Reference holding its Link, a note a Note with its own /ID`, async (t) => {
    const printed = await printDoc(`${fixture}/index.html`, { standard: ['ua-1', 'a-2a'] }, { engine });
    assert.ok(printed.bytes, printed.refused);
    const elements = printed.list?.structure.elements ?? [];
    const tree = shape(elements);
    const types = new Set(elements.map((e) => e.type));
    assert.ok(elements.every((e) => e.namespace === undefined && e.refs === undefined), 'no namespace and no /Ref');
    for (const type of ['FENote', 'Title', 'DocumentFragment', 'Sub', 'Artifact']) assert.ok(!types.has(type), `no ${type}: ${tree}`);
    const mapped = new Set((printed.list?.structure.roleMap ?? []).map((m) => m.type));
    for (const type of ['Em', 'Strong', 'Aside']) assert.equal(mapped.has(type), types.has(type), `the role map names ${type} exactly where the tree holds one`);
    const parentOf = (index: number) => elements.findIndex((e) => e.children.includes(index));
    for (const [index, e] of elements.entries()) {
      if (e.children.some((c) => typeof c === 'object' && 'link' in c)) assert.equal(e.type, 'Link', `${e.path} owns an annotation and is a Link (ISO 14289-1, 7.18.5): ${tree}`);
      if (e.type === 'Reference') assert.ok(e.children.some((c) => typeof c === 'number' && elements[c].type === 'Link'), `${e.path} holds a Link`);
      if (e.type === 'Link' && elements[parentOf(index)].type === 'Reference') assert.equal(e.path, `${elements[parentOf(index)].path}/Link[0]`);
    }
    if (fixture === 'older-tags') for (const type of ['BlockQuote', 'Code', 'Quote', 'TOC', 'TOCI', 'Reference']) assert.ok(types.has(type), `a ${type}: ${tree}`);
    const notes = elements.filter((e) => e.type === 'Note');
    if (fixture === 'older-tags-pagedjs') {
      assert.ok(notes.length >= 2, `the notes are Notes: ${tree}`);
      assert.deepEqual(notes.map((n) => n.id), notes.map((_, i) => `note-${i + 1}`), 'each with its own /ID');
      assert.ok(notes.every((n) => !(n.attributes ?? []).some((a) => a.O === 'FENote')), 'and no FENote attribute');
    }
    for (const flavour of ['ua1', '2a']) {
      const failed = verapdf(flavour, printed.bytes, `${fixture}-17`);
      if (failed === null) { t.diagnostic('verapdf is not on the path'); continue; }
      assert.deepEqual(failed, [], `veraPDF -f ${flavour}`);
      PASSES.push(`${fixture} ua-1,a-2a -f ${flavour}`);
    }
  });
}

test('under a-2a a guessed tag lowers the claim to PDF/A-2u with the guess\'s own warning, and beside ua-1 withdraws PDF/UA-1', async (t) => {
  const inject = '<x-aside style="display: block">Guessed by its layout.</x-aside>';
  const alone = await printDoc('archival/index.html', { standard: 'a-2a' }, { inject });
  assert.ok(alone.bytes, alone.refused);
  assert.equal(alone.archival, 'pdfa2u', 'the report names what the file claims');
  assert.equal(alone.list?.info.archival, 'pdfa2u');
  assert.equal(claimsIn(alone.bytes).pdfa, '2U');
  const guesses = alone.warnings?.filter((w) => w.includes('<x-aside>')) ?? [];
  assert.equal(guesses.length, 1, 'one warning, the guess\'s');
  assert.match(guesses[0], /^caster: <x-aside> at .+ was laid out as a block \(display: block\) and printed as an anonymous P; the file claims PDF\/A-2u in place of PDF\/A-2a$/u);
  const both = await printDoc('archival/index.html', { standard: ['ua-1', 'a-2a'] }, { inject });
  assert.ok(both.bytes, both.refused);
  assert.equal(both.conformance, 'tagged', 'the guess withdrew PDF/UA-1');
  assert.equal(both.archival, 'pdfa2u');
  assert.equal(claimsIn(both.bytes).ua1, false);
  assert.ok(both.warnings?.some((w) => w.endsWith('the file does not claim PDF/UA-1, and claims PDF/A-2u in place of PDF/A-2a')));
  const u = await printDoc('archival/index.html', { standard: 'a-2u' }, { inject });
  assert.equal(u.archival, 'pdfa2u', 'under a-2u a guess changes nothing');
  for (const [name, file] of [['guessed-2u', alone.bytes], ['guessed-ua1-2u', both.bytes]] as const) {
    const failed = verapdf('2u', file, name);
    if (failed === null) { t.diagnostic('verapdf is not on the path'); continue; }
    assert.deepEqual(failed, [], `veraPDF -f 2u on ${name}`);
    PASSES.push(`${name} -f 2u`);
  }
});

test('the heading sequence PDF/UA-1 asks for: the first heading an H1; a skip is the walk\'s refusal, never counted here', () => {
  const h = (...levels: number[]) => levels.map((level, i) => ({ path: `Document/H${level}[${i}]`, level, title: `h${i}` }));
  assert.equal(headingBreaks(h(2, 3)).length, 1, 'an h2 first breaks once');
  assert.match(headingBreaks(h(2, 3))[0], /^caster: the first heading, H2 "h0" at Document\/H2\[0\], is not an H1, and PDF\/UA-1 asks a document's headings to begin at H1 \(ISO 14289-1, 7\.4\.2\); the file is tagged and does not claim PDF\/UA-1/u);
  assert.deepEqual(headingBreaks(h(1, 2, 3, 4, 1, 2, 2, 1)), [], 'climbing any number of levels, or repeating one, breaks nothing');
  assert.deepEqual(headingBreaks([]), [], 'no heading, nothing to break');
});

test('under ua-1 a first heading that is no H1 prints as written, withdraws PDF/UA-1 with one warning and leaves PDF/A-2a standing; a skipped level is refused under ua-1 as under every value', async (t) => {
  const printed = await printDoc('headings/index.html', { standard: ['ua-1', 'a-2a'] }, { inject: '<h2>Two</h2><p>Text.</p><h3>Three</h3><p>Text.</p>' });
  assert.ok(printed.bytes, printed.refused);
  assert.equal(printed.conformance, 'tagged', 'a first heading that is no H1 withdraws the claim');
  assert.equal(printed.archival, 'pdfa2a', 'PDF/A-2a asks for tags, not a sequence');
  assert.deepEqual(printed.warnings?.filter((w) => w.includes('ISO 14289-1, 7.4.2')).length, 1);
  assert.ok(printed.list?.structure.elements.some((e) => e.type === 'H2'), 'the H2 is written as the author wrote it');
  assert.equal(claimsIn(printed.bytes).ua1, false);
  const kept = await printDoc('headings/index.html', { standard: 'ua-1' }, { inject: '<h1>One</h1><p>Text.</p><h2>Two</h2><p>Text.</p><h3>Three</h3><p>Text.</p><h1>Again</h1><p>Text.</p><h2>Two</h2><p>Text.</p>' });
  assert.equal(kept.conformance, 'pdfua1', 'a sequence that climbs keeps the claim');
  for (const [name, file, flavour, expected] of [['broken-2a', printed.bytes, '2a', []], ['kept-ua1', kept.bytes, 'ua1', []]] as const) {
    if (!file) continue;
    const failed = verapdf(flavour, file, name);
    if (failed === null) { t.diagnostic('verapdf is not on the path'); continue; }
    assert.deepEqual(failed, expected, `veraPDF -f ${flavour} on ${name}`);
    PASSES.push(`${name} -f ${flavour}`);
  }
  const skip = '<h1>One</h1><p>Text.</p><h2>Two</h2><p>Text.</p><h4>Four</h4><p>Text.</p>';
  for (const standard of ['ua-1', 'ua-2'] as const) {
    const refused = await printDoc('headings/index.html', { standard }, { inject: skip });
    assert.match(refused.refused ?? '', /^caster: heading level jumps from H2 to H4 at /u, `${standard} refuses a skip, as every value does`);
  }
});

test('under a PDF/A-2 claim with a CMYK intent, a gradient and a transparency group in RGB name the sRGB profile themselves, and a run in a CMYK ink is kept', async (t) => {
  const printed = await printDoc('archival-cmyk/index.html', { standard: ['ua-1', 'a-2b'] }, { profile: true });
  assert.ok(printed.bytes, printed.refused);
  const text = printed.bytes.toString('latin1');
  assert.ok(!/\/ShadingType \d+\s*\/ColorSpace \/DeviceRGB/u.test(text), 'no shading names /DeviceRGB');
  assert.ok(/\/Subtype \/Form[\s\S]*?\/DefaultRGB/u.test(text), 'a form names its own /DefaultRGB');
  for (const flavour of ['2b', 'ua1']) {
    const failed = verapdf(flavour, printed.bytes, 'archival-cmyk-17');
    if (failed === null) { t.diagnostic('verapdf is not on the path'); continue; }
    assert.deepEqual(failed, [], `veraPDF -f ${flavour}`);
    PASSES.push(`archival-cmyk ua-1,a-2b -f ${flavour}`);
  }
});

test('under a PDF/A-2 member, what PDF/A-4 refuses is refused in PDF/A-2\'s words', async () => {
  const cmyk = await printDoc('archival-cmyk/index.html', { standard: ['ua-1', 'a-2b'] });
  assert.match(cmyk.refused ?? '', /^caster: text item \d+ of page 1 is painted in CMYK, and no CMYK profile stands behind it: the output intent is an RGB profile, so the file could not say what the ink means, which PDF\/A-2 asks of every colour \(ISO 19005-2, 6\.2\.4\.3\); pass a CMYK profile as the `profile` option, or print without the PDF\/A-2 member in `standard`$/u);
  const facsimile = await printDoc('roads/facsimile.html', { standard: 'a-2u' });
  assert.match(facsimile.refused ?? '', /a page of another PDF, which Caster copies as it is and does not read, so it cannot stand behind it under PDF\/A-2; print without the PDF\/A-2 member in `standard`, or place the page as an image$/u);
});

test('a list is held to its version: a claim on the other version, a namespace or a /Ref in a 1.7 list, a role map in a 2.0 one', () => {
  const list = JSON.parse(fs.readFileSync(path.join(LISTS, 'paper.json'), 'utf8')) as DisplayList;
  const refused = (amend: (l: DisplayList) => void) => {
    const copy = structuredClone(list);
    amend(copy);
    try { validateList(copy); return null; } catch (error) { return (error as Error).message; }
  };
  assert.equal(refused((l) => { l.info.conformance = 'pdfua1'; }), 'caster: the display list claims pdfua1, a claim on PDF 1.7, and its file is PDF 2.0; a claim fixes the version');
  assert.equal(refused((l) => { l.info.pdf = '1.7'; }), 'caster: the display list claims pdfua2, a claim on PDF 2.0, and its file is PDF 1.7; a claim fixes the version');
  assert.equal(refused((l) => { l.info.pdf = '1.7'; l.info.conformance = 'pdfua1'; l.info.archival = 'pdfa4'; }), 'caster: the display list claims pdfa4, a claim on PDF 2.0, and its file is PDF 1.7; a claim fixes the version');
  assert.match(refused((l) => { l.info.pdf = '1.7'; l.info.conformance = 'tagged'; }) ?? '', /^caster: structure element \d+ \(.+\) names a namespace in a PDF 1\.7 list, and a PDF 1\.7 file has neither namespaces nor the \/Ref key$/u);
  assert.equal(refused((l) => { l.structure.roleMap = [{ type: 'Em', mapped: 'Span' }]; }), 'caster: the display list carries a role map and its file is PDF 2.0; only a PDF 1.7 file writes the custom types a role map names');
});

test.after(() => { if (PASSES.length) console.log(`ℹ veraPDF passed ${WRITER}'s files: ${PASSES.join('; ')}`); });
