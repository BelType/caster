/**
 * Ported whole from `harness/tests/node/tableHeaders.test.ts` in the `browser-to-pdf-experiments` repository (E11); `docs/guide/tables.md` §"Header association" is the prose. Vitest's `expect` becomes `node:assert/strict`; nothing else changed. The harness's own header follows.
 *
 * E11's header association, over tables written by hand.
 *
 * These ran before the fixture existed, and that is the point of them. The fixture can only ever show that the algorithm agrees with itself on ten tables somebody drew to suit it; the cases below are the ones HTML's algorithm exists for, each stated as the smallest table that exhibits it, so a regression names the rule it broke rather than "case 3 moved".
 *
 * The models are built here rather than parsed out of HTML: `buildTableModel` needs a DOM and this project is the node one, and more importantly a model literal is a table a reader can see in the source. The placement loop is the same one `tableModel.js` runs, restated in ten lines, because a builder that imported the DOM one would drag the DOM in with it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assignHeaders, headersOf, isColumnHeader, isRowHeader, scopeNameOf } from '../src/walk/tableHeaders.ts';

import type { ScopeAttribute, TableCell, TableModel, TableSection } from '../src/walk/tableModel.ts';

export type Spec = {
  /** `th` unless given. */
  t?: 'th' | 'td';
  /** Text, which also becomes the cell's DOM id when no `id` is given. */
  text?: string;
  id?: string;
  scope?: ScopeAttribute;
  rs?: number;
  cs?: number;
  /** The `headers` attribute, space separated. */
  headers?: string;
  empty?: boolean;
  section?: TableSection;
  group?: number;
};

/** A hand-written table: rows of cells, laid out by HTML's slot rule. */
function handModel(rows: Spec[][]): TableModel {
  const cells: TableCell[] = [];
  const grid: (number|null)[][] = [];
  const ensure = (row: number, col: number) => {
    while (grid.length <= row) grid.push([]);
    while (grid[row].length <= col) grid[row].push(null);
  };
  rows.forEach((row, r) => {
    let c = 0;
    for (const spec of row) {
      ensure(r, c);
      while ((grid[r][c] ?? null) !== null) {
        c += 1;
        ensure(r, c);
      }
      const index = cells.length;
      const rowSpan = spec.rs ?? 1;
      const colSpan = spec.cs ?? 1;
      const section = spec.section ?? (r === 0 ? 'thead' : 'tbody');
      cells.push({
        index,
        kind: spec.t ?? 'th',
        id: spec.id ?? spec.text ?? '',
        headers: (spec.headers ?? '').split(/\s+/u).filter((t) => t !== ''),
        scope: spec.scope ?? '',
        rowSpan,
        colSpan,
        row: r,
        col: c,
        section,
        rowGroup: spec.group ?? (section === 'thead' ? 0 : 1),
        colGroup: -1,
        empty: spec.empty ?? false,
        synthetic: false,
        fragment: 0,
        domPath: spec.text ?? `${spec.t ?? 'th'}[${r},${c}]`,
      });
      for (let dr = 0; dr < rowSpan; dr++) {
        for (let dc = 0; dc < colSpan; dc++) {
          ensure(r + dr, c + dc);
          grid[r + dr][c + dc] = index;
        }
      }
      c += colSpan;
    }
  });
  const columns = Math.max(0, ...grid.map((g) => g.length));
  for (const row of grid) while (row.length < columns) row.push(null);
  const groups = [...new Set(cells.map((c) => c.rowGroup))].sort((a, b) => a - b);
  return {
    key: 'hand',
    rows: grid.length,
    columns,
    grid,
    cells,
    rowList: [],
    rowGroups: groups.map((index) => ({
      index,
      section: (cells.find((c) => c.rowGroup === index) as TableCell).section,
      startRow: Math.min(...cells.filter((c) => c.rowGroup === index).map((c) => c.row)),
      endRow: Math.max(...cells.filter((c) => c.rowGroup === index).map((c) => c.row + c.rowSpan - 1)),
      elements: [],
    })),
    colGroups: [],
    warnings: [],
    fragments: [],
  };
}

/** Header ids of one cell, named by the text the cell was written with. */
const named = (model: TableModel, cell: number): string[] => headersOf(model, cell).headers.map((i) => model.cells[i].domPath);

const cellNamed = (model: TableModel, text: string): number => model.cells.findIndex((c) => c.domPath === text);

// ---------------------------------------------------------------------------

test('e11-tables header association: a head row labels every cell of its column', () => {
  const model = handModel([
    [{ text: 'Region' }, { text: 'Q1' }, { text: 'Q2' }],
    [{ t: 'td', text: 'north-1' }, { t: 'td', text: 'north-2' }, { t: 'td', text: 'north-3' }],
    [{ t: 'td', text: 'south-1' }, { t: 'td', text: 'south-2' }, { t: 'td', text: 'south-3' }],
  ]);
  // No `scope` anywhere: the head row is a set of column headers because no row it covers holds a data cell, which is HTML's auto rule and not a guess about what `thead` means.
  assert.equal(model.cells.filter((c) => c.kind === 'th').every((c) => isColumnHeader(model, c.index)), true);
  assert.deepEqual(named(model, cellNamed(model, 'north-1')), ['Region']);
  assert.deepEqual(named(model, cellNamed(model, 'south-3')), ['Q2']);
});

test('e11-tables header association: a row header and a column header, column first and nearest first', () => {
  const model = handModel([
    [{ text: 'corner', scope: 'col' }, { text: 'Q1', scope: 'col' }, { text: 'Q2', scope: 'col' }],
    [{ text: 'North', scope: 'row' }, { t: 'td', text: 'n1' }, { t: 'td', text: 'n2' }],
    [{ text: 'South', scope: 'row' }, { t: 'td', text: 's1' }, { t: 'td', text: 's2' }],
  ]);
  assert.equal(isRowHeader(model, cellNamed(model, 'North')), true);
  // The order is E11's, not HTML's: HTML runs the row scan first and produces an unordered list, and a reader announcing `/Headers` reads it aloud.
  assert.deepEqual(named(model, cellNamed(model, 's2')), ['Q2', 'South']);
  assert.equal(scopeNameOf(model, cellNamed(model, 'corner')), 'Column');
  assert.equal(scopeNameOf(model, cellNamed(model, 'North')), 'Row');
});

test('e11-tables header association: a spanning column header labels both columns under it', () => {
  const model = handModel([
    [{ text: 'Region', rs: 2 }, { text: 'Sales', cs: 2 }],
    [{ text: 'Q1', section: 'thead' }, { text: 'Q2', section: 'thead' }],
    [{ t: 'td', text: 'north' }, { t: 'td', text: 'n1' }, { t: 'td', text: 'n2' }],
  ]);
  // Walking up from `n2`: `Q2` first, then `Sales` above it. Both are column headers and neither is opaque, so both are named, nearest first.
  assert.deepEqual(named(model, cellNamed(model, 'n2')), ['Q2', 'Sales']);
  assert.deepEqual(named(model, cellNamed(model, 'n1')), ['Q1', 'Sales']);
});

test('e11-tables header association: a data cell makes the headers above it opaque', () => {
  const model = handModel([
    [{ text: 'Metric', scope: 'col' }, { text: 'Value', scope: 'col' }],
    [{ t: 'td', text: 'first' }, { t: 'td', text: 'v1' }],
    [{ text: 'Restated', scope: 'col', section: 'tbody' }, { text: 'Value2', scope: 'col', section: 'tbody' }],
    [{ t: 'td', text: 'second' }, { t: 'td', text: 'v2' }],
  ]);
  // Scanning up from `v2`: `Value2` is a column header and is taken; then a data cell (`v1`) closes that header block and makes `Value2` opaque; `Value` above it has the same x and the same width, so it is blocked. Without the opaque-headers list a reader would be told the second half of the table is headed by the first half's headings as well.
  assert.deepEqual(named(model, cellNamed(model, 'v2')), ['Value2']);
  assert.deepEqual(named(model, cellNamed(model, 'v1')), ['Value']);
});

test('e11-tables header association: a row header in a column scan is skipped, not taken', () => {
  const model = handModel([
    [{ text: 'Item', scope: 'col' }, { text: 'Amount', scope: 'col' }],
    [{ text: 'Subtotal', scope: 'row' }, { t: 'td', text: 'sub' }],
    [{ text: 'Total', scope: 'row' }, { t: 'td', text: 'tot' }],
  ]);
  // `Subtotal` sits in `tot`'s row scan and heads its own row; it also sits in nothing's column scan, because the column scan of `tot` runs up column 1.
  assert.deepEqual(named(model, cellNamed(model, 'tot')), ['Amount', 'Total']);
  assert.deepEqual(named(model, cellNamed(model, 'sub')), ['Amount', 'Subtotal']);
});

test('e11-tables header association: a rowgroup header labels every cell of its group', () => {
  const model = handModel([
    [{ text: 'Line', scope: 'col' }, { text: 'Amount', scope: 'col' }],
    [{ text: 'Europe', scope: 'rowgroup', rs: 2, group: 1 }, { t: 'td', text: 'e1', group: 1 }],
    [{ t: 'td', text: 'e2', group: 1 }],
    [{ text: 'Asia', scope: 'rowgroup', rs: 2, group: 2 }, { t: 'td', text: 'a1', group: 2 }],
    [{ t: 'td', text: 'a2', group: 2 }],
  ]);
  // The group scope's extent is what `/Headers` carries and `/Scope /Row` cannot: `e2` is not in `Europe`'s row at all, and only the group rule reaches it.
  assert.deepEqual(named(model, cellNamed(model, 'e1')), ['Amount', 'Europe']);
  assert.deepEqual(named(model, cellNamed(model, 'e2')), ['Amount', 'Europe']);
  assert.deepEqual(named(model, cellNamed(model, 'a2')), ['Amount', 'Asia']);
  assert.equal(scopeNameOf(model, cellNamed(model, 'Europe')), 'Row');
});

test('e11-tables header association: an explicit headers attribute wins over the geometry', () => {
  const model = handModel([
    [{ text: 'Q1', scope: 'col' }, { text: 'Q2', scope: 'col' }, { text: 'Note', scope: 'col' }],
    [{ t: 'td', text: 'a', headers: 'Q1' }, { t: 'td', text: 'b', headers: 'Q2 Note' }, { t: 'td', text: 'c' }],
  ]);
  // `Note` is nowhere in `b`'s scans; the attribute is the author overruling the geometry, and its order is the author's too.
  assert.deepEqual(named(model, cellNamed(model, 'b')), ['Q2', 'Note']);
  assert.equal(headersOf(model, cellNamed(model, 'b')).explicit, true);
  assert.equal(headersOf(model, cellNamed(model, 'c')).explicit, false);
});

test('e11-tables header association: a headers attribute may name a data cell, and an unknown id is dropped', () => {
  const model = handModel([
    [{ text: 'Q1', scope: 'col' }, { text: 'Q2', scope: 'col' }],
    [{ t: 'td', text: 'anchor', id: 'anchor' }, { t: 'td', text: 'b', headers: 'anchor nowhere' }],
  ]);
  // HTML resolves `headers` against cells, not against header cells, so a `td` is a legal target; an id that names nothing in this table is dropped rather than guessed at, because a dangling `/Headers` entry is a reader error.
  assert.deepEqual(named(model, cellNamed(model, 'b')), ['anchor']);
});

test('e11-tables header association: an empty header cell is dropped', () => {
  const model = handModel([
    [{ text: 'corner', empty: true, scope: 'col' }, { text: 'Q1', scope: 'col' }],
    [{ text: 'North', scope: 'row' }, { t: 'td', text: 'n1' }],
  ]);
  // The blank corner cell is a header of the row-header column by geometry and of nothing at all by meaning; HTML's empty flag is what keeps it out.
  assert.deepEqual(named(model, cellNamed(model, 'n1')), ['Q1', 'North']);
});

test('e11-tables header association: a spanning data cell collects every header it covers', () => {
  const model = handModel([
    [{ text: 'Q1', scope: 'col' }, { text: 'Q2', scope: 'col' }, { text: 'Q3', scope: 'col' }],
    [{ t: 'td', text: 'wide', cs: 2 }, { t: 'td', text: 'x' }],
  ]);
  assert.deepEqual(named(model, cellNamed(model, 'wide')), ['Q1', 'Q2']);
});

test('e11-tables header association: every data cell of a laid-out table gets an answer', () => {
  const model = handModel([
    [{ text: 'Region', scope: 'col' }, { text: 'Q1', scope: 'col' }, { text: 'Q2', scope: 'col' }],
    [{ text: 'North', scope: 'row' }, { t: 'td', text: 'n1' }, { t: 'td', text: 'n2' }],
  ]);
  const assignments = assignHeaders(model);
  assert.deepEqual(assignments.map((a) => model.cells[a.cell].domPath), ['n1', 'n2']);
  assert.equal(assignments.every((a) => a.headers.length > 0), true);
  // The two halves of the answer are kept apart so the emitted order is a rule rather than an accident of concatenation.
  assert.deepEqual(assignments[0].columnHeaders.map((i) => model.cells[i].domPath), ['Q1']);
  assert.deepEqual(assignments[0].rowHeaders.map((i) => model.cells[i].domPath), ['North']);
});
