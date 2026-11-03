/**
 * `scripts/bundle-vendor.js` — regenerates `vendor/`: every heavy dependency Caster needs as ONE browser ESM file, with its `.wasm` beside it.
 *
 * Caster's own; no harness source — the harness imported its libraries through Vite, and PLAN.md D3 is why they are committed bundles here instead.
 *
 * The house rule is no build step at install (the Homebrew tap runs `npm ci --omit=dev` on a clone; the import map is the vendoring), and the four libraries the printer needs are CommonJS or mixed and cannot ride an import map: pdf-lib's `es/` build pulls `pako`, fontkit pulls `brotli`/`clone`/`tiny-inflate`. esbuild folds each graph into one file and the artifacts are COMMITTED, on the `scripts/bundle-pug.js` precedent in `packages/editing-tools`.
 *
 * Two of the six are Emscripten modules whose glue locates its `.wasm` through `import.meta.url`: `harfbuzzjs/dist/index.mjs` and `lcms-wasm/dist/lcms.js`. esbuild preserves `import.meta.url` in an ESM output, so the wasm is COPIED beside the bundle and the glue finds it with no configuration. `harfbuzz-subset.wasm` is NOT glue-bound — `hbSubset.js` instantiates it with `WebAssembly.compile` and no imports — so it is copied as a plain file the capability registry fetches.
 *
 * Run after any dependency bump:  npm run bundle-vendor  (in packages/caster)
 *
 * @packageDocumentation
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { BUILD } from './rebuild-harfbuzz.js';
import { FILES as FORME_FILES, SECTION as FORME_SECTION } from './bundle-forme.js';
import { CasterError } from '../src/errors.ts';

/** @import { PluginBuild } from 'esbuild' */

const here = path.dirname(fileURLToPath(import.meta.url));
const vendorDir = path.join(here, '..', 'vendor');
const require = createRequire(import.meta.url);
const stub = path.join(here, 'vendor-stubs', 'node-absent.js');

/**
 * The one SOURCE PATCH this script applies, and it is three lines long (DESIGN.md S46).
 *
 * @remarks
 * `wawoff2`'s Emscripten glue ends its `ENVIRONMENT_IS_NODE` branch with `if(typeof module!=="undefined"){module["exports"]=Module}` and does the same nowhere else. In a tab that branch is dead, so `decompress.js`'s `em_module` is the empty object a CommonJS wrapper handed it, the `onRuntimeInitialized` it writes goes onto nothing, and the promise it awaits never settles — which is what `WOFF2_NEVER_SETTLED` recorded and what made WOFF2 a refusal.
 *
 * Appending the same assignment unconditionally at the END of the glue's own file scope exports the Module in either branch. Nothing else about the browser branch needed fixing: the `.wasm` is a base64 `data:` URI inside the glue, so no `locateFile`, no XHR and no `scriptDirectory` is ever reached.
 */
const EXPORT_THE_MODULE = {
  name: 'wawoff2-export',
  setup(/** @type {PluginBuild} */ build) {
    build.onLoad({ filter: /decompress_binding\.js$/ }, async (/** @type {{ path: string }} */ args) => ({
      contents: await fs.promises.readFile(args.path, 'utf8') + '\nif(typeof module!=="undefined"){module["exports"]=Module}\n',
      loader: 'js'
    }));
  }
};

/**
 * A package's version, read from its own package.json — several of these seal `./package.json` out of their `exports`, so the file is read rather than required.
 *
 * @throws {CasterError} No package.json names `name` between its entry point and the filesystem root. The house rule reaches maintainer scripts too.
 */
function versionOf(/** @type {string} */ name) {
  const entry = require.resolve(name);
  let dir = path.dirname(entry);
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (parsed.name === name) return parsed.version;
    }
    const up = path.dirname(dir);
    if (up === dir) throw new CasterError(`no package.json for ${name}`);
    dir = up;
  }
}

/** One bundle: `export * from '<pkg>'` folded to a single browser ESM file. `entry` overrides the specifier where the package's default export condition is not the one we want. */
const BUNDLES = [
  { out: 'pdf-lib.js', pkg: 'pdf-lib', note: 'the object layer: contexts, streams, pages, operators, the writer' },
  { out: 'fontkit.js', pkg: 'fontkit', note: 'table parsing, glyph outlines, metrics, glyph intercepts. The browser build has NO default export — use the named `create`' },
  { out: 'fast-png.js', pkg: 'fast-png', note: 'a correct PNG decode where one is forced (alpha, Adam7, palette+tRNS)' },
  { out: 'lcms.js', pkg: 'lcms-wasm', note: 'offline RGB->CMYK under `convertRgb: \'wasm\'`. Emscripten glue: `lcms.wasm` must sit beside this file' },
  { out: 'wawoff2.js', pkg: 'wawoff2', entry: `export { default as decompress } from 'wawoff2/decompress.js';`, plugins: [EXPORT_THE_MODULE], note: 'WOFF2 to SFNT in a tab. Its own wasm is a base64 data: URI inside the glue, so nothing sits beside this file; the export patch above is what makes the browser branch reachable' }
];

/** The pair this script does not write: `scripts/rebuild-harfbuzz.js` compiles harfbuzzjs with HarfBuzz's fallback shaping left in (DESIGN.md S101), and a copy from the npm package would put the stock build back. */
const HELD = [
  { out: 'harfbuzz.js', source: 'harfbuzzjs 1.6.1, rebuilt', note: 'shaping that reproduces every browser width and glyph sequence, marks included. Emscripten glue: `harfbuzz.wasm` must sit beside this file' },
  { out: 'harfbuzz.wasm', source: 'harfbuzzjs 1.6.1, rebuilt', note: 'located by harfbuzz.js through import.meta.url' }
];

/** The Rust writer's three files, which `scripts/bundle-forme.js` builds from a forme checkout: their rows and their section are kept as that script last wrote them. */
const readmeBefore = fs.existsSync(path.join(vendorDir, 'README.md')) ? fs.readFileSync(path.join(vendorDir, 'README.md'), 'utf8').split('\n') : [];
const formeRows = readmeBefore.filter((line) => FORME_FILES.some((f) => line.startsWith(`| \`${f.out}\` |`)));
const formeSection = readmeBefore.includes(FORME_SECTION) ? readmeBefore.slice(readmeBefore.indexOf(FORME_SECTION)) : [];

/** Plain file copies — a wasm nothing bundles, or a wasm an Emscripten bundle locates through `import.meta.url`. */
const COPIES = [
  { out: 'harfbuzz-subset.wasm', from: 'harfbuzzjs/dist/harfbuzz-subset.wasm', note: 'fetched and instantiated directly by fonts/hbSubset.js — no glue' },
  { out: 'lcms.wasm', from: 'lcms-wasm/dist/lcms.wasm', note: 'located by lcms.js through import.meta.url' }
];

fs.mkdirSync(vendorDir, { recursive: true });
const rows = [];

for (const spec of BUNDLES) {
  const version = versionOf(spec.pkg);
  const result = await build({
    stdin: { contents: spec.entry ?? `export * from ${JSON.stringify(spec.pkg)};`, resolveDir: path.join(here, '..') },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    write: false,
    legalComments: 'none',
    ...(spec.plugins ? { plugins: spec.plugins } : {}),
    // Both Emscripten glues (harfbuzzjs, lcms-wasm) name `module`, `fs` and `path` inside a branch guarded by `ENVIRONMENT_IS_NODE`, which is `typeof process == 'object' && process.versions?.node` — false in a tab, so the branch is dead and esbuild only needs something to resolve.
    alias: { module: stub, fs: stub, path: stub }
  });
  const header = `/* ${spec.pkg} ${version} — one browser ESM module. GENERATED by scripts/bundle-vendor.js; do not edit. Regenerate: npm run bundle-vendor */\n`;
  const text = header + result.outputFiles[0].text;
  const dest = path.join(vendorDir, spec.out);
  fs.writeFileSync(dest, text);
  const leftovers = /\brequire\(/.test(result.outputFiles[0].text);
  rows.push({ file: spec.out, source: `${spec.pkg} ${version}`, bytes: Buffer.byteLength(text), note: spec.note + (leftovers ? ' — WARNING: a `require(` survived the bundle' : '') });
  console.log(`vendor/${spec.out}: ${spec.pkg} ${version}, ${Buffer.byteLength(text)} bytes${leftovers ? ' (require( survived!)' : ''}`);
}

for (const copy of COPIES) {
  const src = path.join(here, '..', '..', '..', 'node_modules', ...copy.from.split('/'));
  const from = fs.existsSync(src) ? src : require.resolve(copy.from);
  const bytes = fs.readFileSync(from);
  fs.writeFileSync(path.join(vendorDir, copy.out), bytes);
  rows.push({ file: copy.out, source: copy.from, bytes: bytes.length, note: copy.note });
  console.log(`vendor/${copy.out}: ${bytes.length} bytes`);
}

for (const held of HELD) {
  const bytes = fs.statSync(path.join(vendorDir, held.out)).size;
  rows.push({ file: held.out, source: held.source, bytes, note: held.note });
  console.log(`vendor/${held.out}: ${bytes} bytes (held: scripts/rebuild-harfbuzz.js)`);
}

const readme = [
  '# `vendor/` — the committed bundles',
  '',
  'GENERATED by `scripts/bundle-vendor.js`. Do not edit a file here; run `npm run bundle-vendor` after a dependency bump and commit what changes.',
  '',
  'Each is loaded by `src/capabilities.js` through `new URL(rel, import.meta.url)`, never a bare specifier, so any host that serves the package directory can run the printer with no import map at all.',
  '',
  '| file | source | bytes | what it buys |',
  '| :--- | :--- | ---: | :--- |',
  ...rows.map((r) => `| \`${r.file}\` | ${r.source} | ${r.bytes} | ${r.note} |`),
  ...formeRows,
  '',
  '## `harfbuzz.js` and `harfbuzz.wasm` are rebuilt, not copied',
  '',
  'The npm build of harfbuzzjs compiles with `-DHB_TINY`, which drops HarfBuzz\'s fallback shaping: a face that leaves its combining marks out of the GDEF glyph classes (Arial Unicode\'s Hebrew points) then keeps each mark\'s advance, where Blink zeroes it and places the mark. These two are the same harfbuzzjs 1.6.1 sources with one line added to its `config-override.h`, `#undef HB_NO_LEGACY` (DESIGN.md S101). `scripts/rebuild-harfbuzz.js` writes them; `bundle-vendor.js` leaves them alone.',
  '',
  `- Emscripten ${BUILD.image}, image digest \`${BUILD.digest}\`. The harfbuzzjs Makefile is unchanged, and its CI uses 4.0.13: the same sources rebuilt there with no override are byte-identical to the stock \`harfbuzz.wasm\` this directory held before (426620 bytes), and their glue, bundled, to the stock \`harfbuzz.js\`. The 6.0.13 glue names node builtins with a \`node:\` prefix, so \`rebuild-harfbuzz.js\` aliases those to the stub as well.`,
  `- harfbuzzjs ${BUILD.harfbuzzjs} (tag \`v${BUILD.harfbuzzjs}\`) with HarfBuzz 14.4.0 at commit \`${BUILD.harfbuzz}\`, the submodule commit that tag pins.`,
  `- The override: \`${BUILD.override}\`, appended to \`config-override.h\`. Nothing else in harfbuzzjs or HarfBuzz is edited. \`harfbuzz-subset.wasm\` is untouched: it has its own override file and shapes nothing.`,
  '- To rebuild: `docker pull emscripten/emsdk@' + BUILD.digest + '`, then `node scripts/rebuild-harfbuzz.js <harfbuzzjs v1.6.1 checkout> <harfbuzz checkout at the commit above>` (the script runs `docker run --rm -v <work>:/src -w /src emscripten/emsdk@' + BUILD.digest + ' make harfbuzz`), then `docker rmi` the image.',
  ...(formeSection.length ? ['', ...formeSection] : ['']),
].join('\n');
fs.writeFileSync(path.join(vendorDir, 'README.md'), readme);
console.log(`vendor/README.md: ${rows.length} rows`);
