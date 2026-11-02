/**
 * `coordinates/matrix.js` — the PDF matrix and its two operations, product and application.
 *
 * @remarks
 * Pure arithmetic with no value import (the type is the display list's, `displayList.js`), so the writer can multiply a matrix without reaching the placement and measurement modules that also use one (moved from `images/imagePlace.js`, stage 2 of `.claude/plans/the-rust-writer/plan-close-the-list.md`).
 *
 * @packageDocumentation
 */

import type { Matrix } from '../displayList.ts';
export type { Matrix } from '../displayList.ts';

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `A` then `B`. Row vectors, so a point is `[x y 1] · A · B`. */
export function mul(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

/** The point `(x, y)` under `m`. */
export function apply(m: Matrix, x: number, y: number): [number,number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
