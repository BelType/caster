/**
 * `displayList/validate.js` — `validateList(list)`: the refusals of a list a writer could not write, each a sentence, before a byte is written.
 *
 * @remarks
 * Pure and synchronous: it reads the list and nothing else, imports only the error and the JPEG header reader, and returns nothing when the list is one the writer can write. The writer calls it first (`emitStructure`), the replay of the identity gate calls it on every saved list, and a foreign writer's reader is tested against the same list of refusals. What it holds: the version; every blob key a resource names; each image's samples in a shape the schema names, as many bytes as it says (version 6; `DeviceCMYK` at four components and with neither palette nor profile, version 7); the font instances (unique keys, sorted widths, a width for every glyph a text item shows and every space glyph it names); under a PDF/UA-2 claim, no word gap of a face with no space glyph (S103); under the archival claim a colour story, no facsimile, and no CMYK colour without a CMYK output profile (S109); every image, raster and colour-cluster key an item names; the marked content of each page (no end without a start, none left open); the links (`order` running 0, 1, 2 … over the document, a destination or a URI on each); the structure tree (an element index anywhere in range, one parent each, no cycle, a content child that is a content start naming its element back, every content start some element's child, a link child owned by the link's element, the attribute keys the schema names, a namespace that is the PDF 1.7 one where one is named, every `refs` index in range and none empty). What it leaves to the writer is what only writing finds: a font program the subsetter refuses, an image no filter reads, a malformed `info.created`. Glyph 0 needs no width: a `.notdef` is refused by the ToUnicode map, which names the item it was painted in. The checks of the tree moved here from the writer's `checkTree` with their sentences (stage 5 of `.claude/plans/the-rust-writer/plan-close-the-list.md`, in the BelType monorepo).
 *
 * @packageDocumentation
 */

import { CasterError } from '../errors.ts';
import { parseJpeg } from '../images/jpeg.ts';

import type { DisplayList, Item, LinkItem, Paint, StructElement, VectorItem } from '../displayList.ts';

/** The version this module and the writer read. */
export const LIST_VERSION = 7;

/** The keys an attribute object of `/A` may carry: `StructAttribute`'s, which the writer writes in this order. */
export const ATTRIBUTE_KEYS = ['O', 'ListNumbering', 'BBox', 'Scope', 'Headers', 'RowSpan', 'ColSpan', 'TextPosition', 'NoteType'] as const;

/** The PDF 1.7 standard structure namespace, the one other namespace an element may name (*the older tag names are written in the older namespace*). */
export const PDF_1_7_NAMESPACE = 'http://iso.org/pdf/ssn';

/**
 * Refuse a list the writer could not write.
 *
 * @throws {CasterError} The first thing in the list that is not so, in a sentence; one that concerns an item carries it as `listItem`.
 */
export function validateList(list: DisplayList): void {
  if (list.version !== LIST_VERSION)
    throw new CasterError(`caster: the writer reads a display list of version ${LIST_VERSION}, and this one is version ${String(list.version)}; a list is written again by print(), never upgraded`);
  checkBlobs(list);
  checkSamples(list);
  checkFonts(list);
  checkGaps(list);
  checkArchival(list);
  checkItems(list);
  checkLinks(list);
  checkTree(list);
}

/** Every blob key a resource names is a key of `resources.blobs`. */
function checkBlobs(list: DisplayList) {
  const { blobs, fonts, images, rasters, emoji } = list.resources;
  const named = (key: string | undefined, what: string) => {
    if (key !== undefined && !blobs[key])
      throw new CasterError(`caster: ${what} names the blob ${key}, and the display list holds no bytes under that key`);
  };
  fonts.forEach((instance) => named(instance.blob, `the font instance ${instance.key}`));
  for (const [key, image] of Object.entries(images)) {
    named(image.blob, `image ${key} (${image.domPath})`);
    named(image.jpeg, `image ${key}'s photo JPEG`);
    named(image.samples?.blob, `image ${key}'s samples`);
    named(image.samples?.palette, `image ${key}'s palette`);
    named(image.samples?.icc, `image ${key}'s profile`);
  }
  for (const [key, raster] of Object.entries(rasters)) {
    named(raster.blob, `raster ${key} (${raster.feature})`);
    named(raster.jpeg, `raster ${key}'s photo JPEG`);
  }
  for (const [key, cluster] of Object.entries(emoji)) named(cluster.blob, `colour cluster ${key}`);
  if (list.writing.colour) {
    named(list.writing.colour.profiles.cmyk, 'the colour story\'s CMYK profile');
    named(list.writing.colour.profiles.srgb, 'the colour story\'s sRGB profile');
  }
}

/** Each image's samples in a shape the schema names, holding as many bytes as the shape says. */
function checkSamples(list: DisplayList) {
  const { blobs, images } = list.resources;
  for (const [key, image] of Object.entries(images)) {
    const samples = image.samples;
    if (!samples) continue;
    const { colorSpace, bitsPerComponent, alpha, palette, icc } = samples;
    const indexed = colorSpace === 'Indexed';
    const paletteBytes = palette === undefined ? 0 : blobs[palette].length;
    const named = (colorSpace === 'DeviceRGB' || colorSpace === 'DeviceGray' || colorSpace === 'DeviceCMYK' || indexed) && (bitsPerComponent === 8 || bitsPerComponent === 16);
    if (!named || indexed !== (palette !== undefined) || (indexed && (bitsPerComponent !== 8 || icc !== undefined || paletteBytes % 3 !== 0 || paletteBytes < 3 || paletteBytes > 768)) || (colorSpace === 'DeviceCMYK' && icc !== undefined))
      throw new CasterError(`caster: image ${key}'s samples are ${String(colorSpace)} at ${String(bitsPerComponent)} bits${palette !== undefined ? ` with a palette of ${paletteBytes} bytes` : ''}${icc !== undefined ? ' with a profile' : ''}, a shape the schema does not name`);
    const expected = samples.width * samples.height * ((colorSpace === 'DeviceRGB' ? 3 : colorSpace === 'DeviceCMYK' ? 4 : 1) + (alpha ? 1 : 0)) * (bitsPerComponent / 8);
    const held = blobs[samples.blob].length;
    if (held !== expected)
      throw new CasterError(`caster: image ${key}'s samples hold ${held} bytes, and ${samples.width} by ${samples.height} ${colorSpace} at ${bitsPerComponent} bits${alpha ? ' with alpha' : ''} is ${expected}`);
  }
}

/** One key per instance, its widths sorted, and a width for every glyph a text item shows and every space glyph it names. */
function checkFonts(list: DisplayList) {
  const widths = new Map<string, Set<number>>();
  for (const instance of list.resources.fonts) {
    if (widths.has(instance.key))
      throw new CasterError(`caster: the display list holds two font instances under the key ${instance.key}`);
    const { gids, units } = instance.widths;
    if (gids.length !== units.length || gids.some((gid, at) => at > 0 && gid <= gids[at - 1]))
      throw new CasterError(`caster: the widths of ${instance.key} are not one unit per glyph id in ascending order (${gids.length} ids, ${units.length} units)`);
    widths.set(instance.key, new Set(gids));
  }
  list.pages.forEach((page, p) => page.items.forEach((item, at) => {
    if (item.kind !== 'text') return;
    const have = widths.get(item.font);
    if (!have)
      throw new CasterError(`caster: a text item names the font ${item.font}, and the display list holds no instance under that key`, { listItem: { page: p, item: at } });
    for (const gid of [...item.glyphs.ids, item.space]) {
      if (gid !== 0 && !have.has(gid))
        throw new CasterError(`caster: the display list holds no width for glyph ${gid} of ${item.font}; the builder writes one for every glyph a text item shows and every space glyph it names`, { listItem: { page: p, item: at } });
    }
  }));
}

/**
 * A list that claims PDF/UA-2 shows no word gap as glyph 0 (*PDF/UA-2 is a flag, not a given*, S103).
 *
 * @remarks
 * A text item's `space` is 0 when its face has no space glyph, and a gap it owes (`leadingSpace`, or `spaceBefore` past the first segment) would then show `.notdef`, which PDF/UA-2 forbids (ISO 14289-2, 8.4.5.9). Under a list that claims nothing (`tagged`) the writer writes such a gap as positioning with no glyph. The builder calls this too, since it knows the flag; the sentence names the face and the flag that prints it.
 *
 * @throws {CasterError} carrying `listItem`.
 */
export function checkGaps(list: DisplayList): void {
  if (list.info.conformance !== 'pdfua2') return;
  list.pages.forEach((page, p) => page.items.forEach((item, at) => {
    if (item.kind !== 'text' || item.space !== 0) return;
    if (!item.leadingSpace && !item.segments.spaceBefore.some((gap, i) => i > 0 && gap)) return;
    const family = list.resources.fonts.find((instance) => instance.key === item.font)?.family || item.font;
    throw new CasterError(`caster: the face ${family} (${item.font}) has no space glyph, so the word gap in text item ${at} of page ${p + 1} would be glyph 0, .notdef, which PDF/UA-2 forbids a file to show (ISO 14289-2, 8.4.5.9); give the text a face with a space, or print with \`standard: 'none'\`, or \`'a-4'\` alone, which do not claim PDF/UA-2 and write the gap as positioning with no glyph`, { listItem: { page: p, item: at } });
  }));
}

/**
 * A list that claims PDF/A-4 is one the file can keep the claim for, or it is refused by name (*an archival claim is kept or refused*, S109).
 *
 * @remarks
 * It carries a colour story, so its device colour has an output intent; it places no page of another PDF, which the writer copies as it is and does not read; and no colour in it is CMYK unless the output profile is a CMYK one. CMYK is a declared ink, process or spot (whose alternate is CMYK), on a run or a rectangle; black text under `blackText: '100k'`; a vector paint or gradient in CMYK, a group's children and a mask's content among it; print marks, in the `/All` separation; and an image whose samples are `DeviceCMYK` or whose file is a four-component JPEG. It is not converted: a silent conversion would change the ink the author asked for. The facsimiles are read by image key, then the pages' items in order, then the forms by name. The builder calls this too, since it knows the flag.
 *
 * @throws {CasterError} carrying `listItem` where an item broke the claim.
 */
export function checkArchival(list: DisplayList): void {
  if (list.info.archival === undefined) return;
  const story = list.writing.colour;
  if (!story)
    throw new CasterError('caster: the display list claims PDF/A-4 and carries no colour story, so no output intent would say what its colours mean (ISO 19005-4, 6.2.4.3)');
  for (const image of Object.values(list.resources.images)) {
    if (image.facsimile)
      throw new CasterError(`caster: the facsimile at ${image.domPath} is page ${image.facsimile.page} of ${image.facsimile.url}, a page of another PDF, which Caster copies as it is and does not read, so it cannot stand behind it under PDF/A-4; print without \`a-4\` in \`standard\`, or place the page as an image`);
  }
  if (String.fromCharCode(...list.resources.blobs[story.profiles.cmyk].subarray(16, 20)) === 'CMYK') return;
  const refuse = (what: string, page: number, item: number) => new CasterError(`caster: ${what}, and no CMYK profile stands behind it: the output intent is an RGB profile, so the file could not say what the ink means, which PDF/A-4 asks of every colour (ISO 19005-4, 6.2.4.3); pass a CMYK profile as the \`profile\` option, or print without \`a-4\` in \`standard\``, { listItem: { page, item } });
  list.pages.forEach((page, p) => page.items.forEach((item, at) => {
    if (item.kind === 'text' && story.blackText === '100k' && !item.fill.ink && item.fill.rgb.every((c) => c === 0))
      throw refuse(`text item ${at} of page ${p + 1} is painted in CMYK, by \`blackText: '100k'\``, p, at);
    const cmyk = item.kind === 'text' ? item.fill.ink !== undefined
      : item.kind === 'shape' && 'rect' in item ? item.fill.ink !== undefined
        : item.kind === 'marks' ? true
          : item.kind === 'image' ? imageCmyk(list, item.source)
            : item.kind === 'shape' || item.kind === 'group' || item.kind === 'form' || (item.kind === 'raster' && item.table === 'rasters') ? vectorCmyk(item as VectorItem)
              : false;
    if (cmyk) throw refuse(`${item.kind} item ${at} of page ${p + 1} is painted in CMYK`, p, at);
  }));
  for (const [name, form] of Object.entries(list.resources.forms)) {
    if (form.items.some(vectorCmyk))
      throw new CasterError(`caster: the form ${name} is painted in CMYK, and no CMYK profile stands behind it: the output intent is an RGB profile, so the file could not say what the ink means, which PDF/A-4 asks of every colour (ISO 19005-4, 6.2.4.3); pass a CMYK profile as the \`profile\` option, or print without \`a-4\` in \`standard\``);
  }
}

/** Whether an image's samples or file are CMYK: `DeviceCMYK` samples, or a JPEG of four components. */
function imageCmyk(list: DisplayList, source: number): boolean {
  const image = list.resources.images[source];
  if (!image) return false;
  if (image.samples?.colorSpace === 'DeviceCMYK') return true;
  return image.blob !== undefined && image.mime === 'image/jpeg' && parseJpeg(list.resources.blobs[image.blob]).components === 4;
}

/** Whether a vector item paints in CMYK, its children and its mask among it; a form item is read where its definition is, by name. */
function vectorCmyk(item: VectorItem): boolean {
  const paint = (p: Paint | undefined) => p !== undefined && ('cmyk' in p || ('gradient' in p && p.gradient.colorSpace === 'DeviceCMYK'));
  const own = item.kind === 'shape' ? paint(item.fill) || paint(item.stroke?.paint)
    : item.kind === 'group' ? item.items.some(vectorCmyk)
      : false;
  return own || (item.softMask?.items.some(vectorCmyk) ?? false);
}

/** Every resource key a page item names, and each page's marked content opened and closed in turn. */
function checkItems(list: DisplayList) {
  const { images, rasters, emoji } = list.resources;
  list.pages.forEach((page, p) => {
    let open = -1;
    page.items.forEach((item: Item, at) => {
      const where = `item ${at} of page ${p + 1}`;
      if (item.kind === 'image' && !images[item.source])
        throw new CasterError(`caster: the image at ${where} names source ${item.source}, which resources.images does not hold`, { listItem: { page: p, item: at } });
      if (item.kind === 'raster' && !(item.table === 'emoji' ? emoji : rasters)[item.source])
        throw new CasterError(`caster: the raster at ${where} names ${item.table} ${item.source}, which the resources do not hold`, { listItem: { page: p, item: at } });
      if (item.kind !== 'tag') return;
      if ('end' in item) {
        if (open < 0)
          throw new CasterError(`caster: the marked content end at ${where} closes nothing`, { listItem: { page: p, item: at } });
        open = -1;
      } else {
        if (open >= 0)
          throw new CasterError(`caster: the marked content at ${where} opens inside the one opened at item ${open}, which is not yet closed`, { listItem: { page: p, item: at } });
        open = at;
      }
    });
    if (open >= 0)
      throw new CasterError(`caster: the marked content opened at item ${open} of page ${p + 1} is never closed`, { listItem: { page: p, item: open } });
  });
}

/**
 * The element at `index`.
 *
 * @param what - What names it, for the refusal.
 * @throws {CasterError} No element has that index.
 */
function elementAt(elements: StructElement[], index: number, what: string): StructElement {
  const element = Number.isInteger(index) ? elements[index] : undefined;
  if (!element)
    throw new CasterError(`caster: ${what} names structure element ${String(index)}, and the list's tree has ${elements.length}`);
  return element;
}

/** The list's link items in document order, each with the page it sits on. */
function linksOf(list: DisplayList): { item: LinkItem, page: number }[] {
  return list.pages.flatMap((page, p) => page.items.filter((item): item is LinkItem => item.kind === 'link').map((item) => ({ item, page: p })));
}

/**
 * Hold the tree to the shape the writer writes from: rooted at element 0, every index anywhere in range, every child listed once, every content child a content start that names the element back, every content start claimed, every link child a link owned by it, no attribute key the schema does not name.
 *
 * @throws {CasterError} The first thing in the tree that is not so, named.
 */
function checkTree(list: DisplayList) {
  const elements = list.structure.elements;
  if (elements.length === 0)
    throw new CasterError('caster: the display list\'s structure tree has no elements; element 0 is the root');
  const starts = new Set<string>();
  list.pages.forEach((page, p) => page.items.forEach((item, at) => {
    if (item.kind === 'tag' && 'start' in item && 'element' in item.start) {
      elementAt(elements, item.start.element, `the marked content at item ${at} of page ${p + 1}`);
      starts.add(`${p}:${at}`);
    }
  }));
  const linkOwners = new Map<number, number>();
  for (const { item } of linksOf(list)) {
    elementAt(elements, item.element, `the link of order ${item.order}`);
    if (item.target.dest) elementAt(elements, item.target.dest.element, `the destination at ${item.target.dest.struct}`);
    linkOwners.set(item.order, item.element);
  }
  for (const heading of list.outline) elementAt(elements, heading.element, `the bookmark ${JSON.stringify(heading.title)}`);
  const parent: number[] = elements.map(() => -2);
  parent[0] = -1;
  const claimed = new Set<string>();
  elements.forEach((element, index) => {
    const where = `structure element ${index} (${element.path})`;
    for (const attribute of element.attributes ?? []) {
      const stray = Object.keys(attribute).find((key) => !(ATTRIBUTE_KEYS as readonly string[]).includes(key));
      if (stray !== undefined)
        throw new CasterError(`caster: ${where} carries an attribute object with the key ${stray}, which the schema does not name`);
    }
    if (element.namespace !== undefined && element.namespace !== PDF_1_7_NAMESPACE)
      throw new CasterError(`caster: ${where} names the namespace ${JSON.stringify(element.namespace)}; an element is in the PDF 2.0 namespace or names ${PDF_1_7_NAMESPACE}`);
    if (element.refs !== undefined) {
      if (element.refs.length === 0)
        throw new CasterError(`caster: ${where} carries an empty refs; an element that refers to none carries none`);
      for (const ref of element.refs) elementAt(elements, ref, `the Ref of ${where}`);
    }
    for (const child of element.children) {
      if (typeof child === 'number') {
        if (!Number.isInteger(child) || child <= 0 || child >= elements.length)
          throw new CasterError(`caster: ${where} lists child ${String(child)}, which is not an element below the root`);
        if (parent[child] !== -2)
          throw new CasterError(`caster: ${where} lists element ${child}, which ${parent[child] === index ? 'it already lists' : `element ${parent[child]} lists too`}; an element has one parent`);
        parent[child] = index;
      } else if ('link' in child) {
        if (linkOwners.get(child.link) !== index)
          throw new CasterError(`caster: ${where} lists the link of order ${String(child.link)}, which ${linkOwners.has(child.link) ? `element ${linkOwners.get(child.link)} owns` : 'no link item has'}`);
      } else {
        const item = list.pages[child.page]?.items[child.item];
        if (!item || item.kind !== 'tag' || !('start' in item) || !('element' in item.start))
          throw new CasterError(`caster: ${where} lists item ${String(child.item)} of page ${String(child.page)}, which is not a content start`, { listItem: { page: child.page, item: child.item } });
        if (item.start.element !== index)
          throw new CasterError(`caster: ${where} lists item ${child.item} of page ${child.page + 1}, which opens content for element ${item.start.element}`, { listItem: { page: child.page, item: child.item } });
        const key = `${child.page}:${child.item}`;
        if (claimed.has(key))
          throw new CasterError(`caster: ${where} lists item ${child.item} of page ${child.page + 1} twice`, { listItem: { page: child.page, item: child.item } });
        claimed.add(key);
      }
    }
  });
  const orphan = parent.indexOf(-2);
  if (orphan >= 0)
    throw new CasterError(`caster: structure element ${orphan} (${elements[orphan].path}) is no element's child, so the tree does not reach it`);
  // One parent each and the root nobody's child: an element the root does not reach sits on a cycle.
  elements.forEach((_, index) => {
    const seen = new Set<number>();
    for (let at = index; at !== -1; at = parent[at]) {
      if (seen.has(at))
        throw new CasterError(`caster: structure element ${index} (${elements[index].path}) is its own ancestor; the tree has a cycle`);
      seen.add(at);
    }
  });
  for (const key of starts) {
    if (!claimed.has(key)) {
      const [page, item] = key.split(':').map(Number);
      throw new CasterError(`caster: the content start at item ${item} of page ${page + 1} is in no element's children`, { listItem: { page, item } });
    }
  }
}

/** The links' `order` runs 0, 1, 2 … over the document, and each link goes somewhere: a destination in the file or a URI. */
function checkLinks(list: DisplayList) {
  const orders = linksOf(list).map(({ item }) => item.order).sort((a, b) => a - b);
  orders.forEach((order, at) => {
    if (order !== at)
      throw new CasterError(`caster: the link at place ${at} among the document's links has order ${order}; the orders run 0, 1, 2 …, and the /StructParent numbering follows them`);
  });
  for (const { item } of linksOf(list)) {
    if (!item.target.dest && item.target.uri === undefined)
      throw new CasterError(`caster: the link of order ${item.order} has neither a destination in the file nor a URI; the builder resolves one for every link without a destination`);
  }
}
