/**
 * Pending edits for a result grid that maps onto one table (inline editing in
 * query results and table data tabs). Rows are addressed by their index in
 * the base `rows` array; inserted rows live in `inserts`.
 */
import type { ResultColumn, RowChangeSet, Value } from '@shared/types';
import { valuesEqual } from '@shared/values';

/** A displayed row: an existing base row or a pending insert. */
export type RowAddr = { kind: 'base'; index: number } | { kind: 'insert'; index: number };

export class EditSession {
  /** base row index -> (column index -> new value) */
  updates = $state<Record<number, Record<number, Value>>>({});
  /** Base row indexes marked for deletion. */
  deleted = $state<Record<number, true>>({});
  /** New rows: column index -> value. Missing columns use the database default. */
  inserts = $state<Record<number, Value>[]>([]);

  readonly columns: ResultColumn[];
  readonly primaryKey: string[];

  constructor(columns: ResultColumn[], primaryKey: string[]) {
    this.columns = columns;
    this.primaryKey = primaryKey;
  }

  readonly updatedRowCount = $derived(Object.keys(this.updates).length);
  readonly deletedCount = $derived(Object.keys(this.deleted).length);
  readonly count = $derived(this.updatedRowCount + this.deletedCount + this.inserts.length);
  readonly hasChanges = $derived(this.count > 0);

  /** Column indexes of the primary key; null when a PK column is missing from the result. */
  readonly pkIndexes = $derived.by(() => {
    const idx = this.primaryKey.map((k) => this.columns.findIndex((c) => c.name === k));
    return idx.length > 0 && idx.every((i) => i >= 0) ? idx : null;
  });

  /** Editing needs every primary key column in the result. */
  readonly canEdit = $derived(this.pkIndexes !== null);

  isDeleted(row: number): boolean {
    return !!this.deleted[row];
  }

  isChanged(row: number, col: number): boolean {
    return this.updates[row]?.[col] !== undefined;
  }

  /** Current value of a base cell, including a pending update. */
  valueAt(rows: Value[][], row: number, col: number): Value {
    return this.updates[row]?.[col] ?? rows[row][col];
  }

  /** Set a base cell. Setting it back to the original value drops the edit. */
  setCell(rows: Value[][], row: number, col: number, value: Value): void {
    const original = rows[row][col];
    if (valuesEqual(original, value)) {
      const r = this.updates[row];
      if (!r) return;
      delete r[col];
      if (Object.keys(r).length === 0) delete this.updates[row];
      return;
    }
    (this.updates[row] ??= {})[col] = value;
  }

  revertCell(row: number, col: number): void {
    const r = this.updates[row];
    if (!r) return;
    delete r[col];
    if (Object.keys(r).length === 0) delete this.updates[row];
  }

  revertRow(row: number): void {
    delete this.updates[row];
    delete this.deleted[row];
  }

  /** Insert-row cell; undefined means DEFAULT. */
  insertValue(index: number, col: number): Value | undefined {
    return this.inserts[index]?.[col];
  }

  setInsertCell(index: number, col: number, value: Value | undefined): void {
    const row = this.inserts[index];
    if (!row) return;
    if (value === undefined) delete row[col];
    else row[col] = value;
  }

  addRow(): number {
    this.inserts.push({});
    return this.inserts.length - 1;
  }

  removeInsert(index: number): void {
    this.inserts.splice(index, 1);
  }

  toggleDelete(rows: number[]): void {
    const allDeleted = rows.every((r) => this.deleted[r]);
    for (const r of rows) {
      if (allDeleted) delete this.deleted[r];
      else this.deleted[r] = true;
    }
  }

  discard(): void {
    this.updates = {};
    this.deleted = {};
    this.inserts = [];
  }

  #pk(rows: Value[][], row: number): Record<string, Value> {
    const out: Record<string, Value> = {};
    const idx = this.pkIndexes ?? [];
    this.primaryKey.forEach((k, i) => (out[k] = rows[row][idx[i]]));
    return out;
  }

  /** Changes in the shape `db.applyChanges` expects. Rows both updated and deleted only delete. */
  toChangeSet(rows: Value[][]): RowChangeSet {
    const updates = Object.entries(this.updates)
      .filter(([row]) => !this.deleted[Number(row)])
      .map(([row, cols]) => {
        const set: Record<string, Value> = {};
        for (const [col, v] of Object.entries(cols)) set[this.columns[Number(col)].name] = $state.snapshot(v) as Value;
        return { pk: this.#pk(rows, Number(row)), set };
      });
    const deletes = Object.keys(this.deleted).map((row) => this.#pk(rows, Number(row)));
    const inserts = this.inserts.map((r) => {
      const out: Record<string, Value> = {};
      for (const [col, v] of Object.entries(r)) out[this.columns[Number(col)].name] = $state.snapshot(v) as Value;
      return out;
    });
    return { updates, inserts, deletes };
  }
}
