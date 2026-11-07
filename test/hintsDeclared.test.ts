/**
 * A print asks no element about a `--pdf-*` hint in a document that declares none, and every place a hint can be declared is one it looks.
 *
 * A miss here is the failure the printer says it never commits, the colour the author demanded quietly dropped, so each door has a page of its own: a yes on one page must not hide a no on another.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './launch.ts';
import { contentType } from '@beltype/common/mime';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const DIST = path.join(PACKAGE, 'dist');
const COMMON = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));
const IMPORT_MAP = `<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>`;

const page = (head: string, body: string) => `<!doctype html><html lang="it"><head><meta charset="utf-8">${IMPORT_MAP}${head}</head><body>${body}</body></html>`;

const HINT = '--pdf-color: device-cmyk(0 0 0 1)';
const script = (code: string) => `<script type="module">${code}</script>`;
const DOORS: Record<string, string> = {
  rule: page(`<style>p { ${HINT} }</style>`, '<p>a</p>'),
  grouped: page(`<style>@media screen { @layer deep { p { ${HINT} } } }</style>`, '<p>a</p>'),
  nested: page(`<style>div { & p { ${HINT} } }</style>`, '<div><p>a</p></div>'),
  imported: page('<link rel="stylesheet" href="/importer.css">', '<p>a</p>'),
  inline: page('', `<p style="${HINT}">a</p>`),
  written: page('', `<p>a</p>${script(`document.querySelector('p').style.setProperty('--pdf-color', 'device-cmyk(0 0 0 1)');`)}`),
  adopted: page('', `<p>a</p>${script(`const sheet = new CSSStyleSheet(); sheet.replaceSync('p { ${HINT} }'); document.adoptedStyleSheets = [sheet];`)}`),
  host: page('', `<div id="host"><p>a</p></div>${script(`document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML = '<style>:host { ${HINT} }</style><slot></slot>';`)}`),
  shadowAdopted: page('', `<div id="host"><p>a</p></div>${script(`const sheet = new CSSStyleSheet(); sheet.replaceSync('::slotted(p) { ${HINT} }'); const root = document.querySelector('#host').attachShadow({ mode: 'open' }); root.innerHTML = '<slot></slot>'; root.adoptedStyleSheets = [sheet];`)}`),
  deepShadow: page('', `<div id="host"></div>${script(`const root = document.querySelector('#host').attachShadow({ mode: 'open' }); root.innerHTML = '<div id="inner"></div>'; root.querySelector('#inner').attachShadow({ mode: 'open' }).innerHTML = '<p style="${HINT}">a</p>';`)}`),
  artifact: page('<style>p { --pdf-artifact: layout }</style>', '<p>a</p>'),
  foreign: 'FOREIGN',
};
const NONE = page('<style>:root { --pdf-bleed: 3mm; --pdf-marks: crop } p { color: red; --other: 1 } @media screen { p { color: blue } }</style>', '<p style="--other: 2; --pdf-trim-inset: 0px">a</p>');

test('every door a hint can come through is looked at', async () => {
  const serve = (host: (url: URL) => string|undefined) => http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const text = host(url);
    if (text !== undefined) return void response.writeHead(200, { 'Content-Type': url.pathname.endsWith('.css') ? 'text/css' : 'text/html' }).end(text);
    const [root, rel] = url.pathname.startsWith('/common/') ? [COMMON, url.pathname.slice(8)] : [DIST, url.pathname.slice(1)];
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': contentType(file) }).end(fs.readFileSync(file));
  });
  const elsewhere = serve((url) => (url.pathname === '/foreign.css' ? 'p { color: red }' : undefined));
  await new Promise<void>((resolve) => elsewhere.listen(0, '127.0.0.1', () => resolve()));
  const foreign = page(`<link rel="stylesheet" href="http://127.0.0.1:${(elsewhere.address() as { port: number }).port}/foreign.css">`, '<p>a</p>');
  const server = serve((url) => (url.pathname === '/importer.css' ? '@import url(/imported.css);' : url.pathname === '/imported.css' ? `p { ${HINT} }` : url.pathname === '/none' ? NONE : url.pathname === '/door/foreign' ? foreign : url.pathname.startsWith('/door/') ? DOORS[url.pathname.slice(6)] : undefined));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await launchBrowser();
  const asks = async (where: string) => {
    const tab = await browser.newPage();
    await tab.goto(origin + where);
    const answer = await tab.evaluate(async () => {
      const { declaresHints } = await import('/src/colour/colorHints.js' as string);
      return declaresHints(document) as boolean;
    });
    await tab.close();
    return answer;
  };
  try {
    for (const door of Object.keys(DOORS)) assert.equal(await asks(`/door/${door}`), true, `${door} declares a hint and was not seen`);
    assert.equal(await asks('/none'), false, 'a document that declares no hint is asked as if it did');
    // The survey takes the answer, and a declared property the painting does not read still refuses.
    const tab = await browser.newPage();
    await tab.goto(`${origin}/door/rule`);
    const survey = await tab.evaluate(async () => {
      const { surveyNeeds } = await import('/src/index.js' as string);
      const before = surveyNeeds(document, document.body, {});
      document.head.insertAdjacentHTML('beforeend', '<style>p { --pdf-fill: red }</style>');
      document.querySelector('style')?.remove();
      try { surveyNeeds(document, document.body, {}); return { before, refused: null }; } catch (error) { return { before, refused: String((error as Error).message) }; }
    });
    assert.equal(survey.before.colourHints, true);
    assert.match(survey.refused ?? '', /--pdf-fill/);
  } finally {
    await browser.close();
    server.close();
    elsewhere.close();
  }
});
