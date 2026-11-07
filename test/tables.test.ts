/**
 * The grid model and the collapsed-border resolver, over tables written by hand.
 *
 * `test/tableHeaders.test.js` is the harness's own suite ported whole; this one covers the two rules beside it that a document can trip over and that need no browser: what `buildTableModel` does with a ragged row, with an overlap, with a fragmented table and with a repeated head row, and how `resolveEdge` decides one grid edge under CSS 2.1 §17.6.2. `docs/guide/tables.md` §"The grid model" and §"Collapsed borders" are the prose.
 *
 * The DOM the model reads is duck-typed here — `tagName`, `children`, `getAttribute`, `textContent` and nothing else — because that is the whole of what `buildTableModel` asks of an element, and because a model built from a literal is a table a reader can see in the source. The half of `collectTableBorders` that reads rectangles off a live engine belongs to the browser acceptance test.
 */
import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TABLE_FRAGMENT_ATTRIBUTE,
  TABLE_REPEAT_ATTRIBUTE,
  buildTableModel,
  isEmptyCell,
  isRepeated,
  regularityOf,
} from '../src/walk/tableModel.ts';
import { resolveEdge, resolvedWidthsOf } from '../src/vectors/tableBorders.ts';
import { resolveStructure } from '../src/displayList/structure.ts';
import { CasterError } from '../src/errors.ts';
import type { EdgeOrigin } from '../src/vectors/tableBorders.ts';

/** The smallest thing `buildTableModel` will read: a tag, some attributes, some children and some text. */
function el(tag: string, attributes: Record<string,string> = {}, children: any[] = [], text: string = ''): any {
  return {
    tagName: tag.toUpperCase(),
    children,
    textContent: text || children.map((c) => c.textContent ?? '').join(''),
    getAttribute(name: string) {
      return Object.hasOwn(attributes, name) ? attributes[name] : null;
    },
  };
}

const describe = (element: any): string => element.getAttribute('data-path') ?? element.tagName.toLowerCase();

const cell = (kind: 'th'|'td', path: string, attributes: Record<string,string> = {}): any => el(kind, { 'data-path': path, ...attributes }, [], path);

test('the model lays cells out by HTML’s slot rule, spans expanded', () => {
  const table = el('table', {}, [
    el('thead', { 'data-path': 'head' }, [
      el('tr', { 'data-path': 'r0' }, [cell('th', 'Region', { rowspan: '2' }), cell('th', 'Sales', { colspan: '2' })]),
      el('tr', { 'data-path': 'r1' }, [cell('th', 'Q1'), cell('th', 'Q2')]),
    ]),
    el('tbody', { 'data-path': 'body' }, [
      el('tr', { 'data-path': 'r2' }, [cell('th', 'North'), cell('td', 'n1'), cell('td', 'n2')]),
    ]),
  ]);
  const model = buildTableModel([table], describe);
  assert.equal(model.rows, 3);
  assert.equal(model.columns, 3);
  assert.deepEqual(regularityOf(model.grid), { rectangular: true, rows: 3, columns: 3, missing: [] });
  assert.equal(model.warnings.length, 0, 'a rectangular table needs no padding');
  // `Region` covers (0,0) and (1,0); `Sales` covers (0,1) and (0,2); the second row's cells slot in after the rowspan.
  const at = (r: number, c: number): string => model.cells[(model.grid[r][c] as number)].domPath;
  assert.deepEqual(
    [at(0, 0), at(0, 1), at(0, 2), at(1, 0), at(1, 1), at(1, 2), at(2, 0), at(2, 1), at(2, 2)],
    ['Region', 'Sales', 'Sales', 'Region', 'Q1', 'Q2', 'North', 'n1', 'n2'],
  );
  // Two row groups, each knowing the rows it covers.
  assert.deepEqual(model.rowGroups.map((g) => [g.section, g.startRow, g.endRow]), [['thead', 0, 1], ['tbody', 2, 2]]);
  assert.equal(model.key, 'table', 'with no data-pdf-table the key is the first fragment’s own path');
});

test('a ragged row is padded with synthetic empty TDs, in column order, with a warning naming the row', () => {
  const table = el('table', {}, [
    el('tbody', { 'data-path': 'body' }, [
      el('tr', { 'data-path': 'r0' }, [cell('td', 'a'), cell('td', 'b'), cell('td', 'c')]),
      el('tr', { 'data-path': 'r1' }, [cell('td', 'd')]),
    ]),
  ]);
  const model = buildTableModel([table], describe);
  assert.equal(regularityOf(model.grid).rectangular, true, 'PDF/UA-2 8.2.5.26 t2–t4 want a rectangle');
  const padded = model.cells.filter((c) => c.synthetic);
  assert.equal(padded.length, 2);
  assert.deepEqual(padded.map((c) => [c.row, c.col, c.kind, c.empty]), [[1, 1, 'td', true], [1, 2, 'td', true]]);
  // Inserted into the row in COLUMN order, so the reading order of the emitted TR is still left to right.
  const row = (model.rowList.find((r) => r.index === 1) as any);
  assert.deepEqual(row.cells.map(( i: number) => model.cells[i].col), [0, 1, 2]);
  assert.equal(model.warnings.length, 1);
  assert.equal(
    model.warnings[0],
    'row 1 (r1) covers 1 of 3 columns; 2 empty TDs were added at columns 1, 2 to make the table rectangular',
  );
});

test('one hole takes the singular, because a warning a reader trips over is a warning nobody reads', () => {
  const table = el('table', {}, [
    el('tbody', { 'data-path': 'body' }, [
      el('tr', { 'data-path': 'r0' }, [cell('td', 'a'), cell('td', 'b')]),
      el('tr', { 'data-path': 'r1' }, [cell('td', 'c')]),
    ]),
  ]);
  const model = buildTableModel([table], describe);
  assert.equal(model.warnings[0], 'row 1 (r1) covers 1 of 2 columns; 1 empty TD was added at column 1 to make the table rectangular');
});

test('two cells claiming one slot is an export error naming both', () => {
  // HTML's slot rule advances past a taken ANCHOR slot, so an overlap needs a span that reaches over one: a rowspan holding (1,1) while the next row's colspan tries to cover it.
  const bad = el('table', {}, [
    el('tbody', { 'data-path': 'body' }, [
      el('tr', { 'data-path': 'r0' }, [cell('td', 'a'), cell('td', 'tall', { rowspan: '2' })]),
      el('tr', { 'data-path': 'r1' }, [cell('td', 'wide', { colspan: '3' })]),
    ]),
  ]);
  assert.throws(
    () => buildTableModel([bad], describe),
    (error) => {
      assert.ok(error instanceof CasterError);
      assert.equal(error.element, 'wide', 'the panel gets the cell that could not be placed');
      assert.match(error.message, /the cell at wide covers slot \(1, 1\), which tall already covers/);
      assert.match(error.message, /8\.2\.5\.26 t1.*no padding can repair them/);
      return true;
    },
  );

  // The control: the same two cells with a colspan that does not reach the taken slot lay out fine.
  const fine = el('table', {}, [
    el('tbody', { 'data-path': 'body' }, [
      el('tr', { 'data-path': 'r0' }, [cell('td', 'a'), cell('td', 'tall', { rowspan: '2' })]),
      el('tr', { 'data-path': 'r1' }, [cell('td', 'narrow')]),
    ]),
  ]);
  assert.equal(buildTableModel([fine], describe).rows, 2);
});

test('a rowspan reaching past the last declared row is a defect, pinned rather than repaired', () => {
  // The grid grows to hold the span and `rowList` does not, so the ragged-row padding looks for a row record that was never made. The harness's `rowList.find(...)!` asserts the row exists; here that is a bare TypeError out of an author's own document, which is the wrong shape for a refusal — see DESIGN.md §Painting, proposition P9. Ported as written (PLAN.md P1) and pinned, so the day it is repaired the pin says so.
  const overrun = el('table', {}, [
    el('tbody', { 'data-path': 'body' }, [el('tr', { 'data-path': 'r0' }, [cell('td', 'tall', { rowspan: '3' }), cell('td', 'a')])]),
  ]);
  assert.throws(() => buildTableModel([overrun], describe), TypeError);
});

test('fragments are one table, and a row group merges across them by section and ordinal', () => {
  /**
   * @param [attrs]
   */
  const bodyFragment = (name: string, rows: string[], attrs: Record<string,string> = {}) =>
    el('table', { [TABLE_FRAGMENT_ATTRIBUTE]: 'sales', ...attrs }, [
      el('tbody', { 'data-path': `${name}-body` }, rows.map((r) => el('tr', { 'data-path': r }, [cell('td', `${r}a`), cell('td', `${r}b`)]))),
    ]);
  const model = buildTableModel([bodyFragment('f1', ['r0', 'r1']), bodyFragment('f2', ['r2'])], describe);
  assert.equal(model.key, 'sales', 'the shared data-pdf-table id is the key');
  assert.equal(model.rows, 3);
  assert.equal(model.rowGroups.length, 1, 'two continuation tbodies are ONE TBody');
  assert.deepEqual([model.rowGroups[0].startRow, model.rowGroups[0].endRow], [0, 2]);
  assert.equal(model.rowGroups[0].elements.length, 2, 'and it remembers both elements');
  assert.deepEqual(model.cells.map((c) => c.fragment), [0, 0, 0, 0, 1, 1]);

  // Two tbodies on ONE page stay two, because the merge key is the ordinal within the fragment.
  const twoBodies = el('table', {}, [
    el('tbody', { 'data-path': 'b1' }, [el('tr', { 'data-path': 'r0' }, [cell('td', 'a')])]),
    el('tbody', { 'data-path': 'b2' }, [el('tr', { 'data-path': 'r1' }, [cell('td', 'b')])]),
  ]);
  assert.equal(buildTableModel([twoBodies], describe).rowGroups.length, 2);
});

test('a repeated head row is ink on a continuation page and never a row of the table', () => {
  const head = (path: string, repeated: boolean): any =>
    el('thead', { 'data-path': path, ...(repeated ? { [TABLE_REPEAT_ATTRIBUTE]: 'header' } : {}) }, [
      el('tr', { 'data-path': `${path}-tr` }, [cell('th', `${path}-Q1`), cell('th', `${path}-Q2`)]),
    ]);
  const model = buildTableModel(
    [
      el('table', { [TABLE_FRAGMENT_ATTRIBUTE]: 't' }, [
        head('h1', false),
        el('tbody', { 'data-path': 'b1' }, [el('tr', { 'data-path': 'r0' }, [cell('td', 'a'), cell('td', 'b')])]),
      ]),
      el('table', { [TABLE_FRAGMENT_ATTRIBUTE]: 't' }, [
        head('h2', true),
        el('tbody', { 'data-path': 'b2' }, [el('tr', { 'data-path': 'r1' }, [cell('td', 'c'), cell('td', 'd')])]),
      ]),
    ],
    describe,
  );
  assert.equal(model.rows, 3, 'one head row and two body rows; the repeat is not a row');
  assert.deepEqual(model.rowList.filter((r) => r.repeated).map((r) => r.domPath), ['h2-tr']);
  assert.deepEqual(model.rowList.filter((r) => r.repeated).map((r) => r.index), [-1], 'a repeated row has no grid index');
  assert.equal(model.cells.some((c) => c.domPath.startsWith('h2-')), false, 'and its cells never reach the grid');
  assert.equal(isRepeated(head('h2', true)), true);
  assert.equal(isRepeated(head('h1', false)), false);
});

test('HTML’s empty-cell flag: no element children and only whitespace text', () => {
  assert.equal(isEmptyCell(el('td', {}, [], '   ')), true);
  assert.equal(isEmptyCell(el('td', {}, [], '')), true);
  assert.equal(isEmptyCell(el('td', {}, [], 'x')), false);
  assert.equal(isEmptyCell(el('td', {}, [el('span', {}, [], '')], '')), false, 'an element child is content whatever its text');
});

test('regularityOf names every uncovered slot', () => {
  assert.deepEqual(regularityOf([[0, 1], [2, null]]), { rectangular: false, rows: 2, columns: 2, missing: [[1, 1]] });
  assert.deepEqual(regularityOf([]), { rectangular: false, rows: 0, columns: 0, missing: [] });
  assert.equal(regularityOf([[0, 1], [2, 3]]).rectangular, true);
});

test('a row divided across pages reads its cells in column order, whatever page each starts on', () => {
  // The divided row of `fixtures/cast-divided-row/`: the long third cell starts on the first page, the three short ones are centred on the second.
  const n = (tag: string, path: string, kids: any[] = []): any => ({ tag, path, attrs: {}, kids });
  const row = 'D/T/TR';
  const tree = n('Document', 'D', [n('Table', 'D/T', [n('TR', row, [0, 1, 2, 3].map((i) => n('TD', `${row}/TD${i}`)))]), n('P', 'D/P')]);
  const contents = [
    { page: 0, item: 0, owner: `${row}/TD2`, seq: 0 },
    { page: 1, item: 0, owner: `${row}/TD0`, seq: 1e6 },
    { page: 1, item: 1, owner: `${row}/TD1`, seq: 1e6 + 1 },
    { page: 1, item: 2, owner: `${row}/TD2`, seq: 1e6 + 2 },
    { page: 1, item: 3, owner: `${row}/TD3`, seq: 1e6 + 3 },
    { page: 1, item: 4, owner: 'D/P', seq: 1e6 + 4 },
  ];
  const { elements } = resolveStructure(tree, contents, [], {}, []).structure;
  const tr = elements.find((e) => e.path === row) as any;
  assert.deepEqual(tr.children.map((i: number) => elements[i].path), [0, 1, 2, 3].map((i) => `${row}/TD${i}`));

  // The same, in the committed list of the fixture itself.
  const list = JSON.parse(fs.readFileSync(new URL('../fixtures/lists/cast-divided-row.json', import.meta.url), 'utf8'));
  const recorded = list.structure.elements;
  const divided = recorded.find((e: any) => e.path === 'Document/Table[0]/TBody[0]/TR[1]');
  assert.deepEqual(divided.children.map((i: number) => recorded[i].path.split('/').pop()), ['TD[0]', 'TD[1]', 'TD[2]', 'TD[3]']);
});

const candidate = (origin: EdgeOrigin, style: string, widthPx: number, color: string = 'rgb(0, 0, 0)'): any => ({ origin, style, widthPx, color, domPath: `${origin}:${style}` });

test('§17.6.2 rule 2: `hidden` beats everything, including a wider border', () => {
  const { winner, hidden } = resolveEdge([candidate('cell', 'solid', 6), candidate('row', 'hidden', 0)]);
  assert.equal(hidden, true);
  assert.equal(winner, null);
  // It is not "a border of width zero": a 12 px hidden and a 1 px solid resolve the same way.
  assert.equal(resolveEdge([candidate('cell', 'solid', 1), candidate('table', 'hidden', 12)]).hidden, true);
});

test('§17.6.2 rule 3: `none` and a zero width are dropped, and nothing left is no border', () => {
  assert.deepEqual(resolveEdge([]), { winner: null, hidden: false });
  assert.deepEqual(resolveEdge([candidate('cell', 'none', 4), candidate('row', 'solid', 0)]), { winner: null, hidden: false });
  assert.equal((resolveEdge([candidate('cell', 'none', 4), candidate('table', 'solid', 1)]).winner as any).origin, 'table');
});

test('§17.6.2 rule 3: the widest wins, whatever declared it', () => {
  const { winner } = resolveEdge([candidate('cell', 'solid', 2), candidate('cell', 'solid', 6), candidate('table', 'double', 1)]);
  assert.equal((winner as any).widthPx, 6);
  // The guide's own row: a 1 px table border against 2 px cells never appears anywhere on the page.
  const { winner: cellWins } = resolveEdge([candidate('cell', 'solid', 2), candidate('table', 'solid', 1)]);
  assert.equal((cellWins as any).origin, 'cell');
});

test('§17.6.2 rule 4: style precedence, double solid dashed dotted ridge outset groove inset', () => {
  const order = ['double', 'solid', 'dashed', 'dotted', 'ridge', 'outset', 'groove', 'inset'];
  for (let i = 0; i + 1 < order.length; i++) {
    const { winner } = resolveEdge([candidate('cell', order[i + 1], 4), candidate('cell', order[i], 4)]);
    assert.equal((winner as any).style, order[i], `${order[i]} beats ${order[i + 1]} at equal width`);
  }
  // A style outside the list sorts last, so it never beats one that is in it.
  const { winner } = resolveEdge([candidate('cell', 'wavy', 4), candidate('cell', 'inset', 4)]);
  assert.equal((winner as any).style, 'inset');
});

test('§17.6.2 rule 5: origin precedence, cell row row-group column column-group table', () => {
  const order = (['cell', 'row', 'row-group', 'column', 'column-group', 'table'] as const);
  for (let i = 0; i + 1 < order.length; i++) {
    const { winner } = resolveEdge([candidate(order[i + 1], 'solid', 3), candidate(order[i], 'solid', 3)]);
    assert.equal((winner as any).origin, order[i], `${order[i]} beats ${order[i + 1]} at equal width and style`);
  }
  // Origin is the LAST tie-break: a wider row border beats a narrower cell one.
  assert.equal((resolveEdge([candidate('cell', 'solid', 1), candidate('row', 'solid', 5)]).winner as any).origin, 'row');
  // And style outranks origin: a table's `double` beats a cell's `solid` at the same width.
  assert.equal((resolveEdge([candidate('cell', 'solid', 3), candidate('table', 'double', 3)]).winner as any).origin, 'table');
});

test('resolvedWidthsOf reads a cell’s four sides back out of the painted edges', () => {
  const model: any = {
    cells: [{ index: 0, row: 1, col: 1, rowSpan: 1, colSpan: 2 }],
  };
  const edges: any[] = [
    { axis: 'h', line: 1, from: 0, to: 3, widthPx: 6 },
    { axis: 'h', line: 2, from: 1, to: 2, widthPx: 2 },
    { axis: 'v', line: 1, from: 0, to: 4, widthPx: 4 },
    { axis: 'v', line: 3, from: 1, to: 2, widthPx: 1 },
  ];
  // Top, right, bottom, left — the right edge is at col + colSpan, which is 3 for a cell spanning two columns.
  assert.deepEqual(resolvedWidthsOf(model, edges, 0), [6, 1, 2, 4]);
  // An edge nothing painted is a zero, which is what "no border was painted here" means to the comparison.
  assert.deepEqual(resolvedWidthsOf(model, [], 0), [0, 0, 0, 0]);
});
