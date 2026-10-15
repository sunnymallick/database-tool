<!--
  Virtualized results grid (rows and columns), with sorting, range selection,
  copy/export, a value viewer, and inline editing through an EditSession.
-->
<script lang="ts">
  import { tick, untrack, type Snippet } from 'svelte';
  import { ContextMenu, DropdownMenu } from 'bits-ui';
  import { toast } from 'svelte-sonner';
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import Ban from '@lucide/svelte/icons/ban';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Copy from '@lucide/svelte/icons/copy';
  import Download from '@lucide/svelte/icons/download';
  import Files from '@lucide/svelte/icons/files';
  import Sheet from '@lucide/svelte/icons/sheet';
  import Eye from '@lucide/svelte/icons/eye';
  import Funnel from '@lucide/svelte/icons/funnel';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Plus from '@lucide/svelte/icons/plus';
  import Trash from '@lucide/svelte/icons/trash';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import type { DbKind, ResultColumn, SortSpec, Value } from '@shared/types';
  import { classifyType, displayValue, editText, NULL_VALUE, valueFromInput } from '@shared/values';
  import { formatShortcut, isMac } from '$lib/keys';
  import { cn, copyText, formatCount, formatDuration } from '$lib/utils';
  import CellViewer from './CellViewer.svelte';
  import { estimateWidths, fitWidth } from './column-widths';
  import type { EditSession, RowAddr } from './edit-session.svelte';
  import { EXPORT_FORMATS, plainText, serialize, type ExportFormat } from './export';
  import { exportResult, FILE_EXPORT_FORMATS, type FileExportFormat } from './export-files';
  import {
    cellCount,
    inRanges,
    norm,
    rowInRanges,
    selectedAxes,
    sortPermutation,
    type CellPos,
    type CellRange,
    type ColumnSort
  } from './grid-selection';

  interface Props {
    columns: ResultColumn[];
    rows: Value[][];
    /** 'client' sorts locally, 'server' reports sort changes through onSortChange, 'none' disables sorting. */
    sortMode?: 'client' | 'server' | 'none';
    /** Server-mode sort (controlled). */
    sort?: SortSpec[];
    onSortChange?: (sort: SortSpec[]) => void;
    edits?: EditSession | null;
    /** Enable inline editing (also requires `edits` with every primary key column present). */
    editable?: boolean;
    rowNumberStart?: number;
    dialect?: DbKind | null;
    /** Target for "SQL INSERT" copy/export. */
    table?: { schema: string; table: string } | null;
    /** Base file name for exports. */
    exportName?: string;
    truncated?: boolean;
    onFetchAll?: () => void;
    durationMs?: number;
    totalRows?: number | null;
    loading?: boolean;
    onFilter?: (column: string, value: Value) => void;
    footerStart?: Snippet;
    footerEnd?: Snippet;
    /** When the grid shows one of several results from a run, offers exporting all of them at once. */
    exportAllResults?: { count: number; truncated: number; run: (format: 'csv' | 'xlsx') => void };
    emptyText?: string;
    /** Changing this scrolls to the top and clears the selection (e.g. the page number). */
    resetKey?: unknown;
    class?: string;
  }

  let {
    columns,
    rows,
    sortMode = 'client',
    sort = [],
    onSortChange,
    edits = null,
    editable = false,
    rowNumberStart = 1,
    dialect = null,
    table = null,
    exportName = 'results',
    truncated = false,
    onFetchAll,
    durationMs,
    totalRows = null,
    loading = false,
    onFilter,
    footerStart,
    footerEnd,
    exportAllResults,
    emptyText = 'No results',
    resetKey,
    class: klass
  }: Props = $props();

  const ROW_H = 26;
  const HEADER_H = 30;
  const OVERSCAN_ROWS = 10;
  const OVERSCAN_COLS = 2;
  const MOD = isMac ? 'Mod' : 'Ctrl';

  // -- state -------------------------------------------------------------------

  let scroller = $state<HTMLElement | null>(null);
  let scrollTop = $state(0);
  let scrollLeft = $state(0);
  let viewW = $state(0);
  let viewH = $state(0);
  let focused = $state(false);
  let focusRing = $state(false);

  let widthOverrides = $state<Record<number, number>>({});
  let clientSort = $state<ColumnSort[]>([]);
  let ranges = $state<CellRange[]>([]);
  let active = $state<CellPos | null>(null);
  let menuOpen = $state(false);

  interface EditingState {
    row: number;
    col: number;
    addr: RowAddr;
    text: string;
  }
  let editing = $state<EditingState | null>(null);
  let editInput = $state<HTMLInputElement | null>(null);

  interface ViewerState {
    open: boolean;
    addr: RowAddr;
    col: number;
    column: ResultColumn | null;
    value: Value | undefined;
    original?: Value;
    editable: boolean;
    edit: boolean;
  }
  let viewer = $state<ViewerState>({
    open: false,
    addr: { kind: 'base', index: 0 },
    col: 0,
    column: null,
    value: undefined,
    editable: false,
    edit: false
  });

  // -- derived layout ------------------------------------------------------------

  const signature = $derived(columns.map((c) => `${c.name}\u0001${c.type}`).join('\u0002'));
  const hasRows = $derived(rows.length > 0);

  /** Estimated widths, recomputed only for a new column set (or the first non-empty rows). */
  const baseWidths = $derived.by(() => {
    void signature;
    void hasRows;
    return untrack(() => estimateWidths(columns, rows));
  });

  const widths = $derived(columns.map((_, i) => widthOverrides[i] ?? baseWidths[i] ?? 120));
  const offsets = $derived.by(() => {
    const out = new Array<number>(widths.length + 1);
    out[0] = 0;
    for (let i = 0; i < widths.length; i++) out[i + 1] = out[i] + widths[i];
    return out;
  });
  const totalW = $derived(offsets[offsets.length - 1] ?? 0);

  const canEdit = $derived(editable && !!edits && edits.canEdit);
  const pkNames = $derived(new Set(edits?.primaryKey ?? []));

  const effectiveSort = $derived.by<ColumnSort[]>(() => {
    if (sortMode === 'server')
      return sort
        .map((s) => ({ col: columns.findIndex((c) => c.name === s.column), desc: s.desc }))
        .filter((s) => s.col >= 0);
    if (sortMode === 'client') return clientSort;
    return [];
  });

  /** Display order of base rows (null = natural order). */
  const order = $derived(sortMode === 'client' && clientSort.length > 0 ? sortPermutation(rows, clientSort) : null);
  const insertCount = $derived(canEdit && edits ? edits.inserts.length : 0);
  const displayCount = $derived(rows.length + insertCount);

  const rowNumW = $derived(Math.max(44, Math.ceil(String(rowNumberStart + Math.max(0, displayCount - 1)).length * 7.2 + 22)));

  function colAt(x: number): number {
    let lo = 0;
    let hi = widths.length - 1;
    if (hi < 0) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= x) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  const firstRow = $derived(Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN_ROWS));
  const lastRow = $derived(
    Math.min(displayCount - 1, Math.ceil((scrollTop + Math.max(0, viewH - HEADER_H)) / ROW_H) + OVERSCAN_ROWS)
  );
  const visibleRows = $derived.by(() => {
    const out: number[] = [];
    for (let r = firstRow; r <= lastRow; r++) out.push(r);
    return out;
  });
  const firstCol = $derived(Math.max(0, colAt(scrollLeft) - OVERSCAN_COLS));
  const lastCol = $derived(
    Math.min(columns.length - 1, colAt(scrollLeft + Math.max(0, viewW - rowNumW)) + OVERSCAN_COLS)
  );
  const visibleCols = $derived.by(() => {
    const out: number[] = [];
    for (let c = firstCol; c <= lastCol; c++) out.push(c);
    return out;
  });

  // -- resets --------------------------------------------------------------------

  let lastSignature: string | null = null;
  $effect.pre(() => {
    const sig = signature;
    untrack(() => {
      if (sig === lastSignature) return;
      const first = lastSignature === null;
      lastSignature = sig;
      if (first) return;
      widthOverrides = {};
      clientSort = [];
      resetView();
    });
  });

  let lastResetKey: unknown = undefined;
  let resetKeySeen = false;
  $effect.pre(() => {
    const key = resetKey;
    untrack(() => {
      if (!resetKeySeen) {
        resetKeySeen = true;
        lastResetKey = key;
        return;
      }
      if (key === lastResetKey) return;
      lastResetKey = key;
      resetView();
    });
  });

  // Keep the selection inside the grid when rows shrink.
  $effect.pre(() => {
    const count = displayCount;
    const cols = columns.length;
    untrack(() => {
      if (count === 0 || cols === 0) {
        if (ranges.length || active) {
          ranges = [];
          active = null;
        }
        return;
      }
      if (active && (active.row >= count || active.col >= cols)) {
        active = { row: Math.min(active.row, count - 1), col: Math.min(active.col, cols - 1) };
        ranges = [{ r0: active.row, c0: active.col, r1: active.row, c1: active.col }];
      }
    });
  });

  function resetView() {
    ranges = [];
    active = null;
    editing = null;
    scrollTop = 0;
    scrollLeft = 0;
    if (scroller) {
      scroller.scrollTop = 0;
      scroller.scrollLeft = 0;
    }
  }

  // -- viewport tracking ----------------------------------------------------------

  $effect(() => {
    const el = scroller;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      viewW = el.clientWidth;
      viewH = el.clientHeight;
    });
    ro.observe(el);
    viewW = el.clientWidth;
    viewH = el.clientHeight;
    return () => ro.disconnect();
  });

  let scrollFrame = 0;
  function onScroll() {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      if (!scroller) return;
      scrollTop = scroller.scrollTop;
      scrollLeft = scroller.scrollLeft;
    });
  }

  // -- data access -----------------------------------------------------------------

  function addrOf(d: number): RowAddr {
    if (d < rows.length) return { kind: 'base', index: order ? order[d] : d };
    return { kind: 'insert', index: d - rows.length };
  }

  /** Current value of a cell; undefined = DEFAULT (unset insert cell). */
  function valueAt(addr: RowAddr, c: number): Value | undefined {
    if (addr.kind === 'base') {
      const row = rows[addr.index];
      if (!row) return NULL_VALUE;
      return canEdit && edits ? (edits.updates[addr.index]?.[c] ?? row[c] ?? NULL_VALUE) : (row[c] ?? NULL_VALUE);
    }
    return edits?.inserts[addr.index]?.[c];
  }

  function isDeletedRow(addr: RowAddr): boolean {
    return addr.kind === 'base' && canEdit && !!edits?.deleted[addr.index];
  }

  function cellTypeClass(v: Value | undefined): string {
    if (!v) return 'default';
    switch (v.t) {
      case 'null':
        return 'null';
      case 'int':
      case 'float':
      case 'decimal':
        return 'num';
      case 'bool':
      case 'bytes':
        return 'muted';
      case 'json':
        return 'json';
      default:
        return '';
    }
  }

  // -- selection ---------------------------------------------------------------------

  function selectCell(row: number, col: number, mode: 'replace' | 'extend' | 'add' = 'replace') {
    if (displayCount === 0 || columns.length === 0) return;
    row = Math.max(0, Math.min(displayCount - 1, row));
    col = Math.max(0, Math.min(columns.length - 1, col));
    if (mode === 'extend' && ranges.length > 0) {
      const last = ranges[ranges.length - 1];
      ranges[ranges.length - 1] = { ...last, r1: row, c1: col };
    } else if (mode === 'add') {
      const idx = ranges.findIndex((r) => r.r0 === row && r.r1 === row && r.c0 === col && r.c1 === col);
      if (idx !== -1 && ranges.length > 1) ranges.splice(idx, 1);
      else ranges.push({ r0: row, c0: col, r1: row, c1: col });
    } else {
      ranges = [{ r0: row, c0: col, r1: row, c1: col }];
    }
    active = { row, col };
  }

  function selectRows(row: number, mode: 'replace' | 'extend' | 'add') {
    if (columns.length === 0) return;
    const last = columns.length - 1;
    if (mode === 'extend' && ranges.length > 0) {
      const r = ranges[ranges.length - 1];
      ranges[ranges.length - 1] = { r0: r.r0, c0: 0, r1: row, c1: last };
    } else if (mode === 'add') {
      ranges.push({ r0: row, c0: 0, r1: row, c1: last });
    } else {
      ranges = [{ r0: row, c0: 0, r1: row, c1: last }];
    }
    active = { row, col: active?.col ?? 0 };
  }

  function selectAll() {
    if (displayCount === 0 || columns.length === 0) return;
    ranges = [{ r0: 0, c0: 0, r1: displayCount - 1, c1: columns.length - 1 }];
    active = active ?? { row: 0, col: 0 };
  }

  function isSelected(row: number, col: number): boolean {
    return inRanges(ranges, row, col);
  }

  function colSelected(col: number): boolean {
    for (const r of ranges) {
      const n = norm(r);
      if (col >= n.left && col <= n.right) return true;
    }
    return false;
  }

  function ensureVisible(row: number, col: number) {
    const el = scroller;
    if (!el) return;
    const top = row * ROW_H;
    const bodyH = el.clientHeight - HEADER_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + bodyH) el.scrollTop = top + ROW_H - bodyH;
    const left = offsets[col] ?? 0;
    const right = offsets[col + 1] ?? left;
    const dataW = el.clientWidth - rowNumW;
    if (left < el.scrollLeft) el.scrollLeft = left;
    else if (right > el.scrollLeft + dataW) el.scrollLeft = Math.min(left, right - dataW);
  }

  function cellFromPoint(clientX: number, clientY: number): CellPos | null {
    const el = scroller;
    if (!el || displayCount === 0 || columns.length === 0) return null;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left + el.scrollLeft - rowNumW;
    const y = clientY - rect.top + el.scrollTop - HEADER_H;
    const row = Math.max(0, Math.min(displayCount - 1, Math.floor(y / ROW_H)));
    const col = Math.max(0, Math.min(columns.length - 1, colAt(Math.max(0, x))));
    return { row, col };
  }

  // -- pointer interaction ------------------------------------------------------------

  let dragMode: 'cells' | 'rows' | null = null;

  function onPointerDown(e: PointerEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('[data-editor]')) return;
    const rn = target.closest<HTMLElement>('[data-rn]');
    const cell = target.closest<HTMLElement>('[data-c]');
    if (e.button !== 0) return;
    if (editing) commitEdit();
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (rn) {
      const row = Number(rn.dataset.rn);
      selectRows(row, e.shiftKey ? 'extend' : mod ? 'add' : 'replace');
      dragMode = 'rows';
    } else if (cell) {
      const row = Number(cell.dataset.r);
      const col = Number(cell.dataset.c);
      if (e.shiftKey && active) selectCell(row, col, 'extend');
      else selectCell(row, col, mod ? 'add' : 'replace');
      dragMode = 'cells';
    } else return;
    scroller?.focus({ preventScroll: true });
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragMode || !(e.buttons & 1)) return;
    const el = scroller;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (e.clientY > rect.bottom - 12) el.scrollTop += ROW_H;
    else if (e.clientY < rect.top + HEADER_H) el.scrollTop -= ROW_H;
    if (e.clientX > rect.right - 12) el.scrollLeft += 40;
    else if (e.clientX < rect.left + rowNumW) el.scrollLeft -= 40;
    const pos = cellFromPoint(e.clientX, e.clientY);
    if (!pos || ranges.length === 0) return;
    const last = ranges[ranges.length - 1];
    if (dragMode === 'rows') {
      if (last.r1 !== pos.row) ranges[ranges.length - 1] = { ...last, r1: pos.row };
    } else if (last.r1 !== pos.row || last.c1 !== pos.col) {
      ranges[ranges.length - 1] = { ...last, r1: pos.row, c1: pos.col };
      active = pos;
    }
  }

  function onPointerUp() {
    dragMode = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
  }

  $effect(() => () => onPointerUp());

  function onDoubleClick(e: MouseEvent) {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-c]');
    if (!cell) return;
    const row = Number(cell.dataset.r);
    const col = Number(cell.dataset.c);
    if (canEdit) startEdit(row, col);
    else openViewer(row, col);
  }

  function onContextMenu(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const rn = target.closest<HTMLElement>('[data-rn]');
    const cell = target.closest<HTMLElement>('[data-c]');
    if (editing) commitEdit();
    if (rn) {
      const row = Number(rn.dataset.rn);
      if (!rowInRanges(ranges, row)) selectRows(row, 'replace');
    } else if (cell) {
      const row = Number(cell.dataset.r);
      const col = Number(cell.dataset.c);
      if (!isSelected(row, col)) selectCell(row, col);
      else active = { row, col };
    }
  }

  // -- header: sort + resize ----------------------------------------------------------

  function toSpecs(list: ColumnSort[]): SortSpec[] {
    return list.map((s) => ({ column: columns[s.col].name, desc: s.desc }));
  }

  function headerClick(e: MouseEvent, col: number) {
    if ((e.target as HTMLElement).closest('[data-resize]')) return;
    if (sortMode === 'none') return;
    const cur = effectiveSort;
    const existing = cur.find((s) => s.col === col);
    let next: ColumnSort[];
    if (e.shiftKey) {
      if (!existing) next = [...cur, { col, desc: false }];
      else if (!existing.desc) next = cur.map((s) => (s.col === col ? { col, desc: true } : s));
      else next = cur.filter((s) => s.col !== col);
    } else if (!existing) next = [{ col, desc: false }];
    else if (!existing.desc) next = [{ col, desc: true }];
    else next = [];
    if (sortMode === 'client') {
      clientSort = next;
      ranges = [];
      active = null;
    } else onSortChange?.(toSpecs(next));
  }

  let resizing = $state<{ col: number; startX: number; startW: number } | null>(null);

  function resizeDown(e: PointerEvent, col: number) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    resizing = { col, startX: e.clientX, startW: widths[col] };
  }
  function resizeMove(e: PointerEvent) {
    if (!resizing) return;
    widthOverrides[resizing.col] = Math.max(40, Math.min(2000, Math.round(resizing.startW + e.clientX - resizing.startX)));
  }
  function resizeUp(e: PointerEvent) {
    if (!resizing) return;
    resizing = null;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  }
  function autoFit(col: number) {
    function* values() {
      for (let i = 0; i < rows.length; i++) yield rows[i][col] ?? NULL_VALUE;
    }
    widthOverrides[col] = fitWidth(columns[col], values());
  }

  // -- editing -----------------------------------------------------------------------

  function setValue(addr: RowAddr, col: number, value: Value | undefined) {
    if (!edits) return;
    if (addr.kind === 'base') {
      if (value === undefined) edits.revertCell(addr.index, col);
      else edits.setCell(rows, addr.index, col, value);
    } else edits.setInsertCell(addr.index, col, value);
  }

  function isLongValue(v: Value | undefined): boolean {
    if (!v) return false;
    if (v.t === 'json') return true;
    return v.t === 'text' && (v.v.includes('\n') || v.v.length > 300);
  }

  async function startEdit(row: number, col: number, initial?: string) {
    if (!canEdit) {
      openViewer(row, col);
      return;
    }
    const addr = addrOf(row);
    if (isDeletedRow(addr)) return;
    const v = valueAt(addr, col);
    if (isLongValue(v) || classifyType(columns[col].type) === 'json') {
      openViewer(row, col, true);
      return;
    }
    selectCell(row, col);
    ensureVisible(row, col);
    editing = { row, col, addr, text: initial ?? (v ? editText(v) : '') };
    await tick();
    editInput?.focus();
    if (initial === undefined) editInput?.select();
  }

  function commitEdit(move?: 'right' | 'left' | 'down') {
    const e = editing;
    if (!e) return;
    editing = null;
    const current = valueAt(e.addr, e.col);
    const unchanged = current === undefined ? e.text === '' : e.text === editText(current);
    if (!unchanged) {
      const original = e.addr.kind === 'base' ? rows[e.addr.index]?.[e.col] : undefined;
      setValue(e.addr, e.col, valueFromInput(e.text, { original, columnType: columns[e.col].type }));
    }
    if (move === 'right') moveActive(0, 1, false);
    else if (move === 'left') moveActive(0, -1, false);
    else if (move === 'down') moveActive(1, 0, false);
    scroller?.focus({ preventScroll: true });
  }

  function cancelEdit() {
    editing = null;
    scroller?.focus({ preventScroll: true });
  }

  function onEditorKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      commitEdit(e.shiftKey ? 'left' : 'right');
    }
  }

  function openViewer(row: number, col: number, edit = false) {
    const addr = addrOf(row);
    const v = valueAt(addr, col);
    const cellEditable = canEdit && !isDeletedRow(addr);
    viewer = {
      open: true,
      addr,
      col,
      column: columns[col],
      value: v ? ($state.snapshot(v) as Value) : undefined,
      original: addr.kind === 'base' ? rows[addr.index]?.[col] : undefined,
      editable: cellEditable,
      edit: edit && cellEditable
    };
  }

  // -- selection helpers for actions ----------------------------------------------------

  function selectedCells(): { row: number; col: number }[] {
    const { rows: rs, cols } = selectedAxes(ranges);
    const out: { row: number; col: number }[] = [];
    for (const r of rs) for (const c of cols) if (inRanges(ranges, r, c)) out.push({ row: r, col: c });
    return out;
  }

  function selectedDisplayRows(): number[] {
    return selectedAxes(ranges).rows;
  }

  function setNullSelected() {
    if (!canEdit) return;
    for (const { row, col } of selectedCells()) {
      const addr = addrOf(row);
      if (!isDeletedRow(addr)) setValue(addr, col, NULL_VALUE);
    }
  }

  function revertSelected() {
    if (!edits) return;
    const deletedToRestore: number[] = [];
    for (const { row, col } of selectedCells()) {
      const addr = addrOf(row);
      if (addr.kind === 'base') edits.revertCell(addr.index, col);
      else edits.setInsertCell(addr.index, col, undefined);
    }
    for (const row of selectedDisplayRows()) {
      const addr = addrOf(row);
      if (addr.kind === 'base' && edits.deleted[addr.index]) deletedToRestore.push(addr.index);
    }
    if (deletedToRestore.length) edits.toggleDelete(deletedToRestore);
  }

  function selectionHasChanges(): boolean {
    if (!edits || !canEdit) return false;
    for (const row of selectedDisplayRows()) {
      const addr = addrOf(row);
      if (addr.kind === 'insert') return true;
      if (edits.deleted[addr.index] || edits.updates[addr.index]) return true;
    }
    return false;
  }

  function toggleDeleteSelected() {
    if (!edits || !canEdit) return;
    const base: number[] = [];
    const inserts: number[] = [];
    for (const row of selectedDisplayRows()) {
      const addr = addrOf(row);
      if (addr.kind === 'base') base.push(addr.index);
      else inserts.push(addr.index);
    }
    if (base.length) edits.toggleDelete(base);
    for (const i of inserts.sort((a, b) => b - a)) edits.removeInsert(i);
    if (inserts.length) {
      ranges = [];
      active = null;
    }
  }

  async function addRow() {
    if (!edits || !canEdit) return;
    edits.addRow();
  }

  // A new pending insert (from the context menu or the host toolbar): select it and scroll to it.
  let lastInsertCount = 0;
  $effect(() => {
    const n = insertCount;
    const grew = n > lastInsertCount;
    lastInsertCount = n;
    if (!grew) return;
    void tick().then(() => {
      const row = rows.length + n - 1;
      selectCell(row, 0);
      ensureVisible(row, 0);
      scroller?.focus({ preventScroll: true });
    });
  });

  const deleteLabel = $derived.by(() => {
    if (!menuOpen || !edits) return 'Delete row';
    const list = selectedDisplayRows();
    const allDeleted = list.length > 0 && list.every((r) => {
      const a = addrOf(r);
      return a.kind === 'base' && !!edits.deleted[a.index];
    });
    const n = list.length;
    return allDeleted ? (n > 1 ? `Restore ${n} rows` : 'Restore row') : n > 1 ? `Delete ${n} rows` : 'Delete row';
  });

  // -- copy / export -----------------------------------------------------------------------

  /** Values of the selected rows × selected columns (current values, DEFAULT as NULL). */
  function selectionMatrix(): { cols: ResultColumn[]; values: Value[][] } {
    const { rows: rs, cols } = selectedAxes(ranges);
    return {
      cols: cols.map((c) => columns[c]),
      values: rs.map((r) => {
        const addr = addrOf(r);
        return cols.map((c) => valueAt(addr, c) ?? NULL_VALUE);
      })
    };
  }

  async function copySelection(headers = false) {
    if (ranges.length === 0) return;
    const { rows: rs, cols } = selectedAxes(ranges);
    const lines: string[] = [];
    const field = (s: string) => (/[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    if (headers) lines.push(cols.map((c) => field(columns[c].name)).join('\t'));
    const single = ranges.length === 1;
    for (const r of rs) {
      const addr = addrOf(r);
      lines.push(
        cols
          .map((c) => (single || inRanges(ranges, r, c) ? field(plainText(valueAt(addr, c) ?? NULL_VALUE)) : ''))
          .join('\t')
      );
    }
    await copyText(lines.join('\n'));
    const n = single ? cellCount(ranges) : rs.length * cols.length;
    toast.success(n === 1 ? 'Copied value' : `Copied ${formatCount(rs.length)} × ${cols.length} cells`);
  }

  async function copyAs(format: ExportFormat) {
    if (ranges.length === 0) return;
    const { cols, values } = selectionMatrix();
    await copyText(serialize(format, cols, values, { kind: dialect, table, headers: true }));
    const label = EXPORT_FORMATS.find((f) => f.id === format)?.label ?? format;
    toast.success(`Copied ${values.length === 1 ? '1 row' : `${formatCount(values.length)} rows`} as ${label}`);
  }

  async function copyColumnName() {
    if (!active) return;
    const { cols } = selectedAxes(ranges);
    const names = (cols.length ? cols : [active.col]).map((c) => columns[c].name);
    await copyText(names.join(', '));
    toast.success(names.length === 1 ? 'Copied column name' : 'Copied column names');
  }

  function allRowsOrdered(): Value[][] {
    if (!order) return rows;
    return order.map((i) => rows[i]);
  }

  function exportAll(format: FileExportFormat) {
    void exportResult({ format, columns, rows: allRowsOrdered(), name: exportName, kind: dialect, table });
  }

  async function copyAll() {
    await copyText(serialize('tsv', columns, allRowsOrdered(), { headers: true }));
    toast.success(`Copied ${formatCount(rows.length)} rows as TSV`);
  }

  function filterByValue() {
    if (!active || !onFilter) return;
    const v = valueAt(addrOf(active.row), active.col) ?? NULL_VALUE;
    onFilter(columns[active.col].name, v);
  }

  // -- keyboard -------------------------------------------------------------------------------

  function moveActive(dr: number, dc: number, extend: boolean) {
    if (displayCount === 0 || columns.length === 0) return;
    const base = extend && ranges.length ? { row: ranges[ranges.length - 1].r1, col: ranges[ranges.length - 1].c1 } : active ?? { row: 0, col: 0 };
    const row = Math.max(0, Math.min(displayCount - 1, base.row + dr));
    const col = Math.max(0, Math.min(columns.length - 1, base.col + dc));
    if (extend && ranges.length) {
      const last = ranges[ranges.length - 1];
      ranges[ranges.length - 1] = { ...last, r1: row, c1: col };
    } else selectCell(row, col);
    ensureVisible(row, col);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (editing) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const pageRows = Math.max(1, Math.floor((viewH - HEADER_H) / ROW_H) - 1);
    const key = e.key;
    if (mod && !e.altKey && (key === 'c' || key === 'C')) {
      e.preventDefault();
      void copySelection(e.shiftKey);
      return;
    }
    if (mod && !e.shiftKey && (key === 'a' || key === 'A')) {
      e.preventDefault();
      selectAll();
      return;
    }
    if (mod && key === 'Backspace') {
      e.preventDefault();
      toggleDeleteSelected();
      return;
    }
    switch (key) {
      case 'ArrowUp':
        e.preventDefault();
        moveActive(mod ? -displayCount : -1, 0, e.shiftKey);
        return;
      case 'ArrowDown':
        e.preventDefault();
        moveActive(mod ? displayCount : 1, 0, e.shiftKey);
        return;
      case 'ArrowLeft':
        e.preventDefault();
        moveActive(0, mod ? -columns.length : -1, e.shiftKey);
        return;
      case 'ArrowRight':
        e.preventDefault();
        moveActive(0, mod ? columns.length : 1, e.shiftKey);
        return;
      case 'Home':
        e.preventDefault();
        moveActive(mod ? -displayCount : 0, -columns.length, e.shiftKey);
        return;
      case 'End':
        e.preventDefault();
        moveActive(mod ? displayCount : 0, columns.length, e.shiftKey);
        return;
      case 'PageUp':
        e.preventDefault();
        moveActive(-pageRows, 0, e.shiftKey);
        return;
      case 'PageDown':
        e.preventDefault();
        moveActive(pageRows, 0, e.shiftKey);
        return;
      case 'Escape':
        if (active && ranges.length > 1) {
          e.preventDefault();
          selectCell(active.row, active.col);
        }
        return;
      case 'Enter':
      case 'F2':
        if (!active) return;
        e.preventDefault();
        if (canEdit) void startEdit(active.row, active.col);
        else openViewer(active.row, active.col);
        return;
      case ' ':
        if (e.shiftKey && active) {
          e.preventDefault();
          openViewer(active.row, active.col);
        }
        return;
    }
    if (canEdit && active && key.length === 1 && !mod && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      void startEdit(active.row, active.col, key);
    }
  }

  // -- footer summaries -------------------------------------------------------------------------

  const numberFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });

  const selectionInfo = $derived.by(() => {
    if (ranges.length === 0) return null;
    const count = cellCount(ranges);
    if (count <= 1) return null;
    let label: string;
    if (ranges.length === 1) {
      const n = norm(ranges[0]);
      const h = n.bottom - n.top + 1;
      const w = n.right - n.left + 1;
      label = w === columns.length && columns.length > 1 ? `${formatCount(h)} ${h === 1 ? 'row' : 'rows'} selected` : `${formatCount(h)} × ${w} selected`;
    } else label = `${formatCount(count)} cells selected`;
    let sum = 0;
    let n = 0;
    let numeric = count <= 200_000;
    if (numeric) {
      const axes = selectedAxes(ranges);
      outer: for (const r of axes.rows) {
        const addr = addrOf(r);
        for (const c of axes.cols) {
          if (ranges.length > 1 && !inRanges(ranges, r, c)) continue;
          const v = valueAt(addr, c);
          if (!v || v.t === 'null') continue;
          if (v.t !== 'int' && v.t !== 'float' && v.t !== 'decimal') {
            numeric = false;
            break outer;
          }
          sum += Number(v.v);
          n++;
        }
      }
    }
    return { label, sum: numeric && n > 0 ? numberFmt.format(sum) : null, avg: numeric && n > 0 ? numberFmt.format(sum / n) : null };
  });

  const rowsLabel = $derived.by(() => {
    const base = totalRows != null ? `${formatCount(rows.length)} of ${formatCount(totalRows)} rows` : `${formatCount(rows.length)} ${rows.length === 1 ? 'row' : 'rows'}`;
    return insertCount > 0 ? `${base} · ${insertCount} new` : base;
  });

  const sortIndex = (col: number) => effectiveSort.findIndex((s) => s.col === col);
</script>

<div class={cn('grid-root flex h-full min-h-0 flex-col bg-bg', klass)}>
  {#if columns.length === 0}
    <div class="flex min-h-0 flex-1 items-center justify-center text-[12.5px] text-faint">
      {#if loading}<span class="spinner mr-2"></span>{/if}{emptyText}
    </div>
  {:else}
    <div class="relative min-h-0 flex-1">
      <ContextMenu.Root bind:open={menuOpen}>
        <ContextMenu.Trigger
          bind:ref={scroller}
          disabled={!!editing}
          tabindex={0}
          role="grid"
          aria-rowcount={displayCount + 1}
          aria-colcount={columns.length}
          aria-multiselectable="true"
          class={cn('grid-scroller absolute inset-0 overflow-auto outline-none', loading && 'opacity-60')}
          onscroll={onScroll}
          onkeydown={onKeyDown}
          onpointerdown={onPointerDown}
          ondblclick={onDoubleClick}
          oncontextmenu={onContextMenu}
          onfocus={(e: FocusEvent) => {
            focused = true;
            focusRing = (e.currentTarget as HTMLElement).matches(':focus-visible');
          }}
          onblur={() => {
            focused = false;
            focusRing = false;
          }}
        >
          <div class="sizer" style="width: {rowNumW + totalW}px; height: {HEADER_H + displayCount * ROW_H}px;">
            <!-- Header -->
            <div class="gh" style="height: {HEADER_H}px;" role="row">
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <div
                class="corner"
                style="width: {rowNumW}px;"
                role="columnheader"
                tabindex="-1"
                title="Select all"
                onclick={selectAll}
              ></div>
              {#each visibleCols as c (c)}
                {@const col = columns[c]}
                {@const si = sortIndex(c)}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <div
                  class={cn('hc', colSelected(c) && 'sel', sortMode !== 'none' && 'sortable')}
                  style="left: {rowNumW + offsets[c]}px; width: {widths[c]}px;"
                  role="columnheader"
                  tabindex="-1"
                  aria-sort={si === -1 ? 'none' : effectiveSort[si].desc ? 'descending' : 'ascending'}
                  title={`${col.name}${col.type ? ` · ${col.type}` : ''}${sortMode !== 'none' ? '\nClick to sort, Shift-click to add a sort' : ''}`}
                  onclick={(e) => headerClick(e, c)}
                >
                  {#if pkNames.has(col.name)}<KeyRound class="size-3 shrink-0 text-warning" />{/if}
                  <span class="name">{col.name}</span>
                  {#if col.type}<span class="type">{col.type}</span>{/if}
                  {#if si !== -1}
                    <span class="sort">
                      {#if effectiveSort[si].desc}<ArrowDown class="size-3" />{:else}<ArrowUp class="size-3" />{/if}
                      {#if effectiveSort.length > 1}<span>{si + 1}</span>{/if}
                    </span>
                  {/if}
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <div
                    class={cn('rz', resizing?.col === c && 'active')}
                    data-resize
                    title="Drag to resize, double-click to fit"
                    onpointerdown={(e) => resizeDown(e, c)}
                    onpointermove={resizeMove}
                    onpointerup={resizeUp}
                    onpointercancel={resizeUp}
                    ondblclick={(e) => {
                      e.stopPropagation();
                      autoFit(c);
                    }}
                  ></div>
                </div>
              {/each}
            </div>

            <!-- Rows -->
            {#each visibleRows as d (d)}
              {@const addr = addrOf(d)}
              {@const deleted = isDeletedRow(addr)}
              <div
                class={cn('gr', d % 2 === 1 && 'alt', addr.kind === 'insert' && 'inserted', deleted && 'deleted')}
                style="top: {HEADER_H + d * ROW_H}px; width: {rowNumW + totalW}px;"
                role="row"
              >
                <div class={cn('rn', rowInRanges(ranges, d) && 'sel')} style="width: {rowNumW}px;" data-rn={d} role="rowheader">
                  {addr.kind === 'insert' ? '+' : formatCount(rowNumberStart + d)}
                </div>
                {#each visibleCols as c (c)}
                  {@const v = valueAt(addr, c)}
                  {@const changed = addr.kind === 'base' && canEdit && edits?.updates[addr.index]?.[c] !== undefined}
                  <div
                    class={cn(
                      'gc',
                      cellTypeClass(v),
                      changed && 'changed',
                      isSelected(d, c) && 'sel',
                      active?.row === d && active.col === c && (focused || menuOpen ? 'active' : 'active-blur')
                    )}
                    style="left: {rowNumW + offsets[c]}px; width: {widths[c]}px;"
                    data-r={d}
                    data-c={c}
                    role="gridcell"
                  >
                    {#if v === undefined}
                      DEFAULT
                    {:else if v.t === 'null'}
                      NULL
                    {:else}
                      {displayValue(v, 400)}
                    {/if}
                  </div>
                {/each}
              </div>
            {/each}

            {#if editing}
              <input
                bind:this={editInput}
                bind:value={editing.text}
                data-editor
                class="cell-editor"
                style="left: {rowNumW + offsets[editing.col]}px; top: {HEADER_H + editing.row * ROW_H}px; width: {Math.max(widths[editing.col], 120)}px;"
                spellcheck="false"
                autocomplete="off"
                aria-label={`Edit ${columns[editing.col].name}`}
                onkeydown={onEditorKey}
                onblur={() => commitEdit()}
              />
            {/if}
          </div>

        </ContextMenu.Trigger>

        <ContextMenu.Portal>
          <ContextMenu.Content class="menu-content w-[232px]" loop>
            <ContextMenu.Item class="menu-item" onSelect={() => copySelection(false)}>
              <Copy />Copy<span class="menu-shortcut">{formatShortcut(`${MOD}-c`)}</span>
            </ContextMenu.Item>
            <ContextMenu.Item class="menu-item" onSelect={() => copySelection(true)}>
              <span class="size-3.5"></span>Copy with headers<span class="menu-shortcut">{formatShortcut(`${MOD}-Shift-c`)}</span>
            </ContextMenu.Item>
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger class="menu-item">
                <span class="size-3.5"></span>Copy as<ChevronRight class="ml-auto" />
              </ContextMenu.SubTrigger>
              <ContextMenu.SubContent class="menu-content min-w-[150px]" sideOffset={4}>
                {#each EXPORT_FORMATS.filter((f) => f.id !== 'tsv') as f (f.id)}
                  <ContextMenu.Item class="menu-item" onSelect={() => copyAs(f.id)}>{f.label}</ContextMenu.Item>
                {/each}
              </ContextMenu.SubContent>
            </ContextMenu.Sub>
            <ContextMenu.Item class="menu-item" onSelect={copyColumnName}>
              <span class="size-3.5"></span>Copy column name
            </ContextMenu.Item>
            <ContextMenu.Separator class="menu-separator" />
            <ContextMenu.Item class="menu-item" disabled={!active} onSelect={() => active && openViewer(active.row, active.col)}>
              <Eye />View value…<span class="menu-shortcut">{formatShortcut('Shift-Space')}</span>
            </ContextMenu.Item>
            {#if onFilter}
              <ContextMenu.Item class="menu-item" disabled={!active || (active && active.row >= rows.length)} onSelect={filterByValue}>
                <Funnel />Filter by this value
              </ContextMenu.Item>
            {/if}
            {#if canEdit}
              <ContextMenu.Separator class="menu-separator" />
              <ContextMenu.Item class="menu-item" disabled={!active} onSelect={() => active && startEdit(active.row, active.col)}>
                <Pencil />Edit cell<span class="menu-shortcut">↵</span>
              </ContextMenu.Item>
              <ContextMenu.Item class="menu-item" onSelect={setNullSelected}>
                <Ban />Set NULL
              </ContextMenu.Item>
              <ContextMenu.Item class="menu-item" disabled={!menuOpen || !selectionHasChanges()} onSelect={revertSelected}>
                <Undo2 />Revert changes
              </ContextMenu.Item>
              <ContextMenu.Item class="menu-item menu-item-danger" onSelect={toggleDeleteSelected}>
                <Trash />{deleteLabel}<span class="menu-shortcut">{formatShortcut(`${MOD}-Backspace`)}</span>
              </ContextMenu.Item>
              <ContextMenu.Item class="menu-item" onSelect={addRow}>
                <Plus />Add row
              </ContextMenu.Item>
            {/if}
            <ContextMenu.Separator class="menu-separator" />
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger class="menu-item">
                <Download />Export all rows<ChevronRight class="ml-auto" />
              </ContextMenu.SubTrigger>
              <ContextMenu.SubContent class="menu-content min-w-[150px]" sideOffset={4}>
                {#each FILE_EXPORT_FORMATS as f (f.id)}
                  <ContextMenu.Item class="menu-item" onSelect={() => exportAll(f.id)}>{f.label}…</ContextMenu.Item>
                {/each}
              </ContextMenu.SubContent>
            </ContextMenu.Sub>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>

      {#if displayCount === 0}
        <div
          class="pointer-events-none absolute inset-x-0 flex h-20 items-center justify-center text-[12.5px] text-faint"
          style="top: {HEADER_H}px;"
        >
          {loading ? 'Loading…' : 'No rows'}
        </div>
      {/if}
      {#if focusRing}
        <div class="pointer-events-none absolute inset-0 z-[5] shadow-[inset_0_0_0_1px_var(--focus)]"></div>
      {/if}
      {#if loading}
        <div class="loading-bar pointer-events-none absolute inset-x-0 top-0 z-[6] h-0.5 overflow-hidden">
          <div class="h-full w-1/3 bg-accent"></div>
        </div>
      {/if}
    </div>
  {/if}

  {#if truncated}
    <div class="flex h-7 shrink-0 items-center gap-2 border-t border-border bg-warning-soft px-3 text-[11.5px] text-fg">
      <TriangleAlert class="size-3.5 shrink-0 text-warning" />
      <span class="truncate">Showing the first {formatCount(rows.length)} rows (row cap).</span>
      {#if onFetchAll}
        <button type="button" class="btn btn-sm ml-1" onclick={() => onFetchAll?.()}>Fetch all rows</button>
      {/if}
    </div>
  {/if}

  <div
    class="@container flex h-7 shrink-0 items-center gap-3 overflow-hidden border-t border-border bg-panel px-2.5 text-[11.5px] whitespace-nowrap text-muted"
  >
    {@render footerStart?.()}
    {#if columns.length > 0}
      <span class="shrink-0 tabular-nums">{rowsLabel}</span>
    {/if}
    {#if durationMs != null}
      <span class="hidden shrink-0 tabular-nums text-faint @md:inline">{formatDuration(durationMs)}</span>
    {/if}
    {#if selectionInfo}
      <span class="hidden min-w-0 items-center gap-1.5 truncate tabular-nums @xl:flex">
        <span>{selectionInfo.label}</span>
        {#if selectionInfo.sum !== null}
          <span class="text-faint">·</span>
          <span><span class="text-faint">Sum</span> {selectionInfo.sum}</span>
          <span class="text-faint">·</span>
          <span><span class="text-faint">Avg</span> {selectionInfo.avg}</span>
        {/if}
      </span>
    {/if}
    <span class="flex-1"></span>
    {@render footerEnd?.()}
    {#if columns.length > 0}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger class="btn btn-ghost btn-sm -mr-1 gap-1 px-1.5 text-[11.5px]">
          <Download class="size-3.5" />Export<ChevronDown class="size-3 text-faint" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content class="menu-content min-w-[190px]" align="end" sideOffset={4}>
            <DropdownMenu.Group>
              <DropdownMenu.GroupHeading class="menu-label">{exportAllResults && exportAllResults.count > 1 ? 'This result' : 'Save to file'}</DropdownMenu.GroupHeading>
              {#each FILE_EXPORT_FORMATS as f (f.id)}
                <DropdownMenu.Item class="menu-item" onSelect={() => exportAll(f.id)}>
                  {f.label}<span class="menu-shortcut">.{f.ext}</span>
                </DropdownMenu.Item>
              {/each}
            </DropdownMenu.Group>
            {#if exportAllResults && exportAllResults.count > 1}
              <DropdownMenu.Separator class="menu-separator" />
              <DropdownMenu.Group>
                <DropdownMenu.GroupHeading class="menu-label">All {exportAllResults.count} results</DropdownMenu.GroupHeading>
                <DropdownMenu.Item class="menu-item" onSelect={() => exportAllResults.run('csv')}>
                  <Files />CSV files, one per result…
                </DropdownMenu.Item>
                <DropdownMenu.Item class="menu-item" onSelect={() => exportAllResults.run('xlsx')}>
                  <Sheet />Excel workbook, one sheet each…
                </DropdownMenu.Item>
                {#if exportAllResults.truncated > 0}
                  <p class="max-w-[240px] px-2 py-1 text-[11px] leading-snug text-warning">
                    {exportAllResults.truncated === 1 ? '1 result was' : `${exportAllResults.truncated} results were`} cut off at the row cap. Fetch all rows first to export everything.
                  </p>
                {/if}
              </DropdownMenu.Group>
            {/if}
            <DropdownMenu.Separator class="menu-separator" />
            <DropdownMenu.Item class="menu-item" onSelect={copyAll}>
              <Copy />Copy all as TSV
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    {/if}
  </div>
</div>

<CellViewer
  bind:open={viewer.open}
  column={viewer.column}
  value={viewer.value}
  original={viewer.original}
  editable={viewer.editable}
  startInEdit={viewer.edit}
  onSave={(v) => setValue(viewer.addr, viewer.col, v)}
  onSetNull={() => setValue(viewer.addr, viewer.col, NULL_VALUE)}
/>

<style>
  .sizer {
    position: relative;
  }

  /* Header */
  .gh {
    position: sticky;
    top: 0;
    z-index: 3;
    width: 100%;
    background: var(--grid-header);
    border-bottom: 1px solid var(--border);
  }
  .corner {
    position: sticky;
    left: 0;
    z-index: 1;
    height: 100%;
    background: var(--grid-header);
    border-right: 1px solid var(--border);
    cursor: default;
  }
  .corner:hover {
    background: color-mix(in srgb, var(--fg) 5%, var(--grid-header));
  }
  .hc {
    position: absolute;
    top: 0;
    height: 100%;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0 8px 0 9px;
    border-right: 1px solid var(--grid-line);
    font-size: 12px;
    overflow: hidden;
    white-space: nowrap;
  }
  .hc.sortable {
    cursor: pointer;
  }
  .hc.sortable:hover {
    background: var(--hover);
  }
  .hc.sel {
    background: var(--accent-soft);
  }
  .hc .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 500;
    color: var(--fg);
  }
  .hc .type {
    min-width: 0;
    flex-shrink: 100;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 10.5px;
    color: var(--faint);
  }
  .hc .sort {
    margin-left: auto;
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 1px;
    font-size: 10px;
    font-weight: 600;
    color: var(--accent);
  }
  .rz {
    position: absolute;
    top: 0;
    right: 0;
    width: 7px;
    height: 100%;
    cursor: col-resize;
    z-index: 1;
  }
  .rz::after {
    content: '';
    position: absolute;
    right: 0;
    top: 6px;
    bottom: 6px;
    width: 2px;
    border-radius: 1px;
    background: var(--accent);
    opacity: 0;
    transition: opacity 0.12s;
  }
  .rz:hover::after,
  .rz.active::after {
    opacity: 1;
  }

  /* Rows */
  .gr {
    position: absolute;
    left: 0;
    height: 26px;
  }
  .gr.alt {
    background: var(--grid-row-alt);
  }
  .gr:hover {
    background: var(--hover);
  }
  .gr.inserted {
    background: var(--cell-inserted);
  }
  .gr.deleted {
    background: var(--cell-deleted);
  }
  .gr.deleted .gc {
    text-decoration: line-through;
    text-decoration-color: color-mix(in srgb, var(--danger) 70%, transparent);
    opacity: 0.6;
  }
  .rn {
    position: sticky;
    left: 0;
    z-index: 1;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding-right: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--faint);
    background: var(--grid-header);
    border-right: 1px solid var(--border);
    border-bottom: 1px solid var(--grid-line);
    cursor: default;
  }
  .rn.sel {
    color: var(--fg);
    background: color-mix(in srgb, var(--accent) 14%, var(--grid-header));
  }
  .gr.inserted .rn {
    color: var(--success);
    font-weight: 600;
  }
  .gr.deleted .rn {
    color: var(--danger);
  }

  /* Cells */
  .gc {
    position: absolute;
    top: 0;
    height: 26px;
    line-height: 25px;
    padding: 0 8px;
    border-right: 1px solid var(--grid-line);
    border-bottom: 1px solid var(--grid-line);
    font-family: var(--font-mono);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--fg);
    cursor: default;
  }
  .gc.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .gc.null,
  .gc.default {
    color: var(--faint);
    font-style: italic;
    font-size: 11.5px;
  }
  .gc.default {
    opacity: 0.8;
  }
  .gc.muted {
    color: var(--muted);
  }
  .gc.json {
    color: var(--syn-type);
  }
  .gc.changed {
    background: var(--cell-changed);
  }
  .gc.sel {
    background-image: linear-gradient(var(--selection), var(--selection));
  }
  .gc.active {
    box-shadow: inset 0 0 0 2px var(--accent);
  }
  .gc.active-blur {
    box-shadow: inset 0 0 0 1px var(--border-strong);
  }

  .cell-editor {
    position: absolute;
    z-index: 2;
    height: 26px;
    padding: 0 7px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--fg);
    background: var(--raised);
    border: none;
    outline: none;
    box-shadow:
      inset 0 0 0 2px var(--accent),
      var(--shadow);
  }

  .loading-bar > div {
    animation: grid-loading 1.1s ease-in-out infinite;
  }
  @keyframes grid-loading {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(300%);
    }
  }
</style>
