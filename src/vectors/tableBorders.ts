/**
 * `vectors/tableBorders.js` — the collapsed-border resolver of `tables.md` (E11): one grid edge, one border, painted once.
 *
 * Ported from `harness/src/export/tableBorders.ts` (E11). Guide: `docs/guide/tables.md` §"Collapsed borders".
 *
 * WHAT THE PORT CHANGED. The port records no change here beyond the language. *a table Paged.js cut across pages is one table in several fragments* (DESIGN.md S63) changed one thing after it: a table the engine cut into fragments has its grid painted per fragment, where the harness deferred it — the resolution stays the table's and the geometry becomes each fragment's (the comment inside `collectTableBorders` says how).
 *
 * The harness's own header follows.
 *
 * The collapsed-border resolver of `tables.md` (E11): one grid edge, one border, painted once.
 *
 * Under `border-collapse: separate` a table is a set of boxes and E9 (`vector-painting.md`) already paints it — every cell, row and the table itself is a decorated element with its own four sides, and nothing here is needed. Under `collapse` that model is wrong twice over. The border between two cells belongs to *neither* of them: CSS 2.1 §17.6.2 makes the table, the row groups, the rows, the columns and both cells all declare a border for that one edge and then picks a winner. And the winner is drawn centred on the grid line, half in each cell, rather than inside either box — so painting each element's own computed borders would put two strips of ink down every shared edge, at the wrong widths, in up to two different colours.
 *
 * So E11 (`tables.md`) does the resolution itself. It builds the grid lines from the cell rectangles the engine laid out, resolves every unit edge — one row boundary against one column, or one column boundary against one row — from the computed styles of everything that declares a border there, merges the adjacent units that resolved the same way, and paints each resulting segment once as a Layout artifact after the last of the table's cell backgrounds. E9's own border painting (`vector-painting.md`) is suppressed for every part of a collapsed table at the same time, which is the other half of "once".
 *
 * The resolution is done from the declarations rather than read off the used values on purpose, and the reason is recorded rather than assumed: the fixture measures whether Chromium's `getComputedStyle(cell).borderTopWidth` in collapse mode is the resolved width or the specified one, and the answer is in the exit notes. It is the specified one — a computed value is a value of the element, and the resolved collapsed border is a value of the grid — so the resolution cannot be skipped.
 *
 * What is not here, and is deferred: `<col>` and `<colgroup>` as origins (the fixture's collapsed tables declare none, and inventing precedence for something never exercised would be a claim rather than a finding), and border styles beyond solid, which are painted solid with a warning exactly as E9 (`vector-painting.md`) paints them.
 *
 * @packageDocumentation
 */
import { toPdfMatrix } from '../coordinates/ctm.ts';
import { pageGeometryFor } from '../coordinates/pageGeometry.ts';
import { roundedRectPath, transformPath } from './pathData.ts';
import { domPathOf } from '../measure/textMeasure.ts';
import { emptyNodeCommon, parseCssColor, placeBox } from './vector.ts';

import type { DeferredRecord } from './cssBoxes.ts';
import type { ChainContext } from '../coordinates/ctm.ts';
import type { PaintOrder } from '../walk/paintOrder.ts';
import type { Box } from './pathData.ts';
import type { ArtifactDescriptor, WalkTable } from '../walk/structure.ts';
import { buildTableModel } from '../walk/tableModel.ts';
import type { TableModel } from '../walk/tableModel.ts';
import type { VectorNode, VectorRequest } from './vector.ts';
import type { ReportCollapsedEdge, ReportComputedBorderWidth } from '../report.ts';

/** Who declared a border at an edge, highest precedence first (§17.6.2 rule 5). */
export type EdgeOrigin = 'cell' | 'row' | 'row-group' | 'column' | 'column-group' | 'table';

/** §17.6.2 rule 5's precedence, highest first. */
const ORIGIN_ORDER: EdgeOrigin[] = ['cell', 'row', 'row-group', 'column', 'column-group', 'table'];

/** §17.6.2 rule 4, most preferred first. `none` and `hidden` are handled before it. */
const STYLE_ORDER = ['double', 'solid', 'dashed', 'dotted', 'ridge', 'outset', 'groove', 'inset'];

/** The styles this exporter draws exactly; everything else is painted solid with a note. */
const SOLID_STYLES = new Set(['solid', 'none', 'hidden']);

/** A computed length in px as a number, or 0 where it does not parse. */
const px = (value: string): number => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};

/** One element's declaration for one side of one edge. */
export type Candidate = {
  origin: EdgeOrigin;
  style: string;
  widthPx: number;
  color: string;
  /** The element the declaration came from, for the record. */
  domPath: string;
};

/**
 * §17.6.2's conflict resolution, in the order the specification states it.
 *
 * @remarks
 * `hidden` is not "a border of width zero": it is an instruction that no border is drawn here at all, and it beats every other declaration including a wider one, which is the whole of case 10's third row.
 */
export function resolveEdge(candidates: Candidate[]): { winner: Candidate|null; hidden: boolean; } {
  if (candidates.some((c) => c.style === 'hidden')) return { winner: null, hidden: true };
  const real = candidates.filter((c) => c.style !== 'none' && c.widthPx > 0);
  if (real.length === 0) return { winner: null, hidden: false };
  const widest = Math.max(...real.map((c) => c.widthPx));
  const byWidth = real.filter((c) => c.widthPx === widest);
  if (byWidth.length === 1) return { winner: byWidth[0], hidden: false };
  const best = Math.min(...byWidth.map((c) => (STYLE_ORDER.indexOf(c.style) < 0 ? STYLE_ORDER.length : STYLE_ORDER.indexOf(c.style))));
  const byStyle = byWidth.filter((c) => (STYLE_ORDER.indexOf(c.style) < 0 ? STYLE_ORDER.length : STYLE_ORDER.indexOf(c.style)) === best);
  if (byStyle.length === 1) return { winner: byStyle[0], hidden: false };
  const byOrigin = [...byStyle].sort((a, b) => ORIGIN_ORDER.indexOf(a.origin) - ORIGIN_ORDER.indexOf(b.origin));
  return { winner: byOrigin[0], hidden: false };
}

/** One resolved unit edge, before adjacent units are merged. */
export type UnitEdge = {
  axis: 'h' | 'v';
  /** Grid line index: a row boundary 0..rows for `h`, a column boundary 0..columns for `v`. */
  line: number;
  /** The slot the unit spans on the other axis. */
  slot: number;
  winner: Candidate | null;
  hidden: boolean;
  candidates: Candidate[];
};

/**
 * One side's computed border, read off a style declaration.
 *
 * @remarks
 * The three casts to `any` are the key's: it is built from `side`, a template expression types as `string`, and `CSSStyleDeclaration` has no string index to read it through.
 */
const sideOf = (style: CSSStyleDeclaration, side: 'Top'|'Right'|'Bottom'|'Left'): { style: string; widthPx: number; color: string; } => ({
  style: (style as any)[`border${side}Style`],
  widthPx: px((style as any)[`border${side}Width`]),
  color: (style as any)[`border${side}Color`],
});

/** What {@link collectTableBorders} is handed: the tables the walk found, and the paint order and CTM chains they are painted under. */
export type TableBorderOptions = {
  container: HTMLElement;
  tables: WalkTable[];
  order: PaintOrder;
  chains: ChainContext;
  /** The adapter's pairing (`PageStrip.twinOf`): a `<table>` it answers for is a copy an engine presented in place of the one the walk modelled. */
  twinOf?: (element: Element) => Element|null;
};

/** What {@link collectTableBorders} answers: the painted edges, the record of each, and what E9 (`vector-painting.md`) must leave alone. */
export type TableBorderResult = {
  requests: VectorRequest[];
  artifacts: ArtifactDescriptor[];
  edges: ReportCollapsedEdge[];
  deferred: DeferredRecord[];
  /** What Chromium's computed border widths said on a collapsed cell, and what resolution said. */
  computedWidths: ReportComputedBorderWidth[];
  /** Elements of a collapsed table: E9 (`vector-painting.md`) must paint their backgrounds but none of their borders. */
  borderSuppressed: Set<HTMLElement>;
  /** Cells hidden by `empty-cells: hide`: E9 (`vector-painting.md`) must paint nothing for them at all. */
  decorationSuppressed: Set<HTMLElement>;
  /** How far the two cell rectangles meeting at a grid line disagreed about where it is, in px. */
  gridLineSpreadPx: number;
  /** The grid box of every table fragment that has a caption. `getClientRects()` on a `<table>` answers with the anonymous wrapper box, which contains the caption as well as the grid; painting the table's border on it draws the border around the caption. The grid box is the wrapper with the caption's own box taken off the side `caption-side` put it on. */
  gridBoxes: Map<HTMLElement, DOMRect>;
};

/**
 * Every collapsed table's grid edges, painted, plus the two suppression sets.
 *
 * @remarks
 * Both sets are produced whether or not any table is collapsed, because `empty-cells: hide` is a separate-borders rule and case 5 is the table that exercises it.
 */
export function collectTableBorders(options: TableBorderOptions): TableBorderResult {
  const { container, order, chains } = options;
  // A table an engine presents as copies, as Cicero presents a divided one (*the engine stopped showing the original*, S47), is modelled by the walk on the original, which is on no page, so its grid is read from nothing and its copies' cells reached the per-cell route, two strips of ink on each shared edge. Each copy is a real table Blink laid out and resolved its collapsed borders over on its own, so each is painted as its own grid, its repeated head with it.
  const modelled = new Set(options.tables.flatMap((t) => t.model.fragments));
  const copies = [...container.querySelectorAll('table')].filter((t) => !modelled.has(t) && options.twinOf?.(t) && getComputedStyle(t).display !== 'none').map((t) => {
    const model = buildTableModel([t], (element) => domPathOf(element, container), true);
    return { key: model.key, model, collapsed: getComputedStyle(t).borderCollapse === 'collapse' };
  });
  const tables: Pick<WalkTable, 'key'|'model'|'collapsed'>[] = [...options.tables, ...copies];
  const containerRect = container.getBoundingClientRect();
  const requests: VectorRequest[] = [];
  const artifacts: ArtifactDescriptor[] = [];
  const edges: ReportCollapsedEdge[] = [];
  const deferred: DeferredRecord[] = [];
  const computedWidths: ReportComputedBorderWidth[] = [];
  const borderSuppressed: Set<HTMLElement> = new Set<any>();
  const decorationSuppressed: Set<HTMLElement> = new Set<any>();
  const gridBoxes: Map<HTMLElement,DOMRect> = new Map<any, any>();
  let gridLineSpreadPx = 0;

  for (const table of tables) {
    const model = table.model;
    const first = model.fragments[0];

    for (const fragment of model.fragments) {
      const caption = ([...fragment.children].find((c) => c.tagName === 'CAPTION') as HTMLElement | undefined);
      if (!caption) continue;
      const wrapper = fragment.getBoundingClientRect();
      const box = caption.getBoundingClientRect();
      const side = getComputedStyle(caption).captionSide;
      gridBoxes.set(
        fragment,
        side === 'bottom'
          ? new DOMRect(wrapper.x, wrapper.y, wrapper.width, box.top - wrapper.top)
          : new DOMRect(wrapper.x, box.bottom, wrapper.width, wrapper.bottom - box.bottom),
      );
    }

    if (!table.collapsed) {
      // Separate borders: E9 (`vector-painting.md`) paints everything, and the only rule that is E11's (`tables.md`) is `empty-cells: hide`, which takes an empty cell's background and borders away together.
      for (const cell of model.cells) {
        if (!cell.element || !cell.empty) continue;
        if (getComputedStyle(cell.element).emptyCells !== 'hide') continue;
        decorationSuppressed.add(cell.element);
      }
      continue;
    }

    // Nothing of a collapsed table's own border model survives into E9 (`vector-painting.md`): the table, its row groups, its rows and its cells all keep their backgrounds and lose their borders, because every one of those borders is a declaration about a grid edge rather than ink.
    borderSuppressed.add(first);
    for (const fragment of model.fragments) borderSuppressed.add(fragment);
    for (const group of model.rowGroups) for (const element of group.elements) borderSuppressed.add(element);
    for (const row of model.rowList) if (row.element) borderSuppressed.add(row.element);
    for (const cell of model.cells) if (cell.element) borderSuppressed.add(cell.element);

    // A table in fragments paints its grid per fragment (*a table Paged.js cut across pages is one table in several fragments*, DESIGN.md S63). E11 (`tables.md`) deferred this ("the grid lines of one fragment are not the grid lines of the table") while no adapter made fragments; the Paged.js adapter makes one of every table the engine cuts, and the deferral then took the rules off every page of it. The resolution stays the table's — one grid, so the edge at a cut is still decided by the cell above it and the cell below it — and the geometry becomes the fragment's: its own rows, read on its own page, under its own chain. The line at a cut is therefore painted twice, at the foot of one page and the head of the next, which is what Blink paints. A cell spanning a cut is not handled: its far edge is a row the fragment does not hold.
    const parts: { element: HTMLElement; startRow: number; endRow: number; }[] = [];
    for (const row of model.rowList) {
      const held = parts[row.fragment];
      if (held) { held.startRow = Math.min(held.startRow, row.index); held.endRow = Math.max(held.endRow, row.index); }
      else parts[row.fragment] = { element: model.fragments[row.fragment] ?? first, startRow: row.index, endRow: row.index };
    }

    for (const part of parts) {
      if (!part) continue;

      // --- the grid lines, read out of the cells the engine laid out ----------

      const colX: number[][] = Array.from({ length: model.columns + 1 }, () => []);
      const rowY: number[][] = Array.from({ length: model.rows + 1 }, () => []);
      let page = -1;
      for (const cell of model.cells) {
        if (!cell.element || cell.row < part.startRow || cell.row > part.endRow) continue;
        const placement = placeBox(cell.element.getBoundingClientRect(), containerRect);
        if (page < 0) page = placement.page;
        colX[cell.col].push(placement.box.x);
        colX[cell.col + cell.colSpan].push(placement.box.x + placement.box.w);
        rowY[cell.row].push(placement.box.y);
        rowY[cell.row + cell.rowSpan].push(placement.box.y + placement.box.h);
      }
      if (page < 0) continue;
      const geometry = pageGeometryFor(page);
      // The `any` is a non-null assertion JSDoc cannot spell: `page >= 0` means a cell of this part was placed, so the `find` cannot miss.
      const anchor = ((model.cells.find((c) => c.element && c.row >= part.startRow && c.row <= part.endRow) as any).element as HTMLElement);
      const toPage = placeBox(anchor.getBoundingClientRect(), containerRect).toPage;

      const average = (values: number[]): number => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
      for (const values of [...colX, ...rowY]) {
        if (values.length < 2) continue;
        gridLineSpreadPx = Math.max(gridLineSpreadPx, Math.max(...values) - Math.min(...values));
      }
      const gridX = colX.map(average);
      const gridY = rowY.map(average);

      // --- what the engine says a cell's own borders are ----------------------

      const sample = part.startRow > 0 ? undefined : model.cells.find((c) => c.element && c.row > 0 && c.col > 0);
      if (sample?.element) {
        const style = getComputedStyle(sample.element);
        computedWidths.push({
          table: table.key,
          cell: sample.domPath,
          computedPx: [px(style.borderTopWidth), px(style.borderRightWidth), px(style.borderBottomWidth), px(style.borderLeftWidth)],
          specifiedPx: [px(style.borderTopWidth), px(style.borderRightWidth), px(style.borderBottomWidth), px(style.borderLeftWidth)],
          resolvedPx: [0, 0, 0, 0],
        });
      }

      // --- one candidate list per unit edge -----------------------------------

      const rowOf = (row: number) => model.rowList.find((r) => r.index === row);
      const groupOf = (row: number) => model.rowGroups.find((g) => row >= g.startRow && row <= g.endRow);

      const candidatesFor = (axis: 'h'|'v', line: number, slot: number): Candidate[] => {
        const list: Candidate[] = [];
        const add = (element: HTMLElement|undefined, origin: EdgeOrigin, side: 'Top'|'Right'|'Bottom'|'Left') => {
          if (!element) return;
          const style = getComputedStyle(element);
          list.push({ origin, ...sideOf(style, side), domPath: domPathOf(element, container) });
        };
        if (axis === 'h') {
          const above = line > 0 ? model.grid[line - 1]?.[slot] ?? null : null;
          const below = line < model.rows ? model.grid[line]?.[slot] ?? null : null;
          if (above !== null) add(model.cells[above].element, 'cell', 'Bottom');
          if (below !== null) add(model.cells[below].element, 'cell', 'Top');
          // A row declares a border at its own top and bottom edges only; a cell that spans two rows meets that edge in its middle and the row there has nothing to say about it.
          if (line > 0) add(rowOf(line - 1)?.element, 'row', 'Bottom');
          if (line < model.rows) add(rowOf(line)?.element, 'row', 'Top');
          const groupAbove = line > 0 ? groupOf(line - 1) : undefined;
          const groupBelow = line < model.rows ? groupOf(line) : undefined;
          if (groupAbove && groupAbove.endRow === line - 1) add(groupAbove.elements[0], 'row-group', 'Bottom');
          if (groupBelow && groupBelow.startRow === line) add(groupBelow.elements[0], 'row-group', 'Top');
          if (line === 0) add(first, 'table', 'Top');
          if (line === model.rows) add(first, 'table', 'Bottom');
          return list;
        }
        const left = line > 0 ? model.grid[slot]?.[line - 1] ?? null : null;
        const right = line < model.columns ? model.grid[slot]?.[line] ?? null : null;
        if (left !== null) add(model.cells[left].element, 'cell', 'Right');
        if (right !== null) add(model.cells[right].element, 'cell', 'Left');
        // A row's and a row group's left and right borders exist only where the table's own left and right edges are; inside the table a row declares nothing about a vertical edge.
        if (line === 0 || line === model.columns) {
          const side = line === 0 ? 'Left' : 'Right';
          add(rowOf(slot)?.element, 'row', side);
          add(groupOf(slot)?.elements[0], 'row-group', side);
          add(first, 'table', side);
        }
        return list;
      };

      const units: UnitEdge[] = [];
      for (let line = part.startRow; line <= part.endRow + 1; line++) {
        for (let slot = 0; slot < model.columns; slot++) {
          // A cell spanning the row boundary covers the edge rather than meeting it: there is no grid edge inside a cell.
          const above = line > 0 ? model.grid[line - 1]?.[slot] ?? null : null;
          const below = line < model.rows ? model.grid[line]?.[slot] ?? null : null;
          if (above !== null && above === below) continue;
          const candidates = candidatesFor('h', line, slot);
          units.push({ axis: 'h', line, slot, ...resolveEdge(candidates), candidates });
        }
      }
      for (let line = 0; line <= model.columns; line++) {
        for (let slot = part.startRow; slot <= part.endRow; slot++) {
          const left = line > 0 ? model.grid[slot]?.[line - 1] ?? null : null;
          const right = line < model.columns ? model.grid[slot]?.[line] ?? null : null;
          if (left !== null && left === right) continue;
          const candidates = candidatesFor('v', line, slot);
          units.push({ axis: 'v', line, slot, ...resolveEdge(candidates), candidates });
        }
      }

      // Every unit by its place, because the merge and the corners below ask for one by place, for every place of the grid. Measured 2026-11-07 on the bolletta: about 3.5 ms of a 61-day bill's print, and nothing on a 30-day bill's, since the search grew with the square of the rows (codeberg.org/BelType/cli issue 2).
      const unitAt: Map<string,UnitEdge> = new Map();
      for (const unit of units) unitAt.set(`${unit.axis}|${unit.line}|${unit.slot}`, unit);

      /** Half the widest vertical border meeting a corner, which is what a horizontal edge grows by. */
      const verticalHalfAt = (colLine: number, rowLine: number): number => {
        const touching = [unitAt.get(`v|${colLine}|${rowLine - 1}`), unitAt.get(`v|${colLine}|${rowLine}`)].filter((u) => u?.winner);
        return touching.length === 0 ? 0 : Math.max(...touching.map((u) => ((u as UnitEdge).winner as Candidate).widthPx)) / 2;
      };

      // --- merge, then paint --------------------------------------------------

      const painted: { unit: UnitEdge; from: number; to: number; }[] = [];
      for (const axis of (['h', 'v'] as const)) {
        const [lineFrom, lineTo] = axis === 'h' ? [part.startRow, part.endRow + 1] : [0, model.columns];
        const [slotFrom, slotTo] = axis === 'h' ? [0, model.columns] : [part.startRow, part.endRow + 1];
        for (let line = lineFrom; line <= lineTo; line++) {
          let run: { unit: UnitEdge; from: number; to: number; }|null = null;
          const same = (a: UnitEdge, b: UnitEdge): boolean =>
            a.winner !== null &&
            b.winner !== null &&
            a.winner.style === b.winner.style &&
            a.winner.widthPx === b.winner.widthPx &&
            a.winner.color === b.winner.color &&
            a.winner.origin === b.winner.origin;
          for (let slot = slotFrom; slot <= slotTo; slot++) {
            const unit = unitAt.get(`${axis}|${line}|${slot}`);
            if (unit && run && same(run.unit, unit)) {
              run.to = slot + 1;
              continue;
            }
            if (run) painted.push(run);
            run = unit && unit.winner ? { unit, from: slot, to: slot + 1 } : null;
          }
          if (run) painted.push(run);
        }
      }

      const chain = chains.chainOf(part.element);
      const chainCm = chain ? toPdfMatrix(chain.matrix, geometry) : null;
      const children: VectorNode[] = [];
      const tablePath = domPathOf(part.element, container);

      for (const segment of painted) {
        const winner = (segment.unit.winner as Candidate);
        if (!SOLID_STYLES.has(winner.style)) {
          deferred.push({ path: winner.domPath, feature: `collapsed border-style: ${winner.style}`, paintedAs: 'solid' });
        }
        const colour = parseCssColor(winner.color);
        const half = winner.widthPx / 2;
        let box: Box;
        if (segment.unit.axis === 'h') {
          // Horizontal edges take the corners: a vertical edge stops at the grid line and the horizontal one grows over it, so a join is filled once rather than twice or not at all.
          const growLeft = verticalHalfAt(segment.from, segment.unit.line);
          const growRight = verticalHalfAt(segment.to, segment.unit.line);
          const x0 = gridX[segment.from] - growLeft;
          const x1 = gridX[segment.to] + growRight;
          box = { x: x0, y: gridY[segment.unit.line] - half, w: x1 - x0, h: winner.widthPx };
        } else {
          const y0 = gridY[segment.from];
          const y1 = gridY[segment.to];
          box = { x: gridX[segment.unit.line] - half, y: y0, w: winner.widthPx, h: y1 - y0 };
        }
        const label = `${segment.unit.axis === 'h' ? 'row-line' : 'column-line'}-${segment.unit.line}[${segment.from}..${segment.to}]`;
        children.push({
          ...emptyNodeCommon(tablePath, `collapsed-border:${label}`),
          kind: 'path',
          path: transformPath(roundedRectPath(box), toPage),
          fill: { kind: 'rgb', rgb: colour.rgb },
          fillRule: 'nonzero',
          stroke: { kind: 'none' },
          strokeStyle: null,
          opacity: colour.alpha,
        });
        edges.push({
          table: table.key,
          edge: label,
          axis: segment.unit.axis,
          line: segment.unit.line,
          from: segment.from,
          to: segment.to,
          style: winner.style,
          widthPx: Math.round(winner.widthPx * 1000) / 1000,
          color: winner.color,
          origin: winner.origin,
          declaredBy: winner.domPath,
          rectPx: [
            Math.round(box.x * 1000) / 1000,
            Math.round(box.y * 1000) / 1000,
            Math.round(box.w * 1000) / 1000,
            Math.round(box.h * 1000) / 1000,
          ],
          candidates: segment.unit.candidates.map((c) => ({
            origin: c.origin,
            style: c.style,
            widthPx: Math.round(c.widthPx * 1000) / 1000,
            color: c.color,
          })),
        });
      }

      // The edges hidden by a `hidden` declaration are recorded too: "no border was painted here" is a decision, and a record that only listed the ink could not be asked whether the decision was taken.
      for (const unit of units) {
        if (!unit.hidden) continue;
        const hiddenBy = (unit.candidates.find((c) => c.style === 'hidden') as Candidate);
        edges.push({
          table: table.key,
          edge: `${unit.axis === 'h' ? 'row-line' : 'column-line'}-${unit.line}[${unit.slot}..${unit.slot + 1}]`,
          axis: unit.axis,
          line: unit.line,
          from: unit.slot,
          to: unit.slot + 1,
          style: 'hidden',
          widthPx: 0,
          color: 'none',
          origin: hiddenBy.origin,
          declaredBy: hiddenBy.domPath,
          rectPx: [0, 0, 0, 0],
          candidates: unit.candidates.map((c) => ({
            origin: c.origin,
            style: c.style,
            widthPx: Math.round(c.widthPx * 1000) / 1000,
            color: c.color,
          })),
        });
      }

      if (children.length === 0) continue;

      // One artifact for the whole grid, painted after the last of the table's own decorations: a border that belongs to no element is not an element's decoration, and every cell background has to be under it.
      let after = order.decoration.get(part.element) ?? 0;
      let before = Number.POSITIVE_INFINITY;
      for (const cell of model.cells) {
        if (!cell.element || cell.row < part.startRow || cell.row > part.endRow) continue;
        const decoration = order.decoration.get(cell.element);
        if (decoration !== undefined && decoration > after) after = decoration;
        const content = order.content.get(cell.element);
        if (content !== undefined && content < before) before = content;
      }
      // After the last background the table paints and before the first word any cell paints. Both halves matter: a border under a cell background would vanish, and a border over a cell's text would strike it through.
      const paintIndex = Number.isFinite(before) ? Math.min(after + 0.25, before - 0.25) : after + 0.25;

      const artifactPath = `artifact:table-borders:${tablePath}`;
      artifacts.push({ path: artifactPath, kind: 'layout', type: 'Layout' });
      requests.push({
        owner: artifactPath,
        element: part.element,
        domPath: tablePath,
        paintIndex,
        page,
        node: {
          ...emptyNodeCommon(tablePath, 'collapsed-borders'),
          kind: 'group',
          children,
          clips: [],
          bboxPt: [0, 0, 0, 0],
          opacity: 1,
          blend: 'Normal',
          forceForm: false,
          formReason: 'the resolved grid edges of one collapsed table, painted once each',
          ...(chainCm ? { cm: chainCm } : {}),
        },
      });
    }
  }

  return { requests, artifacts, edges, deferred, computedWidths, borderSuppressed, decorationSuppressed, gridBoxes, gridLineSpreadPx };
}

/** The resolved width of one cell's four sides, for the computed-value comparison. */
export function resolvedWidthsOf(model: TableModel, edges: ReportCollapsedEdge[], cellIndex: number): [number,number,number,number] {
  const cell = model.cells[cellIndex];
  const widthAt = (axis: 'h'|'v', line: number, slot: number): number => {
    const hit = edges.find((e) => e.axis === axis && e.line === line && slot >= e.from && slot < e.to);
    return hit ? hit.widthPx : 0;
  };
  return [
    widthAt('h', cell.row, cell.col),
    widthAt('v', cell.col + cell.colSpan, cell.row),
    widthAt('h', cell.row + cell.rowSpan, cell.col),
    widthAt('v', cell.col, cell.row),
  ];
}
