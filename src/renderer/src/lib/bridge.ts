/**
 * Seams between the workbench UI and the AI panel, which are built
 * independently. The workbench registers `WorkbenchBridge`; the AI panel
 * registers `AiBridge`. Callers use the exported `workbench` / `ai` objects,
 * which no-op safely until the other side registers.
 */
import type { EditorSnapshot } from '@shared/ai';
import type { ConnRef } from '@shared/types';

export interface OpenQueryTabOptions {
  sql: string;
  conn?: ConnRef | null;
  title?: string;
  /** Run the SQL immediately after opening. */
  run?: boolean;
}

/** Implemented by the workbench (tabs, editor, layout). */
export interface WorkbenchBridge {
  /** Connection of the focused tab, or the sidebar selection. */
  activeConn(): ConnRef | null;
  /** The focused query editor, or null when no query tab is focused. */
  activeEditor(): EditorSnapshot | null;
  openQueryTab(opts: OpenQueryTabOptions): void;
  /** Replace the focused editor's SQL. Returns false when no query tab is focused. */
  replaceActiveEditorSql(sql: string): boolean;
  /** Insert at the cursor of the focused editor. Returns false when no query tab is focused. */
  insertIntoActiveEditor(sql: string): boolean;
  openTable(conn: ConnRef, schema: string, table: string): void;
  setAiPanelOpen(open: boolean): void;
}

export interface AskAiOptions {
  conn?: ConnRef | null;
  /** Attach the active editor's SQL as context. */
  includeEditor?: boolean;
  /** Send immediately instead of only filling the input. */
  send?: boolean;
}

/** Implemented by the AI panel. */
export interface AiBridge {
  /** Open the AI panel and prefill (or send) a prompt. */
  ask(prompt: string, opts?: AskAiOptions): void;
}

let workbenchImpl: WorkbenchBridge | null = null;
let aiImpl: AiBridge | null = null;

export function registerWorkbench(impl: WorkbenchBridge): () => void {
  workbenchImpl = impl;
  return () => {
    if (workbenchImpl === impl) workbenchImpl = null;
  };
}

export function registerAi(impl: AiBridge): () => void {
  aiImpl = impl;
  return () => {
    if (aiImpl === impl) aiImpl = null;
  };
}

export const workbench: WorkbenchBridge = {
  activeConn: () => workbenchImpl?.activeConn() ?? null,
  activeEditor: () => workbenchImpl?.activeEditor() ?? null,
  openQueryTab: (opts) => workbenchImpl?.openQueryTab(opts),
  replaceActiveEditorSql: (sql) => workbenchImpl?.replaceActiveEditorSql(sql) ?? false,
  insertIntoActiveEditor: (sql) => workbenchImpl?.insertIntoActiveEditor(sql) ?? false,
  openTable: (conn, schema, table) => workbenchImpl?.openTable(conn, schema, table),
  setAiPanelOpen: (open) => workbenchImpl?.setAiPanelOpen(open)
};

export const ai: AiBridge = {
  ask: (prompt, opts) => aiImpl?.ask(prompt, opts)
};
