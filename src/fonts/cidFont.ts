/**
 * `fonts/cidFont.js` — the whole-face entry point: one face embedded as it arrived.
 *
 * Ported from `harness/src/export/cidFont.ts` (E3, E5). Guide: `docs/guide/font-embedding.md`.
 *
 * The harness's own header follows.
 *
 * The font entry point of `text-emission.md` (E3): one whole face, embedded as it arrived.
 *
 * pdf-lib's `embedFont` is not usable from E3 (`text-emission.md`) on: it encodes a *string* through its own fontkit layout and hands back the bytes it chose, so there is no way to show a glyph id the shaper picked. E3's whole claim is that harfbuzzjs owns glyph selection, so the font objects are written by hand and the content stream shows glyph ids directly.
 *
 * Everything that writes those objects now lives in `fontEmbed.ts`, because E4 (`font-embedding.md`) needs the same dictionaries for CFF, for CID-keyed CFF and for instanced variable faces, and a second implementation of a `/W` array is a second place for it to be wrong. What is left here is the shape E3 (`text-emission.md`) and E5 (`structure-tree.md`) ask for: no subsetting, no axes, integer widths, `/DW` at its 1000 default, and the ToUnicode destination of a glyph the first text it was used for. That combination is `WHOLE_FONT_PROFILE`, and it is what keeps E3's and E5's content streams byte-identical across this change.
 *
 * Widths are integers and the emitter tracks its pen on the same integers, which is not a rounding convenience: mupdf stores a `/W` entry in an `int`, so a producer whose pen model disagrees with the reader's by half a thousandth of an em per glyph drifts about a fifth of a point along a line of a 1024-unit-per-em face. E4 (`font-embedding.md`) writes three decimals instead and records what that costs; see `docs/E4-fonts-plan.md`.
 *
 * @packageDocumentation
 */

import { embedFace, WHOLE_FONT_PROFILE } from './fontEmbed.ts';

import type { CidFont } from './fontEmbed.ts';
import { outlineTableOf } from './fontProgram.ts';
export { glyphString } from './fontEmbed.ts';
/** Embed one face whole. Nothing is written until `finish()`, because the `/W` array and the ToUnicode CMap can only be built once every page has been emitted. */
export function embedCidFont(context: PDFContext, bytes: Uint8Array, id: string): CidFont {
    return embedFace(context, {
        id,
        faceId: id,
        family: '',
        bytes,
        sourceFormat: outlineTableOf(bytes) === 'glyf' ? 'ttf' : 'otf',
        coords: {},
        profile: WHOLE_FONT_PROFILE,
    });
}
