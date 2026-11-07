/**
 * `node scripts/quote-marks.ts`: writes `src/adapters/quoteMarks.ts`, the quote marks Chromium renders for `quotes: auto` in each language, read off the pinned build itself.
 *
 * @remarks
 * Blink takes them from ICU's locale data, which no page can ask for, so this asks the browser what it paints: every tag is the `lang` of a paragraph holding a nested `<q>` (a `<q>` paints in the language around it, not its own `lang`), and the marks are read back through the accessibility tree. Every primary language of two and three letters is asked, and every region and script Node's `Intl.DisplayNames` names under a language it names, and a language-script pair that differs is asked again under each region. Only what differs from what its shorter tag would answer is kept. Run it again when `playwright-core` moves, since a new build is a new oracle, and delete the checkpoint first: every answer is appended to `node_modules/.cache/caster-quote-marks.jsonl` as its chunk is read, and a run that stops resumes from it without asking again.
 *
 * @packageDocumentation
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../test/launch.ts';

const OUT = fileURLToPath(new URL('../src/adapters/quoteMarks.ts', import.meta.url));
const CACHE = fileURLToPath(new URL('../node_modules/.cache/caster-quote-marks.jsonl', import.meta.url));
fs.mkdirSync(path.dirname(CACHE), { recursive: true });
/** Every answer already read, by tag, from the checkpoint a stopped run left. */
const asked = new Map<string,string>(fs.existsSync(CACHE) ? fs.readFileSync(CACHE, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as [string, string]) : []);
/** Pages read in parallel; each holds one chunk at a time. */
const PAGES = 4;
const letters = 'abcdefghijklmnopqrstuvwxyz';
const known = (type: 'language'|'region'|'script', code: string) => new Intl.DisplayNames(['en'], { type, fallback: 'none' }).of(code) !== undefined;
const codes = (length: number): string[] => (length === 0 ? [''] : codes(length - 1).flatMap((prefix) => [...letters].map((letter) => prefix + letter)));
const named = (type: 'language'|'region'|'script', list: string[]) => list.filter((code) => { try { return known(type, code); } catch { return false; } });

const browser = await launchBrowser();
const pages = await Promise.all(Array.from({ length: PAGES }, () => browser.newPage()));
/** The four marks each tag renders, open and close at depth 0 then at depth 1, joined; a tag the checkpoint holds is not asked again. */
async function marksOf(all: string[]): Promise<Map<string,string>> {
  const tags = all.filter((tag) => !asked.has(tag));
  const chunks: string[][] = [];
  for (let at = 0; at < tags.length; at += 1000) chunks.push(tags.slice(at, at + 1000));
  let done = 0;
  await Promise.all(pages.map(async (page) => { for (let chunk = chunks.shift(); chunk; chunk = chunks.shift()) await readChunk(page, chunk).then(() => process.stderr.write(`${done += chunk!.length}/${tags.length}\r`)); }));
  return new Map(all.map((tag) => [tag, asked.get(tag)!]));
}
async function readChunk(page: Awaited<ReturnType<typeof browser.newPage>>, chunk: string[]) {
  const out = new Map<string,string>();
  {
    await page.setContent(`<!doctype html><body>${chunk.map((tag) => `<p lang="${tag}"><q>a<q>b</q>c</q></p>`).join('')}</body>`);
    const cdp = await page.context().newCDPSession(page);
    const { nodes } = await cdp.send('Accessibility.getFullAXTree') as { nodes: { nodeId: string, role?: { value: string }, name?: { value: string }, childIds?: string[] }[] };
    await cdp.detach();
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const paragraphs: string[] = [];
    const text = (node: typeof nodes[number]): string => (node.role?.value === 'StaticText' ? node.name?.value ?? '' : (node.childIds ?? []).map((id) => text(byId.get(id)!)).join(''));
    const visit = (node: typeof nodes[number]) => { if (node.role?.value === 'paragraph') paragraphs.push(text(node)); else for (const id of node.childIds ?? []) visit(byId.get(id)!); };
    visit(nodes[0]!);
    if (paragraphs.length !== chunk.length) throw new Error(`read ${paragraphs.length} paragraphs for ${chunk.length} tags`);
    chunk.forEach((tag, i) => {
      const parts = /^(.*)a(.*)b(.*)c(.*)$/su.exec(paragraphs[i]!);
      if (!parts) throw new Error(`${tag}: ${paragraphs[i]}`);
      out.set(tag, JSON.stringify([parts[1], parts[4], parts[2], parts[3]]));
    });
  }
  fs.appendFileSync(CACHE, [...out].map((entry) => `${JSON.stringify(entry)}\n`).join(''));
  for (const [tag, value] of out) asked.set(tag, value);
}

const table = new Map<string,string>();
const basic = (await marksOf(['']))!.get('')!;
const answer = (tag: string): string => { for (let t = tag; t; t = t.slice(0, Math.max(0, t.lastIndexOf('-')))) { const hit = table.get(t); if (hit) return hit; } return basic; };
const keep = (marks: Map<string,string>) => { for (const [tag, value] of marks) if (value !== answer(tag)) table.set(tag, value); };

const languages = [...codes(2), ...codes(3)];
keep(await marksOf(languages));
const speaking = [...new Set([...named('language', languages), ...[...table.keys()]])];
const regions = [...named('region', [...codes(2)].map((code) => code.toUpperCase())), '001', '150', '419'];
const scripts = named('script', ['Arab', 'Armn', 'Beng', 'Cyrl', 'Deva', 'Ethi', 'Geor', 'Grek', 'Hans', 'Hant', 'Hebr', 'Jpan', 'Khmr', 'Kore', 'Latn', 'Mong', 'Thaa', 'Tibt', 'Vaii', 'Adlm', 'Olck', 'Rohg', 'Mtei', 'Guru', 'Tfng', 'Syrc', 'Nkoo']);
keep(await marksOf(speaking.flatMap((language) => scripts.map((script) => `${language}-${script}`))));
keep(await marksOf(speaking.flatMap((language) => regions.map((region) => `${language}-${region}`))));
const pairs = [...table.keys()].filter((tag) => /^[a-z]+-[A-Z][a-z]{3}$/.test(tag));
keep(await marksOf(pairs.flatMap((pair) => regions.map((region) => `${pair}-${region}`))));
await browser.close();

const rows = [...table].sort(([a], [b]) => (a < b ? -1 : 1)).map(([tag, value]) => `  '${tag.toLowerCase()}': ${value.replace(/"/g, "'").replace(/','/g, "', '")},`);
fs.writeFileSync(OUT, `/**
 * The quote marks Chromium renders for \`quotes: auto\`, by language: open and close at the first depth, then at the second, which every deeper one repeats.
 *
 * @remarks
 * Written by \`scripts/quote-marks.ts\` from what the pinned build paints in a nested \`<q>\` inside a \`<p lang>\`; do not edit by hand. A tag that is not here answers what its tag without the last subtag answers, down to the primary language, and a language that is not here answers {@link BASIC_QUOTES}, as Blink does where ICU has nothing for a locale. Every primary language of two and three letters was asked.
 *
 * @packageDocumentation
 */

/** What Blink paints where the locale has no quote marks of its own: \`“ ” ‘ ’\`. */
export const BASIC_QUOTES: readonly [string, string, string, string] = ${basic.replace(/"/g, "'").replace(/','/g, "', '")};

/** Lower-case BCP 47 tags, each with the marks that differ from its shorter tag's. */
export const QUOTE_MARKS: Readonly<Record<string, readonly [string, string, string, string]>> = {
${rows.join('\n')}
};
`);
console.log(`${table.size} tags, ${path.relative(process.cwd(), OUT)}`);
