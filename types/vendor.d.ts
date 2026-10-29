/* The vendored bundles carry no type declarations of their own — `scripts/bundle-vendor.js` emits JavaScript, and the libraries reach the printer as capability handles rather than as package imports (P2), so `import('pdf-lib').PDFContext` has nothing to resolve against at a runtime path. The types are still worth having, so the object-layer names Caster writes against are declared here as globals, pointing at the real declarations in `node_modules` where a package ships them (pdf-lib does) and standing as `any` where it does not (fontkit's shipped types are for its node build; harfbuzzjs binds nothing to its subset wasm at all, so `fonts/hbSubset.js` declares that surface itself).

Keep in step with `packages/caster/package.json`'s pinned versions. */

declare global {
  type PDFContext = import('pdf-lib').PDFContext;
  type PDFDocument = import('pdf-lib').PDFDocument;
  type PDFRef = import('pdf-lib').PDFRef;
  type PDFDict = import('pdf-lib').PDFDict;
  type PDFArray = import('pdf-lib').PDFArray;
  type PDFName = import('pdf-lib').PDFName;
  type PDFNumber = import('pdf-lib').PDFNumber;
  type PDFString = import('pdf-lib').PDFString;
  type PDFHexString = import('pdf-lib').PDFHexString;
  type PDFRawStream = import('pdf-lib').PDFRawStream;
  type PDFObject = import('pdf-lib').PDFObject;
  type PDFPage = import('pdf-lib').PDFPage;
  type PDFOperator = import('pdf-lib').PDFOperator;
  type PDFWriter = any;
  type PDFContentStream = any;
  /** fontkit's own `Font`, `Glyph` and `BBox`: its shipped declarations describe its node build, and the browser bundle exports only `create`. */
  type FontkitFont = any;
  type FontkitGlyph = any;
}

export {};
