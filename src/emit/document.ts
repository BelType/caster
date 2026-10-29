/**
 * `emit/document.js` — the document scaffolding: the PDF 2.0 header, the catalog `/Version`, the Info dictionary and the XMP packet.
 *
 * Ported from `harness/src/export/document.ts` (E0, E3, E5, E12F). Guide: `docs/guide/structure-tree.md`.
 *
 * WHAT THE PORT CHANGED (P2, P3). pdf-lib is a capability handle. `registerFontkit(@pdf-lib/fontkit)` is dropped: it exists so `pdf().PDFDocument.embedFont` can lay a string out with fontkit, which is Path A — the subsetting route `font-embedding.md` §"The two tiers" documents as a refusal and P3 keeps only as a flag whose loader refuses. Caster writes every font dictionary by hand (`fonts/fontEmbed.js`), never calls `embedFont`, and therefore needs neither the registration nor the extra package.
 *
 * The harness's own header follows.
 *
 * Document scaffolding shared by every exporter in the harness.
 *
 * E0's `emit.ts` grew the PDF 2.0 header, the catalog `/Version`, the Info dictionary and the XMP packet one veraPDF rule at a time; E3 (`text-emission.md`) needs exactly the same four things around a completely different content stream, so they live here and both emitters call them. Nothing in this module knows what is on the page.
 *
 * The split is deliberately shaped so the bytes of `emit.ts` (E0) do not move: `/Version` is written by `serialize()` rather than by `createDocument()` because the catalog is serialised in key-insertion order, and setting it first would reorder the catalog dictionary of `emit.ts` for no gain.
 *
 * @packageDocumentation
 */
import { capability } from '../capabilities.ts';
import { PDF20Writer } from './pdf20-writer.ts';

const pdf = () => capability('pdf');

export type DocumentInfo = {
  /** BCP 47 tag written to the catalog /Lang and to the XMP dc:title. */
  language: string;
  /** Written to Info /Title, to the window title bar flag, and to dc:title. */
  title: string;
  producer: string;
  creator: string;
  /** Whether the XMP claims PDF/UA-2 (*the printer guesses, says so, and withdraws the claim*, S90). `'tagged'` writes no `pdfuaid` block: the file is tagged, and a tag the printer guessed is not a claim it makes. */
  conformance: 'pdfua2'|'tagged';
};

/**
 * An empty PDF 2.0 document.
 *
 * @remarks
 * Nothing is registered on it — the fonts are embedded by hand in `fontEmbed.js`, which is why pdf-lib's own fontkit registration is not wanted here.
 */
export async function createDocument(): Promise<PDFDocument> {
    const pdfDoc = await pdf().PDFDocument.create();
    // PDFContext.header is a public mutable field, so the document's version lives here; PDF20Writer is what makes the writer honour it, since pdf-lib's own PDFWriter hardcodes pdf().PDFHeader.forVersion(1, 7).
    pdfDoc.context.header = pdf().PDFHeader.forVersion(2, 0);
    return pdfDoc;
}
/** Write the catalog `/Lang` and the Info dictionary's title, producer and creator. */
export function setInfo(pdfDoc: PDFDocument, info: DocumentInfo) {
    pdfDoc.setLanguage(info.language);
    pdfDoc.setTitle(info.title, { showInWindowTitleBar: true });
    pdfDoc.setProducer(info.producer);
    pdfDoc.setCreator(info.creator);
}
/** Escape `&`, `<` and `>` for XML text content. */
const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/**
 * XMP packet carrying dc:title, the producing tool, the PDF/UA-2 identification when the file claims it, and the language.
 *
 * @remarks
 * Forced by veraPDF PDF/UA-2 rule 8.11.1 t2: the catalog needs a Metadata key whose stream dictionary has Type /Metadata and Subtype /XML. pdf-lib's setTitle only writes the Info dictionary, so the packet is built by hand. `xmp:CreatorTool` and `pdf:Producer` restate what `setInfo` puts in the Info dictionary, because a PDF 2.0 reader is entitled to consult only the packet.
 */
export function addXmpMetadata(pdfDoc: PDFDocument, info: DocumentInfo) {
    const { title, language } = info;
    const escaped = escapeXml(title);
    const xmp = `<?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:title>
        <rdf:Alt>
          <rdf:li xml:lang="${language}">${escaped}</rdf:li>
        </rdf:Alt>
      </dc:title>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <xmp:CreatorTool>${escapeXml(info.creator)}</xmp:CreatorTool>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
      <pdf:Producer>${escapeXml(info.producer)}</pdf:Producer>
    </rdf:Description>${info.conformance === 'pdfua2' ? `
    <rdf:Description rdf:about="" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/">
      <pdfuaid:part>2</pdfuaid:part>
      <pdfuaid:rev>2024</pdfuaid:rev>
    </rdf:Description>` : ''}
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
    // Metadata streams stay uncompressed so they remain readable without the document, which is the whole point of the packet.
    //
    // The packet is handed over as bytes and not as a string. pdf-lib's `context.stream(string)` encodes by `charCodeAt`, one byte per code unit: the packet's leading BOM, U+FEFF, landed as the single byte 0xFF — which is never valid UTF-8 — so the XML was malformed in every file this printer has written, and a non-ASCII `dc:title` was mangled in the one place ISO 14289-2 §8.11 requires it (`Größe` measured as `ff 47 72 f6 df 65`). `TextEncoder` is what the packet's own `<?xpacket?>` header claims.
    const metadataRef = pdfDoc.context.register(pdfDoc.context.stream(new TextEncoder().encode(xmp), { Type: 'Metadata', Subtype: 'XML' }));
    pdfDoc.catalog.set(pdf().PDFName.of('Metadata'), metadataRef);
}
/**
 * Flush and write the file.
 *
 * @remarks
 * pdf().PDFDocument.save() is bypassed because it hardcodes its writer: it is only flush() plus PDFWriter/PDFStreamWriter.forContext(...).serializeToBuffer(), and PDFWriter is the half that ignores context.header. Doing those two steps by hand lets PDF20Writer take the writer's place, and it pauses after every 50 ms of work where pdf-lib pauses after every 50 objects. PDFWriter rather than PDFStreamWriter keeps object streams off, which keeps the saved file greppable during development.
 *
 * The catalog /Version entry is what a PDF 2.0 reader consults when it disagrees with the header, and it is written here so it lands last in the catalog, after everything the emitters put there.
 */
export async function serialize(pdfDoc: PDFDocument): Promise<Uint8Array> {
    pdfDoc.catalog.set(pdf().PDFName.of('Version'), pdf().PDFName.of('2.0'));
    await pdfDoc.flush();
    return PDF20Writer.create(pdfDoc.context).serializeToBuffer();
}
