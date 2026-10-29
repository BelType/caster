---
title: A document that declares no face of its own
lang: en
---

# A document that declares no face of its own

This document links no stylesheet and declares no `@font-face`. Everything it is set in comes from BelType's addendum, which ships four families of its own: Source Sans 3 for the body, Source Code Pro for code, Source Serif 4 for a document that asks for a serif, and Noto Emoji standing before the generic in all three stacks.

Until those faces existed the printer refused a page like this one on its first paragraph, naming the family the stack ended at and saying that nothing in the document supplied bytes for it. That refusal was correct — a PDF carries font PROGRAMS, and a tab is not allowed to read the bytes behind a system family — and the answer was never to soften it but to ship faces the document could reach.

The stacks have to be exercised, not merely declared, so this paragraph carries *an italic phrase* and **a bold one**, which are two more instances of one variable programme, and `an inline code span`, which is a second family.

<p style="font-family: 'Source Serif 4', 'Noto Emoji', serif">And this paragraph is set in the third, named the way an author names it — no vendoring, no <code>@font-face</code>, just the family. Source Serif 4 carries an optical-size axis that Chromium pins to the used font size, so it reaches the file frozen at the coordinate the browser actually painted rather than at its own default master.</p>

## Emoji, which is why the fourth family is here

A rocket 🚀 and a printer 🖨 in the middle of a sentence, so the cluster has to reach a face the printer can embed. Noto Emoji is the MONOCHROME outline face on purpose: the printer paints no colour glyph table, and an outline emoji shapes, subsets, instances and embeds through exactly the road a letter does.

```
a fenced block, set in Source Code Pro
```
