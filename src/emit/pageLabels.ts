/**
 * `emit/pageLabels.js` — `/PageLabels` from a custom property on the page element.
 *
 * Ported from `harness/src/export/pageLabels.ts` (E12F). Guide: `docs/guide/coordinates-and-pages.md`; the experiments are `browser-to-pdf-experiments`.
 *
 * WHAT THE PORT CHANGED (DESIGN.md P11, P12). `PageLabelParseError` extends `CasterError` rather than `Error`, the same move `colorHints.js`'s `HintParseError` makes, so a refusal carries the house error family and the panel's `{ element }` context; the message and the `value` field are the harness's, unchanged. The harness's `SidecarPageLabel` is `ReportPageLabel` here, field for field.
 *
 * The harness's own header follows.
 *
 * A PDF page has two numbers — where it sits in the file and what the reader's page box shows — and they are different in every book ever printed: front matter in lower roman, the body restarting at arabic 1, an appendix with a prefix. Nothing in CSS says either of those things, because `@page` numbering is a counter for generated content and not a claim about the document's pagination, so the engine has to be asked, and the channel is the one of `colour.md` (E8): a registered non-inheriting custom property on the page element.
 *
 * The grammar is `--pdf-page-label: <style> [start <n>] ["prefix"]`, with `<style>` one of `decimal`, `lower-roman`, `upper-roman`, `lower-alpha`, `upper-alpha` or `none`, `start` an integer at least 1, and the prefix a quoted string. `none` with a prefix is the case a PDF writes as `/P` alone, which is how a page labelled "Cover" and nothing else is written.
 *
 * Registration is `syntax: '*'` rather than a typed one, for the reason the colour hints of `colour.md` (E8) are: the value is a small language of the exporter's own and no CSS type describes it, so it travels as a token stream and is parsed here. `inherits: false` is load-bearing in exactly the way it is for a colour hint — a label declared on the strip would otherwise claim every page in it, and a document whose every page said "i" would be worse than one with no labels.
 *
 * Consecutive pages that declare the same style, no prefix change and a consecutive number become one `/Nums` run, which is what the entry is for: a three-hundred-page book is two entries, not three hundred.
 *
 * @packageDocumentation
 */

import { CasterError } from '../errors.ts';

import type { ReportPageLabel } from '../report.ts';

/** The property a page element declares its label through. */
export const PAGE_LABEL_PROPERTY = '--pdf-page-label';

/** The style names the grammar accepts, and the PDF `/S` name each becomes. */
export const LABEL_STYLES: Readonly<Record<string,string>> = {
  decimal: 'D',
  'lower-roman': 'r',
  'upper-roman': 'R',
  'lower-alpha': 'a',
  'upper-alpha': 'A',
  none: '',
};

/** What registering the property came to. */
export type PageLabelRegistration = {
  property: string;
  /** True also when an earlier run in this realm had already registered it. */
  registered: boolean;
  /** What `CSS.registerProperty` threw, verbatim. */
  error?: string;
};

/** Register the property, non-inheriting, exactly as `colour.md` (E8) registers a colour hint. */
export function registerPageLabelProperty(): PageLabelRegistration {
  try {
    CSS.registerProperty({ name: PAGE_LABEL_PROPERTY, syntax: '*', inherits: false, initialValue: '' });
    return { property: PAGE_LABEL_PROPERTY, registered: true };
  } catch (error) {
    // A second registration of the same name throws, and in a run that has already registered it that is success rather than failure.
    const message = String(error);
    return { property: PAGE_LABEL_PROPERTY, registered: /already/i.test(message), error: message };
  }
}

/** One declaration, parsed. */
export type PageLabel = {
  /** The PDF `/S` name without its slash; '' for `none`. */
  style: string;
  /** `/St`; 1 when the declaration named none. */
  start: number;
  /** `/P`; '' when the declaration named none. */
  prefix: string;
};

/** The error a declaration this grammar cannot read produces. Its message names the value. */
export class PageLabelParseError extends CasterError {
  declare value: string;
  /**
   * @param value - The declaration as the page element carried it.
   * @param reason - What in it the grammar could not read.
   */
  constructor(value: string, reason: string) {
    super(`pageLabels: cannot read ${JSON.stringify(PAGE_LABEL_PROPERTY)}: ${JSON.stringify(value)} — ${reason}`);
    this.name = 'PageLabelParseError';
    this.value = value;
  }
}

/**
 * One declaration as the grammar reads it.
 *
 * @remarks
 * The tokeniser is a regular expression over the whole value rather than a split on whitespace, because the prefix is a quoted string and may contain spaces; everything outside the quotes is a bare word.
 *
 * @returns Null for an empty declaration — the page declares no label.
 * @throws {PageLabelParseError} An unknown style, a `start` that is not an integer of at least 1, a token that is neither `start <n>` nor a quoted prefix, or `none` with no prefix.
 */
export function parsePageLabel(declared: string): PageLabel|null {
  const value = declared.trim();
  if (value === '') return null;
  const tokens = value.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  if (tokens.length === 0) return null;

  const styleName = tokens[0] ?? '';
  if (!(styleName in LABEL_STYLES)) {
    throw new PageLabelParseError(declared, `${JSON.stringify(styleName)} is not one of ${Object.keys(LABEL_STYLES).join(', ')}`);
  }
  const label: PageLabel = { style: LABEL_STYLES[styleName], start: 1, prefix: '' };

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === 'start') {
      const number = Number(tokens[++i]);
      if (!Number.isInteger(number) || number < 1) {
        throw new PageLabelParseError(declared, `start wants an integer of at least 1, not ${JSON.stringify(tokens[i])}`);
      }
      label.start = number;
      continue;
    }
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      label.prefix = token.slice(1, -1);
      continue;
    }
    throw new PageLabelParseError(declared, `${JSON.stringify(token)} is neither "start <n>" nor a quoted prefix`);
  }

  if (label.style === '' && label.prefix === '') {
    throw new PageLabelParseError(declared, 'a label of style none and no prefix labels the page with nothing at all');
  }
  return label;
}

/** The roman numerals by value, subtractive pairs included, largest first. */
const ROMAN: readonly (readonly [number,string])[] = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
];

/** Lower-case roman, the way 12.4.2's `r` style spells it. */
export function toRoman(n: number): string {
  let rest = n;
  let out = '';
  for (const [value, numeral] of ROMAN) {
    while (rest >= value) {
      out += numeral;
      rest -= value;
    }
  }
  return out;
}

/**
 * The `a` style: `a` to `z`, then `aa` to `zz`, then `aaa`.
 *
 * @remarks
 * 12.4.2 spells it out and it is not base 26: the 27th page is `aa` and not `ba`, so the letter is `(n − 1) mod 26` repeated `ceil(n / 26)` times.
 */
export function toAlpha(n: number): string {
  const letter = String.fromCharCode(0x61 + ((n - 1) % 26));
  return letter.repeat(Math.ceil(n / 26));
}

/** What a reader shows for a page carrying this label at this offset into its run. */
export function labelText(label: PageLabel, indexInRun: number): string {
  const number = label.start + indexInRun;
  const body =
    label.style === 'D'
      ? String(number)
      : label.style === 'r'
        ? toRoman(number)
        : label.style === 'R'
          ? toRoman(number).toUpperCase()
          : label.style === 'a'
            ? toAlpha(number)
            : label.style === 'A'
              ? toAlpha(number).toUpperCase()
              : '';
  return `${label.prefix}${body}`;
}

/** One `/Nums` entry: the page it starts at and the dictionary it carries. */
export type LabelRun = {
  page: number;
  label: PageLabel;
};

/** Every page's label, twice: as the file writes it and as the report records it. */
export type PageLabelResult = {
  runs: LabelRun[];
  /** One per page, in page order. */
  records: ReportPageLabel[];
};

/**
 * The declarations of every page, as `/Nums` runs and as a per-page record.
 *
 * @remarks
 * A page continues the run above it when its style, its prefix and its number all follow from it; anything else opens a run. A page that declares nothing while a run is open continues that run, because a book does not restate its numbering on every leaf — but a document whose *first* page declares nothing has no labels at all and gets none, rather than an invented decimal run that would say something the author did not.
 *
 * @param declarations - One per page, in page order, as {@link readPageLabels} reads them.
 * @throws {PageLabelParseError} As {@link parsePageLabel}, for the first declaration it cannot read.
 */
export function pageLabelRuns(declarations: readonly string[]): PageLabelResult {
  const runs: LabelRun[] = [];
  const records: ReportPageLabel[] = [];
  let current: LabelRun|null = null;

  declarations.forEach((declared, page) => {
    const parsed = parsePageLabel(declared);
    if (parsed) {
      const continues =
        current !== null &&
        current.label.style === parsed.style &&
        current.label.prefix === parsed.prefix &&
        current.label.start + (page - current.page) === parsed.start;
      if (!continues) {
        current = { page, label: parsed };
        runs.push(current);
      }
    }
    if (!current) {
      records.push({ page, declared, style: '', opensRun: false, label: '' });
      return;
    }
    const run: LabelRun = current;
    const indexInRun = page - run.page;
    records.push({
      page,
      declared,
      style: run.label.style,
      ...(run.label.start !== 1 ? { start: run.label.start } : {}),
      ...(run.label.prefix !== '' ? { prefix: run.label.prefix } : {}),
      opensRun: indexInRun === 0,
      label: labelText(run.label, indexInRun),
    });
  });

  return { runs, records };
}

/** The `--pdf-page-label` each page element declares, verbatim from the computed style. */
export function readPageLabels(pageElements: readonly HTMLElement[]): string[] {
  return pageElements.map((element) => getComputedStyle(element).getPropertyValue(PAGE_LABEL_PROPERTY).trim());
}
