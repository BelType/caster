# `fonts/` — where every byte came from

Five faces. Four are copied from `browser-to-pdf-experiments`' `harness/fonts/`, whose own provenance script (`harness/tools/fonts.sh`) pins each to a `raw.githubusercontent.com` URL and a SHA-256. The sums below were re-taken from the files in this directory; a mismatch against the harness's table is a drift the specimen would otherwise not notice.

They are tracked in git because the specimen has to run offline, and because D2 is what they demonstrate: **the printer embeds font PROGRAMS**, so a document whose stack ends in a system family cannot be printed at all. BelType's addendum ends its default stack in one, which is why this venue declares its own `@font-face` for every face any run resolves to.

| file | SHA-256 | upstream |
| :--- | :--- | :--- |
| `CrimsonText-Regular.ttf` | `48e6c5d5ad1d01599d374ecb817e15890d1feb3b8a3a88e527d44c90389e1f06` | https://raw.githubusercontent.com/google/fonts/main/ofl/crimsontext/CrimsonText-Regular.ttf |
| `CrimsonText-Italic.ttf` | `4ed1699ac7c64e8b3d33f6bb8323c3d7206b0d7bacb9ee2d65c697e6014d29de` | https://raw.githubusercontent.com/google/fonts/main/ofl/crimsontext/CrimsonText-Italic.ttf |
| `CrimsonText-Bold.ttf` | `a3a0765fc5e8d0b49b540a23aefe0184887dd79f06a0bdf4db7035cea6befa93` | https://raw.githubusercontent.com/google/fonts/main/ofl/crimsontext/CrimsonText-Bold.ttf |
| `JetBrainsMono-Regular.ttf` | `e6fd0d7e91550b3ed2b735d4312474362c4716edc4fc0577a0f61ed782d5aed1` | https://raw.githubusercontent.com/JetBrains/JetBrainsMono/master/fonts/ttf/JetBrainsMono-Regular.ttf |
| `CrimsonPro-Variable.ttf` | `16aa9fb7300a93637da51fac03a071b2ff08b6bbf65f99c794c25f040b58af6a` | https://raw.githubusercontent.com/google/fonts/main/ofl/crimsonpro/CrimsonPro%5Bwght%5D.ttf |

Crimson Text, Crimson Pro and JetBrains Mono are all SIL Open Font License 1.1.

The fifth face is here for one reason: it is VARIABLE. `CrimsonPro[wght].ttf` carries a single `wght` axis running 200 to 900 with a default of 400, at 246 324 bytes and 1024 units per em, and the specimen uses it at two weights — a heading at 700 and a span at 400 — so the export has to freeze one programme into two instances and give each its own subset tag. A PDF carries no variable font: `fvar`, `gvar`, `CFF2` and `HVAR` are ignored by every viewer, so the coordinate Chromium painted has to be pinned at embedding time or the file shows the default master under the browser's rectangles for another weight. It is the only face in this directory the harness did not already have, and the file name is the release's own with the axis brackets flattened out of it.

## `../img/`

| file | SHA-256 | what it is |
| :--- | :--- | :--- |
| `rgb.png` | `ba360b1199da8309e7f0a24a22427ed4bbc052c12b3f0313fd4b793c4a0fea87` | An opaque 8-bit RGB PNG from `harness/fixtures/img/`. It is here because it goes through PASSTHROUGH — no decoder, no re-encode, the file's own bytes into the PDF — which is most of `docs/guide/images.md` and needs no capability at all. |
| `baseline.jpg` | `59ef7a7215e289a368d3c118c03de66cbaf69f3e8c27ccb02f1787770f6e9c3c` | A baseline JPEG, passed through as `DCTDecode`. |
