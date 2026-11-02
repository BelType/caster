/**
 * `node scripts/number-tokens.ts <out.txt>`: every distinct number token of the content streams the oracle wrote, one per line, for forme's number test.
 *
 * @remarks
 * Reads every committed file in `fixtures/lists/` (the oracle's, one per printed list), inflates each content stream through mupdf (page contents, Form XObjects, tiling patterns), tokenises it as ISO 32000-2 §7.2 does, and keeps each number token as it is written, sorted and without duplicates. forme parses each as a double and formats it back by its own rule, and names every token that comes back otherwise (the measurement of stage 1 of `.claude/plans/the-rust-writer/plan-rust-writer.md`, in the BelType monorepo, finding 5). Reads only; writes the one file it is given.
 *
 * @packageDocumentation
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as mupdf from 'mupdf';

const LISTS = path.join(path.dirname(fileURLToPath(new URL('../package.json', import.meta.url))), 'fixtures', 'lists');
const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)$/u;
const DELIMITER = new Set([...'()<>[]{}/%']);
const WHITE = new Set([0, 9, 10, 12, 13, 32]);

/** The number tokens of one decoded content stream, outside strings, names and comments. */
function numbersOf(bytes: Uint8Array, into: Set<string>) {
  let at = 0;
  while (at < bytes.length) {
    const c = bytes[at];
    const ch = String.fromCharCode(c);
    if (WHITE.has(c)) { at += 1; continue; }
    if (ch === '%') { while (at < bytes.length && bytes[at] !== 10 && bytes[at] !== 13) at += 1; continue; }
    if (ch === '(') {
      let depth = 0;
      for (; at < bytes.length; at += 1) {
        if (bytes[at] === 92) { at += 1; continue; }
        if (bytes[at] === 40) depth += 1;
        if (bytes[at] === 41 && --depth === 0) break;
      }
      at += 1;
      continue;
    }
    if ((ch === '<' || ch === '>') && bytes[at + 1] === c) { at += 2; continue; }
    if (ch === '<') { while (at < bytes.length && bytes[at] !== 62) at += 1; at += 1; continue; }
    if (DELIMITER.has(ch) && ch !== '/') { at += 1; continue; }
    // A name or a bare token: read to the next white space or delimiter.
    let end = at + 1;
    while (end < bytes.length && !WHITE.has(bytes[end]) && !DELIMITER.has(String.fromCharCode(bytes[end]))) end += 1;
    const token = Buffer.from(bytes.subarray(at, end)).toString('latin1');
    if (ch !== '/' && NUMBER.test(token)) into.add(token);
    at = end;
  }
}

const out = process.argv[2];
if (!out) throw new Error('usage: node scripts/number-tokens.ts <out.txt>');
const tokens = new Set<string>();
let streams = 0;
const files = fs.readdirSync(LISTS).filter((name) => name.endsWith('.pdf')).sort();
for (const name of files) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(path.join(LISTS, name)), 'application/pdf') as mupdf.PDFDocument;
  const contents = new Set<number>();
  for (let p = 0; p < doc.countPages(); p += 1) {
    const value = doc.loadPage(p).getObject().get('Contents');
    if (value.isArray()) value.forEach((ref) => contents.add(ref.asIndirect()));
    else contents.add(value.asIndirect());
  }
  for (let n = 1; n < doc.countObjects(); n += 1) {
    const obj = doc.newIndirect(n);
    if (!obj.isStream()) continue;
    const content = contents.has(n) || obj.get('Subtype').toString() === '/Form' || obj.get('PatternType').toString() === '1';
    if (!content) continue;
    numbersOf(new Uint8Array(obj.readStream().asUint8Array()), tokens);
    streams += 1;
  }
}
const sorted = [...tokens].sort();
fs.writeFileSync(out, `${sorted.join('\n')}\n`);
console.log(`${sorted.length} distinct number tokens from ${streams} content streams of ${files.length} files`);
