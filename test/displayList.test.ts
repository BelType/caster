/**
 * The display list is all the writer is handed: the same list prints the same bytes, in node, with no page.
 *
 * @remarks
 * The node half reads the committed fixtures (`fixtures/lists/`, recorded by `npm run identity -- record --list-out`) and hands each list to `emitStructure` with nothing beside it: all eight documents of the corpus, since stage 3 moved the browser's decoders before the list. Since stage 4 the writer returns its records and no report, and `recordsOf` over those records gives every member of each committed report snapshot that the list and the writer decide, from the writer's own return and from the same records through JSON, as a foreign writer would hand them back. The browser half prints one small page and asks HarfBuzz in the page, through the very module the print used, whether the list's widths are its own.
 *
 * @see /Users/egildo/Privata/dev/beltype/.claude/plans/the-rust-writer/plan-close-the-list.md (stages 1 and 4)
 * @packageDocumentation
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as mupdf from 'mupdf';
import { contentType } from '@beltype/common/mime';
import { capability, load } from '../src/capabilities.ts';
import { loadSubsetter } from '../src/fonts/hbSubset.ts';
import { emitStructure } from '../src/emit/structureEmit.ts';
import { colourWith, paragraphMcidsOf, recordsOf, runsWith } from '../src/displayList/records.ts';
import { absoluteUri } from '../src/displayList/build.ts';
import { resolveStructure } from '../src/displayList/structure.ts';
import { CasterError } from '../src/errors.ts';
import { deflate } from '../src/images/imageEmbed.ts';
import { prepareImage } from '../src/images/imagePass.ts';
import { photoVerdict } from '../src/images/photoRule.ts';
import { decodePng } from '../src/images/png.ts';
import { launchBrowser } from './launch.ts';

import type { DisplayList, LinkItem, StructElement, TextItem, WriterRecords } from '../src/displayList.ts';

const PACKAGE = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const LISTS = path.join(PACKAGE, 'fixtures', 'lists');
const DIST = path.join(PACKAGE, 'dist');
const COMMON = path.dirname(fileURLToPath(import.meta.resolve('@beltype/common/errors')));
const FONTS = path.join(PACKAGE, 'fixtures', 'specimen', 'fonts');
const ROADS = path.join(PACKAGE, 'fixtures', 'roads');

type Entry = { name: string; list: { blobs: string[] } };
const corpus: Entry[] = JSON.parse(fs.readFileSync(path.join(LISTS, 'corpus.json'), 'utf8')).documents;

/** A committed list with its blobs, each checked against its name. */
function listOf(name: string): DisplayList {
  const list = JSON.parse(fs.readFileSync(path.join(LISTS, `${name}.json`), 'utf8'));
  list.resources.blobs = {};
  for (const hash of corpus.find((e) => e.name === name)!.list.blobs) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(LISTS, 'blobs', hash)));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), hash, `the blob ${hash} is what its name says`);
    list.resources.blobs[hash] = bytes;
  }
  return list;
}

const textItems = (list: DisplayList) => list.pages.flatMap((page) => page.items.filter((item): item is TextItem => item.kind === 'text'));

before(async () => {
  await load(['pdf', 'fontkit', 'hbSubset', 'fastPng']);
  await loadSubsetter();
});

test('the same list prints the same bytes: every committed list gives the committed file, in node, the browser-decoded images and the photo rule\'s JPEG included', async () => {
  assert.ok(corpus.length >= 8 && ['webp', 'photo', 'arithmetic'].every((name) => corpus.some((e) => e.name === name)), 'the whole corpus, the image roads among it');
  for (const { name } of corpus) {
    const list = listOf(name);
    assert.equal(list.version, 5, `${name}: a version 5 list`);
    const emitted = await emitStructure(list);
    assert.ok(Buffer.from(emitted.bytes).equals(fs.readFileSync(path.join(LISTS, `${name}.pdf`))), `${name}: the file is byte for byte the committed one`);
  }
});

/** A value as the identity harness snapshots a report: every timing gone (`scripts/identity.ts`, `snapshot`). */
const snapshotOf = (value: unknown): any => JSON.parse(JSON.stringify(value, (key, v) => (key === 'timing' || key === 'ms' || key === 'fontTiming' || /Ms$/u.test(key) ? undefined : v)));

/** The members of a report snapshot the list and the writer's records decide, as `recordsOf` and the writer give them; the measurement's members are left out on both sides. */
function recordMembers(list: DisplayList, written: WriterRecords, report?: any) {
  const derived = recordsOf(list, written);
  // A dummy origin for the joins: what it answers is the measurement's, and is left out of the comparison.
  const dummy = () => ({ run: -1, paragraph: 0, path: '?', color: '?', rectPt: [0, 0, 0, 0] as [number, number, number, number] });
  const colour = written.colour ? colourWith(list, written.colour, dummy) : undefined;
  const own = (rows: any[], from?: any[]) => rows.map((row, at) => {
    const { hint, rectPt, ...rest } = row;
    return rest.path === '?' ? { ...rest, path: from?.[at]?.path } : rest;
  });
  const fromReport = report && {
    emission: Object.fromEntries(['pageCount', 'baselineMethod', 'columnWidthPx', 'kernAdjustments', 'actualTextSpans', 'faces'].map((k) => [k, report.emission[k]])),
    runs: report.emission.runs.map(({ index, color, ...rest }: any) => rest),
    words: report.emission.words.map(({ page, mcid, xPt, spaceEmitted, emittedAdj }: any) => ({ page, mcid, xPt, spaceEmitted, emittedAdj })),
    structure: (({ headings, ...rest }) => rest)(report.structure),
    outline: report.outline, links: report.links, idTree: report.idTree, paint: report.paint, vectorResources: report.vectorNotes.resources, streamOrder: report.vectorNotes.streamOrder, xobjects: report.xobjects,
    images: report.images?.map((i: any) => ({ format: i.format, path: i.path, filter: i.filter, bpc: i.bpc, colorSpace: i.colorSpace, hasSMask: i.hasSMask, intrinsic: i.intrinsic, xobjectHash: i.xobjectHash, xobjectName: i.xobjectName, bytesIn: i.bytesIn, bytesOut: i.bytesOut, icc: i.icc, gammaOnly: i.gammaOnly, interpolate: i.interpolate, reason: i.reason })),
    colour: report.color?.elements && { ...report.color, elements: own(report.color.elements), worklist: report.color.worklist.map(({ css, ...rest }: any) => rest) },
  };
  const fromRecords = {
    emission: derived.emission,
    runs: derived.runs.map(({ item, ...rest }) => rest),
    words: derived.words.map(({ page, mcid, xPt, spaceEmitted, emittedAdj }) => ({ page, mcid, xPt, spaceEmitted, emittedAdj })),
    structure: derived.structure,
    outline: derived.outline, links: derived.links.length > 0 ? derived.links : undefined, idTree: report?.idTree === undefined ? undefined : derived.idTree, paint: written.paint, vectorResources: written.vectorResources, streamOrder: derived.streamOrder, xobjects: written.images.length > 0 ? written.xobjects : undefined,
    images: written.images.length > 0 ? written.images.map((use, at) => ({ format: derived.images[at].format, path: use.info.path, filter: use.info.filter, bpc: use.info.bitsPerComponent, colorSpace: use.info.colorSpace, hasSMask: use.info.hasSMask, intrinsic: [use.info.width, use.info.height], xobjectHash: use.hash, xobjectName: use.name, bytesIn: derived.images[at].bytesIn, bytesOut: use.info.bytesOut, icc: use.info.icc, gammaOnly: use.info.gammaOnly, interpolate: use.info.interpolate, reason: derived.images[at].reason })) : undefined,
    colour: colour && { ...colour, elements: own(colour.elements, report?.color?.elements), worklist: colour.worklist.map(({ css, path, ...rest }: any, at: number) => ({ path: path === '?' ? report?.color?.worklist[at]?.path : path, ...rest })) },
    // The joins print() makes, with nothing but the list, the records and an origin per item.
    joined: { runs: runsWith(derived.runs, dummy).length, paragraphs: paragraphMcidsOf(derived.runs, dummy).size },
  };
  return { fromRecords: snapshotOf(fromRecords), fromReport: fromReport && snapshotOf(fromReport) };
}

test('the records are enough for the report: recordsOf over the writer\'s records, in node, gives every member of each committed report snapshot that the list and the writer decide', async () => {
  let rows = 0;
  for (const { name } of corpus) {
    const list = listOf(name);
    const { records } = await emitStructure(list);
    const report = JSON.parse(fs.readFileSync(path.join(LISTS, `${name}.report.json`), 'utf8'));
    const { fromRecords, fromReport } = recordMembers(list, records, report);
    const { joined, ...compared } = fromRecords;
    for (const key of Object.keys(compared)) {
      // The work list's path and css and a colour row's path are the measurement's where the item has no owner: compared through the snapshot itself, which is what `own` does.
      assert.deepEqual(compared[key], fromReport[key], `${name}: the report's ${key} is the records'`);
    }
    assert.equal(joined.runs, report.emission.runs.length, `${name}: one run per text item`);
    rows += report.emission.words.length + report.structure.annots.length + (report.paint?.length ?? 0);
  }
  assert.ok(rows > 1000, `the comparison reached the corpus (${rows} rows)`);
});

test('a foreign writer\'s return is plain data and enough: the records through JSON, with nothing else, give recordsOf and print()\'s joins the same answers', async () => {
  for (const { name } of corpus) {
    const list = listOf(name);
    const { records } = await emitStructure(list);
    // What a writer in another language hands back: the declared members and nothing more, through JSON.
    const keys: (keyof WriterRecords)[] = ['mcids', 'pens', 'kernAdjustments', 'actualTextSpans', 'faces', 'images', 'xobjects', 'paint', 'vectorResources', 'colour', 'emoji'];
    assert.deepEqual(Object.keys(records).sort(), keys.filter((k) => records[k] !== undefined).sort(), `${name}: the writer returns the declared records and nothing else`);
    const foreign: WriterRecords = JSON.parse(JSON.stringify(Object.fromEntries(keys.filter((k) => records[k] !== undefined).map((k) => [k, records[k]]))));
    assert.deepEqual(recordMembers(list, foreign).fromRecords, recordMembers(list, records).fromRecords, `${name}: the same report members from the JSON records`);
  }
  // A hand-made return for a list with one text item: the writer's choices made up, and the joins complete.
  const list = listOf('arithmetic');
  const { records } = await emitStructure(list);
  const made: WriterRecords = { ...records, mcids: records.mcids.map((items) => [...items].reverse()), pens: records.pens.map((pen) => ({ ...pen, adjustments: pen.adjustments.map((a, at) => (at === 0 ? null : 7)) })) };
  const derived = recordsOf(list, made);
  assert.ok(derived.words.every((word) => word.emittedAdj === null || word.emittedAdj === 7), 'the words carry the made-up pen');
  const firstPage = derived.structure.pages[0].mcidOwners;
  assert.deepEqual(firstPage, [...recordsOf(list, records).structure.pages[0].mcidOwners].reverse(), 'the MCID owners follow the made-up numbering');
  await assert.rejects(async () => recordsOf(list, { ...records, pens: [] }), (error: unknown) => error instanceof CasterError && /no pen for the text item/.test(error.message), 'a text item with no pen is refused');
});

/** The list's tree, and each link with the element that owns it and the element its destination names. */
function treeOf(list: DisplayList) {
  const links = list.pages.flatMap((page, p) => page.items.filter((item): item is LinkItem => item.kind === 'link').map((item) => ({ page: p, order: item.order, element: item.element, dest: item.target.dest?.element })));
  return { elements: list.structure.elements, links };
}

/**
 * Read the file's structure tree back and hold it to the resolved one: element for element in allocation order, every `/K` entry in order, every entry and attribute object, every `/Dest`.
 *
 * @returns How many elements were compared.
 */
function assertTreeIsWritten(name: string, list: DisplayList, tree: { elements: StructElement[]; links: { page: number; order: number; element: number; dest?: number }[] }, bytes: Uint8Array): number {
  const doc = mupdf.Document.openDocument(Buffer.from(bytes), 'application/pdf') as mupdf.PDFDocument;
  const pageRefs = list.pages.map((_, i) => doc.findPage(i).asIndirect());
  // The MCID of a content start is its place among its page's content starts.
  const mcidAt = list.pages.map((page) => {
    const at = new Map<number, number>();
    page.items.forEach((item, i) => { if (item.kind === 'tag' && 'start' in item && !('artifact' in item.start)) at.set(i, at.size); });
    return at;
  });
  const text = (obj: mupdf.PDFObject) => (obj.isNull() ? undefined : obj.asString());
  const plainOf = (obj: mupdf.PDFObject): unknown => {
    if (obj.isName()) return obj.asName();
    if (obj.isNumber()) return Math.round(obj.asNumber() * 1000) / 1000; // mupdf reads a real as a float
    if (obj.isString()) return obj.asString();
    if (obj.isArray()) { const out: unknown[] = []; for (let i = 0; i < obj.length; i++) out.push(plainOf(obj.get(i))); return out; }
    const out: Record<string, unknown> = {};
    obj.forEach((value, key) => { out[String(key)] = plainOf(value); });
    return out;
  };
  const objects: number[] = [];
  const visit = (index: number, obj: mupdf.PDFObject, parent: number) => {
    const element = tree.elements[index];
    const where = `${name}: element ${index} (${element.path})`;
    objects[index] = obj.asIndirect();
    assert.equal(obj.get('S').asName(), element.type, `${where}: /S`);
    assert.equal(obj.get('P').asIndirect(), parent, `${where}: /P`);
    for (const [key, member] of [['Lang', 'lang'], ['Alt', 'alt'], ['E', 'expansion'], ['ID', 'id']] as const) assert.equal(text(obj.get(key)), element[member], `${where}: /${key}`);
    const a = obj.get('A');
    assert.deepEqual(a.isNull() ? undefined : a.isArray() ? plainOf(a) : [plainOf(a)], element.attributes, `${where}: /A`);
    const k = obj.get('K');
    assert.equal(k.length, element.children.length, `${where}: /K length`);
    element.children.forEach((child, j) => {
      const entry = k.get(j);
      if (typeof child === 'number') return visit(child, entry, obj.asIndirect());
      if ('link' in child) {
        assert.equal(entry.get('Type').asName(), 'OBJR', `${where}: /K[${j}] an /OBJR`);
        return assert.equal(entry.get('Obj').get('StructParent').asNumber(), list.info.pageCount + child.link, `${where}: /K[${j}] the link of order ${child.link}`);
      }
      const mcid = mcidAt[child.page].get(child.item);
      assert.notEqual(mcid, undefined, `${where}: /K[${j}] names a content start`);
      if (entry.isNumber()) {
        assert.equal(entry.asNumber(), mcid, `${where}: /K[${j}] the MCID`);
        assert.equal(obj.get('Pg').asIndirect(), pageRefs[child.page], `${where}: /Pg`);
      } else {
        assert.equal(entry.get('MCID').asNumber(), mcid, `${where}: /K[${j}] the /MCR's MCID`);
        assert.equal(entry.get('Pg').asIndirect(), pageRefs[child.page], `${where}: /K[${j}] the /MCR's page`);
      }
    });
  };
  const root = doc.getTrailer().get('Root').get('StructTreeRoot');
  assert.equal(root.get('K').length, 1, `${name}: one root element`);
  visit(0, root.get('K').get(0), doc.getTrailer().get('Root').get('StructTreeRoot').asIndirect());
  assert.equal(objects.filter((n) => n !== undefined).length, tree.elements.length, `${name}: every element is written once`);
  assert.ok(objects.every((n, i) => i === 0 || n > objects[i - 1]), `${name}: the elements are allocated in the array's order`);
  for (const link of tree.links) {
    const annots = doc.findPage(link.page).get('Annots');
    let annot: mupdf.PDFObject | null = null;
    for (let i = 0; i < annots.length; i++) if (annots.get(i).get('StructParent').asNumber() === list.info.pageCount + link.order) annot = annots.get(i);
    assert.ok(annot, `${name}: the link of order ${link.order} is an annotation on page ${link.page + 1}`);
    const dest = annot.get('Dest');
    assert.equal(dest.isNull() ? undefined : objects.indexOf(dest.get(0).asIndirect()), link.dest, `${name}: the link of order ${link.order} names the element its destination resolved to`);
  }
  return tree.elements.length;
}

test('the list\'s tree is the tree the writer writes: every element, every /K in order, every attribute, every destination', async () => {
  let compared = 0;
  for (const { name } of corpus) {
    const list = listOf(name);
    compared += assertTreeIsWritten(name, list, treeOf(list), (await emitStructure(list)).bytes);
  }
  assert.ok(compared > 150, `${compared} elements compared`);
});

// --- the resolver's rules, one by one, on a tree made by hand ----------------------------------------------

/** A walk node. */
const n = (tag: string, path: string, kids: any[] = [], attrs: Record<string, unknown> = {}) => ({ tag, path, attrs, kids });

test('the resolver prunes an element that owns nothing, and keeps an empty cell and the row around it', () => {
  const tree = n('Document', 'D', [n('P', 'D/P0'), n('Sect', 'D/S0', [n('P', 'D/S0/P0')]), n('Table', 'D/T0', [n('TR', 'D/T0/TR0', [n('TD', 'D/T0/TR0/TD0'), n('TD', 'D/T0/TR0/TD1')])])]);
  const { structure } = resolveStructure(tree, [{ page: 0, item: 0, owner: 'D/T0/TR0/TD1', seq: 5 }], [], {}, []);
  assert.deepEqual(structure.elements.map((e) => e.path), ['D', 'D/T0', 'D/T0/TR0', 'D/T0/TR0/TD0', 'D/T0/TR0/TD1'], 'the empty P and the Sect around an empty P are gone; the empty TD stays, in DOM order');
});

test('the resolver orders /K by reading key: content and children by the earliest content under them, an empty child after the sibling before it, the annotation last', () => {
  const tree = n('Document', 'D', [n('P', 'D/P0', [n('Link', 'D/P0/Link0')]), n('TD', 'D/TD0'), n('P', 'D/P1'), n('TD', 'D/TD1')]);
  const contents = [
    { page: 0, item: 1, owner: 'D/P1', seq: 1 },
    { page: 0, item: 4, owner: 'D/P0', seq: 3 },
    { page: 0, item: 7, owner: 'D/P0/Link0', seq: 2 },
    { page: 1, item: 0, owner: 'D/P0', seq: 1e6 },
  ];
  const { structure } = resolveStructure(tree, contents, [{ order: 0, owner: 'D/P0/Link0' }], {}, []);
  const [root, p0, link, td0, p1, td1] = structure.elements;
  assert.deepEqual(structure.elements.map((e) => e.path), ['D', 'D/P0', 'D/P0/Link0', 'D/TD0', 'D/P1', 'D/TD1'], 'allocation is DOM order');
  assert.deepEqual(root.children, [4, 5, 1, 3], 'P1 reads first and P0 second; an empty TD has no key of its own and takes that of the sibling declared before it, so TD1 follows P1 and TD0 follows P0');
  assert.deepEqual(p0.children, [2, { page: 0, item: 4 }, { page: 1, item: 0 }], 'the Link (key 2) before P0\'s own content (3, then the next page)');
  assert.deepEqual(link.children, [{ page: 0, item: 7 }, { link: 0 }], 'the /OBJR after the content');
  assert.deepEqual([td0.children, p1.children, td1.children], [[], [{ page: 0, item: 1 }], []]);
});

test('the resolver points a destination at the first element under its target with content of its own, and refuses one with none', () => {
  const tree = n('Document', 'D', [n('Sect', 'D/S0', [n('Div', 'D/S0/Div0', [n('P', 'D/S0/Div0/P0')]), n('H2', 'D/S0/H0'), n('Div', 'D/S0/Div1')]), n('Link', 'D/L0'), n('Sect', 'D/S1', [n('TD', 'D/S1/TD0')])]);
  const contents = [{ page: 0, item: 0, owner: 'D/S0/H0', seq: 1 }, { page: 0, item: 2, owner: 'D/S0/Div0/P0', seq: 2 }, { page: 0, item: 4, owner: 'D/L0', seq: 3 }];
  const resolved = resolveStructure(tree, contents, [{ order: 0, owner: 'D/L0', dest: 'D/S0' }, { order: 1, owner: 'D/L0' }], {}, ['D/S0/H0']);
  const at = (path: string) => resolved.structure.elements.findIndex((e) => e.path === path);
  assert.deepEqual(resolved.destElement, [at('D/S0/H0'), undefined], 'the Sect has no /Pg; its first child in reading order, the heading, does');
  assert.deepEqual(resolved.linkElement, [at('D/L0'), at('D/L0')]);
  assert.deepEqual(resolved.structure.elements[at('D/L0')].children, [{ page: 0, item: 4 }, { link: 1 }], 'one element, two links: the later one is its /OBJR, as the writer always kept it');
  assert.deepEqual(resolved.headingElement, [at('D/S0/H0')]);
  assert.throws(() => resolveStructure(tree, contents, [{ order: 0, owner: 'D/L0', dest: 'D/S1' }], {}, []), /the destination at D\/S1 has no content anywhere under it/);
  assert.throws(() => resolveStructure(tree, contents, [], {}, ['D/S0/Div1']), /the heading at D\/S0\/Div1 was pruned/);
  assert.throws(() => resolveStructure(tree, contents, [{ order: 0, owner: 'D/Nowhere' }], {}, []), /the link at D\/Nowhere has no structure element/);
  assert.throws(() => resolveStructure(tree, [{ page: 0, item: 9, owner: 'D/Nowhere', seq: 0 }], [], {}, []), (error: unknown) => error instanceof CasterError && error.listItem?.item === 9);
});

test('the resolver writes the attribute objects /A carries, in order, and leaves out an empty entry', () => {
  const tree = n('Document', 'D', [
    n('Figure', 'D/F0', [], { alt: 'A chart', lang: 'it' }),
    n('L', 'D/L0', [n('LI', 'D/L0/LI0', [n('LBody', 'D/L0/LI0/LBody0')])], { listNumbering: 'Decimal' }),
    n('TH', 'D/TH0', [], { scope: 'Column', id: 'h1', rowSpan: 1, colSpan: 2 }),
    n('TD', 'D/TD0', [], { headers: ['h1'], rowSpan: 3 }),
    n('TD', 'D/TD1', [], { headers: [] }),
    n('Span', 'D/Span0', [], { textPosition: 'Sup', alt: '', expansion: 'Portable Document Format' }),
  ]);
  const contents = ['D/F0', 'D/L0/LI0/LBody0', 'D/TH0', 'D/TD0', 'D/Span0'].map((owner, item) => ({ page: 0, item, owner, seq: item }));
  const byPath = Object.fromEntries(resolveStructure(tree, contents, [], { 'D/F0': [10, 20, 30.0004, 40] }, []).structure.elements.map((e) => [e.path, e]));
  assert.deepEqual(byPath['D/F0'], { type: 'Figure', path: 'D/F0', lang: 'it', alt: 'A chart', attributes: [{ O: 'Layout', BBox: [10, 20, 40, 60] }], children: [{ page: 0, item: 0 }] }, 'the box as a PDF rectangle, to thousandths');
  assert.deepEqual(byPath['D/L0'].attributes, [{ O: 'List', ListNumbering: 'Decimal' }]);
  assert.deepEqual(byPath['D/TH0'].attributes, [{ O: 'Table', Scope: 'Column', ColSpan: 2 }], 'a span of one is not written');
  assert.equal(byPath['D/TH0'].id, 'h1');
  assert.deepEqual(byPath['D/TD0'].attributes, [{ O: 'Table', Headers: ['h1'], RowSpan: 3 }]);
  assert.equal(byPath['D/TD1'].attributes, undefined, 'a cell with nothing to say has no /A');
  assert.deepEqual(byPath['D/Span0'], { type: 'Span', path: 'D/Span0', expansion: 'Portable Document Format', attributes: [{ O: 'Layout', TextPosition: 'Sup' }], children: [{ page: 0, item: 4 }] }, 'an empty /Alt is left out');
});

test('the writer refuses a tree that is not one, with a sentence', async () => {
  /** A copy of cast's list with its tree changed by `change`. */
  const broken = (change: (list: DisplayList) => void) => { const list = listOf('cast'); change(list); return list; };
  const refused = async (list: DisplayList, pattern: RegExp) => assert.rejects(emitStructure(list), (error: unknown) => error instanceof CasterError && pattern.test(error.message));
  const parentOfOne = (list: DisplayList) => list.structure.elements.findIndex((e) => e.children.includes(1));
  await refused(broken((list) => { list.structure.elements[0].children.push(list.structure.elements.length); }), /lists child \d+, which is not an element below the root/);
  await refused(broken((list) => { list.structure.elements[0].children.push(1); }), /lists element 1, which/);
  await refused(broken((list) => { const p = parentOfOne(list); list.structure.elements[p].children = list.structure.elements[p].children.filter((c) => c !== 1); }), /element 1 .* is no element's child/);
  await refused(broken((list) => {
    // Element 1 moves under its own last descendant: every element keeps one parent, and the tree has a cycle.
    const p = parentOfOne(list);
    list.structure.elements[p].children = list.structure.elements[p].children.filter((c) => c !== 1);
    let leaf = 1;
    for (let kids = list.structure.elements[leaf].children.filter((c): c is number => typeof c === 'number'); kids.length > 0; kids = list.structure.elements[leaf].children.filter((c): c is number => typeof c === 'number')) leaf = kids[kids.length - 1];
    list.structure.elements[leaf].children.push(1);
  }), /is its own ancestor; the tree has a cycle/);
  await refused(broken((list) => { const e = list.structure.elements.find((x) => x.children.some((c) => typeof c === 'object'))!; const at = e.children.findIndex((c) => typeof c === 'object'); e.children[at] = { page: 0, item: list.pages[0].items.findIndex((i) => i.kind === 'text') }; }), /which is not a content start/);
  await refused(broken((list) => { const owners = list.structure.elements.filter((x) => x.children.some((c) => typeof c === 'object' && 'page' in c)); const [a, b] = owners; const at = b.children.findIndex((c) => typeof c === 'object'); a.children.push(b.children[at]); b.children.splice(at, 1); }), /which opens content for element/);
  await refused(broken((list) => { const tag = list.pages[0].items.find((i) => i.kind === 'tag' && 'start' in i && 'element' in i.start)!; (tag as any).start.element = 999; }), /names structure element 999/);
  await refused(broken((list) => { list.outline[0].element = -3; }), /the bookmark .* names structure element -3/);
});

test('the widths cover every glyph a text item shows and every space glyph it names, and the writer refuses one that is missing', async () => {
  for (const { name } of corpus) {
    const list = listOf(name);
    for (const item of textItems(list)) {
      const instance = list.resources.fonts.find((f) => f.key === item.font)!;
      const have = new Set(instance.widths.gids);
      for (const gid of [...item.glyphs.ids, item.space]) assert.ok(have.has(gid), `${name}: ${item.font} holds a width for glyph ${gid}`);
      assert.deepEqual(instance.widths.gids, [...instance.widths.gids].sort((a, b) => a - b), `${name}: ${item.font}'s widths are sorted by glyph id`);
    }
  }
  const list = listOf('cast');
  const instance = list.resources.fonts.find((f) => textItems(list).some((item) => item.font === f.key))!;
  const dropped = instance.widths.gids.pop()!;
  instance.widths.units.pop();
  await assert.rejects(emitStructure(list), (error: unknown) => error instanceof CasterError && error.message.includes(`glyph ${dropped} of ${instance.key}`));
});

test('the fonts array order is the resource order: the writer embeds and names F0, F1, … in it, whatever the order', async () => {
  for (const reversed of [false, true]) {
    const list = listOf('paper');
    if (reversed) list.resources.fonts.reverse();
    const emitted = await emitStructure(list);
    const faces = emitted.records.faces;
    assert.deepEqual(faces.map((f) => f.id), list.resources.fonts.map((f) => f.key), 'the faces are recorded in the array order');
    const doc = mupdf.Document.openDocument(Buffer.from(emitted.bytes), 'application/pdf') as mupdf.PDFDocument;
    const fonts = doc.loadPage(0).getObject().get('Resources').get('Font');
    // The subset tag is a hash of face, coordinates and glyph set, so each instance's `/BaseFont` is its own.
    faces.forEach((face, i) => assert.equal(fonts.get(`F${i}`).get('BaseFont').asName(), `${face.subsetTag}+${face.postScriptName}`, `F${i} is the array's instance ${i}${reversed ? ', reversed' : ''}`));
    assert.equal(new Set(faces.map((f) => f.subsetTag)).size, faces.length, 'no two instances share a /BaseFont');
  }
});

test('a link\'s URI is percent-encoded once: a space, a %20, a non-ASCII path and a query each arrive in one encoding', () => {
  const base = 'https://example.org/book/';
  assert.equal(absoluteUri('https://example.org/a path', base), 'https://example.org/a%20path', 'a space is %20, not %2520');
  assert.equal(absoluteUri('https://example.org/a%20path', base), 'https://example.org/a%20path', 'a %20 the author wrote stays %20');
  assert.equal(absoluteUri('chapter two.html#x', base), 'https://example.org/book/chapter%20two.html#x', 'a relative href, resolved and encoded once');
  assert.equal(absoluteUri('https://example.org/café/über', base), 'https://example.org/caf%C3%A9/%C3%BCber', 'a non-ASCII path is its UTF-8, encoded once');
  assert.equal(absoluteUri('https://example.org/s?q=a b&x=é#frag ment', base), 'https://example.org/s?q=a%20b&x=%C3%A9#frag%20ment', 'a query and a fragment, encoded once, their reserved characters kept');
  assert.equal(absoluteUri('https://example.org/a%2541', base), 'https://example.org/a%2541', 'an encoded percent sign stays one encoding deep');
  assert.equal(absoluteUri('https://example.org/100%', base), 'https://example.org/100%25', 'a bare percent sign is encoded');
  assert.equal(absoluteUri('https://example.org/p|q^r', base), 'https://example.org/p%7Cq%5Er', 'what the parser leaves raw and RFC 3986 refuses is encoded');
  for (const link of listOf('roads').pages.flatMap((page) => page.items.filter((item): item is LinkItem => item.kind === 'link')))
    if (link.target.uri !== undefined) assert.ok(!/%25[0-9A-Fa-f]{2}/u.test(link.target.uri), `roads: ${link.target.uri} is encoded once`);
});

test('a link that leaves the file carries its URI resolved: a relative href is absolute in the list', () => {
  const links = listOf('roads').pages.flatMap((page) => page.items.filter((item): item is LinkItem => item.kind === 'link'));
  const relative = links.find((link) => link.target.href === '../cast/index.html')!;
  assert.equal(relative.target.uri, 'https://print.invalid/cast/index.html');
  assert.ok(links.every((link) => (link.target.dest === undefined) === (link.target.uri !== undefined)), 'every link has a destination or a URI, never both');
  assert.equal(absoluteUri('http://[not a host', 'https://example.org/'), 'http://[not a host', 'an href the parser refuses is kept as written');
});

test('the writer reads the creation date from the list, and refuses one that is not an instant in UTC', async () => {
  const list = listOf('cast');
  list.info.created = '2026-11-02T10:20:30.456Z';
  const text = Buffer.from((await emitStructure(list)).bytes).toString('latin1');
  assert.ok(text.includes('/CreationDate (D:20261102102030Z)') && text.includes('/ModDate (D:20261102102030Z)'), 'both dates, at whole seconds');
  list.info.created = '2026-11-02 10:20';
  await assert.rejects(emitStructure(list), CasterError);
});

test('the writer refuses a list of another version', async () => {
  const list = listOf('cast');
  (list as { version: number }).version = 2;
  await assert.rejects(emitStructure(list), (error: unknown) => error instanceof CasterError && /version 2/.test(error.message));
});

// --- the image roads, as the image pass left them ---------------------------------------------

/** A mupdf buffer's bytes. */
const bytesOf = (buffer: mupdf.Buffer) => Buffer.from(buffer.asUint8Array());

/** Every image XObject the file's first page names, by its resource name. */
function imagesOf(bytes: Uint8Array): Map<string, mupdf.PDFObject> {
  const doc = mupdf.Document.openDocument(Buffer.from(bytes), 'application/pdf') as mupdf.PDFDocument;
  const out = new Map<string, mupdf.PDFObject>();
  doc.loadPage(0).getObject().get('Resources').get('XObject').forEach((obj, key) => { if (obj.get('Subtype').asName() === 'Image') out.set(String(key), obj); });
  return out;
}

test('an arithmetic-coded JPEG is handed through: the pass is refused a decode in node as in the page, and the writer gives the file to /DCTDecode unread', async () => {
  const file = { bytes: new Uint8Array(fs.readFileSync(path.join(ROADS, 'logo-arithmetic.jpg'))), mimeType: 'image/jpeg' };
  const prepared = await prepareImage(file, true);
  assert.equal(prepared.samples, undefined, 'no pixels: node has no createImageBitmap');
  assert.match(String(prepared.refusal), /could not decode image\/jpeg/u, 'the refusal travels with the file');
  const list = listOf('arithmetic');
  const source = list.resources.images[0];
  assert.ok(source.blob && source.mime === 'image/jpeg' && source.samples === undefined, 'the list holds the file');
  assert.match(String(source.refusal), /could not decode image\/jpeg/u, 'and the page\'s refusal');
  const emitted = await emitStructure(list);
  const [image] = imagesOf(emitted.bytes).values();
  assert.equal(image.get('Filter').asName(), 'DCTDecode');
  assert.ok(bytesOf(image.readRawStream()).equals(Buffer.from(file.bytes)), 'the stream is the file, byte for byte');
});

test('a WebP reaches the list as the browser\'s pixels, and the writer writes them as they are, RGB under /FlateDecode and the alpha as an /SMask', async () => {
  const list = listOf('webp');
  const source = list.resources.images[0];
  assert.equal(source.blob, undefined, 'the list does not hold the WebP');
  assert.deepEqual(source.original, { format: 'image/webp', bytes: fs.statSync(path.join(ROADS, 'logo.webp')).size });
  const samples = source.samples!;
  assert.deepEqual({ colorSpace: samples.colorSpace, bitsPerComponent: samples.bitsPerComponent }, { colorSpace: 'DeviceRGB', bitsPerComponent: 8 });
  const rgba = list.resources.blobs[samples.blob];
  assert.equal(rgba.length, samples.width * samples.height * 4, 'RGBA, four bytes a pixel');
  const [image] = imagesOf((await emitStructure(list)).bytes).values();
  assert.deepEqual([image.get('Width').asNumber(), image.get('Height').asNumber(), image.get('ColorSpace').asName(), image.get('BitsPerComponent').asNumber(), image.get('Filter').asName()], [samples.width, samples.height, 'DeviceRGB', 8, 'FlateDecode']);
  const rgb = rgba.filter((_, i) => i % 4 !== 3);
  assert.ok(bytesOf(image.readStream()).equals(Buffer.from(rgb)), 'the stream inflates to the list\'s RGB');
  const alpha = rgba.filter((_, i) => i % 4 === 3);
  const opaque = alpha.every((a) => a === 255);
  assert.equal(image.get('SMask').isNull(), opaque, 'an /SMask exactly where a pixel is not opaque');
  if (!opaque) assert.ok(bytesOf(image.get('SMask').readStream()).equals(Buffer.from(alpha)), 'and it inflates to the alpha');
  assert.equal(source.photo?.chosenQuality, null, 'the rule was consulted and declined');
});

test('the photo rule\'s choice and quality are the pass\'s: the list holds its JPEG and evidence, the file carries that JPEG, and the flag off keeps the PNG', async () => {
  const list = listOf('photo');
  const source = list.resources.images[0];
  const photo = source.photo!;
  assert.equal(photo.chosenQuality, 0.85, 'the cheapest quality that clears the target');
  assert.deepEqual(photo.candidates.map((c) => c.quality), [0.85, 0.9, 0.95], 'every quality tried');
  assert.ok(photo.candidates[0].psnrDb >= 40, `${photo.candidates[0].psnrDb} dB at 0.85`);
  assert.equal(list.resources.blobs[source.jpeg!].length, photo.candidates[0].bytes, 'the JPEG is the chosen candidate');
  assert.equal(source.blob, undefined, 'the list does not hold the PNG');
  assert.equal(source.original?.format, 'image/png');
  const [image] = imagesOf((await emitStructure(list)).bytes).values();
  assert.equal(image.get('Filter').asName(), 'DCTDecode');
  assert.ok(bytesOf(image.readRawStream()).equals(Buffer.from(list.resources.blobs[source.jpeg!])), 'the file carries the pass\'s JPEG');
  // The gates and the sampled look are arithmetic over the PNG's own samples, so node reaches the same verdict the page did.
  const png = new Uint8Array(fs.readFileSync(path.join(ROADS, 'photo.png')));
  const decoded = decodePng(png);
  const verdict = photoVerdict({ width: decoded.width, height: decoded.height, rgb: decoded.data as Uint8Array, hasAlpha: false });
  assert.deepEqual({ isPhoto: verdict.isPhoto, uniqueRatio: verdict.uniqueRatio, longestRun: verdict.longestRun, pixels: verdict.pixels }, { isPhoto: photo.isPhoto, uniqueRatio: photo.uniqueRatio, longestRun: photo.longestRun, pixels: photo.pixels });
  const off = await prepareImage({ bytes: png, mimeType: 'image/png' }, false);
  assert.equal(off.jpeg, undefined, 'the flag off, no re-encode');
  assert.equal(off.photo?.reason, 'the photoRule flag is off', 'and the record says the rule was never asked');
});

test('the image deflate is byte-stable across realms: node deflates the list\'s planes to the very streams the page wrote', async () => {
  const { PDFDocument } = capability('pdf');
  const context = (await PDFDocument.create()).context;
  const checked: string[] = [];
  for (const [name, rgba] of [['webp', (l: DisplayList) => l.resources.blobs[l.resources.images[0].samples!.blob]], ['roads', (l: DisplayList) => l.resources.blobs[l.resources.rasters[0].blob!]]] as const) {
    const list = listOf(name);
    const pixels = rgba(list);
    const rgb = pixels.filter((_, i) => i % 4 !== 3);
    const alpha = pixels.filter((_, i) => i % 4 === 3);
    const file = fs.readFileSync(path.join(LISTS, `${name}.pdf`));
    const doc = mupdf.Document.openDocument(file, 'application/pdf') as mupdf.PDFDocument;
    const streams: Buffer[] = [];
    for (let page = 0; page < doc.countPages(); page++) doc.loadPage(page).getObject().get('Resources').get('XObject')?.forEach((obj) => { if (obj.get('Subtype').asName() === 'Image') { streams.push(bytesOf(obj.readRawStream())); if (!obj.get('SMask').isNull()) streams.push(bytesOf(obj.get('SMask').readRawStream())); } });
    const ours = deflate(context, rgb);
    assert.ok(streams.some((stream) => stream.equals(Buffer.from(ours))), `${name}: the RGB stream the page wrote is node's deflate of the list's RGB`);
    if (alpha.some((a) => a !== 255)) assert.ok(streams.some((stream) => stream.equals(Buffer.from(deflate(context, alpha)))), `${name}: and the /SMask is node's deflate of its alpha`);
    assert.ok(Buffer.from(deflate(context, rgb)).equals(Buffer.from(ours)), `${name}: twice, the same bytes`);
    checked.push(name);
  }
  assert.deepEqual(checked, ['webp', 'roads']);
});

// --- in the page ------------------------------------------------------------

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(['errors', 'data-beltype', 'flags', 'mime'].map((m) => [`@beltype/common/${m}`, `/common/${m}.js`])) })}</script>
<style>
@font-face { font-family: "Crimson Pro"; src: url("/fonts/CrimsonPro-Variable.ttf"); font-weight: 200 900; }
body { margin: 0; }
.s { width: 90mm; height: 50mm; padding: 4mm; box-sizing: border-box; font: 15px/1.4 "Crimson Pro"; }
p { margin: 0; } b { font-weight: 650; }
</style></head><body><div class="s"><p>Light <b>heavier</b> words, and <a href="sub/other page.html">a relative link</a>.</p></div></body></html>`;

/** One WebP painted twice. */
const TWICE = PAGE.replace(/<div class="s">.*<\/div>/u, '<div class="s"><p>One file, <img src="/roads/logo.webp" alt="once"> and <img src="/roads/logo.webp" alt="twice">.</p></div>');

function serve(): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
    if (url.pathname === '/twice') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end(TWICE);
    const [root, rel] = url.pathname.startsWith('/common/') ? [COMMON, url.pathname.slice(8)] : url.pathname.startsWith('/fonts/') ? [FONTS, url.pathname.slice(7)] : url.pathname.startsWith('/roads/') ? [ROADS, url.pathname.slice(7)] : [DIST, url.pathname.slice(1)];
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': contentType(file) }).end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('in the page: the list\'s widths are HarfBuzz\'s for every glyph it holds, its links are resolved against the document, and its date is the host\'s', async () => {
  const server = await serve();
  const port = (server.address() as { port: number }).port;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.evaluate(() => document.fonts.ready);
    /** What the page answers. */
    type Seen = { version: number; created: string; fonts: { key: string; coords: Record<string, number>; gids: number[]; units: number[]; harfbuzz: number[] }[]; used: { font: string; gids: number[] }[]; links: { href: string; uri?: string }[]; file: string };
    const seen: Seen = await page.evaluate(async () => {
      const load = (p: string) => import(p);
      const caster = await load('/src/index.js');
      // The module the print shaped with: one URL, one instance, one registry of fonts.
      const hb = await load('/src/fonts/hbShaper.js');
      const axis = await load('/src/fonts/axisMap.js');
      caster.prepare(document);
      const strip = document.querySelector('.s') as HTMLElement;
      const box = strip.getBoundingClientRect();
      const pt = (px: number) => Math.round(((px * 72) / 96) * 1000) / 1000;
      const printed = await caster.print({
        document,
        created: '2026-11-02T10:20:30.456Z',
        strip: {
          strip, probeRoot: strip, pageElements: [strip],
          pages: [{ element: strip, index: 0, flow: [...strip.children], flowBox: null, trimBox: null, nominal: { widthPt: pt(box.width), heightPt: pt(box.height) }, declaredPx: { widthPx: box.width, heightPx: box.height }, contentArea: strip, continuations: [] }],
          pageOfNode: new Map(), twinOf: () => null, transparent: () => false, lang: 'en', pageElementOf: () => strip, backgrounds: [],
        },
      });
      const list = printed.displayList;
      const fonts = list.resources.fonts.map((f: any) => ({
        key: f.key,
        coords: f.coords,
        gids: f.widths.gids,
        units: f.widths.units,
        harfbuzz: f.widths.gids.map((gid: number) => hb.glyphAdvance(f.url, gid, axis.shaperVariations(f.coords))),
      }));
      const items = list.pages.flatMap((p: any) => p.items);
      return {
        version: list.version,
        created: list.info.created,
        fonts,
        used: items.filter((i: any) => i.kind === 'text').map((i: any) => ({ font: i.font, gids: [...i.glyphs.ids, i.space] })),
        links: items.filter((i: any) => i.kind === 'link').map((i: any) => i.target),
        file: new TextDecoder('latin1').decode(printed.bytes),
      };
    });
    assert.equal(seen.version, 5);
    assert.ok(seen.fonts.length >= 2 && seen.fonts.every((f) => Object.keys(f.coords).length > 0), `two instances of the variable face, each pinned: ${JSON.stringify(seen.fonts.map((f) => f.key))}`);
    for (const font of seen.fonts) assert.deepEqual(font.units, font.harfbuzz, `${font.key}: the list's widths are HarfBuzz's at the instance's coordinates`);
    for (const { font, gids } of seen.used) {
      const held = new Set(seen.fonts.find((f) => f.key === font)!.gids);
      assert.ok(gids.every((gid) => held.has(gid)), `${font}: every glyph the item shows has its width`);
    }
    assert.equal(seen.links.length, 1);
    assert.equal(seen.links[0].href, 'sub/other page.html', 'the href stays as written, for the report');
    assert.equal(seen.links[0].uri, `http://127.0.0.1:${port}/sub/other%20page.html`, 'the URI is absolute, resolved against the document');
    assert.equal(seen.created, '2026-11-02T10:20:30.456Z', 'the host\'s date is the list\'s');
    assert.ok(seen.file.includes('/CreationDate (D:20261102102030Z)'), 'and the file\'s');
  } finally {
    await browser.close();
    server.close();
  }
});

test('in the page: one WebP painted twice is decoded once, names one blob of pixels, and is one image object in the file', async () => {
  const server = await serve();
  const port = (server.address() as { port: number }).port;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/twice`);
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map((image) => image.decode())); });
    const seen: { decodes: number; sources: { samples?: string; blob?: string }[]; painted: number; file: string } = await page.evaluate(async () => {
      const load = (p: string) => import(p);
      const caster = await load('/src/index.js');
      // Count the browser's decodes of a WebP: the image pass is the only caller.
      let decodes = 0;
      const decode = window.createImageBitmap.bind(window);
      (window as any).createImageBitmap = (source: Blob, ...rest: any[]) => { if (source instanceof Blob && source.type === 'image/webp') decodes++; return (decode as any)(source, ...rest); };
      caster.prepare(document);
      const strip = document.querySelector('.s') as HTMLElement;
      const box = strip.getBoundingClientRect();
      const pt = (px: number) => Math.round(((px * 72) / 96) * 1000) / 1000;
      const printed = await caster.print({
        document,
        created: '2026-11-02T10:20:30.456Z',
        strip: {
          strip, probeRoot: strip, pageElements: [strip],
          pages: [{ element: strip, index: 0, flow: [...strip.children], flowBox: null, trimBox: null, nominal: { widthPt: pt(box.width), heightPt: pt(box.height) }, declaredPx: { widthPx: box.width, heightPx: box.height }, contentArea: strip, continuations: [] }],
          pageOfNode: new Map(), twinOf: () => null, transparent: () => false, lang: 'en', pageElementOf: () => strip, backgrounds: [],
        },
      });
      const list = printed.displayList;
      let binary = '';
      for (const byte of printed.bytes as Uint8Array) binary += String.fromCharCode(byte);
      return {
        decodes,
        sources: Object.values(list.resources.images).map((source: any) => ({ samples: source.samples?.blob, blob: source.blob })),
        painted: list.pages.flatMap((p: any) => p.items).filter((item: any) => item.kind === 'image').length,
        file: btoa(binary),
      };
    });
    assert.equal(seen.decodes, 1, 'the WebP is decoded once');
    assert.equal(seen.painted, 2, 'and painted twice');
    assert.equal(seen.sources.length, 2, 'two image sources, one per element');
    assert.ok(seen.sources.every((source) => source.samples !== undefined && source.blob === undefined), 'each holds pixels, not the file');
    assert.equal(new Set(seen.sources.map((source) => source.samples)).size, 1, 'one blob of pixels between them');
    assert.equal(imagesOf(Buffer.from(seen.file, 'base64')).size, 1, 'one image object in the file');
  } finally {
    await browser.close();
    server.close();
  }
});
