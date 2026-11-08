/**
 * `measure/conservation.js` — THE CONSERVATION OF WORDS (DESIGN.md S61): every word a page shows is a word the measurement was handed, or the print refuses.
 *
 * Caster's own; no harness source — *the conservation of words* (DESIGN.md S61), the round that found the cut-table hole (*a table Paged.js cut across pages is one table in several fragments*, S63) and the anonymous block (S64).
 *
 * The printer has two collectors and they do not see the same document. Boxes, borders and backgrounds are read off whatever is rendered (`vectors/`), while a glyph is emitted only for a block the structure walk registered — the walk is the PDF/UA tagger, and ink is a by-product of tagging. Tagging first is the decision (a word outside the tree is not a PDF/UA file), and this is its price made payable: a text node the tagger never classified was neither measured nor refused, it was simply absent, with its cell's border drawn around the hole. Measured 2026-09-21 on the manual under Paged.js: a table continued across a cut kept every rule and every code chip and lost every word of its later pages — 2 300 words over eight pages, zero errors, zero warnings.
 *
 * So the census asks the DOM and never the tagger. It walks every text node under the strip, keeps the ones a reader can see on a page, and asks one question of each: did a block's own walk reach it (`MeasureResult.claimed`)? What the measurement did next is the measurement's lawful business — R5 drops a straddler's clipped tail, and the continuation that carries those lines emits them. What this refuses is the text nobody was ever handed.
 *
 * It names no engine and no tag, which is what makes it hold for an adapter nobody has written yet.
 *
 * @packageDocumentation
 */

import { CasterError } from '../errors.ts';
import { domPathOf } from './textMeasure.ts';
import { SUPPRESS_CLASS, resolveGenerated } from '../adapters/reify.ts';

import type { PageStrip } from '../adapters/strip.ts';

/** One text node a reader can see on a page, as {@link renderedTextNodes} found it. */
export type RenderedText = {
  node: Text;
  parent: Element;
  /** Zero-based, the index of `pageElementOf(parent)` among the strip's pages. */
  page: number;
  /** R5's clip in viewport space, the page box's top and the flow box's bottom (*R5's head is the page box and its foot is the cut*, S69); null for margin content and for an engine that moves its overflow instead of clipping it. */
  clip: { top: number, bottom: number, sliceTop?: number }|null;
  /** The node's client rectangles, at least one of them inside `clip`. */
  rects: DOMRect[];
};

/** Whether a client rectangle is inside R5's clip: it overlaps the page box and the cut, and inside a painted slice it belongs to the page that holds its top, so a line the wrapper's top divides is on one page and not two (*the slice wrapper's clip*, S69). */
export function inClip(clip: NonNullable<RenderedText['clip']>, rect: DOMRect): boolean {
  return rect.bottom > clip.top && rect.top < clip.bottom && (clip.sliceTop === undefined || rect.top >= clip.sliceTop - 0.01);
}

/**
 * The one predicate for "rendered" (*the conservation of words*, DESIGN.md S61; *an interval is a marked-content sequence*, S71): every text node under the strip a reader can see on a page — the conservation of words asks it of what no block claimed, and the tiling invariant states itself over the text nodes it returns.
 *
 * @remarks
 * "Rendered" is asked of the browser: not whitespace, on a page (`pageElementOf`, so a divided block's unassigned original is not a second copy), visible, and with a rectangle of its own — `display: none` has none, which is how an engine's hidden running original falls out without being named. KaTeX's MathML twin is excluded by name because it is laid out and never painted (`rawSegments` says why), and so is the text of a `script`, `style` or `template`. SVG is not excluded: a `<text>` is claimed by `measureSvgText`, a `<title>` has no rectangle, and the HTML inside a `<foreignObject>` — which `svgGeometry.js` paints as nothing — is exactly the rendered, unclaimed text the conservation exists to name.
 *
 * And inside the page's own clip, where the engine has one (R5): the page box at the head and the flow box's bottom at the foot (*R5's head is the page box and its foot is the cut*, S69). Cicero lays a straddling block's whole tail out on the page it begins on and clips it at the cut, so every clone of a drawing below a cut has real rectangles on a page that never shows it. The measurement claims such HTML text before it drops it; an SVG `<text>` down there is dropped by the collector before any request exists, so the census asks the geometry instead — both rectangles in viewport space, no conversion — and margin content, which sits outside the flow box by construction (*the margins are lifted into the light DOM*, S57), is exempt.
 *
 * @param skip - Asked first, before any style or rectangle is read: the conservation passes what the blocks claimed, which is nearly everything, so the cost is paid only for the rest.
 * @returns In document order.
 */
export function renderedTextNodes(strip: PageStrip, skip?: (node: Text) => boolean): RenderedText[] {
  const container = strip.strip;
  const { pageElementOf } = strip;
  const doc = container.ownerDocument;
  const view = doc.defaultView ?? window;
  // The clip `index.js`'s `clipToPage` reads: the page box at the head, the flow box's bottom at the foot (*R5's head is the page box and its foot is the cut*, S69).
  const clips = strip.pages.map((page) => (page.flowBox ? { top: page.element.getBoundingClientRect().top, bottom: page.flowBox.getBoundingClientRect().bottom } : null));
  const out: RenderedText[] = [];
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node as Text);
    if (skip?.(text) || !/\S/u.test(text.data)) continue;
    const parent = text.parentElement;
    if (!parent || parent.closest('.katex-mathml, script, style, template')) continue;
    const pageElement = pageElementOf(parent);
    if (!pageElement) continue;
    if (view.getComputedStyle(parent).visibility !== 'visible') continue;
    const page = strip.pageElements.indexOf(pageElement);
    const clip = strip.inMargin?.(parent) ? null : clips[page] ?? null;
    // Inside a painted slice the wrapper's top is the head (*the slice wrapper's clip*, S69).
    const sliceTop = clip ? parent.closest('[data-beltype~="shell"]')?.getBoundingClientRect().top : undefined;
    range.selectNodeContents(text);
    const rects = [...range.getClientRects()];
    if (!rects.some((rect) => rect.width > 0 && rect.height > 0 && (!clip || inClip(clip, rect)))) continue;
    out.push({ node: text, parent, page, clip: clip && sliceTop !== undefined ? { ...clip, sliceTop } : clip, rects });
  }
  return out;
}

/**
 * The rendered text nodes no block claimed.
 *
 * @param claimed - What the blocks' own walks reached (`MeasureResult.claimed`).
 */
export function unclaimedText(claimed: Set<Text>, strip: PageStrip): { node: Text; parent: Element; }[] {
  return renderedTextNodes(strip, (node) => claimed.has(node)).map(({ node, parent }) => ({ node, parent }));
}

/**
 * Refuse a print that would lose words, naming the first few by the element the author wrote and the page the reader would have missed them on.
 *
 * @param claimed - What the blocks' own walks reached (`MeasureResult.claimed`).
 * @throws {CasterError} Any rendered text node went unclaimed, naming the word count, the first five by page and DOM path, and the `<foreignObject>` case apart.
 */
export function assertConserved(claimed: Set<Text>, strip: PageStrip) {
  const { strip: container, pageElementOf, pageElements } = strip;
  const lost = unclaimedText(claimed, strip);
  if (lost.length === 0) return;
  const words = lost.reduce((n, { node }) => n + node.data.split(/\s+/u).filter(Boolean).length, 0);
  const foreign = lost.filter(({ parent }) => parent.closest('foreignObject')).length;
  const shown = lost.slice(0, 5).map(({ node, parent }) => {
    const page = pageElements.indexOf((pageElementOf(parent) as HTMLElement)) + 1;
    const excerpt = node.data.trim().replace(/\s+/gu, ' ');
    return `page ${page}, ${domPathOf(parent, container)}: ${JSON.stringify(excerpt.length > 48 ? `${excerpt.slice(0, 48)}…` : excerpt)}`;
  });
  throw new CasterError(`caster: ${words} word${words === 1 ? '' : 's'} in ${lost.length} text node${lost.length === 1 ? '' : 's'} are rendered on a page and were never handed to the measurement, so the file would show their boxes and not their text. ${foreign ? `${foreign} of them sit${foreign === 1 ? 's' : ''} inside an SVG <foreignObject>, which this printer paints as nothing (vectors/svgGeometry.js): a drawing that labels itself in HTML — Mermaid's default — has to label itself in SVG <text> (htmlLabels: false) to be printed. ` : ''}${foreign < lost.length ? 'No structure element owns the rest — a gap in the walk\'s tag table or in the adapter\'s pairing, never a fact about the document. ' : ''}The first: ${shown.join('; ')}${lost.length > shown.length ? `; and ${lost.length - shown.length} more` : ''}`, { element: domPathOf(lost[0].parent, container) });
}

/**
 * The generated text a reader sees on a page that no real element carries (*a pseudo that reads a value the engine delivers is made real after the run*, DESIGN.md S79): `::before` and `::after` the browser still paints from `content`.
 *
 * @remarks
 * Text a pseudo-element paints is no text node, so {@link renderedTextNodes} cannot see it, and the printer has no glyph to emit for it: `reify` makes it a real span first and sets the suppress class that takes the pseudo away, so a pseudo still painting at print time is one that was never made real — the number a `target-counter()` shows, found missing from a contents page that went to print without it. Asked of the browser, as everywhere in the census: a visible element whose pseudo's computed `content` resolves to something other than the empty string and which does not carry its pseudo's suppress class.
 *
 * @returns In document order.
 */
export function unmadeGeneratedText(strip: PageStrip): { element: Element; page: number; pseudo: '::before'|'::after'; content: string; }[] {
  const container = strip.strip;
  const view = container.ownerDocument.defaultView ?? window;
  const out: { element: Element; page: number; pseudo: '::before'|'::after'; content: string; }[] = [];
  for (const element of container.querySelectorAll('*')) {
    if (element.closest('script, style, template, .katex-mathml')) continue;
    const pageElement = strip.pageElementOf(element);
    if (!pageElement || element.getClientRects().length === 0 || view.getComputedStyle(element).visibility !== 'visible') continue;
    for (const pseudo of (['::before', '::after'] as const)) {
      if (element.classList.contains(SUPPRESS_CLASS[pseudo === '::before' ? 'before' : 'after'])) continue;
      const content = view.getComputedStyle(element, pseudo).content;
      if (!content || content === 'none' || content === 'normal') continue;
      let text;
      try { text = resolveGenerated(content, element, [], '', pseudo); } catch { text = content; }
      if (text !== '') out.push({ element, page: strip.pageElements.indexOf(pageElement), pseudo, content });
    }
  }
  return out;
}

/**
 * Refuse a print whose pages show generated text no element carries.
 *
 * @throws {CasterError} Any visible `::before` or `::after` still paints text from `content`, naming the count, the first five by page and DOM path, and what each reads.
 */
export function assertGeneratedConserved(strip: PageStrip) {
  const lost = unmadeGeneratedText(strip);
  if (lost.length === 0) return;
  const shown = lost.slice(0, 5).map(({ element, page, pseudo, content }) => `page ${page + 1}, ${domPathOf(element, strip.strip)}${pseudo}: ${content.length > 64 ? `${content.slice(0, 64)}…` : content}`);
  throw new CasterError(`caster: ${lost.length} generated text${lost.length === 1 ? '' : 's'} (\`::before\` or \`::after\` content) show${lost.length === 1 ? 's' : ''} on a page and no element carries ${lost.length === 1 ? 'it' : 'them'}, so the file would print the page without the words the screen shows — a number a \`target-counter()\` delivers, or a label. Reification makes such text real before the print, and these were not made real (DESIGN.md S49, S79). The first: ${shown.join('; ')}${lost.length > shown.length ? `; and ${lost.length - shown.length} more` : ''}`, { element: domPathOf(lost[0].element, strip.strip) });
}
