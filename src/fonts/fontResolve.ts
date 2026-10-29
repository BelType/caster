/**
 * `fonts/fontResolve.js` — the fallback predictor: which face painted which grapheme cluster, from the `@font-face` descriptors and the font bytes alone.
 *
 * Ported from `harness/src/export/fontResolve.ts` (E2, E4). Guide: `docs/guide/font-fallback.md`.
 *
 * WHAT THE PORT CHANGED (P3). It added one thing. `requestFor(element)` — the `FaceRequest` a computed style makes — lived in `harness/src/export/e2-fixture.ts`, and P3 does not port a fixture. It is not a fixture fact: it is the reading of `font-family`, `font-weight`, `font-style`, `font-stretch` and `font-synthesis` that every measured run needs, so it comes home here, beside `matchFace`, with the sidecar half of its return value dropped.
 *
 * The harness's own header follows.
 *
 * The predictor of `font-fallback.md` (E2): which face painted which grapheme cluster, from the gateway's FontFace descriptors and the font bytes alone.
 *
 * Two halves, matching the experiment's two sub-problems:
 *
 * - `matchFace()` is the CSS Fonts 4 §5.2 face-matching algorithm over a family's descriptor set. Deterministic: stretch, then style, then weight, with range descriptors handled for variable faces.
 * - `resolveWord()` is the character-fallback walk down the `font-family` list, with `unicode-range` pre-assignment and a `.notdef` walk behind it. This half mirrors Chromium and is only as right as the agreement report says.
 *
 * The `.notdef` test goes through the harfbuzzjs shaper (`hbShaper.js`, E1), so the predictor asks the same shaper Blink asks rather than reading a cmap directly; a cluster whose shaped output contains glyph 0 is not covered by that face. A variable face is shaped at the instance the request pins, via `varShaper.ts`, because Blink sets `wght` from the computed `font-weight`.
 *
 * @packageDocumentation
 */
import { CasterError } from '../errors.ts';

import type { AxisSetting } from './varShaper.ts';
export type FontStyle = 'normal'|'italic'|'oblique';
/** The one error the walk raises: it reached a CSS generic family, which means the gateway leaked a system font the printer cannot embed. */
export type ErrorCode = 'UnexportableFallback';

export type FaceDescriptor = {
  /** Stable id, normally the file's base name. It keys the report's font entries. */
  id: string;
  /** CSS family name the FontFace was registered under. */
  family: string;
  /** URL of the bytes; doubles as the shaper's cache key. */
  url: string;
  /** `font-weight` descriptor as a range; a single value is [w, w]. */
  weight: [number, number];
  style: FontStyle;
  /** `font-stretch` descriptor in percent, as a range. */
  stretch: [number, number];
  /** `unicode-range` descriptor, already parsed. Absent means "all". */
  unicodeRange?: UnicodeRange[];
  /** name-table family, i.e. what Chromium's oracle calls the font. */
  platformFamily: string;
  /** The face's own `fvar` axes, by tag. Absent or empty for a static face. E2 (`font-fallback.md`) needed only the `wght` range from the descriptor; E4 (`font-embedding.md`) pins every axis a variable face has, so the ranges have to come from the font rather than from the `@font-face` rule, which declares none of them. */
  axes?: Record<string, { min: number; default: number; max: number }>;
};
export type UnicodeRange = {
  from: number;
  to: number;
};
export type FaceRequest = {
  families: string[];
  weight: number;
  style: FontStyle;
  /** `font-stretch` in percent. */
  stretch: number;
  /** Whether `font-synthesis` still permits each synthesis. */
  synthesis: { weight: boolean; style: boolean };
};
export type Synthesis = {
  bold: boolean;
  italic: boolean;
};
export type ResolvedRun = {
  /** [start, end) in grapheme-cluster indices within the word. */
  clusterRange: [number, number];
  /** [start, end) in UTF-16 code units within the word. */
  charRange: [number, number];
  text: string;
  /** FaceDescriptor.id, or null when nothing in the list covered the run. */
  face: string|null;
  /** name-table family of the chosen face, comparable with the oracle. */
  platformFamily: string|null;
  gids: number[];
  widthPx: number;
  synthesis: Synthesis|null;
  /** Variable-font axes the face was instanced at; empty for a static face. */
  axes: AxisSetting[];
};
export type ResolveError = {
  code: ErrorCode;
  /** Why the walk stopped: a generic family name, or the exhausted list. */
  reason: string;
  text: string;
  codePoints: number[];
};
export type ResolvedWord = {
  text: string;
  runs: ResolvedRun[];
  errors: ResolveError[];
  /** Sum of every run's width. Meaningless when `errors` is non-empty. */
  widthPx: number;
  /** Multiset the harness's node checker compared against the oracle. */
  byFamily: FamilyCount[];
};
export type FamilyCount = {
  familyName: string;
  glyphCount: number;
};
export type FaceMatch = {
  face: FaceDescriptor;
  synthesis: Synthesis;
  /** The variable-font instance the request selects. CSS Fonts 4 §5.2 makes the chosen weight the request clamped into the face's declared range, and Blink applies it as the `wght` axis. */
  axes: AxisSetting[];
};
export type Cluster = {
  text: string;
  start: number;
  end: number;
};

import { shapeAt } from './varShaper.ts';
/** CSS generic families. Reaching one means the gateway leaked a system font. */
const GENERIC_FAMILIES = new Set([
    'serif',
    'sans-serif',
    'monospace',
    'cursive',
    'fantasy',
    'system-ui',
    'ui-serif',
    'ui-sans-serif',
    'ui-monospace',
    'ui-rounded',
    'math',
    'emoji',
    'fangsong',
]);
/** Blink's `kBoldThreshold` and `kItalicSlopeValue`, from third_party/blink/renderer/platform/fonts/font_selection_types.h. They are the two numbers the synthesis decision turns on, so they are named after the constants they mirror rather than inlined. */
const BOLD_THRESHOLD = 600;
const ITALIC_SLOPE = 14;
// --- unicode-range ---------------------------------------------------------
/** Parse a `unicode-range` descriptor string, e.g. `U+0-24F, U+2C60-2C7F, U+A7??`. Wildcards expand to the interval they cover. */
export function parseUnicodeRange(descriptor: string): UnicodeRange[] {
    const ranges: UnicodeRange[] = [];
    for (const raw of descriptor.split(',')) {
        const token = raw.trim().replace(/^[Uu]\+/, '');
        if (!token)
            continue;
        if (token.includes('?')) {
            ranges.push({
                from: parseInt(token.replace(/\?/g, '0'), 16),
                to: parseInt(token.replace(/\?/g, 'F'), 16),
            });
            continue;
        }
        const [from, to] = token.split('-');
        ranges.push({ from: parseInt(from, 16), to: parseInt(to ?? from, 16) });
    }
    return ranges;
}
function inRange(ranges: UnicodeRange[]|undefined, codePoint: number): boolean {
    if (!ranges)
        return true;
    return ranges.some((r) => codePoint >= r.from && codePoint <= r.to);
}
// --- CSS Fonts 4 §5.2 face matching ---------------------------------------
/** Distance from a request to a descriptor range; 0 means the range contains it. */
function rangeDistance(range: [number,number], desired: number): number {
    if (desired < range[0])
        return range[0] - desired;
    if (desired > range[1])
        return desired - range[1];
    return 0;
}
/** §5.2 step 1, font-stretch. Faces whose range contains the request win; the rest are ordered by which side of the request they sit on, condensed values preferring narrower first and expanded values preferring wider first. */
function filterStretch(faces: FaceDescriptor[], desired: number): FaceDescriptor[] {
    const exact = faces.filter((f) => rangeDistance(f.stretch, desired) === 0);
    if (exact.length > 0)
        return exact;
    const below = faces.filter((f) => f.stretch[1] < desired).sort((a, b) => b.stretch[1] - a.stretch[1]);
    const above = faces.filter((f) => f.stretch[0] > desired).sort((a, b) => a.stretch[0] - b.stretch[0]);
    const ordered = desired <= 100 ? [...below, ...above] : [...above, ...below];
    return ordered.length > 0 ? [ordered[0]] : [];
}
/** §5.2 step 2, font-style. The spec's oblique-angle ordering collapses to a preference list here because `host/fonts.js`'s descriptor table only ever emits the three keywords. */
function filterStyle(faces: FaceDescriptor[], desired: FontStyle): FaceDescriptor[] {
    const order: Record<FontStyle,FontStyle[]> = {
        italic: ['italic', 'oblique', 'normal'],
        oblique: ['oblique', 'italic', 'normal'],
        normal: ['normal', 'oblique', 'italic'],
    };
    for (const style of order[desired]) {
        const hit = faces.filter((f) => f.style === style);
        if (hit.length > 0)
            return hit;
    }
    return [];
}
/** §5.2 step 3, font-weight. The 400–500 window is the special case the spec spends most of its words on: a request in it first looks up to 500, then down, then past 500. */
function filterWeight(faces: FaceDescriptor[], desired: number): FaceDescriptor|undefined {
    const contains = faces.filter((f) => rangeDistance(f.weight, desired) === 0);
    if (contains.length > 0)
        return contains[0];
    const key = (f: FaceDescriptor) => (f.weight[1] < desired ? f.weight[1] : f.weight[0]);
    const below = faces.filter((f) => f.weight[1] < desired).sort((a, b) => key(b) - key(a));
    const above = faces.filter((f) => f.weight[0] > desired).sort((a, b) => key(a) - key(b));
    if (desired >= 400 && desired <= 500) {
        const upToFive = above.filter((f) => f.weight[0] <= 500);
        return upToFive[0] ?? below[0] ?? above[0];
    }
    if (desired < 400)
        return below[0] ?? above[0];
    return above[0] ?? below[0];
}
/** The weight a matched face effectively renders at; also the variable instance. */
function effectiveWeight(face: FaceDescriptor, desired: number): number {
    if (rangeDistance(face.weight, desired) === 0)
        return desired;
    return desired < face.weight[0] ? face.weight[0] : face.weight[1];
}
/** Blink's slope for a style keyword: 0 upright, 14 for italic and oblique. */
const slopeOf = (style: FontStyle) => (style === 'normal' ? 0 : ITALIC_SLOPE);
/** CSS Fonts 4 §5.2 over one family. Returns the chosen face and whether Chromium would have to fake bold or italic on top of it. */
export function matchFace(table: readonly FaceDescriptor[], family: string, request: FaceRequest): FaceMatch|undefined {
    const candidates = table.filter(( f: FaceDescriptor) => f.family === family);
    if (candidates.length === 0)
        return undefined;
    const byStretch = filterStretch(candidates, request.stretch);
    const byStyle = filterStyle(byStretch, request.style);
    const face = filterWeight(byStyle, request.weight);
    if (!face)
        return undefined;
    const variable = face.weight[0] !== face.weight[1];
    // Blink decides synthesis from the family's aggregate capabilities, not from the face the match landed on: CSSSegmentedFontFace::GetFontData tests `font_selection_capabilities_.weight.maximum < kBoldThreshold` over every face registered under the family name. A family holding a 700 upright and a 400 italic therefore synthesises nothing for `700 italic` — it paints the 400 italic at 400 — even though the matched face is well under the threshold. Deciding this per face would predict a fake bold that Chromium never applies.
    const familyMaxWeight = Math.max(...candidates.map((f) => f.weight[1]));
    const familyMaxSlope = Math.max(...candidates.map((f) => slopeOf(f.style)));
    return {
        face,
        axes: variable ? [{ tag: 'wght', value: effectiveWeight(face, request.weight) }] : [],
        synthesis: {
            bold: request.synthesis.weight && familyMaxWeight < BOLD_THRESHOLD && request.weight >= BOLD_THRESHOLD,
            italic: request.synthesis.style && familyMaxSlope < ITALIC_SLOPE && slopeOf(request.style) >= ITALIC_SLOPE,
        },
    };
}
// --- character fallback ----------------------------------------------------
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function clusters(text: string): Cluster[] {
    const out: Cluster[] = [];
    for (const seg of segmenter.segment(text))
        out.push({ text: seg.segment, start: seg.index, end: seg.index + seg.segment.length });
    return out;
}
/** Whether a face can paint a cluster: shape it and look for glyph 0. The whole cluster is rejected if any of its glyphs is `.notdef`, which is what Blink does — it never splits a grapheme across two fonts. */
function covers(match: FaceMatch, cluster: Cluster, sizePx: number): boolean {
    for (const ch of cluster.text)
        if (!inRange(match.face.unicodeRange, (ch.codePointAt(0) as number)))
            return false;
    return !shapeAt(match.face.url, match.axes, cluster.text, sizePx).gids.includes(0);
}
/** The family walk. Each family in turn takes every cluster still unassigned that its matched face can paint; a generic family name stops the walk and whatever is left becomes an `UnexportableFallback`. */
export function resolveWord(text: string, request: FaceRequest, table: FaceDescriptor[], sizePx: number): ResolvedWord {
    const cells = clusters(text);
    const assigned: (FaceMatch|null)[] = cells.map(() => null);
    const errors: ResolveError[] = [];
    for (const family of request.families) {
        if (assigned.every((a) => a !== null))
            break;
        if (GENERIC_FAMILIES.has(family.toLowerCase())) {
            const left = cells.filter((_, i) => assigned[i] === null);
            errors.push({
                code: 'UnexportableFallback',
                reason: `generic family "${family}" reached with clusters unresolved`,
                text: left.map((c) => c.text).join(''),
                codePoints: left.flatMap(( c: Cluster) => [...c.text].map((ch) => (ch.codePointAt(0) as number))),
            });
            return finish(text, cells, assigned, errors, sizePx);
        }
        const match = matchFace(table, family, request);
        if (!match)
            continue;
        for (let i = 0; i < cells.length; i++) {
            if (assigned[i] === null && covers(match, cells[i], sizePx))
                assigned[i] = match;
        }
    }
    const left = cells.filter((_, i) => assigned[i] === null);
    if (left.length > 0) {
        errors.push({
            code: 'UnexportableFallback',
            reason: `font-family list exhausted: ${request.families.join(', ')}`,
            text: left.map((c) => c.text).join(''),
            codePoints: left.flatMap(( c: Cluster) => [...c.text].map((ch) => (ch.codePointAt(0) as number))),
        });
    }
    return finish(text, cells, assigned, errors, sizePx);
}
/** Group consecutive clusters that landed on the same face into runs and shape each run as a whole, because that is the unit Blink hands to HarfBuzz and the unit whose advances a PDF text-showing operator has to reproduce. */
function finish(text: string, cells: Cluster[], assigned: (FaceMatch|null)[], errors: ResolveError[], sizePx: number): ResolvedWord {
    const runs: ResolvedRun[] = [];
    let i = 0;
    while (i < cells.length) {
        const match = assigned[i];
        let j = i + 1;
        while (j < cells.length && assigned[j]?.face.id === match?.face.id)
            j++;
        const charRange: [number,number] = [cells[i].start, cells[j - 1].end];
        const runText = text.slice(charRange[0], charRange[1]);
        const shaped = match ? shapeAt(match.face.url, match.axes, runText, sizePx) : undefined;
        runs.push({
            clusterRange: ([i, j] as [number, number]),
            charRange,
            text: runText,
            face: match?.face.id ?? null,
            platformFamily: match?.face.platformFamily ?? null,
            gids: shaped?.gids ?? [],
            widthPx: shaped?.widthPx ?? 0,
            synthesis: match ? match.synthesis : null,
            axes: match ? match.axes : [],
        });
        i = j;
    }
    const counts: Map<string,number> = new Map<any, any>();
    for (const run of runs) {
        if (!run.platformFamily)
            continue;
        counts.set(run.platformFamily, (counts.get(run.platformFamily) ?? 0) + run.gids.length);
    }
    return {
        text,
        runs,
        errors,
        widthPx: runs.reduce((sum, r) => sum + r.widthPx, 0),
        byFamily: [...counts]
            .map(([familyName, glyphCount]) => ({ familyName, glyphCount }))
            .sort((a, b) => a.familyName.localeCompare(b.familyName)),
    };
}
// --- name table ------------------------------------------------------------
/**
 * The font's own family name, i.e. what `CSS.getPlatformFontsForNode` reports. Chromium names a web font by its `name` table, not by the CSS family the `FontFace` was registered under, so the predictor has to read it out of the bytes to be able to compare with the oracle at all.
 *
 * @remarks
 * Name ID 16 (typographic family) wins over ID 1 when present, matching FreeType, whose `family_name` is what Skia hands back on Linux.
 *
 * @throws {CasterError} The bytes carry no `name` table, or one with neither name ID 1 nor 16.
 */
export function platformFamilyName(bytes: Uint8Array): string {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const numTables = view.getUint16(4);
    let nameOffset = -1;
    for (let i = 0; i < numTables; i++) {
        const rec = 12 + i * 16;
        const tag = String.fromCharCode(bytes[rec], bytes[rec + 1], bytes[rec + 2], bytes[rec + 3]);
        if (tag === 'name')
            nameOffset = view.getUint32(rec + 8);
    }
    if (nameOffset < 0)
        throw new CasterError('caster: font has no name table');
    const count = view.getUint16(nameOffset + 2);
    const storage = nameOffset + view.getUint16(nameOffset + 4);
    const best = new Map<any, any>();
    for (let i = 0; i < count; i++) {
        const rec = nameOffset + 6 + i * 12;
        const platformId = view.getUint16(rec);
        const nameId = view.getUint16(rec + 6);
        if (nameId !== 1 && nameId !== 16)
            continue;
        const length = view.getUint16(rec + 8);
        const offset = storage + view.getUint16(rec + 10);
        // Platform 3 (Windows) and platform 0 (Unicode) are UTF-16BE; platform 1 (Macintosh) is single byte for the ASCII names every one of these has.
        let value = '';
        if (platformId === 1) {
            for (let k = 0; k < length; k++)
                value += String.fromCharCode(bytes[offset + k]);
        }
        else {
            for (let k = 0; k + 1 < length; k += 2)
                value += String.fromCharCode(view.getUint16(offset + k));
        }
        if (!best.has(nameId))
            best.set(nameId, value);
    }
    const name = best.get(16) ?? best.get(1);
    if (!name)
        throw new CasterError('caster: name table has neither name ID 1 nor 16');
    return name;
}

/**
 * The computed `font-family` as a list of names, quotes stripped.
 *
 * @remarks
 * Ported from `harness/src/export/e2-fixture.ts` (P3: it is not a fixture fact — it is how a request is read off an element, which every measured run needs).
 */
export function parseFamilyList(computed: string): string[] {
  return computed
    .split(',')
    .map((name) => name.trim().replace(/^["']|["']$/g, ''))
    .filter((name) => name.length > 0);
}

/**
 * The cascade's request, read off the element rather than restated from the registry, so a typo in the stylesheet shows up as a disagreement instead of being papered over on both sides.
 *
 * @remarks
 * Ported from `harness/src/export/e2-fixture.ts`, with the sidecar half of the return value dropped: the harness returned `{ request, sidecar }` and recorded the second for its report, and Caster's report keeps the same facts under `ReportElement`.
 */
export function requestFor(element: Element): FaceRequest {
  const style = getComputedStyle(element);
  const families = parseFamilyList(style.fontFamily);
  const weight = parseFloat(style.fontWeight);
  const fontStyle = ((style.fontStyle.startsWith('oblique') ? 'oblique' : style.fontStyle) as FontStyle);
  const stretchRaw = style.fontStretch;
  const stretch = stretchRaw.endsWith('%') ? parseFloat(stretchRaw) : 100;
  const synthWeight = style.getPropertyValue('font-synthesis-weight').trim();
  const synthStyle = style.getPropertyValue('font-synthesis-style').trim();
  return { families, weight, style: fontStyle, stretch, synthesis: { weight: synthWeight !== 'none', style: synthStyle !== 'none' } };
}
