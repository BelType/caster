/**
 * `adapters/prepare.js` — the print preparation: the one place the document is altered, and it happens in Caster's own frame — or, under Paged.js, in the engine's own window.
 *
 * Caster's own; no harness source — PLAN.md D9.
 *
 * It runs in the print frame after the dresser has adopted the render's stylesheets — or, under Paged.js, which takes them as text, with the author's sheets adopted for the length of the call — and before the engine paginates, which is what makes the pages Caster measures the pages that contain what it prepared: nothing is measured that was not laid out. D1 is why it may alter anything at all: the frame is Caster's, discarded after the export, and no author preview — pane or window, either engine — is ever prepared (ruled 2026-10-16, *preparation runs in no author preview*, DESIGN.md S81; the claim of *the second adapter gets a BelType host* (S59) that "the window is prepared too" is withdrawn). The CLI's door calls it in its headless page before the first cut (*`beltype build <target> --pdf --printer caster`*, DESIGN.md S65), a page that is also discarded. What lets the preview and the file agree without the preview wearing this is the rule it is held to: preparation must not change layout, and `test/preview-unprepared.test.js` checks it.
 *
 * Five jobs, each with the rule it serves.
 *
 * 1. **Register the `--pdf-*` properties.** `docs/guide/colour.md` and `coordinates-and-pages.md`: every one is `inherits: false`, which is the whole mechanism — a declaration claims one element and never its subtree. The two lengths get `syntax: '<length>'` so the engine computes them to px and the printer never has to know what a millimetre is (measured: `6mm` arrives as `22.6772px`); everything else gets `*`, deliberately, because a restricted syntax rejects an invalid value silently at computed-value time and the exporter would then see the initial value where the author wrote a typo.
 *
 * 2. **`font-synthesis: none` on the root.** The engine contract's first paragraph. Chromium's fake bold and fake italic change no advance, so a synthesised face measures like the real one and prints as neither; refusing the synthesis makes the face the printer resolves the face the browser painted.
 *
 * 3. **Reify the pseudo-painted text** — `::before`, `::after` and `::marker` made real elements. That is `reify.js`'s primitive (*reification is one primitive with two moments*, DESIGN.md S49), called here for its first moment, over the author's content; a paginator that paints text of its own — page numbers in margin cells, footnote calls and bodies — gets the same call again after it has run, which is why the primitive is not this module's.
 *
 * 4. **Materialise the task states.** GFM's checkbox is a native widget, not pseudo-painted text, so it is this module's and not `reify.js`'s: it is a fact about the belt's markup rather than about anything a paginator paints, and the second moment has no checkbox to find.
 *
 * 5. **Keep the source.** Every element under `<body>` is stamped `data-pdf-source` and the body is cloned once, last, so the reified spans are source nodes (the round plan's ruling 5) and nothing a paginator does afterwards reaches the copy. Paged.js moves elements and splits text nodes rather than cloning them, so after pagination no source survives in the document — this copy is the source tree the interval record's ranges are offsets into, and the stamp is how a moved element or a shell finds its own element in it (ruling 2; *an interval is a marked-content sequence*, DESIGN.md S71).
 *
 * @packageDocumentation
 */

import { CasterError } from '../errors.ts';
import { reify } from './reify.ts';

export { MARKER_CLASS, GENERATED_CLASS, pairsOf, resolveGenerated, roman, alpha } from './reify.ts';

/** The attribute every element under `<body>` carries from the preparation on, naming its element in the source snapshot (*an interval is a marked-content sequence*, DESIGN.md S71). */
export const SOURCE_ATTRIBUTE = 'data-pdf-source';

/**
 * The source snapshot of each prepared document.
 *
 * @remarks
 * Not on the `Preparation`: that is a report, serialised for the panel, and a detached DOM tree is no part of a report. A module-level map is reachable by `print()` because the host calls `prepare()` and `print()` on one module instance, the one it loaded into the frame (*the printer runs in the realm it prints*, S20).
 */
const SNAPSHOTS: WeakMap<Document,HTMLElement> = new WeakMap<any, any>();

/** The source snapshot `prepare()` kept for this document, or null where it never ran here. */
export function sourceSnapshotOf(doc: Document): HTMLElement|null {
  return SNAPSHOTS.get(doc) ?? null;
}

/** The class a materialised task state carries (M3). */
export const TASK_CLASS = 'task-state';

/**
 * Every `--pdf-*` property, with the syntax and the initial value the guide's table gives.
 *
 * @remarks
 * The colour hints are `colour/colorHints.js`'s (`registerHintProperties`) and are registered by that module; this table is the two lengths and the two grammars of the printer's own that no colour module owns. Registering the same name twice throws and that is success in a frame that has already been prepared, so a second registration is reported rather than raised.
 */
export const GEOMETRY_PROPERTIES = [
  { name: '--pdf-bleed', syntax: '<length>', initialValue: '0px' },
  { name: '--pdf-trim-inset', syntax: '<length>', initialValue: '0px' },
  { name: '--pdf-marks', syntax: '*', initialValue: 'none' },
  { name: '--pdf-page-label', syntax: '*', initialValue: '' }
];

import type { ReifiedMarker } from './reify.ts';

/** A marker the preparation made real — `reify.js`'s record, under the name the preparation's callers read. */
export type PreparedMarker = ReifiedMarker;

/** What one preparation did to the frame, for the report. */
export type Preparation = {
  registrations: { property: string, registered: boolean, error?: string }[];
  markers: PreparedMarker[];
  generated: { element: string, pseudo: string, text: string }[];
  warnings: string[];
  /** Pseudos left for the second moment because they read a value the engine delivers while it runs (*a pseudo that reads a value the engine delivers is made real after the run*, DESIGN.md S79). */
  deferred: string[];
  /** How many task-list checkboxes became text (M3). */
  tasks: number;
};

/**
 * Prepare the print frame's document.
 *
 * @remarks
 * Idempotent: running it twice registers nothing new and materialises no second marker.
 *
 * @throws {CasterError} The document has no window.
 */
export function prepare(doc: Document): Preparation {
  const registrations: Preparation['registrations'] = [];
  const view = doc.defaultView;
  if (!view) throw new CasterError('caster: the print frame has no window, so nothing about it can be prepared or measured');

  for (const spec of GEOMETRY_PROPERTIES) {
    try {
      view.CSS.registerProperty({ ...spec, inherits: false });
      registrations.push({ property: spec.name, registered: true });
    } catch (error) {
      const message = String(error);
      registrations.push({ property: spec.name, registered: /already/i.test(message), error: message });
    }
  }

  // `font-synthesis: none` on the root, as an inline declaration so nothing in the cascade outranks it. The frame is Caster's; the author's document is not touched.
  doc.documentElement.style.setProperty('font-synthesis', 'none', 'important');

  const tasks = materialiseTasks(doc);
  const reified = reify(doc, { defer: true });

  let n = 0;
  for (const element of doc.body.querySelectorAll('*')) element.setAttribute(SOURCE_ATTRIBUTE, String(n++));
  SNAPSHOTS.set(doc, (doc.body.cloneNode(true) as HTMLElement));

  return { registrations, ...reified, tasks };
}

/**
 * The two states of a task, as text (M3).
 *
 * @remarks
 * ASCII on purpose: the box characters U+2610/U+2611 are covered by almost no text face, and a mark that refuses on `.notdef` would move the wall rather than remove it. What the two strings should be is a taste decision this constant makes findable.
 */
export const TASK_MARKS = { open: '[ ]', done: '[x]' };

/** The text a task's state becomes. */
export function taskMark(checked: boolean) {
  return checked ? TASK_MARKS.done : TASK_MARKS.open;
}

/**
 * The task list, made text (M3 of the manual list, closed 2026-09-14).
 *
 * @remarks
 * GFM's `- [ ] item` reaches the printer as a disabled `<input type="checkbox">` inside the `<li>`: a native widget the browser paints and the walk refused by name, because the 2.0 standard has no tag for a checkbox that is not a form field and a `/Widget` is a form-field feature nobody asked for. The same move as the markers answers it: the state becomes a real `<span>` of text at the same place, carrying the box's own size and inline margins so the words after it and the line it stands on do not move, and the walk measures it as the words it now is. Print only — the pane keeps its checkboxes — which is what a print preparation is for.
 *
 * @returns How many became text.
 */
function materialiseTasks(doc: Document): number {
  const view = doc.defaultView;
  if (!view) return 0;
  let tasks = 0;
  for (const input of doc.querySelectorAll('li > input[type="checkbox"]')) {
    const span = doc.createElement('span');
    span.className = TASK_CLASS;
    span.textContent = taskMark((input as HTMLInputElement).checked);
    const style = view.getComputedStyle(input);
    // The box's own size, so the line is the line the box made: the text in a box as wide as the widget, and a strut of no width as tall as it, standing where Blink stands a checkbox, its bottom border edge on the baseline and its bottom margin below it. Without them the words after it moved by the difference between the widget's width and the text's (1.1 px at the manual's 15.39 px, 5.3 px at 20 px), and the line took the text's height and not the box's (the manual's two task items 22.69 px unprepared and 21.69 px prepared, measured 2026-10-29); with them both are the unprepared item's, to the hundredth of a pixel at four sizes and faces.
    span.style.cssText = `display: inline-block; inline-size: ${style.width}; margin-left: ${style.marginLeft}; margin-right: ${style.marginRight}; white-space: pre`;
    const strut = doc.createElement('span');
    strut.style.cssText = `display: inline-block; inline-size: 0; block-size: ${style.height}; margin-top: ${style.marginTop}; margin-bottom: ${style.marginBottom}; vertical-align: -${style.marginBottom}`;
    span.append(strut);
    input.replaceWith(span);
    tasks += 1;
  }
  return tasks;
}
