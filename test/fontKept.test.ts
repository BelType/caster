/**
 * A page kept between prints keeps what its faces were read as, and a face the browser made anew is read anew.
 *
 * The font table reads each face through the gateway; a face the browser still holds is the bytes the page paints, so a second print need not fetch or decode it (`readByFace`, `host/fonts.ts`). What must not happen is the old bytes outliving the load: a changed `@font-face` rule, or a new document, has to read the file again.
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
const FONTS = path.join(PACKAGE, 'fixtures', 'specimen', 'fonts');
const IMPORT_MAP = `<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>`;

const RULE = (extra: string) => `@font-face { font-family: Kept; src: url("/fonts/CrimsonPro-Variable.ttf"); font-weight: 200 900; ${extra} } p { font-family: Kept }`;
const PAGE = `<!doctype html><html lang="it"><head><meta charset="utf-8">${IMPORT_MAP}<style id="rule">${RULE('')}</style></head><body><p>Una riga.</p></body></html>`;

test('the font table reads a kept face once, and a new face again', async () => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
    const [root, rel] = url.pathname.startsWith('/common/') ? [COMMON, url.pathname.slice(8)] : url.pathname.startsWith('/fonts/') ? [FONTS, url.pathname.slice(7)] : [DIST, url.pathname.slice(1)];
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': contentType(file) }).end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    const seen = await page.evaluate(async (rule) => {
      const capabilities = await import('/src/capabilities.js' as string);
      await capabilities.load(['fontkit']);
      const { buildFontTable } = await import('/src/host/fonts.js' as string);
      const { createGateway } = await import('/src/host/gateway.js' as string);
      const real = createGateway(new Map());
      let reads = 0;
      const gateway = { ...real, getBytes: (url: string) => { reads += 1; return real.getBytes(url); } };
      const table = async () => {
        await document.fonts.load('16px Kept');
        await document.fonts.ready;
        const built = await buildFontTable(document, gateway);
        return { reads, url: built.descriptors[0]?.url as string, bytes: [...built.bytesByUrl.values()][0] as Uint8Array };
      };
      const first = await table();
      const second = await table();
      (document.getElementById('rule') as HTMLElement).textContent = rule;
      const changed = await table();
      const again = await table();
      // A host seats the next document in the same window (`document.open()`), and the module and its memory stay.
      const html = document.documentElement.outerHTML;
      document.open();
      document.write(`<!doctype html>${html}`);
      document.close();
      const reseated = await table();
      return { first: first.reads, second: second.reads, changed: changed.reads, again: again.reads, reseated: reseated.reads, kept: first.bytes === second.bytes, renewed: first.bytes !== changed.bytes, equal: first.bytes.length === changed.bytes.length, url: first.url };
    }, RULE('font-display: swap'));
    assert.match(seen.url, /CrimsonPro/);
    assert.equal(seen.first, 1, 'the first print reads the face');
    assert.equal(seen.second, 1, 'a second print of a kept page does not read it again');
    assert.ok(seen.kept);
    assert.equal(seen.changed, 2, 'a changed @font-face rule is a new face, and is read again');
    assert.ok(seen.renewed);
    assert.equal(seen.again, 2, 'and is kept from then on');
    assert.ok(seen.equal);
    assert.equal(seen.reseated, 3, 'a document seated in the same window has faces of its own, and reads them');
  } finally {
    await browser.close();
    server.close();
  }
});
