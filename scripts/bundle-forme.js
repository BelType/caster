/**
 * `scripts/bundle-forme.js` — builds `vendor/forme.js` and `vendor/forme_bg.wasm`, the Rust writer, from a forme checkout, and copies its `NOTICE` beside them as `vendor/forme-NOTICE.txt`.
 *
 * @remarks
 * forme is `codeberg.org/BelType/forme`; the checkout is `FORME`, the sibling `../forme` by default, as `scripts/identity.ts` reads `BELTYPE_CLI`. The build is the recipe forme's README records, and it is load-bearing: cargo performs no LTO on a library whose crate types include `rlib`, so the module is built as a `cdylib` alone (`cargo rustc --lib --crate-type cdylib`, the `wasm` profile), or it is about 134 kB larger; the two `--remap-path-prefix` flags keep the builder's home directory out of the panic locations. Then wasm-bindgen writes the glue (`--target web`, which the capability registry imports and initialises with the bytes it fetched, `emit/forme.ts`), and `wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int` shrinks the module; without the two flags `wasm-opt` refuses it, because rustc 1.99 emits both features. wasm-bindgen's command line must be the version forme's `Cargo.lock` pins, or the glue and the module disagree; this refuses another.
 *
 * Nothing is fetched at run time; the build fetches crates, as `pnpm install` fetches packages. It rewrites the forme rows of `vendor/README.md` and its section on forme, with the commit, the toolchain and the sizes; `scripts/bundle-vendor.js` keeps both as they are.
 *
 *     node scripts/bundle-forme.js        (FORME=<checkout> to name another)
 *
 * The module's size is held to the bytes forme lets Caster delete, `vendor/harfbuzz-subset.wasm` and `vendor/pdf-lib.js` (1 061 704); the script prints it beside the budget.
 *
 * @packageDocumentation
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CasterError } from '../src/errors.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const vendorDir = path.join(here, '..', 'vendor');
const FORME = path.resolve(process.env.FORME ?? path.join(here, '..', '..', 'forme'));

/** The bytes forme lets Caster delete: `harfbuzz-subset.wasm` and `pdf-lib.js`. */
export const BUDGET = 1061704;

/** The heading of `vendor/README.md`'s section on forme, which this script writes and `bundle-vendor.js` keeps. */
export const SECTION = '## `forme.js` and `forme_bg.wasm` are built from forme, not copied';

/** The rows of `vendor/README.md`'s table this script owns, with what each buys. */
export const FILES = [
  { out: 'forme.js', note: 'the Rust writer\'s glue, wasm-bindgen `--target web`: the `Writer` class `emit/forme.js` calls under `writer: \'forme\'`, initialised with the bytes the registry fetched' },
  { out: 'forme_bg.wasm', note: 'the Rust writer: the display list in, the file and the records out. Fetched by the registry and handed to the glue\'s `initSync`' },
  { out: 'forme-NOTICE.txt', note: 'forme\'s `NOTICE`: the notices of the code subsetter adapts, and what forme\'s copies of skrifa, write-fonts, hayro-write and hayro-syntax change, which travel with the module' }
];

const run = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {Record<string,string>} */ env = {}) => execFileSync(cmd, args, { cwd: FORME, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!fs.existsSync(path.join(FORME, 'Cargo.toml'))) throw new CasterError(`bundle-forme: no forme checkout at ${FORME}; set FORME to one`);
  const lock = fs.readFileSync(path.join(FORME, 'Cargo.lock'), 'utf8');
  const pinned = /name = "wasm-bindgen"\nversion = "([^"]+)"/u.exec(lock)?.[1];
  const cli = run('wasm-bindgen', ['--version']).split(' ').pop();
  if (!pinned || cli !== pinned) throw new CasterError(`bundle-forme: forme pins wasm-bindgen ${pinned ?? '(none)'}, and the wasm-bindgen on PATH is ${cli}; install the pinned one (cargo install wasm-bindgen-cli --version ${pinned})`);
  const commit = run('git', ['rev-parse', '--short', 'HEAD']);
  const dirty = run('git', ['status', '--porcelain', '--untracked-files=no']) !== '';
  if (dirty) throw new CasterError(`bundle-forme: the forme checkout at ${FORME} has uncommitted changes; the module must be built from a commit`);
  const tag = run('git', ['tag', '--points-at', 'HEAD']).split('\n').filter(Boolean)[0] ?? null;
  const rustc = run('rustc', ['--version']);
  const wasmOpt = run('wasm-opt', ['--version']);

  const registry = path.join(os.homedir(), '.cargo', 'registry', 'src', 'index.crates.io-1949cf8c6b5b557f');
  run('cargo', ['rustc', '--lib', '--profile', 'wasm', '--target', 'wasm32-unknown-unknown', '--crate-type', 'cdylib'], { RUSTFLAGS: `--remap-path-prefix=${registry}=crates --remap-path-prefix=${FORME}=forme` });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'caster-forme-'));
  try {
    run('wasm-bindgen', ['--target', 'web', '--no-typescript', '--out-dir', work, '--out-name', 'forme', path.join(FORME, 'target', 'wasm32-unknown-unknown', 'wasm', 'forme.wasm')]);
    run('wasm-opt', ['-Oz', '--enable-bulk-memory', '--enable-nontrapping-float-to-int', path.join(work, 'forme_bg.wasm'), '-o', path.join(vendorDir, 'forme_bg.wasm')]);
    const header = `/* forme ${tag ?? 'untagged'} at ${commit}, wasm-bindgen ${pinned} --target web. GENERATED by scripts/bundle-forme.js; do not edit. Regenerate: node scripts/bundle-forme.js */\n`;
    fs.writeFileSync(path.join(vendorDir, 'forme.js'), header + fs.readFileSync(path.join(work, 'forme.js'), 'utf8'));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  fs.copyFileSync(path.join(FORME, 'NOTICE'), path.join(vendorDir, 'forme-NOTICE.txt'));

  const size = (/** @type {string} */ name) => fs.statSync(path.join(vendorDir, name)).size;
  const module = size('forme_bg.wasm');
  const glue = size('forme.js');
  const readmePath = path.join(vendorDir, 'README.md');
  const lines = fs.readFileSync(readmePath, 'utf8').split('\n').filter((line) => !FILES.some((f) => line.startsWith(`| \`${f.out}\` |`)));
  const lastRow = lines.findLastIndex((line) => line.startsWith('| `'));
  lines.splice(lastRow + 1, 0, ...FILES.map((f) => `| \`${f.out}\` | forme ${tag ?? commit}, built | ${size(f.out)} | ${f.note} |`));
  const sectionAt = lines.indexOf(SECTION);
  const next = sectionAt < 0 ? -1 : lines.findIndex((line, i) => i > sectionAt && line.startsWith('## '));
  const kept = sectionAt < 0 ? lines : [...lines.slice(0, sectionAt), ...(next < 0 ? [] : lines.slice(next))];
  while (kept.at(-1) === '') kept.pop();
  const section = [
    '',
    SECTION,
    '',
    'forme is BelType\'s Rust PDF writer (`codeberg.org/BelType/forme`), which reads the display list and nothing else. `scripts/bundle-forme.js` builds these three from a forme checkout (`FORME`, the sibling `../forme` by default); `bundle-vendor.js` leaves them alone.',
    '',
    `- forme ${tag ? `tag \`${tag}\`, ` : 'untagged, '}commit \`${commit}\`, with its own copies of skrifa, write-fonts, hayro-write and hayro-syntax under \`vendor/\` (\`forme-NOTICE.txt\` says what each changes).`,
    `- ${rustc}; wasm-bindgen ${pinned} (\`--target web --no-typescript\`), the version forme's \`Cargo.lock\` pins; ${wasmOpt}.`,
    '- The recipe: `cargo rustc --lib --profile wasm --target wasm32-unknown-unknown --crate-type cdylib`, with `RUSTFLAGS` remapping crates.io\'s source folder to `crates` and the checkout to `forme`, then wasm-bindgen, then `wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int` on the module. The crate type is named because cargo performs no LTO on a library that is also an `rlib`.',
    `- The module is ${module} bytes and its glue ${glue}, ${module + glue} together, against the ${BUDGET} bytes forme lets Caster delete (\`harfbuzz-subset.wasm\` and \`pdf-lib.js\`).`,
    ''
  ];
  fs.writeFileSync(readmePath, [...kept, ...section].join('\n'));
  console.log(`vendor/forme_bg.wasm: ${module} bytes; vendor/forme.js: ${glue} bytes; together ${module + glue} against ${BUDGET} (${BUDGET - module - glue} under)`);
}
