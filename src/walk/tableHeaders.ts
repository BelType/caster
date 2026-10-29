/**
 * `walk/tableHeaders.js` — which header cells each data cell belongs to, and the `/Scope` each header carries.
 *
 * Ported from `harness/src/export/tableHeaders.ts` in the `browser-to-pdf-experiments` repository (E11). Guide: `docs/guide/tables.md` §"Header association", §"`/Scope`, and why `/Headers` is written anyway".
 *
 * WHAT THE PORT CHANGED. Nothing but the language: the module is pure, and its names and signatures are the harness's (PLAN.md P1).
 *
 * The harness's own header follows.
 *
 * The HTML specification's "algorithm for assigning header cells", run over the grid model of `tables.md` (E11).
 *
 * PDF has two ways to say which header a cell belongs to and they answer different questions. `/Scope` on a `TH` says "I head my column" and leaves the reader to work out which cells that is; `/Headers` on a `TD` names the header cells outright. ISO 32000-2 14.8.5.7 accepts either, and veraPDF's 8.2.5.26 t5/t6 ask only that one of them lets a reader determine the association — so E11 (`tables.md`) emits both, and this module is where the second one comes from.
 *
 * The algorithm is HTML's, transcribed rather than approximated, because the cases it exists for are exactly the ones a hand-rolled "walk left, walk up" gets wrong: a header block broken by a data cell (the `opaque headers` list), a header that heads its row rather than its column sitting in a column scan, a `headers` attribute pointing at a cell in another row group, and the group scopes. It is pure: a model in, a list of cell indices out, no DOM and no measurement, which is what lets `test/tableHeaders.test.js` state each of those cases as a hand-written table and check the answer before the fixture exists.
 *
 * One thing here is not HTML's. HTML produces one unordered list; PDF's `/Headers` is an array, and a reader announces it in order. The order in `tables.md` (E11) is column headers first, then row headers, each nearest first — the order a person reads a cell's address in, "Revenue, Q3" rather than "Q3, Revenue" — so the two scans are kept apart instead of being concatenated as the specification concatenates them.
 *
 * @packageDocumentation
 */

import type { TableCell, TableModel } from './tableModel.ts';

/**
 * A header cell of its column, per HTML.
 *
 * @remarks
 * The auto state's condition is about *rows*, not about the `thead`: a header cell is a column header when no row it covers contains a data cell, which is what makes the whole of a two-deep head a set of column headers without any `scope` being written anywhere.
 */
export function isColumnHeader(model: TableModel, index: number): boolean {
  const cell = model.cells[index];
  if (cell.kind !== 'th') return false;
  if (cell.scope === 'col') return true;
  if (cell.scope !== '') return false;
  for (let row = cell.row; row < cell.row + cell.rowSpan; row++) {
    for (let col = 0; col < model.columns; col++) {
      const other = model.grid[row]?.[col] ?? null;
      if (other !== null && model.cells[other].kind === 'td') return false;
    }
  }
  return true;
}

/**
 * A header cell of its row, per HTML.
 *
 * @remarks
 * The column test runs first, as it must.
 */
export function isRowHeader(model: TableModel, index: number): boolean {
  const cell = model.cells[index];
  if (cell.kind !== 'th') return false;
  if (cell.scope === 'row') return true;
  if (cell.scope !== '') return false;
  if (isColumnHeader(model, index)) return false;
  for (let col = cell.col; col < cell.col + cell.colSpan; col++) {
    for (let row = 0; row < model.rows; row++) {
      const other = model.grid[row]?.[col] ?? null;
      if (other !== null && model.cells[other].kind === 'td') return false;
    }
  }
  return true;
}

/** A header cell that declares `scope="colgroup"`. */
export const isColumnGroupHeader = (model: TableModel, index: number): boolean => model.cells[index].kind === 'th' && model.cells[index].scope === 'colgroup';

/** A header cell that declares `scope="rowgroup"`. */
export const isRowGroupHeader = (model: TableModel, index: number): boolean => model.cells[index].kind === 'th' && model.cells[index].scope === 'rowgroup';

/**
 * HTML's "internal algorithm for scanning and assigning header cells", for one starting slot and one direction.
 *
 * @remarks
 * `opaque headers` is the part that cannot be left out. Walking up a column, a run of header cells is a header block; the first data cell ends it and makes every header of that block opaque, so a *further* header above it at the same x and the same width is blocked — which is how a table with a second heading row halfway down stops its lower cells from being labelled by the top one.
 *
 * @param principal - The cell whose headers are being found.
 * @param dx - -1 for the row scan, 0 for the column scan.
 * @param dy - -1 for the column scan, 0 for the row scan.
 * @param out - Headers found are appended, nearest first, each once.
 */
function scan(model: TableModel, principal: number, startCol: number, startRow: number, dx: number, dy: number, out: number[]) {
  let col = startCol;
  let row = startRow;
  const opaque: number[] = [];
  let inHeaderBlock = model.cells[principal].kind === 'th';
  let fromBlock: number[] = inHeaderBlock ? [principal] : [];

  for (;;) {
    col += dx;
    row += dy;
    if (col < 0 || row < 0) return;
    const current = model.grid[row]?.[col] ?? null;
    if (current === null) continue;
    const cell = model.cells[current];
    if (cell.kind === 'th') {
      inHeaderBlock = true;
      fromBlock.push(current);
      let blocked = false;
      if (dx === 0) {
        if (opaque.some((i) => model.cells[i].col === cell.col && model.cells[i].colSpan === cell.colSpan)) blocked = true;
        if (!isColumnHeader(model, current)) blocked = true;
      }
      if (dy === 0) {
        if (opaque.some((i) => model.cells[i].row === cell.row && model.cells[i].rowSpan === cell.rowSpan)) blocked = true;
        if (!isRowHeader(model, current)) blocked = true;
      }
      if (!blocked && !out.includes(current)) out.push(current);
      continue;
    }
    if (inHeaderBlock) {
      inHeaderBlock = false;
      opaque.push(...fromBlock);
      fromBlock = [];
    }
  }
}

/** One data cell's headers, as the scans found them and in the order they are emitted. */
export type HeaderAssignment = {
  /** The data cell. */
  cell: number;
  /** Header cells found by the column scan and the column groups, nearest first. */
  columnHeaders: number[];
  /** Header cells found by the row scan and the row groups, nearest first. */
  rowHeaders: number[];
  /** The emitted order: column headers, then row headers, duplicates removed. */
  headers: number[];
  /** True when the `headers` attribute decided it and no scan was run. */
  explicit: boolean;
};

/**
 * The header cells of one data cell.
 *
 * @remarks
 * The `headers` attribute short-circuits everything, as HTML says it must: an author who has named the headers has said the geometry is not to be trusted, and case 4 of the fixture is exactly that — a cell labelled by a header outside any scan's path. Ids are resolved against this table only, and an id that names no cell of it is dropped rather than guessed at.
 */
export function headersOf(model: TableModel, index: number): HeaderAssignment {
  const principal = model.cells[index];
  const byId: Map<string,number> = new Map<any, any>();
  for (const cell of model.cells) if (cell.id !== '' && !byId.has(cell.id)) byId.set(cell.id, cell.index);

  const drop = (list: number[]): number[] => list.filter((i) => i !== index && !model.cells[i].empty).filter((i, at, all) => all.indexOf(i) === at);

  if (principal.headers.length > 0) {
    const named = (principal.headers.map((id) => byId.get(id)).filter((i) => i !== undefined) as number[]);
    const headers = drop(named);
    // The attribute's own order is the author's answer to "in what order does a reader hear these", so it is kept exactly; the two scan lists are then only a record of which of them the geometry would also have found.
    return {
      cell: index,
      columnHeaders: headers.filter((i) => isColumnHeader(model, i) || isColumnGroupHeader(model, i)),
      rowHeaders: headers.filter((i) => !(isColumnHeader(model, i) || isColumnGroupHeader(model, i))),
      headers,
      explicit: true,
    };
  }

  const columnScan: number[] = [];
  const rowScan: number[] = [];
  for (let row = principal.row; row < principal.row + principal.rowSpan; row++) {
    scan(model, index, principal.col, row, -1, 0, rowScan);
  }
  for (let col = principal.col; col < principal.col + principal.colSpan; col++) {
    scan(model, index, col, principal.row, 0, -1, columnScan);
  }

  const lastRow = principal.row + principal.rowSpan - 1;
  const lastCol = principal.col + principal.colSpan - 1;
  const groupRowHeaders = model.cells
    .filter((c) => isRowGroupHeader(model, c.index) && c.rowGroup === principal.rowGroup && c.col <= lastCol && c.row <= lastRow)
    .map((c) => c.index);
  const groupColumnHeaders = model.cells
    .filter(
      (c) =>
        isColumnGroupHeader(model, c.index) && c.colGroup >= 0 && c.colGroup === principal.colGroup && c.col <= lastCol && c.row <= lastRow,
    )
    .map((c) => c.index);

  const columnHeaders = drop([...columnScan, ...groupColumnHeaders]);
  const rowHeaders = drop([...rowScan, ...groupRowHeaders]).filter((i) => !columnHeaders.includes(i));
  return { cell: index, columnHeaders, rowHeaders, headers: [...columnHeaders, ...rowHeaders], explicit: false };
}

/** Every data cell's header assignment, in cell order. */
export function assignHeaders(model: TableModel): HeaderAssignment[] {
  return model.cells.filter((c) => c.kind === 'td').map((c) => headersOf(model, c.index));
}

/**
 * The `/Scope` a `TH` carries, per the mapping of `tables.md` (E11).
 *
 * @remarks
 * PDF 2.0 has three scope names and HTML has four states plus auto, so the two group states fold onto the axis they name — the group *extent* is carried by `/Headers`, which is why emitting `/Headers` even where `/Scope` would do is not redundancy. The auto state resolves the way a reader would read the table: a header in the head labels its column, a header opening a body row labels its row, and anything else is claimed for both rather than for neither.
 */
export function scopeNameOf(model: TableModel, index: number): 'Column'|'Row'|'Both' {
  const cell = model.cells[index];
  if (cell.scope === 'col' || cell.scope === 'colgroup') return 'Column';
  if (cell.scope === 'row' || cell.scope === 'rowgroup') return 'Row';
  if (cell.section === 'thead') return 'Column';
  if (cell.col === 0) return 'Row';
  return 'Both';
}

/** A cell by its DOM `id`, for a checker that wants to name one. */
export function cellById(model: TableModel, id: string): TableCell|undefined {
  return model.cells.find((c) => c.id === id);
}
