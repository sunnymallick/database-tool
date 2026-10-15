/**
 * WorkbenchBridge implementation used by the AI panel.
 */
import { registerWorkbench, type WorkbenchBridge } from '$lib/bridge';
import { layout } from '$lib/stores/layout.svelte';
import { tabs } from '$lib/stores/tabs.svelte';

const impl: WorkbenchBridge = {
  activeConn: () => tabs.activeConn(),
  activeEditor: () => tabs.activeQuery?.snapshot() ?? null,
  openQueryTab: (opts) => {
    tabs.openQuery({ sql: opts.sql, conn: opts.conn, title: opts.title ?? null, run: opts.run });
  },
  replaceActiveEditorSql: (sql) => {
    const t = tabs.activeQuery;
    if (!t) return false;
    t.replaceSql(sql);
    return true;
  },
  insertIntoActiveEditor: (sql) => {
    const t = tabs.activeQuery;
    if (!t) return false;
    t.insertText(sql);
    return true;
  },
  openTable: (conn, schemaName, table) => {
    tabs.openTable(conn, schemaName, table);
  },
  setAiPanelOpen: (open) => {
    layout.aiOpen = open;
  }
};

export function installWorkbenchBridge(): () => void {
  return registerWorkbench(impl);
}
