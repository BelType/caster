# A note for Caster's next round — the engine names the source

Written 2026-09-21, from Cicero's side, and deliberately not acted on here. Delete this file when the round that reads it closes.

## What changed next door

Cicero now answers whose copy a presented element is: `strip.sourceOf(element)` on `<beltype-root>` — the `strip` the Cicero adapter already holds — and `window.__beltypeCicero.sourceOf(element)` for a host. It returns the adopted original in the root's light DOM, or `null`. The decision is [the engine names the source](../../.claude/decisions/cicero/the-engine-names-the-source.md); the pin is the `sourceOf` test in `packages/essay/test/view.test.js`.

It answers **by identity, at any depth**, for every copy the presentation makes: a first fragment, a continuation, a composed block's fragment, a fixed box's per-page copy, a running element's copy in a margin cell. `null` means the element is not a copy of anything the author wrote: an original, one of the engine's own marks (the `__beltype-slice` shell, the Compositor's `__beltype-break` and `__beltype-fill`), or an element outside the root. **Elements only** — it says nothing about text nodes or characters.

The printer runs in the realm it prints, which is the realm the engine presented in, so the method is reachable from the adapter with no import: it is a member of the DOM element, not of the engine's interior.

## What in this package it makes stale

- **The record that a continuation clone carries no link back to its source** was a true measurement when it was taken. The link exists since 2026-09-18 inside the engine and is published since 2026-09-21. The record is history now, not a fact to design against.
- **`pairContinuation`** finds a source by the `data-beltype-pos` stamp, else by the last same-tag element on an earlier page. With no stamps (any host that did not ask for them) two divided blocks of one tag are told apart by page order alone.
- **`originalOf`** finds the canonical box by stamp, else by tag *where exactly one light-DOM original carries that tag*. Where it answers `null`, `verifyPartitions` checks only half its claim and says so.
- **`pairTrees`** walks a clone against its source by position and restates, in its own header, what `consumeLeadingWords` and a blank shell remove. It is correct today because that restatement is correct today.

Each of the three is a second implementation of a fact `packages/engine-cicero/src/fragments.js` owns. None of them is known to be wrong.

## What the round has to decide — not decided here

1. **Whether the adapter may ask.** The package's rule is that the printer does not depend on an engine's interior, and `joinedWords` is restated here rather than imported for that reason. A method on the presented element is arguably the engine's face rather than its interior, and `src/adapters/cicero.js` is already the one module allowed to know Cicero's DOM. That is a judgement for the numbered record, with its reasoning.
2. **What stays a check if it does.** `verifyPartitions` — a first fragment is a prefix of its original, every continuation a suffix, the first pair covers the block — tests the ENGINE's output, not the pairing, and loses none of its value. The tag-name and stamp-agreement refusals inside `pairTrees` would become checks on an answer rather than the mechanism that produces it. A printer that trusted the verb and checked nothing would have traded a rule it can read for a claim it cannot.
3. **What happens to `originalOf`'s `null`.** With the verb, the original is always named, so the half-claim branch of `verifyPartitions` may become unreachable. If so it is pruned, not kept for safety.
4. **The Paged.js adapter is untouched by any of this.** Paged.js publishes no such door, and `src/adapters/pagedjs.js` keeps its own rules.

## One thing measured on the way, in case it saves an hour

Intake (`root.append(...blocks, ...fixed, ...)`) MOVES a nested `position: fixed` box out of its block into the root's light DOM. By the time anything is presented, no source block holds a fixed box, so the *block holding a nested fixed box* branch of `root.js`' presentation is reached only in the composed mode, for the other reason it names. Probed live on a section holding a rail: the section is presented as its original, the rail's original is an unassigned child of the root, and each page gets one copy.
