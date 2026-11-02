/**
 * `errors.js` — `CasterError`, the printer's one error family.
 *
 * Ported from the harness's named error classes (`ZoomError`, `RotationError`, `NonUniformScaleError`, `PerspectiveError`, `CrossOriginImageError`, …, raised across `harness/src/export/frame.ts`, `gateway.ts` and `imageEmbed.ts`) (E10, E7) — E10 the container refusals, E7 the gateway's.
 *
 * WHAT THE PORT CHANGED. BelType's house rule is that every thrown thing is a `BelTypeError` subclass (`packages/common/src/errors.js`). What the port adds over the harness is the context payload P5 names — `{ element, pos, capability }` — so the editing tools' panel can open the author's own source line for an error raised eleven modules deep, through the same `originalPositionFor` road the preview click uses. `pos` is the belt's `pos:` stamp, read off the element or its nearest ancestor that carries one.
 *
 * The guide's closing rule is the reason the family exists at all: *letting a hint or a colour fall back silently* is the failure mode a print job cannot recover from, so every one of these is an export error naming the element, never a guess.
 *
 * @packageDocumentation
 */

import { BelTypeError } from '@beltype/common/errors';

export type CasterErrorContext = {
  /** A DOM path, as `domPath()` writes it: `body>div[2]>p[0]`. */
  element?: string;
  /** The belt's `pos:` stamp, when the element or an ancestor carries one. */
  pos?: number;
  /** The capability registry name a refusal is about. */
  capability?: string;
  /** The option that would have loaded the capability, or the one that produced the refusal. */
  flag?: string;
  /** The tag name an {@link UnknownElementError} is about, lower-cased. */
  tag?: string;
  /** Where in the display list a writer's refusal is about: the page, and the index of the item in that page's list. The writer reads no DOM, so it names this; `print()` adds the `element` from what it holds of the walk. */
  listItem?: { page: number, item: number };
};

/** The base of the family: a `BelTypeError` that carries {@link CasterErrorContext} as its own members. */
export class CasterError extends BelTypeError {
  declare element: string | undefined;
  declare pos: number | undefined;
  declare capability: string | undefined;
  declare flag: string | undefined;
  declare tag: string | undefined;
  declare listItem: { page: number, item: number } | undefined;
  constructor(message: string, context: CasterErrorContext = {}) {
    super(message);
    this.name = 'CasterError';
    if (context.element !== undefined) this.element = context.element;
    if (context.pos !== undefined) this.pos = context.pos;
    if (context.capability !== undefined) this.capability = context.capability;
    if (context.flag !== undefined) this.flag = context.flag;
    if (context.tag !== undefined) this.tag = context.tag;
    if (context.listItem !== undefined) this.listItem = context.listItem;
  }
}

/** The container, or an ancestor of it, applies `zoom`. E10 (`coordinates-and-pages.md`): `zoom` is not a transform and no probe recovers it — refuse by name. */
export class ZoomError extends CasterError {
  constructor(message: string, context?: CasterErrorContext) { super(message, context); this.name = 'ZoomError'; }
}

/** The container is rotated. E10 (`coordinates-and-pages.md`): `getClientRects` gives the axis-aligned box and a rotated run is not one — exact at a quarter turn, 10.7 px out at five degrees. */
export class RotationError extends CasterError {
  constructor(message: string, context?: CasterErrorContext) { super(message, context); this.name = 'RotationError'; }
}

/** The container is skewed, or scaled differently on its two axes. */
export class NonUniformScaleError extends CasterError {
  constructor(message: string, context?: CasterErrorContext) { super(message, context); this.name = 'NonUniformScaleError'; }
}

/** A `perspective` or a `matrix3d` sits on the chain. */
export class PerspectiveError extends CasterError {
  constructor(message: string, context?: CasterErrorContext) { super(message, context); this.name = 'PerspectiveError'; }
}

/** An image the gateway cannot read: cross-origin and not in the manifest. */
export class CrossOriginImageError extends CasterError {
  constructor(message: string, context?: CasterErrorContext) { super(message, context); this.name = 'CrossOriginImageError'; }
}

/** A font family a measured run uses whose bytes nothing can supply (D2). */
export class FontUnavailableError extends CasterError {
  constructor(message: string, context?: CasterErrorContext) { super(message, context); this.name = 'FontUnavailableError'; }
}

/** A capability a module needs that the registry did not load, or refuses to build. Never a silent fallback. */
export class CapabilityError extends CasterError {
  constructor(message: string, context?: CasterErrorContext) { super(message, context); this.name = 'CapabilityError'; }
}

/** An element the structure walk's tag table does not name (P7), and a custom element unless the print runs with `unknownElements: 'infer'` (*the printer guesses, says so, and withdraws the claim*, S90). Carries `element`, the DOM path the panel shows, and `tag`. */
export class UnknownElementError extends CasterError {
  constructor(message: string, context?: CasterErrorContext) { super(message, context); this.name = 'UnknownElementError'; }
}

/** A `--pdf-*` hint that does not parse, or a colour the author demanded and nothing can express. */
export class ColorHintError extends CasterError {
  constructor(message: string, context?: CasterErrorContext) { super(message, context); this.name = 'ColorHintError'; }
}
