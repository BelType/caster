# `profiles/` — the two committed ICC profiles

TRACKED IN GIT, not generated. `scripts/profiles.sh` is their provenance: with no arguments it verifies the recorded SHA-256 sums and prints the header fields; with `--download` it re-fetches each file from its pinned URL first, so an upstream change shows up as a checksum failure rather than as silent drift in what the output intent claims. `test/profiles.test.js` asserts the same sums and the same fields, through the exporter's own `iccDeviceClass`/`iccColorSpace`/`iccVersion`, so `npm test` checks the provenance too.

`src/capabilities.js` loads both as the `profiles` capability — `when: (needs, o) => colourOn(needs, o)`, so a document with no declared colour never fetches 190 KB — reaching them through `new URL('../profiles/<name>', import.meta.url)` and never a bare specifier, which is what lets a tab, a headless host and a static server all serve the same bytes.

| file | source | sha256 | class | space | version | bytes | what it is for |
| :--- | :--- | :--- | :--- | :--- | :--- | ---: | :--- |
| `default_cmyk.icc` | [ArtifexSoftware/ghostpdl](https://raw.githubusercontent.com/ArtifexSoftware/ghostpdl/master/iccprofiles/default_cmyk.icc) | `8472fa14…9fd1b9a9` | `prtr` | `CMYK` | 2.1.0 | 187484 | `/OutputIntents`' `/DestOutputProfile`: the CMYK condition the whole file is destined for. `prtr` + CMYK + ICC v2 is what PDF/A-4 6.2.3 t1 asks of a destination profile |
| `srgb.icc` | [ArtifexSoftware/ghostpdl](https://raw.githubusercontent.com/ArtifexSoftware/ghostpdl/master/iccprofiles/srgb.icc) | `eddaf344…18c5f7d5` | `mntr` | `RGB ` | 2.1.0 | 2576 | every page's `/DefaultRGB`, so an untagged `rg` operand means something rather than nothing |

Neither is a press characterisation profile — no FOGRA39 or FOGRA51 is reachable from this environment — so the output condition identifier is the profile's own description string rather than a registered characterisation name. That is the experiments' own limit, recorded in `docs/guide/colour.md` and inherited here unchanged: a venue that has a real characterisation profile should be able to name it, and the door for that is the `profiles` capability's file list.

saucecontrol's 456-byte `sRGB-v2-micro.icc` was the fallback for the case where Ghostscript's sRGB turned out not to be v2. It is v2, so the compact profile is not committed.
