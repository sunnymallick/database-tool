/**
 * Standalone harness for the AI panel (browser only): `pnpm dev:web`, then
 * open /ai-preview.html. Mounts AiPanel in a right-hand dock with the mock
 * backend and a fake workbench, plus controls for theme and context.
 *
 * URL params: ?theme=light, ?conn=prod|readonly|none, ?ai=nocli|login (mock status),
 * ?prompt=... (auto-send once mounted).
 */
import { mount } from 'svelte';
import './app.css';
import type { ApiResult, PreloadBridge } from '@shared/api';
import type { EditorSnapshot } from '@shared/ai';
import { DEFAULT_SETTINGS, type AppSettings, type ConnRef, type ConnectionProfile, type ConnectionStatus } from '@shared/types';
import { registerWorkbench, ai } from '$lib/bridge';
import { createMockBridge } from '$lib/mock';
import AiPanel from '$lib/components/ai/AiPanel.svelte';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark';

// -- deterministic connections for the preview ---------------------------------

const now = new Date().toISOString();
function profile(p: Partial<ConnectionProfile> & Pick<ConnectionProfile, 'id' | 'name' | 'kind'>): ConnectionProfile {
  return {
    host: 'localhost',
    port: 0,
    database: '',
    username: '',
    filePath: '',
    ssl: false,
    trustServerCertificate: false,
    options: {},
    extraDatabases: [],
    color: null,
    group: null,
    production: false,
    readOnly: false,
    hasPassword: false,
    createdAt: now,
    updatedAt: now,
    ...p
  };
}

const profiles: ConnectionProfile[] = [
  profile({ id: 'shop', name: 'Shop (sample)', kind: 'sqlite', filePath: '/data/sample.sqlite' }),
  profile({ id: 'analytics', name: 'Analytics', kind: 'postgres', database: 'analytics', production: true }),
  profile({ id: 'legacy', name: 'Legacy ERP', kind: 'mssql', database: 'ERP', readOnly: true })
];
const statuses: ConnectionStatus[] = profiles.map((p) => ({ profileId: p.id, database: p.database, state: 'connected' }));
let settings: AppSettings = { ...DEFAULT_SETTINGS };

const base = createMockBridge();
const listeners = new Set<(event: string, payload: unknown) => void>();
const overrides: Record<string, (req: unknown) => unknown> = {
  'connections.list': () => profiles,
  'connections.statuses': () => statuses,
  'settings.get': () => settings,
  'settings.update': (patch) => {
    settings = { ...settings, ...(patch as Partial<AppSettings>) };
    return settings;
  },
  'shell.openExternal': (req) => {
    log(`openExternal ${(req as { url: string }).url}`);
  }
};
const bridge: PreloadBridge = {
  platform: base.platform,
  async invoke(method, req) {
    const fn = overrides[method];
    if (fn) return { ok: true, data: structuredClone(fn(req)) } as ApiResult<unknown>;
    return base.invoke(method, req);
  },
  on(listener) {
    listeners.add(listener);
    const off = base.on(listener);
    return () => {
      listeners.delete(listener);
      off();
    };
  }
};
window.bridge = bridge;

// -- fake workbench --------------------------------------------------------------

const connParam = params.get('conn');
let activeConn: ConnRef | null =
  connParam === 'none' ? null : { profileId: connParam === 'prod' ? 'analytics' : connParam === 'readonly' ? 'legacy' : 'shop' };
let editorSql = 'SELECT c.full_name, COUNT(o.id) AS orders\nFROM customers c\nLEFT JOIN orders o ON o.customer_id = c.id\nGROUP BY c.id\nORDER BY orders DESC\nLIMIT 20;';
let hasEditor = true;

const editor = (): EditorSnapshot | null =>
  hasEditor ? { tabId: 'tab-1', title: 'Query 1', sql: editorSql, selection: null, conn: activeConn } : null;

registerWorkbench({
  activeConn: () => activeConn,
  activeEditor: editor,
  openQueryTab: (o) => log(`openQueryTab (${o.title ?? 'untitled'}):\n${o.sql}`),
  replaceActiveEditorSql: (sql) => {
    if (!hasEditor) return false;
    editorSql = sql;
    log(`replaceActiveEditorSql:\n${sql}`);
    return true;
  },
  insertIntoActiveEditor: (sql) => {
    if (!hasEditor) return false;
    editorSql += `\n${sql}`;
    log(`insertIntoActiveEditor:\n${sql}`);
    return true;
  },
  openTable: (c, s, t) => log(`openTable ${c.profileId} ${s}.${t}`),
  setAiPanelOpen: (open) => {
    dock.style.display = open ? '' : 'none';
    log(`setAiPanelOpen(${open})`);
  }
});

// -- layout -----------------------------------------------------------------------

const app = document.getElementById('app')!;
app.className = 'flex h-full';
app.innerHTML = `
  <main class="flex min-w-0 flex-1 flex-col gap-3 overflow-auto p-5 text-[12.5px]">
    <div class="text-[15px] font-semibold">AI panel preview</div>
    <div class="flex flex-wrap items-center gap-2">
      <button class="btn btn-sm" data-act="theme">Toggle theme</button>
      <select class="select !w-auto" data-act="conn">
        <option value="shop">Active tab: Shop (SQLite)</option>
        <option value="analytics">Active tab: Analytics (production)</option>
        <option value="legacy">Active tab: Legacy ERP (read-only)</option>
        <option value="">No active tab connection</option>
      </select>
      <label class="flex items-center gap-1.5"><input type="checkbox" data-act="editor" checked /> Query tab focused</label>
      <button class="btn btn-sm" data-act="ask">ai.ask (prefill)</button>
      <button class="btn btn-sm" data-act="ask-send">ai.ask (send)</button>
    </div>
    <p class="text-muted">Mock prompts: anything (read flow + proposal), "insert …" (approval), "insert … prod" (production approval), "error", "login".</p>
    <pre id="log" class="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-sunken p-2 font-mono text-[11px] text-muted"></pre>
  </main>
  <aside id="dock" class="h-full w-[400px] shrink-0 border-l border-border"></aside>
`;
const dock = document.getElementById('dock')!;
const logEl = document.getElementById('log')!;
function log(line: string) {
  logEl.textContent = `${new Date().toLocaleTimeString()}  ${line}\n${logEl.textContent ?? ''}`;
}

const connSelect = app.querySelector<HTMLSelectElement>('[data-act="conn"]')!;
connSelect.value = activeConn?.profileId ?? '';
app.addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
  if (act === 'theme') {
    const html = document.documentElement;
    html.dataset.theme = html.dataset.theme === 'light' ? 'dark' : 'light';
  } else if (act === 'ask') {
    ai.ask('Find tables related to orders');
  } else if (act === 'ask-send') {
    ai.ask('How many orders are there per status?', { send: true });
  }
});
app.addEventListener('change', (e) => {
  const el = e.target as HTMLInputElement;
  if (el.dataset.act === 'conn') activeConn = el.value ? { profileId: el.value } : null;
  if (el.dataset.act === 'editor') hasEditor = el.checked;
});

mount(AiPanel, { target: dock });

const auto = params.get('prompt');
if (auto) setTimeout(() => ai.ask(auto, { send: true }), 300);
