/**
 * `emit/pdf20-writer.js` — the `%PDF-2.0` header.
 *
 * Ported from `harness/src/export/pdf20-writer.ts` (E0). Guide: `docs/guide/structure-tree.md` §"The catalog and the XMP".
 *
 * WHAT THE PORT CHANGED (P2). `PDFWriter` is reached through `capability('pdf')`, so the subclass is built lazily on first use — a class declaration cannot extend a value that does not exist yet, and the vendored bundle only exists once the registry has loaded it.
 *
 * The harness's own header follows.
 *
 * A PDFWriter that writes the header its context carries instead of the hardcoded `%PDF-1.7`.
 *
 * pdf-lib's PDFWriter.computeBufferSize() builds its own PDFHeader.forVersion(1, 7) and hands it to serializeToBuffer(), so PDFContext.header — which PDFDocument exposes as a public mutable field — never reaches the file. Overriding computeBufferSize() is the smallest seam: the base implementation still lays out the objects, the cross-reference section and the trailer, and only the header (and the buffer size it implies) is swapped afterwards.
 *
 * The size is adjusted by the difference between the two headers rather than assumed equal. `%PDF-2.0` and `%PDF-1.7` happen to be the same length, which is also why the cross-reference offsets the base class computed stay correct; a header of a different length would need those offsets recomputed too.
 *
 * PDFStreamWriter (pdf-lib's object-stream writer) shares this computeBufferSize shape, so the same override works there if object streams are ever wanted.
 *
 * The writer also pauses by time rather than by count (see {@link SLICE_MS}). Where it pauses changes when the work runs and never what it writes.
 *
 * @packageDocumentation
 */
import { capability } from '../capabilities.ts';
import { CasterError } from '../errors.ts';
import { sha256Bytes } from '../sha256.ts';
/**
 * The subclass, built on first use.
 *
 * @remarks
 * A class declaration cannot extend a value the module does not have yet, and `capability('pdf')` is a value the registry supplies at run time; one memoised call is what turns the harness's static subclass into a lazy one with no other difference. `any` because `PDFWriter` is (`types/vendor.d.ts`): pdf-lib declares its constructor and `computeBufferSize` protected, and a class built from a run-time value cannot reach them otherwise.
 */
let Subclass: any = null;

/**
 * The work, in milliseconds, between two of the writer's pauses: the browser's own threshold for a long task, so the tab still answers while a file is written.
 *
 * @remarks
 * pdf-lib pauses one `setTimeout(0)` every N objects, 50 by default, and the browser holds a timer set inside a timer back to about 4 ms. Measured 2026-10-29 on the manual (304 pages, 15 559 objects) in the headless shell: 623 pauses, 3.0 s of the writer's 6.1 s spent waiting on them, 311 bare timers at 1 373 ms. A pause after every 50 ms of work keeps the tab responsive at a cost of a few pauses.
 */
const SLICE_MS = 50;

/**
 * The `PDFWriter` subclass whose `computeBufferSize` swaps in the context's own header.
 *
 * @returns The memoised class, `any` as {@link Subclass} is.
 */
function writerClass(): any {
    if (Subclass) return Subclass;
    const PDFWriter = capability('pdf').PDFWriter;
    Subclass = class PDF20Writer extends PDFWriter {
        constructor(context: PDFContext) {
            super(context, 1);
            let last = performance.now();
            // pdf-lib assigns its count rule to the instance in its own constructor, so the time rule replaces it here rather than on the prototype.
            this.shouldWaitForTick = () => {
                const at = performance.now();
                if (at - last < SLICE_MS) return false;
                last = at;
                return true;
            };
        }
        async computeBufferSize() {
            // The identifier is laid out as a placeholder of its final length, so every size and offset the base class computes holds; `serializeToBuffer` writes the digest over it.
            const { PDFHexString } = capability('pdf');
            this.context.trailerInfo.ID = this.context.obj([PDFHexString.of(PLACEHOLDER), PDFHexString.of(PLACEHOLDER)]);
            const info = await super.computeBufferSize();
            const header = this.context.header;
            return { ...info, header, size: info.size + header.sizeInBytes() - info.header.sizeInBytes() };
        }
        async serializeToBuffer() {
            const bytes: Uint8Array = await super.serializeToBuffer();
            await writeFileId(bytes);
            return bytes;
        }
    };
    return Subclass;
}

/** 32 hex digits, the identifier's 16 bytes before the digest is known. */
const PLACEHOLDER = '0'.repeat(32);

/**
 * Write the trailer's `/ID` over its placeholder: both entries the first 16 bytes of a SHA-256 over the file up to the cross-reference table, as forme derives it, so the identifier is a function of the list.
 *
 * @remarks
 * ISO 32000-2 §7.5.5 requires an `/ID` of every PDF 2.0 file, and PDF/A-4 tests it (veraPDF's 6.1.3-1). The trailer follows the cross-reference table, so writing it moves no offset. The digest is `crypto.subtle`'s, and {@link sha256Bytes}'s in a realm with none (a page on an origin that is not a secure context), which agrees with it and is slower (32 ms on the 849 kB `convert-images` file in node 25, measured 2026-11-17).
 */
async function writeFileId(bytes: Uint8Array): Promise<void> {
    const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - 64)));
    const xref = Number(/startxref\s+(\d+)\s+%%EOF\s*$/u.exec(tail)?.[1]);
    const head = bytes.subarray(0, xref);
    let digest: Uint8Array;
    // A page on an origin that is not a secure context has no `crypto.subtle`, so the call throws there.
    try { digest = new Uint8Array(await crypto.subtle.digest('SHA-256', head as BufferSource)); }
    catch { digest = sha256Bytes(head); }
    const id = new TextEncoder().encode(Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join(''));
    const placeholder = new TextEncoder().encode(`<${PLACEHOLDER}>`);
    let at = xref;
    for (let found = 0; found < 2; found++) {
        at = indexOf(bytes, placeholder, at);
        bytes.set(id, at + 1);
        at += placeholder.length;
    }
}

/** Where `needle` first stands in `bytes` at or after `from`. */
function indexOf(bytes: Uint8Array, needle: Uint8Array, from: number): number {
    outer: for (let i = from; i <= bytes.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
        return i;
    }
    throw new CasterError('caster: the trailer lost the file identifier the writer laid out for it');
}

/** The writer's one door: `PDFWriter`'s constructor is protected in pdf-lib's declarations, so instantiation happens through `create`. */
export const PDF20Writer = {
    /** A writer for `context` that honours `context.header`. */
    create(context: PDFContext) {
        const Writer = writerClass();
        return new Writer(context);
    }
};
