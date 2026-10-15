<!--
  App settings. Changes apply immediately through settings.update(). Reads its
  open state from `dialogs.settingsOpen`.
-->
<script lang="ts">
  import { untrack, type Component } from 'svelte';
  import Bot from '@lucide/svelte/icons/bot';
  import CodeXml from '@lucide/svelte/icons/code-xml';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import Info from '@lucide/svelte/icons/info';
  import Minus from '@lucide/svelte/icons/minus';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Moon from '@lucide/svelte/icons/moon';
  import Paintbrush from '@lucide/svelte/icons/paintbrush';
  import Plus from '@lucide/svelte/icons/plus';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import Sun from '@lucide/svelte/icons/sun';
  import Table2 from '@lucide/svelte/icons/table-2';
  import type { AiStatus } from '@shared/ai';
  import { DEFAULT_SETTINGS, type AppInfo, type ThemeMode } from '@shared/types';
  import { call, errorMessage } from '$lib/api.svelte';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import Switch from '$lib/components/ui/Switch.svelte';
  import { dialogs } from '$lib/stores/dialogs.svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import { clamp, cn, debounce, formatCount } from '$lib/utils';

  interface SelectItem {
    value: string;
    label: string;
    hint?: string;
  }

  type Section = 'appearance' | 'editor' | 'results' | 'safety' | 'ai' | 'about';

  const SECTIONS: { id: Section; label: string; icon: Component<{ class?: string }> }[] = [
    { id: 'appearance', label: 'Appearance', icon: Paintbrush },
    { id: 'editor', label: 'Editor', icon: CodeXml },
    { id: 'results', label: 'Results', icon: Table2 },
    { id: 'safety', label: 'Safety', icon: ShieldAlert },
    { id: 'ai', label: 'AI assistant', icon: Bot },
    { id: 'about', label: 'About', icon: Info }
  ];

  const THEMES: { value: ThemeMode; label: string; icon: Component<{ class?: string }> }[] = [
    { value: 'dark', label: 'Dark', icon: Moon },
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'system', label: 'System', icon: Monitor }
  ];

  const FALLBACK_MODELS = [DEFAULT_SETTINGS.aiModel, 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];

  const FONT_MIN = 10;
  const FONT_MAX = 24;
  const ROWCAP_MAX = 1_000_000;
  const PAGE_MIN = 50;
  const PAGE_MAX = 5000;

  const uid = $props.id();
  const fid = (name: string) => `settings-${uid}-${name}`;

  let section = $state<Section>('appearance');

  // Local text mirrors for inputs that commit on a debounce.
  let fontSizeText = $state('');
  let rowCapText = $state('');
  let pageSizeText = $state('');
  let cliPathText = $state('');

  let aiStatus = $state<AiStatus | null>(null);
  let aiStatusState = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
  let aiStatusError = $state('');
  let appInfo = $state<AppInfo | null>(null);
  let appInfoError = $state('');

  function parseInt10(text: string): number | null {
    const t = text.trim();
    if (!/^\d+$/.test(t)) return null;
    return Number.parseInt(t, 10);
  }

  const commitFontSize = debounce((text: string) => {
    const n = parseInt10(text);
    if (n === null) return;
    const v = clamp(n, FONT_MIN, FONT_MAX);
    if (v !== settings.value.editorFontSize) void settings.update({ editorFontSize: v });
  }, 400);

  const commitRowCap = debounce((text: string) => {
    const n = parseInt10(text);
    if (n === null) return;
    const v = clamp(n, 0, ROWCAP_MAX);
    if (v !== settings.value.rowCap) void settings.update({ rowCap: v });
  }, 400);

  const commitPageSize = debounce((text: string) => {
    const n = parseInt10(text);
    if (n === null) return;
    const v = clamp(n, PAGE_MIN, PAGE_MAX);
    if (v !== settings.value.pageSize) void settings.update({ pageSize: v });
  }, 400);

  const commitCliPath = debounce((text: string) => {
    const v = text.trim();
    if (v !== settings.value.claudeCliPath) void settings.update({ claudeCliPath: v });
  }, 400);

  function flushAll(): void {
    commitFontSize.flush();
    commitRowCap.flush();
    commitPageSize.flush();
    commitCliPath.flush();
  }

  function syncFromSettings(): void {
    fontSizeText = String(settings.value.editorFontSize);
    rowCapText = String(settings.value.rowCap);
    pageSizeText = String(settings.value.pageSize);
    cliPathText = settings.value.claudeCliPath;
  }

  let wasOpen = false;
  $effect(() => {
    const open = dialogs.settingsOpen;
    untrack(() => {
      if (open && !wasOpen) {
        syncFromSettings();
        void loadAiStatus(false);
        if (!appInfo) void loadAppInfo();
      } else if (!open && wasOpen) {
        flushAll();
      }
    });
    wasOpen = open;
  });

  async function loadAiStatus(refresh: boolean): Promise<void> {
    aiStatusState = 'loading';
    try {
      aiStatus = await call('ai.status', refresh ? { refresh: true } : {});
      aiStatusState = 'ready';
    } catch (err) {
      aiStatusError = errorMessage(err);
      aiStatusState = 'error';
    }
  }

  async function loadAppInfo(): Promise<void> {
    try {
      appInfo = await call('app.info');
      appInfoError = '';
    } catch (err) {
      appInfoError = errorMessage(err);
    }
  }

  function stepFont(delta: number): void {
    const cur = parseInt10(fontSizeText) ?? settings.value.editorFontSize;
    const v = clamp(cur + delta, FONT_MIN, FONT_MAX);
    fontSizeText = String(v);
    commitFontSize.cancel();
    if (v !== settings.value.editorFontSize) void settings.update({ editorFontSize: v });
  }

  function modelLabel(id: string): string {
    const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id);
    if (!m) return id;
    return `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
  }

  const modelItems = $derived.by((): SelectItem[] => {
    const fromStatus = aiStatus?.models ?? [];
    const base: SelectItem[] = fromStatus.length
      ? fromStatus.map((m) => ({ value: m.id, label: m.label || modelLabel(m.id) }))
      : FALLBACK_MODELS.map((id) => ({ value: id, label: modelLabel(id) }));
    const seen = new Set<string>();
    const out: SelectItem[] = [];
    for (const item of base) {
      if (seen.has(item.value)) continue;
      seen.add(item.value);
      out.push({ ...item, hint: item.label === item.value ? undefined : item.value });
    }
    const current = settings.value.aiModel;
    if (current && !seen.has(current)) out.unshift({ value: current, label: modelLabel(current), hint: current });
    return out;
  });

  const previewSize = $derived(clamp(parseInt10(fontSizeText) ?? settings.value.editorFontSize, FONT_MIN, FONT_MAX));
</script>

<Dialog
  bind:open={dialogs.settingsOpen}
  title="Settings"
  width="max-w-[680px]"
  bodyClass="flex h-[min(460px,calc(100vh-160px))] overflow-hidden border-t border-border p-0"
>
  <nav class="flex w-[164px] shrink-0 flex-col gap-0.5 border-r border-border bg-sunken/40 p-2" aria-label="Settings sections">
    {#each SECTIONS as s (s.id)}
      {@const Icon = s.icon}
      <button
        type="button"
        class={cn(
          'flex h-7 items-center gap-2 rounded-md px-2 text-left text-[12.5px] transition-colors',
          section === s.id ? 'bg-active font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg'
        )}
        aria-current={section === s.id ? 'page' : undefined}
        onclick={() => (section = s.id)}
      >
        <Icon class="size-3.5 shrink-0" />
        {s.label}
      </button>
    {/each}
  </nav>

  <div class="min-w-0 flex-1 overflow-auto px-5 py-4">
    {#if section === 'appearance'}
      <h3 class="mb-3 text-[13px] font-semibold">Appearance</h3>
      <div class="flex flex-col gap-4">
        <div class="field">
          <span class="label" id={fid('theme')}>Theme</span>
          <div class="segmented self-start" role="group" aria-labelledby={fid('theme')}>
            {#each THEMES as t (t.value)}
              {@const Icon = t.icon}
              <button
                type="button"
                aria-pressed={settings.value.theme === t.value}
                onclick={() => settings.update({ theme: t.value })}
              >
                <Icon class="size-3.5" />{t.label}
              </button>
            {/each}
          </div>
          <p class="hint">System follows the macOS appearance setting.</p>
        </div>
      </div>
    {:else if section === 'editor'}
      <h3 class="mb-3 text-[13px] font-semibold">Editor</h3>
      <div class="flex flex-col gap-4">
        <div class="field">
          <label class="label" for={fid('font')}>Font size</label>
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="btn btn-icon"
              aria-label="Decrease font size"
              onclick={() => stepFont(-1)}
              disabled={previewSize <= FONT_MIN}
            >
              <Minus class="size-3.5" />
            </button>
            <input
              id={fid('font')}
              class="input w-[56px] text-center tabular-nums"
              inputmode="numeric"
              bind:value={fontSizeText}
              oninput={() => commitFontSize(fontSizeText)}
              onblur={() => {
                commitFontSize.flush();
                fontSizeText = String(settings.value.editorFontSize);
              }}
            />
            <button
              type="button"
              class="btn btn-icon"
              aria-label="Increase font size"
              onclick={() => stepFont(1)}
              disabled={previewSize >= FONT_MAX}
            >
              <Plus class="size-3.5" />
            </button>
            <span class="ml-1 hint">px ({FONT_MIN}–{FONT_MAX})</span>
          </div>
          <div
            class="mt-1 truncate rounded-md border border-border bg-bg px-3 py-2 font-mono leading-[1.6]"
            style:font-size="{previewSize}px"
            aria-hidden="true"
          >
            <span style:color="var(--syn-keyword)">SELECT</span>
            <span style:color="var(--syn-identifier)">id, email</span>
            <span style:color="var(--syn-keyword)">FROM</span>
            <span style:color="var(--syn-identifier)">customers</span>
            <span style:color="var(--syn-keyword)">WHERE</span>
            <span style:color="var(--syn-identifier)">country</span>
            <span style:color="var(--syn-operator)">=</span>
            <span style:color="var(--syn-string)">'DE'</span><span style:color="var(--syn-operator)">;</span>
          </div>
        </div>
        <Switch
          checked={settings.value.editorLineNumbers}
          onCheckedChange={(v) => settings.update({ editorLineNumbers: v })}
          label="Line numbers"
        />
        <Switch
          checked={settings.value.editorWordWrap}
          onCheckedChange={(v) => settings.update({ editorWordWrap: v })}
          label="Wrap long lines"
          hint="Soft-wrap lines at the editor width instead of scrolling horizontally."
        />
      </div>
    {:else if section === 'results'}
      <h3 class="mb-3 text-[13px] font-semibold">Results</h3>
      <div class="flex flex-col gap-4">
        <div class="field">
          <label class="label" for={fid('rowcap')}>Row cap for query results</label>
          <input
            id={fid('rowcap')}
            class="input w-[120px] tabular-nums"
            inputmode="numeric"
            bind:value={rowCapText}
            oninput={() => commitRowCap(rowCapText)}
            onblur={() => {
              commitRowCap.flush();
              rowCapText = String(settings.value.rowCap);
            }}
          />
          <p class="hint">
            Editor results stop loading rows past this number and offer “Fetch all rows”. 0 means unlimited.
            {#if settings.value.rowCap > 0}Currently {formatCount(settings.value.rowCap)} rows.{/if}
          </p>
        </div>
        <div class="field">
          <label class="label" for={fid('pagesize')}>Page size for table data</label>
          <input
            id={fid('pagesize')}
            class="input w-[120px] tabular-nums"
            inputmode="numeric"
            bind:value={pageSizeText}
            oninput={() => commitPageSize(pageSizeText)}
            onblur={() => {
              commitPageSize.flush();
              pageSizeText = String(settings.value.pageSize);
            }}
          />
          <p class="hint">Rows per page when browsing a table ({PAGE_MIN}–{formatCount(PAGE_MAX)}).</p>
        </div>
      </div>
    {:else if section === 'safety'}
      <h3 class="mb-3 text-[13px] font-semibold">Safety</h3>
      <div class="flex flex-col gap-4">
        <Switch
          checked={settings.value.confirmProductionWrites}
          onCheckedChange={(v) => settings.update({ confirmProductionWrites: v })}
          tone="danger"
          label="Confirm writes on production connections"
          hint="Ask before running INSERT, UPDATE, DELETE, DDL, or applying grid edits on a connection marked Production."
        />
        <p class="rounded-md border border-border bg-sunken/50 px-3 py-2 text-[12px] leading-snug text-muted">
          Read-only connections always block write statements in the app, independent of this setting. Mark a
          connection as Production or Read-only in its connection settings.
        </p>
      </div>
    {:else if section === 'ai'}
      <h3 class="mb-3 text-[13px] font-semibold">AI assistant</h3>
      <div class="flex flex-col gap-4">
        <div class="field">
          <label class="label" for={fid('model')}>Model</label>
          <Select
            id={fid('model')}
            class="w-[280px]"
            value={settings.value.aiModel}
            items={modelItems}
            onValueChange={(v) => settings.update({ aiModel: v })}
          />
        </div>
        <Switch
          checked={settings.value.aiAllowWrites}
          onCheckedChange={(v) => settings.update({ aiAllowWrites: v })}
          label="Allow write statements without approval"
          hint="Never applies to production connections; those always ask."
        />
        <div class="field">
          <label class="label" for={fid('cli')}>Claude CLI path</label>
          <input
            id={fid('cli')}
            class="input font-mono text-[12px]"
            placeholder="Auto-detect"
            bind:value={cliPathText}
            oninput={() => commitCliPath(cliPathText)}
            onblur={() => commitCliPath.flush()}
            autocomplete="off"
            spellcheck="false"
          />
          <div class="flex min-h-6 items-center gap-2">
            <span class="min-w-0 flex-1 text-[11.5px]">
              {#if aiStatusState === 'loading'}
                <span class="inline-flex items-center gap-1.5 text-muted"><span class="spinner size-3"></span>Checking…</span>
              {:else if aiStatusState === 'error'}
                <span class="text-faint" title={aiStatusError}>Status unavailable</span>
              {:else if aiStatus?.available}
                <span class="flex min-w-0 items-center gap-1.5">
                  <span class="status-dot bg-success"></span>
                  <span class="truncate font-mono text-muted" title={aiStatus.cliPath ?? ''}>{aiStatus.cliPath ?? 'claude'}</span>
                  {#if aiStatus.version}<span class="shrink-0 text-faint">v{aiStatus.version}</span>{/if}
                </span>
              {:else if aiStatus}
                <span class="flex min-w-0 items-center gap-1.5 text-danger">
                  <span class="status-dot bg-danger"></span>
                  <span class="truncate" title={aiStatus.error}>{aiStatus.error ?? 'Claude CLI not found'}</span>
                </span>
              {/if}
            </span>
            <button
              type="button"
              class="btn btn-sm"
              onclick={() => {
                commitCliPath.flush();
                void loadAiStatus(true);
              }}
              disabled={aiStatusState === 'loading'}
            >
              <RefreshCw class="size-3" />Refresh
            </button>
          </div>
          <p class="hint">Leave empty to find the <span class="font-mono">claude</span> CLI automatically.</p>
        </div>
      </div>
    {:else}
      <h3 class="mb-3 text-[13px] font-semibold">About</h3>
      {#if appInfo}
        <div class="flex flex-col gap-4">
          <div>
            <p class="text-[14px] font-semibold">{appInfo.name}</p>
            <p class="text-[12px] text-muted">Version {appInfo.version}</p>
          </div>
          <dl class="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1.5 text-[12px]">
            <dt class="text-muted">Electron</dt>
            <dd class="font-mono text-[11.5px]">{appInfo.electron}</dd>
            <dt class="text-muted">Node</dt>
            <dd class="font-mono text-[11.5px]">{appInfo.node}</dd>
            <dt class="text-muted">Chrome</dt>
            <dd class="font-mono text-[11.5px]">{appInfo.chrome}</dd>
            <dt class="text-muted">Platform</dt>
            <dd class="font-mono text-[11.5px]">{appInfo.platform}</dd>
          </dl>
          <div class="field">
            <span class="label">Data directory</span>
            <div class="flex items-center gap-2">
              <code
                class="min-w-0 flex-1 truncate rounded-md border border-border bg-sunken px-2 py-1 font-mono text-[11.5px] select-text"
                title={appInfo.dataDir}>{appInfo.dataDir}</code
              >
              <button
                type="button"
                class="btn btn-sm"
                onclick={() => appInfo && call('shell.showItemInFolder', { path: appInfo.dataDir }).catch(() => {})}
              >
                <FolderOpen class="size-3" />Reveal
              </button>
            </div>
            <p class="hint">Connection profiles, history, snippets, settings, and the saved session live here.</p>
          </div>
        </div>
      {:else if appInfoError}
        <p class="text-[12px] text-danger">{appInfoError}</p>
      {:else}
        <span class="inline-flex items-center gap-1.5 text-[12px] text-muted"><span class="spinner size-3"></span>Loading…</span>
      {/if}
    {/if}
  </div>
</Dialog>
