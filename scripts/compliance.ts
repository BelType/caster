/**
 * `npm run compliance -- <dir>`: qpdf and veraPDF over every PDF in `<dir>`, and each verdict held to the oracle's file of the same name.
 *
 * @remarks
 * Ported from the monorepo's `packages/caster/scripts/compliance.js`, which prints Caster's specimen through the editing tools before it judges it. This one prints nothing: it reads the files it is given, as the gate of the Rust writer asks (*the same list prints the same bytes*, DESIGN.md S102; `.claude/plans/the-rust-writer/plan-rust-writer.md` in the BelType monorepo, stage 4). The checkers are a deliberate act, never part of `npm test`: veraPDF is Java and qpdf a C++ binary, and a suite that skipped itself where they are missing would be a green nobody can explain, so this script says plainly what it could not run.
 *
 * What each answers. **qpdf `--check`** says whether the file is well formed and what version it declares, which must be 2.0. **veraPDF** runs the profiles `ua2` (PDF/UA-2 and Tagged PDF) and `wt1a` (Well-Tagged PDF, accessibility), one Java run per profile over every file at once, and its verdict on a file is the set of rules it fails, each with its clause, test number and failed checks. Where `fixtures/lists/` holds a file of the same name, the oracle's, its verdict is read too, and a file whose verdict differs from the oracle's is a failure: the claim is that the two writers fail exactly the same rules. A file with no oracle beside it (the CFF2 list, which the oracle refuses) fails when it fails any rule. Run on `fixtures/lists/` itself, it prints the oracle's verdicts. Prints verdicts and nothing else.
 *
 * @packageDocumentation
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LISTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'lists');
const PROFILES = ['ua2', 'wt1a'];

type Verdict = string[];

/** veraPDF's verdicts on every file under one profile: the failed rules of each, by its path, or null where veraPDF is not here. */
function verapdf(profile: string, files: string[]): Map<string, Verdict> | null {
  const run = spawnSync('verapdf', ['--flavour', profile, '--format', 'json', ...files], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (run.error || !run.stdout) return null;
  const verdicts = new Map<string, Verdict>();
  for (const job of JSON.parse(run.stdout).report.jobs) {
    const rules: Verdict = [];
    for (const result of job.validationResult ?? []) for (const rule of result.details.ruleSummaries) rules.push(`${rule.specification} ${rule.clause} t${rule.testNumber} (${rule.failedChecks})`);
    if (!job.validationResult?.length) rules.push(`not validated: ${job.taskException?.exceptionMessage ?? 'no result'}`);
    verdicts.set(path.resolve(job.itemDetails.name), rules.sort());
  }
  return verdicts;
}

/** qpdf's verdict: empty when the file is well formed and declares 2.0, or null where qpdf is not here. */
function qpdf(file: string): Verdict | null {
  const run = spawnSync('qpdf', ['--check', file], { encoding: 'utf8' });
  if (run.error) return null;
  const version = /PDF Version:\s*([0-9.]+)/u.exec(run.stdout ?? '')?.[1];
  return [...(run.status === 0 ? [] : [`qpdf --check exits ${run.status}`]), ...(version === '2.0' ? [] : [`declares PDF ${version ?? '(unreported)'}`])];
}

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) {
  console.error('usage: npm run compliance -- <dir>');
  process.exit(2);
}
const mine = fs.readdirSync(dir).filter((f) => f.endsWith('.pdf')).sort().map((f) => path.resolve(dir, f));
const isLists = path.resolve(dir) === path.resolve(LISTS);
const oracleOf = (file: string) => (isLists ? null : path.join(LISTS, path.basename(file)));
const oracles = mine.map(oracleOf).filter((f): f is string => f !== null && fs.existsSync(f));
const said = (v: Verdict) => (v.length === 0 ? 'clean' : v.join('; '));

let failures = 0;
const checkers: [string, (file: string) => Verdict | null][] = [['qpdf', qpdf]];
for (const profile of PROFILES) {
  const verdicts = verapdf(profile, [...mine, ...oracles]);
  checkers.push([`veraPDF ${profile}`, (file) => (verdicts ? (verdicts.get(file) ?? ['no verdict']) : null)]);
}
for (const file of mine) {
  const name = path.basename(file, '.pdf');
  const oracle = oracleOf(file);
  const hasOracle = oracle !== null && fs.existsSync(oracle);
  for (const [checker, judge] of checkers) {
    const verdict = judge(file);
    if (verdict === null) { console.log(`${name.padEnd(18)} ${checker}: not installed, skipped`); continue; }
    const theirs = hasOracle ? judge(oracle) : null;
    const same = theirs === null || JSON.stringify(theirs) === JSON.stringify(verdict);
    if (!same || (!hasOracle && verdict.length > 0 && !isLists) || (checker === 'qpdf' && verdict.length > 0)) failures += 1;
    const against = isLists ? '' : hasOracle ? (same ? ', as the oracle\'s' : `; the oracle's: ${said(theirs ?? [])}`) : ', no oracle file';
    console.log(`${name.padEnd(18)} ${checker}: ${said(verdict)}${against}`);
  }
}
console.log(`${mine.length} files, ${failures} verdict${failures === 1 ? '' : 's'} failed`);
process.exit(failures === 0 ? 0 : 1);
