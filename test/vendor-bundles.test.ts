/**
 * The vendor bundles import in a TAB and their entry points work — §10.1's one-page proof.
 *
 * Everything else about `vendor/` is a build fact (`scripts/bundle-vendor.js` says whether esbuild left a `require(` behind). This is the fact that build cannot check: the five bundles evaluate in a browser realm with no `process` and no `Buffer`, the two Emscripten glues locate their `.wasm` through `import.meta.url` from beside the bundle, and `harfbuzz-subset.wasm` compiles with no imports at all — which is what `fonts/hbSubset.js` does with it.
 *
 * It launches through `@egildo/beltype-browser-chromium`, whose baseline is measured rather than assumed. `assertChromiumBaseline` is deliberately NOT called: this suite is about the bundles, not about which Chromium the machine has.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './launch.ts';
import { contentType } from '@beltype/common/mime';
import type { Server } from 'node:http';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const DIST = path.join(PACKAGE, 'dist');

/** A static server over the BUILT package (dist/, where copy-assets puts vendor/ and profiles/ beside src/) — the registry resolves every URL relative to `src/capabilities.js`, so serving the package IS the whole contract. */
function serve() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><meta charset="utf-8"><title>caster vendor proof</title>');
      return;
    }
    const file = path.join(DIST, url.pathname);
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': contentType(file) });
    response.end(fs.readFileSync(file));
  });
  return new Promise<any>((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('the mime table answers for .wasm, which is what serves the two wasm capabilities', () => {
  assert.equal(contentType('/vendor/harfbuzz.wasm'), 'application/wasm');
});

test('every committed bundle is the size its own README declares', () => {
  // `vendor/README.md` is the generator's own output — `bundle-vendor.js` writes the table from the bytes it just wrote — so the table and the files agree by construction on the machine that ran it, and nowhere else. Nothing pinned them, and two of them had drifted from what the script produces: `harfbuzz.js` and `lcms.js` each carried thirteen bytes less than a fresh run, an inert `"use strict"` in the node-absent stub wrapper. A bundle nobody can reproduce is a dependency nobody can audit, which is the reason this directory is committed at all.
  const readme = fs.readFileSync(path.join(PACKAGE, 'vendor', 'README.md'), 'utf8');
  const declared: [string,number][] = [];
  for (const row of readme.split('\n')) {
    const match = /^\|\s*`([^`]+)`\s*\|[^|]*\|\s*(\d+)\s*\|/.exec(row);
    if (match) declared.push([match[1], Number(match[2])]);
  }
  assert.equal(declared.length, 12, `the table lists every artifact: ${JSON.stringify(declared.map(([name]) => name))}`);
  for (const [name, bytes] of declared) {
    assert.equal(fs.statSync(path.join(PACKAGE, 'vendor', name)).size, bytes, `${name} is the size the table declares`);
  }
  // And the directory holds nothing the table does not name.
  const onDisk = fs.readdirSync(path.join(PACKAGE, 'vendor')).filter((name) => name !== 'README.md').sort();
  assert.deepEqual(onDisk, declared.map(([name]) => name).sort(), 'the table names every file in the directory');
});

test('every committed bundle imports in a tab and its entry point answers', async (t) => {
  const server = (await serve() as Server);
  const port = (server.address() as any).port;
  let browser;
  try {
    browser = await launchBrowser();
  } catch (error) {
    server.close();
    t.skip(`no Chromium available: ${(error as Error).message.split('\n')[0]}`);
    return;
  }
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', ( e: Error) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/`);
    const found = await page.evaluate(async () => {
      /** The bundles are served files, not module specifiers this project resolves; `load` keeps the specifier off tsc's static graph. */
      const load = ( p: string) => import(/* webpackIgnore: true */ p);
      const out: Record<string,unknown> = {};
      const pdf = (await load('/vendor/pdf-lib.js') as any);
      const doc = await pdf.PDFDocument.create();
      doc.addPage([595.276, 841.89]);
      out.pdfLib = { hasCreate: typeof pdf.PDFDocument?.create === 'function', bytes: (await doc.save()).length };
      const fontkit = (await load('/vendor/fontkit.js') as any);
      out.fontkit = { create: typeof (fontkit.create), hasDefault: 'default' in fontkit };
      const fastPng = (await load('/vendor/fast-png.js') as any);
      out.fastPng = { encode: typeof (fastPng.encode), decode: typeof (fastPng.decode) };
      const hb = (await load('/vendor/harfbuzz.js') as any);
      out.harfbuzz = { keys: Object.keys(hb).sort(), blob: typeof hb.createBlob };
      const subsetWasm = await (await fetch('/vendor/harfbuzz-subset.wasm')).arrayBuffer();
      const compiled = await WebAssembly.compile(subsetWasm);
      out.hbSubset = { bytes: subsetWasm.byteLength, imports: WebAssembly.Module.imports(compiled).length, hasSubset: WebAssembly.Module.exports(compiled).some((e) => e.name === 'hb_subset_or_fail') };
      const lcms = (await load('/vendor/lcms.js') as any);
      out.lcms = { keys: Object.keys(lcms).sort().slice(0, 6) };
      // wawoff2: the ONE bundle whose whole claim is that its promise SETTLES (S46). An entry point that merely exists proves nothing here — `decompress` was always a function, and the defect was that it awaited a flag written to an empty object. So it is handed bytes that are certainly not a WOFF2 and raced against a deadline: a REJECTION is the pass, because reaching the rejection means the runtime initialised. An unpatched bundle times out instead, which is the exact symptom.
      const wawoff2 = (await load('/vendor/wawoff2.js') as any);
      const garbage = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
      const timeout = new Promise<any>((resolve) => setTimeout(() => resolve('NEVER SETTLED'), 15000));
      const settled = await Promise.race([
        Promise.resolve(wawoff2.decompress(garbage)).then(() => 'resolved', () => 'rejected'),
        timeout
      ]);
      out.wawoff2 = { decompress: typeof wawoff2.decompress, settled };
      // forme: the glue initialises from the module's bytes, as `emit/forme.js` hands them over, and a write answers; a list that is not one is refused with the validator's sentence, which only a module that ran can give.
      const forme = (await load('/vendor/forme.js') as any);
      forme.initSync({ module: new Uint8Array(await (await fetch('/vendor/forme_bg.wasm')).arrayBuffer()) });
      const writer = new forme.Writer();
      try { writer.write('{"version":1}'); out.forme = 'wrote'; } catch (error) { out.forme = String((error as Error).message); }
      writer.free();
      return out;
    });
    assert.deepEqual(errors, [], 'the bundles evaluated with no page error');

    // pdf-lib: the object layer produces a file.
    assert.equal((found.pdfLib as any).hasCreate, true);
    assert.ok((found.pdfLib as any).bytes > 400, 'pdf-lib wrote a document');

    // fontkit: the browser build has NO default export — the named `create` is the door (measured before this round; re-measured here).
    assert.equal((found.fontkit as any).create, 'function');
    assert.equal((found.fontkit as any).hasDefault, false);

    assert.equal((found.fastPng as any).decode, 'function');
    assert.equal((found.fastPng as any).encode, 'function');

    // harfbuzzjs: `dist/index.mjs` runs `init(await createHarfBuzz())` at module top level, so a resolved import means the wasm beside the bundle was found and instantiated.
    assert.ok((found.harfbuzz as any).keys.length > 0, 'harfbuzzjs exported something after its top-level init');

    // harfbuzz-subset.wasm is NOT glue-bound: it compiles with zero imports, which is why it is a plain file the registry fetches.
    assert.equal((found.hbSubset as any).bytes, 622493);
    assert.equal((found.hbSubset as any).imports, 0);
    assert.equal((found.hbSubset as any).hasSubset, true);

    assert.ok((found.lcms as any).keys.length > 0, 'lcms-wasm exported something');

    // wawoff2: the whole point of the export patch in `scripts/bundle-vendor.js`.
    assert.equal((found.wawoff2 as any).decompress, 'function');
    assert.equal((found.wawoff2 as any).settled, 'rejected', 'the WOFF2 decoder initialised and answered — an unpatched bundle returns NEVER SETTLED here');

    // forme: the Rust writer ran in the tab and refused a list of another version by name.
    assert.match(found.forme as string, /version/, `forme answered in the tab: ${found.forme}`);
  } finally {
    await browser.close();
    server.close();
  }
});
