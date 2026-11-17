/**
 * The older tag names are written in the older namespace (`fixtures/older-tags/`): a quotation, code, a contents and a link inside the document are the PDF 1.7 types PDF/UA-2 asks for, each in the PDF 1.7 namespace, and a footnote says what it is.
 *
 * @remarks
 * *the older tag names are written in the older namespace* (`codeberg.org/BelType/decisions`, 2026-11-17). The page is a host strip of the body, so no engine is involved; the footnote's call, which only a paginator writes, is `olderTagsPagedjs.test.ts`'s. Where ISO/TS 32005 forbids an older type in a position the file keeps the flat type there, and the fixture holds three such positions: a quotation block in a table cell, code inside a contents entry's link, and a link holding code. veraPDF's `ua2` profile judges the file where `verapdf` is on the path, under the writer the run prints with (`test/writer.ts`).
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

import type { StructElement } from '../src/displayList.ts';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const DIST = path.join(PACKAGE, 'dist');
const COMMON = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));
const FIXTURES = path.join(PACKAGE, 'fixtures');
const IMPORTS = `<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>`;
const OLDER = 'http://iso.org/pdf/ssn';

/** Print `fixtures/<name>/index.html` with the writer the run names: as one host-strip page, or as the pages Paged.js presented, through its adapter. */
export async function printFixture(name: string, engine: 'strip' | 'pagedjs' = 'strip'): Promise<{ bytes: Buffer; elements: StructElement[] }> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end(fs.readFileSync(path.join(FIXTURES, name, 'index.html'), 'utf8').replace('<head>', `<head>${IMPORTS}<base href="/fixtures/${name}/">`));
    const [root, rel] = url.pathname.startsWith('/common/') ? [COMMON, url.pathname.slice(8)] : url.pathname.startsWith('/fixtures/') ? [FIXTURES, url.pathname.slice(10)] : [DIST, url.pathname.slice(1)];
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': contentType(file) }).end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const browser = await launchBrowser();
  try {
    const tab = await browser.newPage();
    await tab.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    await tab.evaluate(() => document.fonts.ready);
    const { base64, elements } = await tab.evaluate(async ([writer, engine]: string[]) => {
      const caster = await import('/src/index.js' as string);
      if (engine === 'pagedjs') {
        const { adaptPagedjs } = await import('/src/adapters/pagedjs.js' as string);
        const printed = await caster.print({ document, strip: adaptPagedjs(document) }, { writer });
        let binary = '';
        for (const byte of printed.bytes as Uint8Array) binary += String.fromCharCode(byte);
        return { base64: btoa(binary), elements: printed.displayList.structure.elements };
      }
      caster.prepare(document);
      const strip = document.body;
      const box = strip.getBoundingClientRect();
      const pt = (px: number) => Math.round(((px * 72) / 96) * 1000) / 1000;
      const printed = await caster.print({
        document,
        strip: {
          strip, probeRoot: strip, pageElements: [strip],
          pages: [{ element: strip, index: 0, flow: [...strip.children], flowBox: null, trimBox: null, nominal: { widthPt: pt(box.width), heightPt: pt(box.height) }, declaredPx: { widthPx: box.width, heightPx: box.height }, contentArea: strip, continuations: [] }],
          pageOfNode: new Map(), twinOf: () => null, transparent: () => false, lang: 'en', pageElementOf: () => strip, backgrounds: [],
        },
      }, { writer });
      let binary = '';
      for (const byte of printed.bytes as Uint8Array) binary += String.fromCharCode(byte);
      return { base64: btoa(binary), elements: printed.displayList.structure.elements };
    }, [WRITER, engine]);
    return { bytes: Buffer.from(base64, 'base64'), elements: elements as StructElement[] };
  } finally {
    await browser.close();
    server.close();
  }
}

/** veraPDF's failed `ua2` rules on a file, or null where veraPDF is not on the path. */
export function verapdfUa2(bytes: Buffer, name: string): string[] | null {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'caster-older-')), `${name}.pdf`);
  fs.writeFileSync(file, bytes);
  const run = spawnSync('verapdf', ['--flavour', 'ua2', '--format', 'json', file], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (run.error || !run.stdout) return null;
  return JSON.parse(run.stdout).report.jobs.flatMap((job: any) => (job.validationResult ?? [{ details: { ruleSummaries: [{ clause: 'not validated', testNumber: 0, failedChecks: 0 }] } }])
    .flatMap((result: any) => result.details.ruleSummaries.map((rule: any) => `${rule.clause} t${rule.testNumber} (${rule.failedChecks})`)));
}

/** The tree read as `Type[ns]` names, a kid's shape `Type(kid kid)`, for the assertions' messages. */
function shape(elements: StructElement[], at = 0): string {
  const e = elements[at];
  const kids = e.children.filter((c): c is number => typeof c === 'number');
  return `${e.type}${kids.length ? `(${kids.map((k) => shape(elements, k)).join(' ')})` : ''}`;
}

test('a quotation, code, a contents and a link inside the document are their PDF 1.7 types, in the PDF 1.7 namespace', async (t) => {
  const { bytes, elements } = await printFixture('older-tags');
  const tree = shape(elements);
  const of = (type: string) => elements.filter((e) => e.type === type);
  const parentOf = (index: number) => elements.findIndex((e) => e.children.includes(index));
  const typeOfParent = (e: StructElement) => elements[parentOf(elements.indexOf(e))].type;
  const kidsOf = (e: StructElement) => e.children.filter((c): c is number => typeof c === 'number').map((k) => elements[k]);
  const pathOf = (e: StructElement) => e.path;

  for (const e of elements) assert.equal(e.namespace, ['BlockQuote', 'Code', 'Quote', 'TOC', 'TOCI', 'Reference'].includes(e.type) ? OLDER : undefined, `${e.path} (${e.type}) names its namespace exactly where its type is an older one`);

  // The belt's contents: its title a heading beside the TOC, its entries TOCI, each link a Reference naming its heading, the nested list a TOC inside the entry.
  const [belt, declared] = of('TOC').filter((toc) => typeOfParent(toc) !== 'TOCI');
  assert.ok(belt && declared, `two contents at the top: ${tree}`);
  assert.ok(of('H2').some((h) => typeOfParent(h) === typeOfParent(belt)), 'the contents\' title is a heading beside the TOC');
  const h1 = of('H1')[0];
  const h2 = of('H2').at(-1)!;
  const firstEntry = kidsOf(belt)[0];
  assert.equal(firstEntry.type, 'TOCI');
  const [reference, nested] = kidsOf(firstEntry).filter((k) => k.type !== 'P');
  assert.equal(reference.type, 'Reference');
  assert.deepEqual(reference.refs, [elements.indexOf(h1)], 'the entry\'s Reference names the heading it leads to');
  assert.equal(nested.type, 'TOC', 'a list nested in an entry is a TOC in the TOCI');
  const nestedReference = kidsOf(kidsOf(nested)[0]).find((k) => k.type === 'Reference')!;
  assert.deepEqual(nestedReference.refs, [elements.indexOf(h2)]);

  // `role="doc-toc"`: the declared contents, its numbers a Lbl, and code in an entry's link a Span, since a Reference may not hold a Code.
  const declaredEntry = kidsOf(declared)[0];
  assert.deepEqual(kidsOf(declaredEntry).map((k) => k.type).filter((k) => k !== 'P'), ['Lbl', 'Reference']);
  assert.ok(kidsOf(kidsOf(declaredEntry).find((k) => k.type === 'Reference')!).every((k) => k.type === 'Span'), 'code in a contents entry is a Span');

  // Code: in a heading, in a paragraph, in a fenced block (a P holding a Code), in a cell; a key stays a Span.
  const codes = of('Code').map(typeOfParent);
  assert.deepEqual(codes.sort(), ['H1', 'Link', 'P', 'P', 'TD'], `code stands in a heading, a paragraph, a fenced block, a link and a cell: ${tree}`);
  assert.ok(of('Span').length >= 1, 'the key is a Span');

  // Quotations: inline in a paragraph, a cell and a list item; a block in a section; a block in a cell is a Div.
  assert.deepEqual(of('Quote').map(typeOfParent).sort(), ['LBody', 'P', 'TD']);
  assert.deepEqual(of('BlockQuote').map(typeOfParent), ['Sect']);
  assert.ok(of('TD').some((td) => kidsOf(td).some((k) => k.type === 'Div')), 'a block quotation in a cell is a Div');

  // Links: inside the document a Reference with a /Ref; out of it a Link; a link holding code a Link, its /Ref kept.
  const references = of('Reference').filter((r) => typeOfParent(r) === 'P');
  assert.deepEqual(references.map((r) => r.refs), [[elements.indexOf(h2)]], 'the paragraph\'s internal link is a Reference naming its target');
  const links = of('Link');
  assert.equal(links.length, 3, `the address, the mail and the link holding code: ${links.map(pathOf)}`);
  assert.deepEqual(links.map((l) => l.refs), [undefined, undefined, [elements.indexOf(h1)]]);

  // The footnote: a footnote, and nothing calls it.
  const [note] = of('FENote');
  assert.deepEqual(note.attributes, [{ O: 'FENote', NoteType: 'Footnote' }]);
  assert.equal(note.refs, undefined, 'a note nothing calls carries no /Ref');

  const text = bytes.toString('latin1');
  assert.equal((text.match(/\/Type \/Namespace/g) ?? []).length, 2, 'two namespace objects');
  assert.match(text, /\(http:\/\/iso\.org\/pdf\/ssn\)/);
  const failed = verapdfUa2(bytes, 'older-tags');
  if (failed === null) t.diagnostic('verapdf is not on the path');
  else assert.deepEqual(failed, [], 'veraPDF -f ua2 fails no rule');
});

test('under Paged.js a footnote and its call name each other: the call a Reference with a /Ref to the FENote, the FENote a /Ref to its call, the call\'s link a structure destination naming the note', async (t) => {
  const { bytes, elements } = await printFixture('older-tags-pagedjs', 'pagedjs');
  const notes = elements.filter((e) => e.type === 'FENote');
  const calls = elements.filter((e) => e.type === 'Reference');
  assert.equal(notes.length, 2, 'two notes');
  assert.equal(calls.length, 2, `two calls, each a Reference: ${elements.map((e) => e.type)}`);
  notes.forEach((note, at) => {
    assert.deepEqual(note.attributes, [{ O: 'FENote', NoteType: 'Footnote' }]);
    assert.deepEqual(note.refs, [elements.indexOf(calls[at])], 'the note names its call');
    assert.deepEqual(calls[at].refs, [elements.indexOf(note)], 'the call names its note');
    assert.equal(calls[at].namespace, OLDER);
  });
  const text = bytes.toString('latin1');
  for (const note of notes) {
    const id = elements.indexOf(note);
    assert.ok(elements.every((e) => !e.children.includes(id) || e.type !== 'FENote'), 'a note is no note\'s child');
  }
  assert.equal((text.match(/\/Dest \[/g) ?? []).length, 2, 'each call is a link with a destination');
  const failed = verapdfUa2(bytes, 'older-tags-pagedjs');
  if (failed === null) t.diagnostic('verapdf is not on the path');
  else assert.deepEqual(failed, [], 'veraPDF -f ua2 fails no rule');
});
