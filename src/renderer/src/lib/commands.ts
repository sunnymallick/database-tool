/**
 * App-level commands shared by the native menu, keyboard shortcuts, and the
 * command palette.
 */
import type { MenuAction } from '@shared/types';
import { isElectron } from '$lib/api.svelte';
import { dialogs } from '$lib/stores/dialogs.svelte';
import { layout } from '$lib/stores/layout.svelte';
import { openSqlFile, saveQueryTab, tabs } from '$lib/stores/tabs.svelte';
import { askAi } from '$lib/ai-actions';
import { isTextInput } from '$lib/utils';
import { isMac, matchesShortcut } from '$lib/keys';

export interface AppCommand {
  id: string;
  label: string;
  group: 'General' | 'Query' | 'View' | 'Connections' | 'Tabs';
  shortcut?: string;
  keywords?: string;
  /** Hidden from the palette when false. */
  enabled?: () => boolean;
  run: () => void;
}

const hasQuery = () => tabs.activeQuery !== null;

export const commands: AppCommand[] = [
  { id: 'new-query', label: 'New query tab', group: 'Query', shortcut: 'Mod-t', run: () => void tabs.openQuery() },
  {
    id: 'run-query',
    label: 'Run statement or selection',
    group: 'Query',
    shortcut: 'Mod-Enter',
    enabled: hasQuery,
    run: () => void tabs.activeQuery?.run('auto')
  },
  {
    id: 'run-script',
    label: 'Run whole script',
    group: 'Query',
    shortcut: 'Shift-Mod-Enter',
    enabled: hasQuery,
    run: () => void tabs.activeQuery?.run('script')
  },
  {
    id: 'cancel-query',
    label: 'Cancel running query',
    group: 'Query',
    enabled: () => !!tabs.activeQuery?.running,
    run: () => void tabs.activeQuery?.cancel()
  },
  { id: 'format-sql', label: 'Format SQL', group: 'Query', shortcut: 'Shift-Mod-f', enabled: hasQuery, run: () => tabs.activeQuery?.format() },
  { id: 'open-sql-file', label: 'Open SQL file…', group: 'Query', shortcut: 'Mod-o', run: () => void openSqlFile() },
  {
    id: 'save-sql-file',
    label: 'Save',
    group: 'Query',
    shortcut: 'Mod-s',
    enabled: hasQuery,
    run: () => {
      const t = tabs.activeQuery;
      if (t) void saveQueryTab(t, false);
    }
  },
  {
    id: 'save-sql-file-as',
    label: 'Save as…',
    group: 'Query',
    shortcut: 'Shift-Mod-s',
    enabled: hasQuery,
    run: () => {
      const t = tabs.activeQuery;
      if (t) void saveQueryTab(t, true);
    }
  },
  {
    id: 'toggle-history',
    label: 'Show query history',
    group: 'Query',
    enabled: hasQuery,
    run: () => {
      const t = tabs.activeQuery;
      if (t) t.sidePanel = t.sidePanel === 'history' ? null : 'history';
    }
  },
  {
    id: 'toggle-snippets',
    label: 'Show snippets',
    group: 'Query',
    enabled: hasQuery,
    run: () => {
      const t = tabs.activeQuery;
      if (t) t.sidePanel = t.sidePanel === 'snippets' ? null : 'snippets';
    }
  },
  {
    id: 'new-connection',
    label: 'New connection…',
    group: 'Connections',
    shortcut: 'Shift-Mod-n',
    run: () => dialogs.openConnection(null)
  },
  {
    id: 'import-dbtool',
    label: 'Import connections from dbTool…',
    group: 'Connections',
    keywords: 'import dbtool migrate',
    run: () => (dialogs.importOpen = true)
  },
  {
    id: 'close-tab',
    label: 'Close tab',
    group: 'Tabs',
    shortcut: 'Mod-w',
    enabled: () => tabs.active !== null,
    run: () => {
      if (tabs.activeId) void tabs.close(tabs.activeId);
    }
  },
  { id: 'next-tab', label: 'Next tab', group: 'Tabs', shortcut: 'Shift-Mod-]', run: () => tabs.cycle(1) },
  { id: 'prev-tab', label: 'Previous tab', group: 'Tabs', shortcut: 'Shift-Mod-[', run: () => tabs.cycle(-1) },
  {
    id: 'close-other-tabs',
    label: 'Close other tabs',
    group: 'Tabs',
    enabled: () => tabs.tabs.length > 1,
    run: () => {
      if (tabs.activeId) void tabs.closeOthers(tabs.activeId);
    }
  },
  { id: 'toggle-sidebar', label: 'Toggle sidebar', group: 'View', shortcut: 'Mod-b', run: () => layout.toggleSidebar() },
  {
    id: 'toggle-ai',
    label: 'Toggle AI assistant',
    group: 'View',
    shortcut: 'Shift-Mod-a',
    keywords: 'claude chat assistant',
    run: () => layout.toggleAi()
  },
  {
    id: 'ask-ai-editor',
    label: 'Ask AI about the current query',
    group: 'View',
    keywords: 'claude explain',
    enabled: hasQuery,
    run: () => askAi('Explain what this query does and suggest improvements.', { includeEditor: true, conn: tabs.activeConn() })
  },
  {
    id: 'command-palette',
    label: 'Command palette',
    group: 'General',
    shortcut: 'Mod-k',
    enabled: () => false,
    run: () => (dialogs.paletteOpen = true)
  },
  { id: 'open-settings', label: 'Settings…', group: 'General', shortcut: 'Mod-,', keywords: 'preferences theme', run: () => (dialogs.settingsOpen = true) },
  {
    id: 'show-shortcuts',
    label: 'Keyboard shortcuts',
    group: 'General',
    shortcut: 'Shift-Mod-/',
    keywords: 'keys help cheatsheet',
    run: () => (dialogs.shortcutsOpen = true)
  }
];

export function command(id: string): AppCommand | undefined {
  return commands.find((c) => c.id === id);
}

const MENU_TO_COMMAND: Record<MenuAction, string> = {
  'new-query': 'new-query',
  'new-connection': 'new-connection',
  'open-sql-file': 'open-sql-file',
  'save-sql-file': 'save-sql-file',
  'save-sql-file-as': 'save-sql-file-as',
  'close-tab': 'close-tab',
  'toggle-sidebar': 'toggle-sidebar',
  'toggle-ai': 'toggle-ai',
  'open-settings': 'open-settings',
  'show-shortcuts': 'show-shortcuts',
  'command-palette': 'command-palette',
  'run-query': 'run-query',
  'format-sql': 'format-sql'
};

export function runMenuAction(action: MenuAction): void {
  const cmd = command(MENU_TO_COMMAND[action]);
  if (cmd && cmd.id !== 'command-palette' && cmd.enabled && !cmd.enabled()) return;
  cmd?.run();
}

/**
 * Shortcuts the native menu owns inside Electron. In a plain browser there is
 * no menu, so the renderer binds them itself.
 */
const MENU_SHORTCUTS: [string, MenuAction][] = [
  ['Mod-t', 'new-query'],
  ['Shift-Mod-n', 'new-connection'],
  ['Mod-o', 'open-sql-file'],
  ['Mod-s', 'save-sql-file'],
  ['Shift-Mod-s', 'save-sql-file-as'],
  ['Mod-w', 'close-tab'],
  ['Mod-b', 'toggle-sidebar'],
  ['Shift-Mod-a', 'toggle-ai'],
  ['Mod-k', 'command-palette'],
  ['Mod-,', 'open-settings']
];

/** Renderer-level shortcuts (both environments). */
const RENDERER_SHORTCUTS: [string, () => void][] = [
  ['Shift-Mod-]', () => tabs.cycle(1)],
  ['Shift-Mod-[', () => tabs.cycle(-1)],
  ['Ctrl-Tab', () => tabs.cycle(1)],
  ['Ctrl-Shift-Tab', () => tabs.cycle(-1)]
];

/** Global keydown handler installed on window by the shell. */
export function handleGlobalKeydown(e: KeyboardEvent): void {
  if (e.defaultPrevented) return;
  if (!isElectron) {
    for (const [keys, action] of MENU_SHORTCUTS) {
      if (matchesShortcut(e, keys)) {
        e.preventDefault();
        runMenuAction(action);
        return;
      }
    }
  }
  // Run shortcuts also work while the results grid or toolbar has focus (the editor handles its own).
  if (!isTextInput(e.target) && tabs.activeQuery) {
    if (matchesShortcut(e, 'Mod-Enter')) {
      e.preventDefault();
      void tabs.activeQuery.run('auto');
      return;
    }
    if (matchesShortcut(e, 'Shift-Mod-Enter')) {
      e.preventDefault();
      void tabs.activeQuery.run('script');
      return;
    }
  }
  for (const [keys, fn] of RENDERER_SHORTCUTS) {
    if (matchesShortcut(e, keys)) {
      e.preventDefault();
      fn();
      return;
    }
  }
  // Mod-1..9 jumps to a tab.
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key) && !isTextInput(e.target)) {
    const list = tabs.tabs;
    const idx = e.key === '9' ? list.length - 1 : Number(e.key) - 1;
    if (list[idx]) {
      e.preventDefault();
      tabs.activate(list[idx].id);
    }
    return;
  }
  if (matchesShortcut(e, 'Shift-Mod-/')) {
    e.preventDefault();
    dialogs.shortcutsOpen = true;
  }
}
