// The facsimile fixtures: small vector PDFs written with pdf-lib, nothing third-party in the content. Run: node make-pdf.mjs (from anywhere; writes beside itself, reproducibly — no dates).
//   fixture.pdf   two pages of 300 x 400 pt, vector shapes and one line of text in Liberation Sans (OFL, from pdfjs-dist/standard_fonts), the font EMBEDDED whole (pdf-lib's subsetter fails against the repo's fontkit, so `subset: false`)
//   landscape.pdf one page whose MediaBox (450 x 230 pt) and CropBox (400 x 200 pt) both start at (50, 30) rather than the origin, to prove the placement honours the box a reader shows
//   standard.pdf  one page whose text is Helvetica, a standard-14 font that is NOT embedded: the file PDF/UA-2 refuses (the 'fonts not embedded' fixture)
//   encrypted.pdf a file that declares encryption in its trailer (pdf-lib cannot encrypt; it needs only to declare it for the refusal, which is by the declaration)
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as fontkit from 'fontkit';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ttf = readFileSync(fileURLToPath(import.meta.resolve('pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf')));
const fresh = () => PDFDocument.create({ updateMetadata: false });
const save = async (doc, name) => { writeFileSync(join(here, name), await doc.save({ useObjectStreams: false })); console.log('wrote', name); };

{
  const doc = await fresh();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(ttf, { subset: false });
  for (const [n, color] of [[1, rgb(0.8, 0.1, 0.1)], [2, rgb(0.1, 0.3, 0.8)]]) {
    const page = doc.addPage([300, 400]);
    page.drawRectangle({ x: 10, y: 10, width: 280, height: 380, borderColor: color, borderWidth: 4 });
    page.drawCircle({ x: 150, y: 200, size: 80, color, opacity: 0.4 });
    page.drawLine({ start: { x: 10, y: 10 }, end: { x: 290, y: 390 }, thickness: 2, color: rgb(0, 0, 0) });
    page.drawText(`FACSIMILE PAGE ${n}`, { x: 40, y: 340, size: 24, font, color: rgb(0, 0, 0) });
  }
  await save(doc, 'fixture.pdf');
}
{
  const doc = await fresh();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(ttf, { subset: false });
  const page = doc.addPage([450, 230]);
  page.setMediaBox(50, 30, 450, 230);
  page.setCropBox(50, 30, 400, 200);
  page.drawRectangle({ x: 50, y: 30, width: 400, height: 200, color: rgb(0.9, 0.9, 0.6) });
  page.drawText('LANDSCAPE CROP', { x: 70, y: 120, size: 28, font, color: rgb(0, 0, 0) });
  await save(doc, 'landscape.pdf');
}
{
  const doc = await fresh();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 400]).drawText('NOT EMBEDDED', { x: 40, y: 340, size: 24, font });
  await save(doc, 'standard.pdf');
}
{
  const doc = await fresh();
  doc.addPage([300, 400]);
  const ctx = doc.context;
  ctx.trailerInfo.Encrypt = ctx.register(ctx.obj({ Filter: 'Standard', V: 1, R: 2, O: ctx.obj('x'.repeat(32)), U: ctx.obj('y'.repeat(32)), P: -4 }));
  await save(doc, 'encrypted.pdf');
}
