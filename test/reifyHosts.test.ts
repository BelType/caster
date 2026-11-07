/**
 * Reification reads a pseudo-element only on an element a rule may give one, and misses none.
 *
 * What a sheet names decides which elements are read (`namedHosts`, `adapters/reify.ts`), so every spelling of such a rule is here, each with the span it has to make: a miss prints a drop capital at the paragraph's size, and refuses a print over a word the census finds unmade. The expected lists were taken from a reification that read every element, before the sheets were asked.
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

/** One rule per spelling. A class names the element, and the text of its `content` names the spelling. */
const GENERATED = page(`<link rel="stylesheet" href="/imported.css"><style>
.legacy:before { content: 'legacy' }
.comma-a::before, .comma-b::after, .comma-c { content: 'comma' }
:is(.is-a, .is-b)::before { content: 'is' }
.parent ::before { content: 'descendant' }
.parent > ::after { content: 'child' }
[title="::before"]::before { content: 'string' }
@media screen { @layer deep { @supports (display: block) { .grouped::after { content: 'grouped' } } } }
@container (min-width: 1px) { .contained::before { content: 'contained' } }
.state:not(:hover)::after { content: 'state' }
.tinted { background: red }
.bare::before { content: '' }
@media print { .print::before { content: 'print' } }
</style>`, `
<p class="legacy">a</p>
<p class="comma-a">a</p><p class="comma-b">a</p><p class="comma-c">a</p>
<p class="is-a">a</p><p class="is-b">a</p>
<div class="parent"><p class="under">a</p></div>
<p title="::before">a</p><p title=":is(*)">a</p>
<p class="grouped">a</p>
<div style="container-type: inline-size"><p class="contained">a</p></div>
<p class="state">a</p>
<p class="imported">a</p><p class="adopted">a</p>
<p class="bare">a</p><p class="print">a</p><p class="plain tinted">a</p>
<div class="host"></div>
<div class="slotting"><span class="slotted">a</span></div>
<script type="module">
const adopted = new CSSStyleSheet();
adopted.replaceSync(".adopted::after { content: 'adopted' }");
document.adoptedStyleSheets = [adopted];
document.querySelector('.host').attachShadow({ mode: 'open' }).innerHTML = "<style>:host::before { content: 'host' }</style>";
document.querySelector('.slotting').attachShadow({ mode: 'open' }).innerHTML = "<style>::slotted(span)::after { content: 'slotted' }</style><slot></slot>";
</script>`);

/** What cannot be narrowed: a nested rule, `@scope`, a universal rule, a sheet the page may not read. Each is alone on its page, or it would hide a fault in the others. */
const NESTED = page(`<style>.nesting { &::before { content: 'nested' } }</style>`, `<p class="nesting">a</p><p class="plain">a</p>`);
const NESTED_MEDIA = page(`<style>.nesting { @media screen { &::after { content: 'nested' } } }</style>`, `<p class="nesting">a</p><p class="plain">a</p>`);
const SCOPED = page(`<style>@scope (.scoped) { p::before { content: 'scoped' } }</style>`, `<div class="scoped"><p class="in">a</p></div><p class="out">a</p>`);
const UNIVERSAL = page(`<style>::before { content: 'all' }</style>`, `<p class="one">a</p><div class="two"><p class="three">a</p></div>`);
const FOREIGN = (origin: string) => page(`<link rel="stylesheet" href="${origin}/foreign.css">`, `<p class="foreign">a</p><p class="plain">a</p>`);

/** Every way a block's first letter comes to differ from the block. */
const LETTERS = page(`<style>
.drop::first-letter { color: rgb(1, 2, 3) }
.legacy:first-letter { font-size: 30px }
.grouped-letter { }
@media screen { .grouped-letter::first-letter { font-weight: 900 } }
.first-line::first-line { color: rgb(4, 5, 6) }
.outer-line::first-line { color: rgb(7, 8, 9) }
.outer-drop::first-letter { color: rgb(1, 2, 3) }
.reset::first-letter { all: unset !important }
</style>`, `
<p class="drop">Prima</p><p class="legacy">Prima</p><p class="grouped-letter">Prima</p><p class="first-line">Prima</p>
<div class="outer-line"><p class="inner-line">Prima</p></div>
<div class="outer-drop"><p class="inner-drop">Prima</p></div>
<p class="reset" style="background: rgb(240, 240, 240)">Prima</p>
<p class="plain" style="background: rgb(240, 240, 240); text-decoration: underline">Prima</p>
<div class="letter-host"></div>
<div class="adopted-letter">Prima</div>
<script type="module">
const adopted = new CSSStyleSheet();
adopted.replaceSync(".adopted-letter::first-letter { color: rgb(1, 2, 3) }");
document.adoptedStyleSheets = [adopted];
const host = document.querySelector('.letter-host');
host.textContent = 'Prima';
host.attachShadow({ mode: 'open' }).innerHTML = "<style>:host::first-letter { color: rgb(1, 2, 3) }</style><slot></slot>";
</script>`);

const LETTERS_NESTED = page(`<style>.nesting { &::first-letter { float: left } }</style>`, `<p class="nesting">Prima</p><p class="plain">Prima</p>`);

/** Every element of HTML, for what the user-agent sheet gives a pseudo-element, which no author sheet names. */
const TAGS = 'a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p picture pre progress q rb rp rt ruby s samp script search section select slot small source span strong style sub summary sup table tbody td template textarea tfoot th thead time title tr track u ul var video wbr'.split(' ');

test('reification', async (t) => {
  const pages: Record<string, string> = { '/generated': GENERATED, '/universal': UNIVERSAL, '/letters': LETTERS, '/letters-nested': LETTERS_NESTED, '/nested': NESTED, '/nested-media': NESTED_MEDIA, '/scoped': SCOPED, '/quote': page('', '<p>a <q>b</q></p>'), '/plain': page('', '') };
  const serve = (host: (url: URL) => string|undefined) => http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const text = host(url);
    if (text !== undefined) return void response.writeHead(200, { 'Content-Type': url.pathname.endsWith('.css') ? 'text/css' : 'text/html' }).end(text);
    const [root, rel] = url.pathname.startsWith('/common/') ? [COMMON, url.pathname.slice(8)] : [DIST, url.pathname.slice(1)];
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': contentType(file) }).end(fs.readFileSync(file));
  });
  const elsewhere = serve((url) => (url.pathname === '/foreign.css' ? ".foreign::before { content: 'foreign' }" : undefined));
  await new Promise<void>((resolve) => elsewhere.listen(0, '127.0.0.1', () => resolve()));
  pages['/foreign'] = FOREIGN(`http://127.0.0.1:${(elsewhere.address() as { port: number }).port}`);
  const server = serve((url) => (url.pathname === '/imported.css' ? "@import url(/imported-deeper.css);" : url.pathname === '/imported-deeper.css' ? ".imported::before { content: 'imported' }" : pages[url.pathname]));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await launchBrowser();
  const open = async (where: string) => {
    const tab = await browser.newPage();
    await tab.goto(origin + where);
    return tab;
  };
  /** Each generated text and the class of the element it was made in, sorted. */
  const generated = (where: string) => open(where).then((tab) => tab.evaluate(async () => {
    const { reify } = await import('/src/adapters/reify.js' as string);
    const made = reify(document).generated.map((g: { element: string; text: string; pseudo: string }) => `${g.element} ${g.pseudo} ${g.text}`);
    return made.sort();
  }));
  try {
    await t.test('every spelling of a rule makes its span', async () => {
      assert.deepEqual(await generated('/generated'), [
        'div.host ::before host',
        'p.adopted ::after adopted',
        'p.comma-a ::before comma',
        'p.comma-b ::after comma',
        'p.contained ::before contained',
        'p.grouped ::after grouped',
        'p.imported ::before imported',
        'p.is-a ::before is',
        'p.is-b ::before is',
        'p.legacy ::before legacy',
        'p.state ::after state',
        'p.under ::after child',
        'p.under ::before descendant',
        'p ::before string',
        'span.slotted ::after slotted'
      ].sort());
    });

    await t.test('a nested rule and @scope leave every element to be asked', async () => {
      assert.deepEqual(await generated('/nested'), ['p.nesting ::before nested']);
      assert.deepEqual(await generated('/nested-media'), ['p.nesting ::after nested']);
      assert.deepEqual(await generated('/scoped'), ['p.in ::before scoped']);
    });

    await t.test('a universal rule reaches every element', async () => {
      const made = await generated('/universal');
      for (const element of ['html ::before all', 'body ::before all', 'p.one ::before all', 'div.two ::before all', 'p.three ::before all']) assert.ok(made.includes(element), `${element} in ${made.join(', ')}`);
    });

    await t.test('a sheet the page may not read leaves every element to be asked', async () => {
      assert.deepEqual(await generated('/foreign'), ['p.foreign ::before foreign']);
    });

    await t.test('a quotation still refuses, though no sheet names it', async () => {
      const tab = await open('/quote');
      const refused = await tab.evaluate(async () => {
        const { reify } = await import('/src/adapters/reify.js' as string);
        try { reify(document); return null; } catch (error) { return String((error as Error).message); }
      });
      assert.match(refused ?? '', /open-quote/);
    });

    await t.test('every way to style a first letter makes its span, and nothing else does', async () => {
      const spanned = (where: string) => open(where).then((tab) => tab.evaluate(async () => {
        const { reify, FIRST_LETTER_CLASS } = await import('/src/adapters/reify.js' as string);
        reify(document);
        return [...document.querySelectorAll(`.${FIRST_LETTER_CLASS.letter}`)].map((span) => span.parentElement?.classList[0]).sort();
      }));
      assert.deepEqual(await spanned('/letters'), ['adopted-letter', 'drop', 'grouped-letter', 'inner-drop', 'legacy', 'letter-host'].sort());
      assert.deepEqual(await spanned('/letters-nested'), ['nesting']);
    });

    await t.test('the user-agent sheet gives a pseudo-element to <q> and to no other element', async () => {
      const tab = await open('/plain');
      const found = await tab.evaluate((tags) => {
        const signs = ['font-size', 'font-family', 'font-weight', 'font-style', 'color', 'text-transform', 'letter-spacing', 'font-variant-caps'];
        const initials = [['float', 'none'], ['vertical-align', 'baseline'], ['background-color', 'rgba(0, 0, 0, 0)'], ['text-decoration-line', 'none']];
        const out: string[] = [];
        for (const tag of tags) {
          const element = document.createElement(tag);
          document.body.append(element);
          for (const pseudo of ['::before', '::after']) {
            const content = getComputedStyle(element, pseudo).content;
            if (content && content !== 'none' && content !== 'normal') out.push(`${tag}${pseudo}`);
          }
          const own = getComputedStyle(element);
          const letter = getComputedStyle(element, '::first-letter');
          if (signs.some((p) => letter.getPropertyValue(p) !== own.getPropertyValue(p)) || initials.some(([p, v]) => letter.getPropertyValue(p) !== v)) out.push(`${tag}::first-letter`);
          element.remove();
        }
        return out;
      }, TAGS);
      assert.deepEqual(found, ['q::before', 'q::after']);
    });
  } finally {
    await browser.close();
    server.close();
    elsewhere.close();
  }
});
