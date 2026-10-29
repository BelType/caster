/* fontkit as a MODULE specifier, for the node side alone. `src/` never imports it — it arrives through `capability('fontkit')` out of the vendored browser bundle (P2), which is why `types/vendor.d.ts` declares `FontkitFont` as a global and stops there. A node-side test that wants to shape a string reaches for the pinned devDependency instead, and fontkit's shipped declarations describe its node build rather than the `create` its browser module exports. Opaque here for the same reason `FontkitFont` is `any` there: pinning a second surface would be a second version to keep in step.

This file carries no import and no export on purpose — an ambient `declare module` in a file that is itself a module is a module AUGMENTATION, which declares nothing. */

declare module 'fontkit';
