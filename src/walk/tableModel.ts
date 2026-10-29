/**
 * `walk/tableModel.js` — a table, or the fragments of one, as a grid of slots with every span expanded.
 *
 * Ported from `harness/src/export/tableModel.ts` in the `browser-to-pdf-experiments` repository (E11). Guide: `docs/guide/tables.md` §"The grid model", §"Fragmentation across pages".
 *
 * WHAT THE PORT CHANGED (PLAN.md P5). The two refusals are `CasterError`s, the overlap carrying the cell's DOM path as `{ element }`. The fragment contract below had no engine stamping it until *a table Paged.js cut across pages is one table in several fragments* (DESIGN.md S63): the Paged.js adapter now stamps `data-pdf-table` on the original and on each fragment of a table it cut (an author's own key wins), so a table Paged.js cut across pages reaches this module as the fragments it was written for.
 *
 * The harness's own header follows.
 *
 * The grid model of `tables.md` (E11): an HTML table, or a run of table fragments, as rows and columns with every span expanded.
 *
 * Everything E11 (`tables.md`) decides about a table is decided from this structure and not from the DOM: which cell is a header of which (`tableHeaders.js`), what `/Scope` a `TH` carries, which slots the emitted tree has to fill for the regularity check, and which grid edges the collapsed-border resolver has to paint. The DOM is read exactly once, here, so a question about a table is asked of one object rather than of the engine over and over.
 *
 * The model is a plain data structure with no DOM in it beyond an optional `element` per cell, which is what lets the header algorithm be unit-tested over hand-written tables in the node project — the tests that had to exist before the fixture did, because a header association that is only ever checked against the fixture it was written for is a tautology.
 *
 * Two things about the shape are those of `tables.md` (E11) rather than HTML's.
 *
 * **Fragments.** A table that crosses a page break is, in this engine contract, two or three real `<table>` elements sharing a `data-pdf-table` id, one per page element. They are one table here: the rows of every fragment go into one grid in fragment order, and a row group is merged across fragments by its section and its ordinal *within its own fragment*, so three continuation `<tbody>` elements are one `TBody` while two `<tbody>` elements on one page stay two. Rows the engine repeated for the reader's benefit — `thead` or `tr` carrying `data-pdf-repeat` — are not rows of the table at all; they are pagination artifacts, and they are skipped here so the grid is the logical table rather than the printed one.
 *
 * **Ragged rows.** HTML lets a row be short and the table model leaves the slots empty. PDF/UA-2's 8.2.5.26 t2–t4 do not: a row that covers fewer columns than the table has is a failure. Every hole is therefore filled with a synthetic empty `td`, anchored at the slot it fills and inserted into its row in column order, and a warning naming the row is recorded and printed. An overlap is the other way round — two cells claiming one slot is a table the author cannot have meant and no padding can repair — so it throws.
 *
 * @packageDocumentation
 */
import { CasterError } from '../errors.ts';

/** A cell's element kind: a header cell or a data cell. */
export type CellKind = 'th' | 'td';

/** The `scope` attribute as HTML defines its states; '' is the auto state. */
export type ScopeAttribute = '' | 'col' | 'row' | 'colgroup' | 'rowgroup';

/** The row group section a row belongs to. */
export type TableSection = 'thead' | 'tbody' | 'tfoot';

/** One cell of the grid, anchored at its top-left slot. */
export type TableCell = {
  /** Index into `TableModel.cells`, which is document order across fragments. */
  index: number;
  kind: CellKind;
  /** The DOM `id`, or ''. The `headers` attribute is resolved against it. */
  id: string;
  /** The `headers` attribute, split on whitespace. */
  headers: string[];
  scope: ScopeAttribute;
  rowSpan: number;
  colSpan: number;
  /** Row of the anchor slot. */
  row: number;
  /** Column of the anchor slot. */
  col: number;
  section: TableSection;
  /** Index into `TableModel.rowGroups`. */
  rowGroup: number;
  /** Index into `TableModel.colGroups`, or -1 when the table declares none. */
  colGroup: number;
  /** HTML's empty flag: the cell contains no elements and its text is only whitespace. The header algorithm drops empty header cells, because a blank corner cell is not a header of anything. */
  empty: boolean;
  /** True when the model invented the cell to fill a hole in a ragged row. */
  synthetic: boolean;
  /** Which fragment the cell came from; 0 for a table that is one element. */
  fragment: number;
  /** DOM path of the cell, for messages and the report. */
  domPath: string;
  /** Absent for a synthetic cell and in a hand-written model. */
  element?: HTMLElement;
};

/** One row group, merged across fragments by section and ordinal. */
export type TableRowGroup = {
  index: number;
  section: TableSection;
  /** First row of the group. */
  startRow: number;
  /** Last row of the group, inclusive. */
  endRow: number;
  /** The `<thead>`/`<tbody>`/`<tfoot>` elements it was built from, in order. */
  elements: HTMLElement[];
};

/** One column group, as a range of columns. */
export type TableColGroup = {
  index: number;
  startCol: number;
  /** Inclusive. */
  endCol: number;
};

/** One row of the grid, or a repeated row that is not one. */
export type TableRow = {
  index: number;
  section: TableSection;
  rowGroup: number;
  fragment: number;
  /** Cells anchored in this row, in column order, synthetic ones included. */
  cells: number[];
  /** True when the row's cells are painted as a pagination artifact instead. */
  repeated: boolean;
  domPath: string;
  element?: HTMLElement;
};

/** The logical table: the grid, its cells, rows and groups, and what building it recorded. */
export type TableModel = {
  /** `data-pdf-table` when the table declares one, else the first element's DOM path. */
  key: string;
  rows: number;
  columns: number;
  /** `grid[row][col]` is a cell index or null; null survives only before padding. */
  grid: (number | null)[][];
  cells: TableCell[];
  rowList: TableRow[];
  rowGroups: TableRowGroup[];
  colGroups: TableColGroup[];
  /** Ragged rows padded, non-solid collapsed borders, and anything else recorded. */
  warnings: string[];
  /** The fragment elements in DOM order. Empty for a hand-written model. */
  fragments: HTMLElement[];
};

/** The attribute a table fragment names its whole table with. */
export const TABLE_FRAGMENT_ATTRIBUTE = 'data-pdf-table';

/** The attribute a repeated header row carries. */
export const TABLE_REPEAT_ATTRIBUTE = 'data-pdf-repeat';

/** The `scope` keywords HTML defines; anything else is the auto state. */
const SCOPES: Set<string> = new Set(['col', 'row', 'colgroup', 'rowgroup']);

/** A cell's `scope` attribute, normalised to one of HTML's states. */
function scopeOf(cell: Element): ScopeAttribute {
  const raw = (cell.getAttribute('scope') ?? '').trim().toLowerCase();
  return SCOPES.has(raw) ? (raw as ScopeAttribute) : '';
}

/** HTML's empty-cell flag: no element children and only whitespace text. */
export function isEmptyCell(cell: Element): boolean {
  if (cell.children.length > 0) return false;
  return (cell.textContent ?? '').trim() === '';
}

/** Whether an element declares itself a repeated header row or row group. */
export function isRepeated(element: Element): boolean {
  return (element.getAttribute(TABLE_REPEAT_ATTRIBUTE) ?? '').trim() !== '';
}

/** The row groups of one fragment, in DOM order, with their rows. */
export type RawGroup = {
  section: TableSection;
  /** Ordinal of the group among the groups of its section in its own fragment. */
  ordinal: number;
  element: HTMLElement;
  rows: HTMLTableRowElement[];
  repeated: boolean;
};

/**
 * The row groups a fragment declares.
 *
 * @remarks
 * A `<tr>` that is a direct child of the table belongs to the implicit body, and HTML's parser has already put it in a `<tbody>` for us; the fallback is here because a fragment assembled by script need not have been parsed that way.
 */
function groupsOf(fragment: HTMLElement): RawGroup[] {
  const groups: RawGroup[] = [];
  const counts: Record<TableSection,number> = { thead: 0, tbody: 0, tfoot: 0 };
  const loose: HTMLTableRowElement[] = [];
  for (const child of fragment.children) {
    const tag = child.tagName.toLowerCase();
    if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
      const section = (tag as TableSection);
      groups.push({
        section,
        ordinal: counts[section]++,
        element: (child as HTMLElement),
        rows: ([...child.children].filter((r) => r.tagName === 'TR') as HTMLTableRowElement[]),
        repeated: isRepeated(child),
      });
      continue;
    }
    if (tag === 'tr') loose.push((child as HTMLTableRowElement));
  }
  if (loose.length > 0) {
    groups.push({ section: 'tbody', ordinal: counts.tbody++, element: fragment, rows: loose, repeated: false });
  }
  return groups;
}

/** The column groups a fragment declares, from `<colgroup>` and `<col>` spans. */
function colGroupsOf(fragment: HTMLElement): { startCol: number; endCol: number; }[] {
  const out: { startCol: number; endCol: number; }[] = [];
  let col = 0;
  for (const child of fragment.children) {
    if (child.tagName !== 'COLGROUP') continue;
    const cols = [...child.children].filter((c) => c.tagName === 'COL');
    let span = 0;
    if (cols.length === 0) span = Math.max(1, Number(child.getAttribute('span') ?? '1') || 1);
    else for (const c of cols) span += Math.max(1, Number(c.getAttribute('span') ?? '1') || 1);
    out.push({ startCol: col, endCol: col + span - 1 });
    col += span;
  }
  return out;
}

/**
 * Build the grid of one table, or of a run of fragments that share a `data-pdf-table` id.
 *
 * @param fragments - In DOM order; the first one's key, `<colgroup>`s and DOM path stand for the table.
 * @param describe - Names an element for a message and for the report; the walker passes its own `domPathOf` so a warning about a ragged row names the row the same way every other message in the exporter names an element.
 * @throws {CasterError} No fragments at all; two cells covering one slot (PDF/UA-2 8.2.5.26 t1).
 */
export function buildTableModel(fragments: HTMLElement[], describe: (element: Element) => string): TableModel {
  if (fragments.length === 0) throw new CasterError('tableModel: buildTableModel was given no table elements');

  const cells: TableCell[] = [];
  const rowList: TableRow[] = [];
  const grid: (number|null)[][] = [];
  const warnings: string[] = [];
  const rowGroups: TableRowGroup[] = [];
  const groupKeys: Map<string,number> = new Map<any, any>();

  const ensureRow = (row: number) => {
    while (grid.length <= row) grid.push([]);
  };
  const at = (row: number, col: number): number|null => grid[row]?.[col] ?? null;
  const put = (row: number, col: number, index: number) => {
    ensureRow(row);
    while (grid[row].length <= col) grid[row].push(null);
    grid[row][col] = index;
  };

  let rowIndex = 0;

  for (const [fragment, table] of fragments.entries()) {
    for (const group of groupsOf(table)) {
      const key = `${group.section}#${group.ordinal}`;
      let groupIndex = groupKeys.get(key);
      if (groupIndex === undefined) {
        groupIndex = rowGroups.length;
        groupKeys.set(key, groupIndex);
        rowGroups.push({ index: groupIndex, section: group.section, startRow: rowIndex, endRow: rowIndex - 1, elements: [] });
      }
      rowGroups[groupIndex].elements.push(group.element);

      for (const tr of group.rows) {
        const repeated = group.repeated || isRepeated(tr);
        if (repeated) {
          // A repeated head row is ink on a continuation page and nothing else: it is not a row of the table, so it never reaches the grid, the header algorithm or the regularity check.
          rowList.push({
            index: -1,
            section: group.section,
            rowGroup: groupIndex,
            fragment,
            cells: [],
            repeated: true,
            domPath: describe(tr),
            element: tr,
          });
          continue;
        }
        const row = rowIndex++;
        ensureRow(row);
        const record: TableRow = {
          index: row,
          section: group.section,
          rowGroup: groupIndex,
          fragment,
          cells: [],
          repeated: false,
          domPath: describe(tr),
          element: tr,
        };
        rowList.push(record);
        rowGroups[groupIndex].endRow = row;

        let col = 0;
        for (const child of tr.children) {
          const tag = child.tagName;
          if (tag !== 'TH' && tag !== 'TD') continue;
          while (at(row, col) !== null) col += 1;
          const element = (child as HTMLElement);
          const rowSpan = Math.max(1, Number(element.getAttribute('rowspan') ?? '1') || 1);
          const colSpan = Math.max(1, Number(element.getAttribute('colspan') ?? '1') || 1);
          const index = cells.length;
          const cell: TableCell = {
            index,
            kind: tag === 'TH' ? 'th' : 'td',
            id: (element.getAttribute('id') ?? '').trim(),
            headers: (element.getAttribute('headers') ?? '').trim().split(/\s+/u).filter((t) => t !== ''),
            scope: scopeOf(element),
            rowSpan,
            colSpan,
            row,
            col,
            section: group.section,
            rowGroup: groupIndex,
            colGroup: -1,
            empty: isEmptyCell(element),
            synthetic: false,
            fragment,
            domPath: describe(element),
            element,
          };
          cells.push(cell);
          record.cells.push(index);
          for (let dr = 0; dr < rowSpan; dr++) {
            for (let dc = 0; dc < colSpan; dc++) {
              const taken = at(row + dr, col + dc);
              if (taken !== null) {
                throw new CasterError(
                  `tableModel: the cell at ${cell.domPath} covers slot (${row + dr}, ${col + dc}), which ${cells[taken].domPath} already covers; intersecting cells are a PDF/UA-2 failure (8.2.5.26 t1) and no padding can repair them`,
                  { element: cell.domPath },
                );
              }
              put(row + dr, col + dc, index);
            }
          }
          col += colSpan;
        }
      }
    }
  }

  const rows = grid.length;
  const columns = Math.max(0, ...grid.map((r) => r.length));
  for (const row of grid) while (row.length < columns) row.push(null);

  // Ragged rows: one synthetic empty `td` per hole, inserted into the row in column order so the reading order of the emitted TR is still left to right.
  for (let row = 0; row < rows; row++) {
    const holes: number[] = [];
    for (let col = 0; col < columns; col++) if (grid[row][col] === null) holes.push(col);
    if (holes.length === 0) continue;
    const record = (rowList.find((r) => r.index === row) as TableRow);
    for (const col of holes) {
      const index = cells.length;
      cells.push({
        index,
        kind: 'td',
        id: '',
        headers: [],
        scope: '',
        rowSpan: 1,
        colSpan: 1,
        row,
        col,
        section: record.section,
        rowGroup: record.rowGroup,
        colGroup: -1,
        empty: true,
        synthetic: true,
        fragment: record.fragment,
        domPath: `${record.domPath}/td[pad ${col}]`,
      });
      grid[row][col] = index;
      record.cells.push(index);
    }
    record.cells.sort((a, b) => cells[a].col - cells[b].col);
    warnings.push(
      `row ${row} (${record.domPath}) covers ${columns - holes.length} of ${columns} columns; ${holes.length} empty TD${holes.length === 1 ? ' was' : 's were'} added at column${holes.length === 1 ? '' : 's'} ${holes.join(', ')} to make the table rectangular`,
    );
  }

  const colGroups: TableColGroup[] = colGroupsOf(fragments[0]).map((g, index) => ({ index, ...g }));
  for (const cell of cells) {
    cell.colGroup = colGroups.findIndex((g) => cell.col >= g.startCol && cell.col <= g.endCol);
  }

  const key = (fragments[0].getAttribute(TABLE_FRAGMENT_ATTRIBUTE) ?? '').trim() || describe(fragments[0]);

  return { key, rows, columns, grid, cells, rowList, rowGroups, colGroups, warnings, fragments };
}

/**
 * Whether every slot of the grid is covered exactly once.
 *
 * @remarks
 * Called on the model the walker built and, in the node checker, on a grid rebuilt from the emitted tree: the same function over the same shape, so the claim "the tree is as regular as the DOM was" is one comparison rather than two implementations of rectangularity.
 */
export function regularityOf(grid: (number|null)[][]): { rectangular: boolean; rows: number; columns: number; missing: [number,number][]; } {
  const rows = grid.length;
  const columns = Math.max(0, ...grid.map((r) => r.length));
  const missing: [number,number][] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) if ((grid[row]?.[col] ?? null) === null) missing.push([row, col]);
  }
  return { rectangular: missing.length === 0 && rows > 0 && columns > 0, rows, columns, missing };
}
