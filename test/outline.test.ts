/**
 * The document outline: the tree the heading levels make, and the object it becomes.
 *
 * Two things are being checked and they are different in kind. The first is arithmetic on the levels — an `H2` after an `H1` is its child, a second `H1` closes the first, and an `H3` that follows an `H1` with no `H2` between them is one level down and not two, because a reader navigates the tree it is given and a hole in the numbering is not a level of the outline. The second is the object: `/First`, `/Last`, `/Prev`, `/Next` and `/Parent` threaded the way 12.3.3 asks, every item open with a positive `/Count`, and a destination that names the heading's STRUCTURE ELEMENT rather than its page — PDF/UA-2 8.8 t1, which veraPDF fails a page destination on by name, and which is the one place the port's file disagrees with the E12 spec and follows the probe.
 *
 * pdf-lib arrives through `capability('pdf')` here exactly as it does in the printer, so this suite loads the vendored bundle and builds a real `PDFContext` — the object half is read back out of the context rather than asserted from the arguments.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { capability, load } from '../src/capabilities.ts';
import { buildOutline } from '../src/emit/outline.ts';

before(async () => { await load(['pdf']); });

/** A context and a ref per heading, as the emitter would have allocated them. */
function scene( headings: { title: string; level: number; page?: number; topPt?: number; }[]) {
  const { PDFContext } = capability('pdf');
  const context = PDFContext.create();
  return {
    context,
    headings: headings.map((heading, index) => ({
      path: `body>h${heading.level}[${index}]`,
      ref: context.nextRef(),
      title: heading.title,
      level: heading.level,
      page: heading.page ?? 0,
      topPt: heading.topPt ?? 700,
    })),
  };
}

/** One outline item's dictionary, by the name its `/Title` carries. */
function itemsByTitle( context: any,  outlinesRef: any) {
  const { PDFName } = capability('pdf');
  const out: Map<string,any> = new Map<any, any>();
  const visit = ( ref: any) => {
    const dict = context.lookup(ref);
    const title = dict.get(PDFName.of('Title'));
    out.set(title.decodeText ? title.decodeText() : title.asString(), { ref, dict });
    const first = dict.get(PDFName.of('First'));
    let kid = first;
    while (kid) {
      visit(kid);
      kid = context.lookup(kid).get(PDFName.of('Next'));
    }
  };
  const root = context.lookup(outlinesRef);
  let child = root.get(PDFName.of('First'));
  while (child) {
    visit(child);
    child = context.lookup(child).get(PDFName.of('Next'));
  }
  return out;
}

test('a document with no headings gets no outline at all', () => {
  const { context } = scene([]);
  assert.equal(buildOutline(context, []), null);
});

test('the nesting is the heading levels: a second h1 closes the first', () => {
  const { context, headings } = scene([
    { title: 'One', level: 1 },
    { title: 'One.a', level: 2 },
    { title: 'One.a.i', level: 3 },
    { title: 'One.b', level: 2 },
    { title: 'Two', level: 1 },
  ]);
  const outline = (buildOutline(context, headings) as NonNullable<ReturnType<typeof buildOutline>>);
  assert.deepEqual(outline.items.map((i) => [i.title, i.depth, i.count]), [
    ['One', 0, 3],
    ['One.a', 1, 1],
    ['One.a.i', 2, 0],
    ['One.b', 1, 0],
    ['Two', 0, 0],
  ]);
});

test('a level skipped on the way down is one level of the outline, not two', () => {
  const { context, headings } = scene([
    { title: 'Chapter', level: 1 },
    { title: 'Deep', level: 3 },
    { title: 'Deeper', level: 4 },
    { title: 'Next chapter', level: 1 },
  ]);
  const outline = (buildOutline(context, headings) as NonNullable<ReturnType<typeof buildOutline>>);
  assert.deepEqual(outline.items.map((i) => [i.title, i.level, i.depth]), [
    ['Chapter', 1, 0],
    ['Deep', 3, 1],
    ['Deeper', 4, 2],
    ['Next chapter', 1, 0],
  ]);
});

test('the root counts the whole tree, and every item is written open', () => {
  const { PDFName } = capability('pdf');
  const { context, headings } = scene([
    { title: 'One', level: 1 },
    { title: 'One.a', level: 2 },
    { title: 'Two', level: 1 },
  ]);
  const outline = (buildOutline(context, headings) as NonNullable<ReturnType<typeof buildOutline>>);
  // `lookup(ref)` answers `PDFObject | undefined` now that `capability('pdf')` is typed; the narrowing overload `lookup(ref, PDFDict)` is a runtime token, so the read-back goes through `any`, as `itemsByTitle` above already does.
  const root = (context.lookup(outline.ref) as any);
  assert.equal(root.get(PDFName.of('Type')).asString(), '/Outlines');
  assert.equal(root.get(PDFName.of('Count')).asNumber(), 3);

  const items = itemsByTitle(context, outline.ref);
  // A positive `/Count` is an open item; a leaf writes none at all.
  assert.equal(items.get('One').dict.get(PDFName.of('Count')).asNumber(), 1);
  assert.equal(items.get('One.a').dict.get(PDFName.of('Count')), undefined);
  assert.equal(items.get('Two').dict.get(PDFName.of('Count')), undefined);
});

test('the siblings are threaded and the parent is named on every item', () => {
  const { PDFName } = capability('pdf');
  const { context, headings } = scene([
    { title: 'One', level: 1 },
    { title: 'One.a', level: 2 },
    { title: 'One.b', level: 2 },
    { title: 'Two', level: 1 },
  ]);
  const outline = (buildOutline(context, headings) as NonNullable<ReturnType<typeof buildOutline>>);
  const items = itemsByTitle(context, outline.ref);
  // Read back through `any`, for the reason the first test gives.
  const root = (context.lookup(outline.ref) as any);

  assert.equal(String(root.get(PDFName.of('First'))), String(items.get('One').ref));
  assert.equal(String(root.get(PDFName.of('Last'))), String(items.get('Two').ref));
  // The first root has no `/Prev` and the last has no `/Next`.
  assert.equal(items.get('One').dict.get(PDFName.of('Prev')), undefined);
  assert.equal(String(items.get('One').dict.get(PDFName.of('Next'))), String(items.get('Two').ref));
  assert.equal(items.get('Two').dict.get(PDFName.of('Next')), undefined);
  assert.equal(String(items.get('Two').dict.get(PDFName.of('Prev'))), String(items.get('One').ref));
  // The children point back at the item that opened them, and at each other.
  assert.equal(String(items.get('One.a').dict.get(PDFName.of('Parent'))), String(items.get('One').ref));
  assert.equal(String(items.get('One.b').dict.get(PDFName.of('Parent'))), String(items.get('One').ref));
  assert.equal(String(items.get('One.a').dict.get(PDFName.of('Next'))), String(items.get('One.b').ref));
  assert.equal(String(items.get('One').dict.get(PDFName.of('First'))), String(items.get('One.a').ref));
  assert.equal(String(items.get('One').dict.get(PDFName.of('Last'))), String(items.get('One.b').ref));
  // A root's parent is the `/Outlines` dictionary itself.
  assert.equal(String(items.get('One').dict.get(PDFName.of('Parent'))), String(outline.ref));
});

test('a destination names the structure element, keeps the reader’s left and zoom, and asks only for y', () => {
  const { PDFName } = capability('pdf');
  const { context, headings } = scene([{ title: 'Only', level: 1, page: 2, topPt: 731.25 }]);
  const outline = (buildOutline(context, headings) as NonNullable<ReturnType<typeof buildOutline>>);
  const dest = itemsByTitle(context, outline.ref).get('Only').dict.get(PDFName.of('Dest'));
  assert.equal(dest.size(), 5);
  // PDF/UA-2 8.8 t1: a structure destination, which is the heading's own element and not its page.
  assert.equal(String(dest.get(0)), String(headings[0].ref));
  assert.equal(dest.get(1).asString(), '/XYZ');
  assert.equal(String(dest.get(2)), 'null');
  assert.equal(dest.get(3).asNumber(), 731.25);
  assert.equal(String(dest.get(4)), 'null');
  // The page rides the record for the report, and the file resolves it through the element's own `/Pg`.
  assert.equal(outline.items[0].page, 2);
  assert.equal(outline.items[0].topPt, 731.25);
});

test('a title pdf-lib cannot write as a literal is written as hex', () => {
  const { PDFName } = capability('pdf');
  const { context, headings } = scene([
    { title: 'Plain ASCII', level: 1 },
    { title: 'Größe (mit Klammern)', level: 1 },
    { title: 'A (parenthesis)', level: 1 },
  ]);
  const outline = (buildOutline(context, headings) as NonNullable<ReturnType<typeof buildOutline>>);
  // Read back through `any`, for the reason the first test gives — the root and every item below it.
  const root = (context.lookup(outline.ref) as any);
  const written: string[] = [];
  let ref = root.get(PDFName.of('First'));
  while (ref) {
    const dict = (context.lookup(ref) as any);
    written.push(String(dict.get(PDFName.of('Title'))));
    ref = dict.get(PDFName.of('Next'));
  }
  // A literal string is parenthesised; a hex string is angle-bracketed. pdf-lib writes a literal by `charCodeAt` and escapes nothing, so anything outside printable ASCII — or holding a bracket — has to be hex.
  assert.ok(written[0].startsWith('(') && written[0].includes('Plain ASCII'));
  assert.ok(written[1].startsWith('<') && written[1].endsWith('>'));
  assert.ok(written[2].startsWith('<') && written[2].endsWith('>'));
});
