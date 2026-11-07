# `assets/fonts/` — BelType's print default faces, and where every byte came from

Seven files, four families, all SIL Open Font License 1.1, all VARIABLE, all with TrueType (`glyf`) outlines. The decision that put them here is `.claude/decisions/project/print-default-faces.md`; the addendum that declares them is `../beltype-ua.css`; the table that serves them at `/_beltype/vendor/beltype-fonts/` is `packages/cli/src/client-assets.js`.

They are tracked in git and shipped in the published package because they are what makes a document PRINTABLE. BelType's own printer (`packages/caster`) embeds font PROGRAMS, so a stack that ends in `serif` or `sans-serif` is a document nobody can produce a PDF from: a tab is not allowed to read the bytes behind a system family. Before these, every document that declared no `@font-face` of its own refused on its first paragraph.

## The bytes

Every file is the Google Fonts build named below with **nothing changed but the container**: TTF to WOFF2, through `wawoff2`'s own `compress` (the reference Google encoder, run in node). The outlines and the tables are the upstream ones; the sums for both are given so either claim can be re-checked. Upstream files live under `https://raw.githubusercontent.com/google/fonts/main/ofl/<family>/`, and the commit is the newest one that touched that family's directory when these were taken (2026-09-14).

| file | bytes | SHA-256 | upstream file | upstream SHA-256 | commit |
| :--- | ---: | :--- | :--- | :--- | :--- |
| `sourceserif4/SourceSerif4-Variable.woff2` | 428 084 | `1448465ddb15c384bb180c45efe9c507ffd560592422db1b10c1443ed75c5448` | `ofl/sourceserif4/SourceSerif4[opsz,wght].ttf` (1 209 508 B) | `97b2d4da6e3cb494b5a1e66ae176914d852ccabef49e0c02c0df25f3e39aca0b` | `08dc85da6bca7ae308a6f1d38d0b137465646071` |
| `sourceserif4/SourceSerif4-Italic-Variable.woff2` | 346 248 | `efab0677a026d3397b8cc1e5de357ac8bf1ae9aa1275d7e77ca3e2a164a49eb3` | `ofl/sourceserif4/SourceSerif4-Italic[opsz,wght].ttf` (855 432 B) | `15fbc7e4679489a501998c3669272637a6646388ef7e4bd77eebb5bf967a1f42` | `08dc85da6bca7ae308a6f1d38d0b137465646071` |
| `sourcesans3/SourceSans3-Variable.woff2` | 170 296 | `125c226ee175acc3b148470f0aef7f865e23bf02b2ef307061b7b10553654165` | `ofl/sourcesans3/SourceSans3[wght].ttf` (646 340 B) | `042fe2cc0b933e328410d7acbd0aa6a1873dca5aef81875f4bc214b08825c7b9` | `914ec116571b1162d886aa402e715552221f0b77` |
| `sourcesans3/SourceSans3-Italic-Variable.woff2` | 138 260 | `f491893ad5dd69b198834fa78e4d8ea3873b787dc54fc678230519de69f7bda2` | `ofl/sourcesans3/SourceSans3-Italic[wght].ttf` (395 372 B) | `39e3ab05ccd7cb94907c31005bb5bec1d5432f0b096a2b782976e217a540eb6c` | `914ec116571b1162d886aa402e715552221f0b77` |
| `sourcecodepro/SourceCodePro-Variable.woff2` | 89 652 | `2acbd1a045bc5deacbacd36fe882472b99e7aac235bed7c1dcb260b3c221a01c` | `ofl/sourcecodepro/SourceCodePro[wght].ttf` (212 340 B) | `b400fc584e10aff25d0e775ce181b4fc1c5ea1b5dc37b81aeb2084375b945790` | `bd62bd8b4715f007af6905b0c9fd030f8410b289` |
| `sourcecodepro/SourceCodePro-Italic-Variable.woff2` | 75 260 | `ce92b017c26524c311bae6197b60db53cf4693ac61400fe7d91fa1f5d3c30d86` | `ofl/sourcecodepro/SourceCodePro-Italic[wght].ttf` (174 852 B) | `6db77d25aa7b30eff449305b5c998e475694c74d398421127ea5a60f536413cd` | `bd62bd8b4715f007af6905b0c9fd030f8410b289` |
| `notoemoji/NotoEmoji-Variable.woff2` | 1 052 324 | `04f79c94a3b29cbfc882c6cddbe4a2daade6e7e5bcee3e1989c1fed40f6e63ba` | `ofl/notoemoji/NotoEmoji[wght].ttf` (1 982 596 B) | `de6c18832938afc99caf132b39d6a30a19bac7f2e812e28db2535b4608d27551` | `8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5` |

**2 300 124 B of faces**, against 5 476 440 B of the same fonts as TTF. That ratio is why a WOFF2 decoder was worth a round of its own: there is none that runs in a browser as published, and `packages/caster`'s `scripts/bundle-vendor.js` patches the one line of Emscripten glue that keeps `wawoff2` from ever settling in a tab (DESIGN.md S46). Without it these would have shipped as WOFF, at roughly a megabyte more.

The axis brackets are flattened out of every file name — `SourceSerif4[opsz,wght].ttf` becomes `SourceSerif4-Variable.woff2` — on the precedent `packages/caster/fixtures/specimen/fonts/` already set. A square bracket in a URL is percent-encoded by some clients and not by others, and one spelling that four servers and the Linker all agree on is worth more than matching the release's own name.

## The licences

| file | bytes | SHA-256 |
| :--- | ---: | :--- |
| `sourceserif4/OFL.txt` | 4 400 | `5f94c3fd3a23131a417ab5a0c8452de57e70c3cfb9f604d88241f7065ebf9fd9` |
| `sourcesans3/OFL.txt` | 4 579 | `09746787287a289323b0ec3cff4d1a4a801331b82b7207c1e186f5d26619a392` |
| `sourcecodepro/OFL.txt` | 4 622 | `cb30d3086a8b3ce0b9e3690bf48d6620402b61160bc658076f95180ccd9e9dae` |
| `notoemoji/OFL.txt` | 4 330 | `500bb1ccf43df7bbb522112f9133a52b16e1c35e809632f5d8609b179152de5b` |

Each is the upstream `OFL.txt` from the same directory as the faces beside it, unchanged. **17 931 B**, so this directory adds **2 318 055 B** to the published `@egildo/beltype-core`.

## The axes, read out of the programs

The `@font-face` weight ranges in the addendum are these and not the `100 900` everyone writes, because a descriptor claiming a coordinate the axis does not reach is a claim about a master that does not exist.

| family | axes | why it matters |
| :--- | :--- | :--- |
| Source Serif 4 | `wght` 200–900 (default 400), `opsz` 8–60 (default 20) | `font-optical-sizing: auto` is the CSS default and Chromium pins `opsz` to the used font size, so the printer freezes one instance per size × weight. The manual embeds fourteen of them, which is this axis being honest rather than a defect. |
| Source Sans 3 | `wght` 200–900 (default 200) | |
| Source Code Pro | `wght` 200–900 (default 200) | |
| Noto Emoji | `wght` 300–700 (default 400) | The MONOCHROME face, not Noto Color Emoji: the printer paints no COLR or CBDT table, and the colour build is nine megabytes. An outline emoji shapes, subsets, instances and embeds through exactly the road a letter does. |

**What none of them covers**, found by walking the manual's own characters against all four: `∪` U+222A. There is no stack that reaches it here, which is the honest shape of a default — a document that needs a character these four do not have declares a face that does.
