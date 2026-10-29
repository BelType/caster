# The raster assets the pure image suite reads

Thirteen files copied verbatim from `harness/fixtures/img/` in the `browser-to-pdf-experiments` repository, which is where they were generated and where their provenance is written: `harness/tools/images.mjs` regenerates every one of them deterministically from a seeded mulberry32 PRNG through `sharp`, except `arith.jpg`, which no encoder in that environment can write and which is downloaded from libjpeg-turbo's own test images against a recorded checksum.

They are here so `test/images.test.js` can decide the passthrough table's row for each of them **in node**, from the bytes alone, with no browser and no decoder: `parsePng`, `parseJpeg` and `canPassThroughIdat` are header readers, and the table's whole claim is that a header is all the decision needs. The ones the experiments use for measurement rather than for a table row — `photo.png` at 3.8 MB, `lowalpha.png`, `screenshot.png`, `alpha.webp`, `photo.avif`, `anim.gif` — are deliberately not copied: their claims are measured in a browser and belong to the acceptance test, not to this one.

| file | what it is | the row it proves |
| :--- | :--- | :--- |
| `baseline.jpg` | JPEG baseline, YCbCr, 3 components, 240×160 | `/DCTDecode` passthrough, `/DeviceRGB` |
| `progressive.jpg` | JPEG progressive (SOF2), 240×160 | SOF2 passes through unread |
| `cmyk.jpg` | JPEG, 4 components, APP14 Adobe, 240×160 | `/DeviceCMYK` and the `/Decode [1 0 1 0 1 0 1 0]` sign |
| `exif6.jpg` | JPEG baseline, APP1 EXIF orientation 6, stored 160×240 | the rotation is folded into `cm`, never into the pixels |
| `p3.jpg` | JPEG baseline, APP2 Display P3 ICC, 240×160 | `/ICCBased` with `/N` = the component count |
| `arith.jpg` | JPEG arithmetic (SOF9), 227×149, downloaded | Chromium has no arithmetic decoder, so there is no canvas route |
| `rgb.png` | PNG 8-bit RGB, non-interlaced, `iCCP`, 240×160 | `IDAT` passthrough with an embedded profile |
| `gray.png` | PNG 8-bit grayscale with `gAMA`, 200×140 | `/DeviceGray` passthrough; `gAMA` recorded and ignored |
| `rgb16.png` | PNG 16-bit RGB, non-interlaced, 200×140 | `/BitsPerComponent 16`, the case no canvas could give back |
| `palette-trns.png` | PNG palette with `tRNS`, 160×120 | a per-pixel alpha lookup forces a decode |
| `interlaced.png` | PNG 8-bit RGB, Adam7, 160×120 | seven reduced images, which one predictor does not describe |
| `logo.png` | PNG 8-bit RGB, 96×32 | dedupe: one XObject on three pages |
| `tile.png` | PNG 8-bit RGB, 96×96 | the raster `background-image` artifact |

SHA-256, as copied:

```
4672c7f08864cd0a8c73a4fa4b66ca32b635d38464551c1ecf06564ae8c89b38  arith.jpg
59ef7a7215e289a368d3c118c03de66cbaf69f3e8c27ccb02f1787770f6e9c3c  baseline.jpg
9740883ac63ad4662e9681ff48c824b40ebb041423322d7430eb5595b20123a9  cmyk.jpg
4e2432ae2e16909d4ee045b49757a377110c4fc07f02a0e7a9c9ea9adbd6a0d6  exif6.jpg
d843a7eda8fb6e9b35c075089b1a4e7af74e4cffe6cb95c77e87a465989e86f6  gray.png
4ce10961f8e64e3f6b963398160b72929da2764357238cfe9f43e8acdf93c4df  interlaced.png
0d19fed95fab5835ad6e85c857b6ac150cffcfeb83b75436f972300de6160697  logo.png
fed0541d0a9c7a0f45849e9d908f4bdd0faded0504f432aacae37951109890cb  p3.jpg
367766b211b28972a32ad6b3af1e4c75b8c0a7245a4db94d4341a1756272f8c4  palette-trns.png
0e341cf8c7d8fd57bd1d6fde28237d71b4f15a0e2e2d8a6214702c3cc69e642d  progressive.jpg
ba360b1199da8309e7f0a24a22427ed4bbc052c12b3f0313fd4b793c4a0fea87  rgb.png
a9ddeb8fa48e547d3d80a2f75aa69cb0031fbc34377bfdfea1acd394fdaa9606  rgb16.png
0f76a8a11d9ad2efce172e27fe53be0d72a50f645bd64e952fcbc21dd5b8edd9  tile.png
```

The `arith.jpg` checksum is the one `harness/tools/images.mjs` pins against `https://raw.githubusercontent.com/libjpeg-turbo/libjpeg-turbo/main/testimages/testimgari.jpg`; the other twelve are the checksums of that repository's generated files as committed.
