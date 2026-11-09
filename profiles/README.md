# `profiles/` — the committed sRGB ICC profile

TRACKED IN GIT, not generated. `srgb.icc` is `sRGB-v2-magic.icc` from [saucecontrol/Compact-ICC-Profiles](https://github.com/saucecontrol/Compact-ICC-Profiles) (`profiles/sRGB-v2-magic.icc`), 736 bytes, SHA-256 `af4efe28…105f4`, class `mntr`, space `RGB `, ICC version 2.1.0, description `sRGB`. `test/profiles.test.ts` asserts the sum and the header fields through the exporter's own `iccDeviceClass`/`iccColorSpace`/`iccVersion`.

`src/capabilities.ts` loads it as the `profiles` capability, `when: (needs, o) => colourOn(needs, o)`, so a document with no declared colour never fetches it, reaching it through `new URL('../profiles/srgb.icc', import.meta.url)` and never a bare specifier, which is what lets a tab, a headless host and a static server all serve the same bytes. It is every page's `/DefaultRGB`, so an untagged `rg` operand means something rather than nothing, and, when the operator passes no `profile`, the output intent's destination.

## Their licence

The collection's `readme.md` says: "All profiles in this collection are released to the public domain under the Creative Commons CC0 license", and its `license` file is the CC0 1.0 Universal text. Read on 2026-11-08. That replaces the two Ghostscript profiles this folder held until 0.2.7, which came from ghostpdl's `iccprofiles/`, a directory ghostpdl's `LICENSE` puts under the AGPL-3.0, in an MIT package.

Caster ships no CMYK profile. A press characterisation (FOGRA39, FOGRA51, SWOP) is the operator's to supply as the `profile` option, and the output intent then carries it; without one the output intent is this sRGB profile and the two roads that convert to CMYK refuse. A CMYK profile the tests use stays under `test/assets/`, outside the package (see `test/assets/PROVENANCE.md`).
