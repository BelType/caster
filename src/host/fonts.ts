/**
 * `host/fonts.js` — the descriptor table: every `@font-face` the document declares, with the bytes behind it.
 *
 * Caster's own; no harness source — the one module the experiments never had to write. Guide: `docs/guide/font-fallback.md`. The harness built `fontResolve.ts`'s descriptor table from `e2-fixture.ts`'s own spec list — the fixture knew which files it had registered, so the table was a literal. A printer over a real document knows nothing of the kind: it has a CSSOM and a gateway, and it has to read the table out of them. Everything the table contains is the harness's (`FaceDescriptor` in `fonts/fontResolve.js`, unchanged); how it is filled is this file.
 *
 * Three rules, each carrying its source.
 *
 * **The sheets are both lists.** `document.styleSheets` holds only what a document links or embeds; a constructed `CSSStyleSheet` handed to `adoptedStyleSheets` is not among them, and the editing tools' Dresser materialises every author sheet exactly that way. Reading one list would silently see no `@font-face` at all in the one host this round ships against — the same lesson Cicero's own capture learned (`.claude/decisions/cicero/the-capture-reads-adopted-sheets.md`), applied to a different rule type.
 *
 * **Every face is bytes, or the export refuses by name** (D2). The printer embeds font programs; it cannot embed a system font a tab cannot read. A family a measured run resolves to whose bytes the gateway cannot fetch is an export error naming the family and the first element that uses it — E2's gateway rule, `docs/guide/font-fallback.md` §"The engine contract". BelType's addendum declares print default faces of its own (`.claude/decisions/project/print-default-faces.md`; see CHANGELOG 2026-09-14), so a document with no author `@font-face` prints, and a family outside every declared face still refuses, deliberately, with a message that says what to do.
 *
 * **WOFF is decoded by hand; WOFF2 is decoded last.** `fonts/woff.js` rebuilds an SFNT from a WOFF over `DecompressionStream('deflate')` with every table checksum verified, and no library at all. WOFF2 needs Google's own decoder, which *BelType ships faces of its own, and WOFF2 is decoded* (S46) made settle in a tab and `vendor/wawoff2.js` carries — so a descriptor whose only source is a WOFF2 is now read rather than refused, which is what makes BelType's own print default faces (shipped as WOFF2) reach the file. A descriptor that offers anything else still takes that instead: the decode costs a 307 kB bundle and the author's own `url(x.woff2), url(x.woff)` fallback costs nothing.
 *
 * @packageDocumentation
 */

import { CasterError, FontUnavailableError } from '../errors.ts';
import { capability } from '../capabilities.ts';
import { platformFamilyName, parseUnicodeRange } from '../fonts/fontResolve.ts';
import { decodeWoff, decodeWoff2, isWoff, isWoff2 } from '../fonts/woff.ts';
import { sniffMimeType } from './gateway.ts';

import type { Gateway, GatewayBytes } from './gateway.ts';
import type { FaceDescriptor, FontStyle } from '../fonts/fontResolve.ts';
import type { AxisRange } from '../fonts/axisMap.ts';
import type { ReportFontLoad } from '../report.ts';

/** One `url()` in a `src` descriptor, with the `format()` hint that followed it. */
export type FaceSource = {
  /** Absolute, resolved against the declaring sheet. */
  url: string;
  /** The `format()` hint, lower-cased and unquoted; `''` where the author wrote none. */
  format: string;
};

/** One `@font-face` rule, as the CSSOM presents it, before any byte is read. */
export type DeclaredFace = {
  /** The `font-family` descriptor, quotes stripped. */
  family: string;
  /** The first local URL in `src`, resolved against the sheet that declared it. Kept as the face's identity for the report; `buildFontTable` embeds whichever source it could actually read. */
  url: string;
  /** Every `url()` in `src`, in the order the author wrote them, each with its `format()` hint. */
  sources: FaceSource[];
  /** The `font-weight` descriptor string, e.g. `400` or `100 900`. */
  weight: string;
  style: FontStyle;
  stretch: string;
  /** `''` when the face declares none, which means "all". */
  unicodeRange: string;
  display: string;
};

/** The table, plus what it cost and what it could not do. */
export type FontTable = {
  /** What `matchFace` and `resolveWord` read. */
  descriptors: FaceDescriptor[];
  /** The SFNT bytes per face URL — the shaper's cache key is the same string. */
  bytesByUrl: Map<string, Uint8Array>;
  /** What the page loaded, which is not always what is embedded. */
  sourceFormatByUrl: Map<string, 'ttf'|'otf'|'woff'|'woff2'>;
  /** Every rule found, including the ones whose bytes refused. */
  declared: DeclaredFace[];
  warnings: string[];
  /** Reading the `@font-face` rules out of the CSSOM. */
  declareMs: number;
  /** What each URL's bytes cost, by step (*the fonts stage, measured*, DESIGN.md S87); `shaperMs` is filled by the caller that loads the shaper. */
  loads: Map<string, ReportFontLoad>;
  /** Distinct faces `document.fonts` listed, `0` where the document keeps no record. */
  fontFaces: number;
  /** How many of those faces stood in each status. */
  fontFaceStatuses: Record<string, number>;
  /** The declared rules the set had no entry for, as their pairing keys. */
  unmatched: string[];
  /** The set's own keys, for the report of a mismatch. */
  faceKeys: string[];
  /** The rules the browser never loaded, so no byte of theirs was read (*the table reads the faces the browser loaded*, DESIGN.md S88). Empty where the document keeps no `fonts` record. */
  unloaded: DeclaredFace[];
};

/** Round to three decimals. */
const round = ( n: number) => Math.round(n * 1000) / 1000;

/** Strip one level of quotes from a CSS identifier or string. */
const unquote = ( value: string) => value.trim().replace(/^["']|["']$/g, '');

/**
 * Whether the browser loaded a declared face, read from `document.fonts`.
 *
 * @remarks
 * A browser loads a `@font-face` only when layout consults it: the face a run's family list reaches, in style-matching order, until a face covers the cluster. That is the same walk `fontResolve.js` replays, so a face the browser left `unloaded` is a face the predictor never needs, and reading it is the cost S87 measured: 165 of 191 ms on the specimen were thirty-two faces read for eight programs embedded. A CSS-connected `FontFace` carries no link to its rule, so the two are paired by their descriptors, each normalised to the `FontFace`'s own serialisation (`normal` for an unset weight, style or stretch, `U+0-10FFFF` for an unset range, the family unquoted). `loaded` and `loading` both count as needed; `error` counts as needed too, so that the read refuses by name where the browser failed (D2). A document with no `fonts` answers `null` for every face and the table reads everything, as it did before S88.
 *
 * @returns `null` when the document keeps no record; `statusOf` is the browser's own word for the report, `unknown` where the set has no entry for the rule.
 */
export function browserLoaded(doc: Document): ((face: DeclaredFace) => boolean|null)&{ statusOf: (face: DeclaredFace) => string; size: number; statuses: Record<string,number>; keyOf: (face: DeclaredFace) => string; faceKeys: string[]; faceOf: (face: DeclaredFace) => FontFace|undefined; } {
  const set = (doc as any).fonts;
  if (!set || typeof set[Symbol.iterator] !== 'function') return Object.assign(() => null, { statusOf: () => 'unknown', size: 0, statuses: {}, keyOf: () => '', faceKeys: [], faceOf: () => undefined });
  // `declaredFaces` fills an unset weight as `400` and an unset stretch as `100%`, where a `FontFace` says `normal` for both; CSS Fonts 4 makes them the same value.
  const keyOf = (family: string, weight: string, style: string, stretch: string, unicodeRange: string) => [unquote(family), (weight.trim() || 'normal').replace(/^normal$/, '400'), style.trim() || 'normal', (stretch.trim() || 'normal').replace(/^normal$/, '100%'), (unicodeRange.trim() || 'U+0-10FFFF').replace(/\s+/g, '').toUpperCase()].join('|');
  const statusByKey: Map<string,string> = new Map<any, any>();
  const faceByKey: Map<string,FontFace> = new Map();
  for (const face of set) {
    const key = keyOf(face.family, face.weight, face.style, face.stretch, face.unicodeRange);
    faceByKey.set(key, face);
    const before = statusByKey.get(key);
    // Two rules with one key (a face declared twice): any copy the browser needed makes the key needed.
    statusByKey.set(key, before && before !== 'unloaded' ? before : face.status);
  }
  const statusOf = ( face: DeclaredFace) => statusByKey.get(keyOf(face.family, face.weight, face.style, face.stretch, face.unicodeRange)) ?? 'unknown';
  const loaded = ( face: DeclaredFace) => { const s = statusOf(face); return s === 'unknown' ? null : s !== 'unloaded'; };
  const statuses: Record<string,number> = {};
  for (const s of statusByKey.values()) statuses[s] = (statuses[s] ?? 0) + 1;
  return Object.assign(loaded, { statusOf, size: statusByKey.size, statuses, keyOf: ( f: DeclaredFace) => keyOf(f.family, f.weight, f.style, f.stretch, f.unicodeRange), faceKeys: [...statusByKey.keys()], faceOf: ( f: DeclaredFace) => faceByKey.get(keyOf(f.family, f.weight, f.style, f.stretch, f.unicodeRange)) });
}

/**
 * What each face the browser holds was read as, by URL, from one print to the next.
 *
 * @remarks
 * Keyed on the `FontFace`, because that object is what the page paints with and it lives exactly as long as the page keeps that load: a page kept between prints keeps it, and a new document or a changed `@font-face` rule makes a new one, which reads the file again. So a kept page prints the bytes it paints. Measured 2026-11-07 on the bolletta, with the decode the bytes then find remembered: about 12 ms of every print on a kept page, 30-day and 61-day alike (codeberg.org/BelType/cli issue 2).
 */
const readByFace: WeakMap<FontFace,Map<string,GatewayBytes>> = new WeakMap();

/** Every `@font-face` rule in the document, from both sheet lists, in cascade order. */
export function declaredFaces(doc: Document): DeclaredFace[] {
  const out: DeclaredFace[] = [];
  const walk = (sheets: Iterable<CSSStyleSheet>) => {
    for (const sheet of sheets) {
      let rules: CSSRuleList|undefined;
      try { rules = sheet.cssRules; } catch { continue; } // a cross-origin sheet refuses its rules; nothing here can read it and the gateway would refuse its bytes too
      if (!rules) continue;
      for (const rule of rules) {
        // A grouping rule is not a wall. `@layer`, `@media` and `@supports` hold their own `cssRules`, and `@import` hands over a whole sheet — BelType's own strata are layered, so a venue that declares its faces inside `@layer` had them invisible here.
        const nested = (rule as any).cssRules;
        if (nested) { walk([({ cssRules: nested, href: sheet.href } as CSSStyleSheet)]); continue; }
        const imported = (rule as any).styleSheet;
        if (imported) { walk([imported]); continue; }
        if (!isFontFaceRule(rule)) continue;
        const style = (rule as CSSFontFaceRule).style;
        const family = unquote(style.getPropertyValue('font-family'));
        // Against the SHEET's own URL, which is what CSS says a relative `url()` resolves against; `doc.baseURI` is only right for an inline `<style>`, and it happens to agree today only because the Dresser constructs every author sheet in the document's own realm.
        const base = (rule as any).parentStyleSheet?.href ?? sheet.href ?? doc.baseURI;
        const sources = localUrlsOf(style.getPropertyValue('src'), base);
        const url = sources[0]?.url ?? null;
        if (family === '' || url === null) continue;
        const rawStyle = style.getPropertyValue('font-style').trim() || 'normal';
        out.push({
          family,
          url,
          sources,
          weight: style.getPropertyValue('font-weight').trim() || '400',
          style: ((rawStyle.startsWith('oblique') ? 'oblique' : rawStyle) as FontStyle),
          stretch: style.getPropertyValue('font-stretch').trim() || '100%',
          unicodeRange: style.getPropertyValue('unicode-range').trim(),
          display: style.getPropertyValue('font-display').trim()
        });
      }
    }
  };
  walk(doc.styleSheets);
  walk(doc.adoptedStyleSheets);
  return out;
}

/**
 * Whether a rule is a `@font-face`.
 *
 * @remarks
 * `CSSFontFaceRule` by name rather than by `instanceof`, because the rule may come from another realm's sheet — the print frame's document is not this module's.
 */
function isFontFaceRule( rule: CSSRule) {
  return rule.constructor?.name === 'CSSFontFaceRule' || (rule as any).type === 5;
}

/**
 * Every URL in a `src` descriptor, in the author's own order, each with its `format()` hint.
 *
 * @remarks
 * `local()` is skipped by construction: a local face is a system font, the printer cannot embed one, and D2 makes that an error rather than a silent substitution — the error is raised where the family is used, not here, so a face that nothing resolves to costs nothing.
 *
 * Reading only the first url was a real refusal: `src: url(x.woff2) format("woff2"), url(x.woff) format("woff")` is what every font pipeline emits, and the printer refused the whole document on the WOFF2 it cannot decode while the decodable WOFF sat behind it in the same descriptor. The list is what makes the fallback the author already wrote reachable.
 *
 * @param base - The URL a relative source resolves against — the declaring sheet's, not the document's.
 */
export function localUrlsOf(src: string, base: string): FaceSource[] {
  const out: FaceSource[] = [];
  for (const match of src.matchAll(/url\((['"]?)([^'")]+)\1\)\s*(?:format\((['"]?)([^'")]+)\3\))?/g)) {
    try { out.push({ url: new URL(match[2], base).href, format: (match[4] ?? '').trim().toLowerCase() }); } catch { continue; }
  }
  return out;
}

/**
 * Build the table: read every declared face's bytes through the gateway, decode what needs decoding, and read the face's own `fvar` axes out of the program.
 *
 * @remarks
 * A face whose bytes nothing can read is a warning here, never a throw — the refusal is `refuseFamily`'s, where a run resolves to it (D2).
 *
 * The axes come from the bytes rather than from the `@font-face` rule, because `@font-face` declares none of them — the guide's engine contract says so in as many words, and E4 (`font-embedding.md`) needs every axis a variable face has in order to pin the instance the browser painted.
 */
export async function buildFontTable(doc: Document, gateway: Gateway): Promise<FontTable> {
  const declareStarted = performance.now();
  const declared = declaredFaces(doc);
  const declareMs = round(performance.now() - declareStarted);
  const descriptors: FaceDescriptor[] = [];
  const bytesByUrl: Map<string,Uint8Array> = new Map<any, any>();
  const sourceFormatByUrl: Map<string,'ttf'|'otf'|'woff'|'woff2'> = new Map<any, any>();
  const warnings: string[] = [];
  const loads: Map<string,ReportFontLoad> = new Map<any, any>();
  const clock = () => performance.now();
  const loaded = browserLoaded(doc);
  const unloaded: DeclaredFace[] = [];
  const loadOf = (url: string, face: DeclaredFace, fetchMs: number, absolute: string) => {
    const family = face.family;
    const entries = typeof performance.getEntriesByName === 'function' ? performance.getEntriesByName(absolute, 'resource') : [];
    const last = (entries[entries.length - 1] as PerformanceResourceTiming|undefined);
    const load: ReportFontLoad = { url, family, status: loaded.statusOf(face), format: 'ttf', fetchMs: round(fetchMs), decodeMs: 0, parseMs: 0, shaperMs: 0, sfntBytes: 0, ...(last ? { transferBytes: last.transferSize, delivery: (last as any).deliveryType || (last.workerStart > 0 ? 'service-worker' : 'network') } : {}) };
    loads.set(url, load);
    return load;
  };

  /** The gateway's answer for one source of one face, or what it answered last print if the browser still holds that face. */
  const read = async (face: DeclaredFace, url: string): Promise<GatewayBytes> => {
    const owner = loaded.faceOf(face);
    let held = owner ? readByFace.get(owner) : undefined;
    const known = held?.get(url);
    if (known) return known;
    const fetched = await gateway.getBytes(url);
    if (owner) {
      if (!held) readByFace.set(owner, (held = new Map()));
      held.set(url, fetched);
    }
    return fetched;
  };

  let ordinal = 0;
  for (const face of declared) {
    ordinal += 1;
    // A face the browser never loaded is a face no run resolves to, and reading it is the cost of the stage (S88). A face the record does not know (`null`) is read, since a rule the FontFaceSet does not show is a rule this reader cannot vouch for.
    if (loaded(face) === false) { unloaded.push(face); continue; }
    // The whole `src` list, in the author's order. A WOFF2 is skipped here rather than refused — the refusal belongs to the case where nothing else in the descriptor is readable, because `src: url(x.woff2), url(x.woff)` is what every font pipeline writes and the WOFF behind it is a program this printer can embed.
    const attempts: string[] = [];
    let woff2Url = '';
    let chosen = '';
    let sfnt: Uint8Array|undefined;
    for (const source of face.sources) {
      const cached = bytesByUrl.get(source.url);
      if (cached) { chosen = source.url; sfnt = cached; break; }
      if (!gateway.allows(source.url)) {
        attempts.push(`${source.url} is outside the gateway's reach`);
        continue;
      }
      if (source.format === 'woff2') { woff2Url = woff2Url || source.url; attempts.push(`${source.url} is declared \`format("woff2")\`, so it is decoded only after every other source in the descriptor failed`); continue; }
      let fetched;
      const fetchStarted = clock();
      try {
        fetched = await read(face, source.url);
      } catch (error) {
        attempts.push(`${source.url} could not be read (${String((error as Error).message ?? error)})`);
        continue;
      }
      const sniffed = sniffMimeType(fetched.bytes);
      if (sniffed === 'font/woff2' || isWoff2(fetched.bytes)) { woff2Url = woff2Url || source.url; attempts.push(`${source.url} is a WOFF2`); continue; }
      const load = loadOf(source.url, face, clock() - fetchStarted, fetched.url);
      const decodeStarted = clock();
      if (isWoff(fetched.bytes)) {
        const decoded = await decodeWoff(fetched.bytes);
        if (!decoded.checksumsOk) warnings.push(`the WOFF for ${JSON.stringify(face.family)} rebuilt into an SFNT whose table checksums do not all match the ones the WOFF recorded; the program is embedded anyway and this is the one place that says so`);
        sfnt = decoded.bytes;
        sourceFormatByUrl.set(source.url, 'woff');
      } else {
        sfnt = fetched.bytes;
        sourceFormatByUrl.set(source.url, sniffed === 'font/otf' ? 'otf' : 'ttf');
      }
      load.decodeMs = round(clock() - decodeStarted);
      load.format = (sourceFormatByUrl.get(source.url) as string);
      load.sfntBytes = sfnt.length;
      chosen = source.url;
      bytesByUrl.set(source.url, sfnt);
      break;
    }
    // A descriptor whose only source is a WOFF2 is decoded here rather than in the loop above (*BelType ships faces of its own, and WOFF2 is decoded*, S46). The order is deliberate and is what keeps the decode rare: `src: url(x.woff2), url(x.woff)` is what every font pipeline emits, and taking the WOFF the author already wrote costs nothing, where a decode costs a 307 kB bundle and ~40 ms a face. So the WOFF2 road is the last one, taken only when the descriptor offers nothing else — which is exactly when `surveyNeeds` loaded the capability for it.
    if (!sfnt && woff2Url && attempts.length === face.sources.length) {
      try {
        const fetchStarted = clock();
        const fetched = await read(face, woff2Url);
        const load = loadOf(woff2Url, face, clock() - fetchStarted, fetched.url);
        const decodeStarted = clock();
        sfnt = await decodeWoff2(fetched.bytes, face.family, woff2Url);
        Object.assign(load, { format: 'woff2', decodeMs: round(clock() - decodeStarted), sfntBytes: sfnt.length });
        chosen = woff2Url;
        bytesByUrl.set(woff2Url, sfnt);
        sourceFormatByUrl.set(woff2Url, 'woff2');
      } catch (error) {
        // Not swallowed and not re-raised here: a CapabilityError or a decode failure joins the same list every other unreadable source joins, so a face nothing paints still costs the document nothing and a face a run resolves to refuses at `refuseFamily`, naming the element. That is D2's rule, and a WOFF2 is no longer an exception to it.
        attempts.push(`${woff2Url} is a WOFF2 that could not be decoded (${String((error as Error).message ?? error)})`);
      }
    }
    if (!sfnt) {
      // A face the gateway cannot read is a warning here and a refusal where it is used, which is D2's own wording and not a softening of it: a document may declare fifty faces it never paints — KaTeX alone declares more than twenty — and refusing at the declaration would refuse a document over a face no run resolves to. `refuseFamily` is the door, and it names the element.
      warnings.push(`the @font-face for ${JSON.stringify(face.family)} has no source this printer can read (${attempts.join('; ')}); a run that resolves to it will refuse by name`);
      continue;
    }
    const parseStarted = clock();
    const platformFamily = platformFamilyName(sfnt);
    const axes = axesOf(sfnt);
    const load = loads.get(chosen);
    if (load) load.parseMs = round(load.parseMs + clock() - parseStarted);
    descriptors.push({
      id: `${face.family}#${ordinal}`,
      family: face.family,
      url: chosen,
      weight: parseWeightDescriptor(face.weight),
      style: face.style,
      stretch: parseStretchDescriptor(face.stretch),
      ...(face.unicodeRange ? { unicodeRange: parseUnicodeRange(face.unicodeRange) } : {}),
      platformFamily,
      ...(axes ?? {})
    });
  }

  const unmatched = declared.filter((face) => loaded.statusOf(face) === 'unknown').map(loaded.keyOf);
  return { descriptors, bytesByUrl, sourceFormatByUrl, declared, warnings, loads, declareMs, unloaded, fontFaces: loaded.size, fontFaceStatuses: loaded.statuses, unmatched, faceKeys: loaded.faceKeys };
}

/**
 * The face's own `fvar` axes, by tag, read through fontkit.
 *
 * @remarks
 * A static face answers `null`, which the table spreads as nothing, and nothing downstream has to special-case it — an empty coordinate set is the same face, the same subset and the same instance key it always was (`fonts/axisMap.js`).
 *
 * @throws {CapabilityError} fontkit was not loaded.
 */
export function axesOf(bytes: Uint8Array): { axes: Record<string,AxisRange>; }|null {
  const font = capability('fontkit').create(bytes);
  const raw = font?.variationAxes;
  if (!raw) return null;
  const axes: Record<string,AxisRange> = {};
  for (const [tag, axis] of Object.entries((raw as Record<string, { min: number, default: number, max: number }>))) {
    axes[tag] = { min: axis.min, default: axis.default, max: axis.max };
  }
  return Object.keys(axes).length === 0 ? null : { axes };
}

/**
 * `400`, `bold`, or `100 900`, as the range `matchFace` compares against.
 *
 * @remarks
 * `normal` and `bold` are legal in an `@font-face` descriptor (CSS Fonts 4 §4.4) and went through `Number` as `NaN`, so a rule declaring `font-weight: bold` was filed at [400, 400] and the regular program was embedded for every bold run, silently. `bolder` and `lighter` are not legal there — they are relative to an inherited weight and a descriptor has none to be relative to — so they refuse by name rather than resolving to a weight nobody asked for.
 *
 * @throws {CasterError} The descriptor says `bolder` or `lighter`.
 */
export function parseWeightDescriptor( descriptor: string) {
  const KEYWORDS: Record<string,number> = { normal: 400, bold: 700 };
  const tokens = descriptor.trim().split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (token === 'bolder' || token === 'lighter') {
      throw new CasterError(`caster: an @font-face declares \`font-weight: ${token}\`, which CSS Fonts 4 §4.4 does not allow in a descriptor — ${token} is relative to an inherited weight and a face has none. Write the number, or \`normal\`/\`bold\`.`);
    }
  }
  const parts = tokens.map((token) => (token in KEYWORDS ? KEYWORDS[token] : Number(token))).filter((n) => Number.isFinite(n));
  if (parts.length === 0) return ([400, 400] as [number, number]);
  return ([parts[0], parts[1] ?? parts[0]] as [number, number]);
}

/**
 * `condensed`, `75%` or `75% 125%`, as the percentage range `matchFace` compares against.
 *
 * @remarks
 * The keywords are CSS Fonts 4 §4.5's table.
 */
export function parseStretchDescriptor( descriptor: string) {
  const KEYWORDS: Record<string,number> = { 'ultra-condensed': 50, 'extra-condensed': 62.5, condensed: 75, 'semi-condensed': 87.5, normal: 100, 'semi-expanded': 112.5, expanded: 125, 'extra-expanded': 150, 'ultra-expanded': 200 };
  const parts = descriptor.trim().split(/\s+/).map((p) => (p in KEYWORDS ? KEYWORDS[p] : parseFloat(p))).filter((n) => Number.isFinite(n));
  if (parts.length === 0) return ([100, 100] as [number, number]);
  return ([round(parts[0]), round(parts[1] ?? parts[0])] as [number, number]);
}

/**
 * D2's refusal, raised where a family is used rather than where it is declared.
 *
 * @param element - The DOM path of the first element that uses it.
 * @throws {FontUnavailableError} Always, naming the family, the element and the families the document does declare.
 */
export function refuseFamily(family: string, element: string, table: FontTable): never {
  const known = [...new Set(table.descriptors.map((d) => d.family))];
  const known_ = known.length > 0 ? ` The families this document does declare are ${known.map((f) => JSON.stringify(f)).join(', ')}.` : ' This document declares no @font-face at all.';
  throw new FontUnavailableError(`caster: nothing in this document supplies bytes for the family ${JSON.stringify(family)}, which ${element} uses. The printer embeds font PROGRAMS, so every face has to reach it as bytes — declare an @font-face for it in the venue's own stylesheet and serve the file beside the document.${known_} BelType's addendum declares print faces of its own — Source Serif 4, Source Sans 3, Source Code Pro and Noto Emoji — and puts them first in its stacks, so an element that reaches this refusal takes its font-family from some other sheet (the venue's, a component's, or the browser's own, which gives a bare generic) and names none of the declared families. Put one of them first in that stack, or declare an @font-face for the family it names.`, { element });
}

/** A generic CSS family name, which means the stack fell through to a system font the printer cannot embed. */
export const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong']);

/** Whether a family name is one of CSS's generics. */
export function isGenericFamily(family: string) {
  return GENERIC_FAMILIES.has(family.trim().toLowerCase());
}

/** The declared-but-unreadable families, for the report's warnings. */
export function unreadableFamilies(table: FontTable) {
  const readable = new Set(table.descriptors.map((d) => d.family));
  return [...new Set(table.declared.map((d) => d.family))].filter((f) => !readable.has(f));
}

/**
 * The table, or a refusal when none was built.
 *
 * @remarks
 * A programmer error rather than a document one: a table built with no gateway.
 *
 * @throws {CasterError} `buildFontTable` has not run.
 */
export function requireTable( table: FontTable|null) {
  if (!table) throw new CasterError('caster: the font table has not been built; `buildFontTable` runs before anything is measured');
  return table;
}
