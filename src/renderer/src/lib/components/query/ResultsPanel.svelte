<!-- Results area of a query tab: one tab per result set, Messages, and the error panel. -->
<script lang="ts">
  import { untrack } from 'svelte';
  import { DropdownMenu } from 'bits-ui';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Download from '@lucide/svelte/icons/download';
  import Files from '@lucide/svelte/icons/files';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import Sheet from '@lucide/svelte/icons/sheet';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import MessageSquareText from '@lucide/svelte/icons/message-square-text';
  import Square from '@lucide/svelte/icons/square';
  import type { ResultSet, TableRef } from '@shared/types';
  import ResultsGrid from '$lib/grid/ResultsGrid.svelte';
  import PendingChangesBar from '$lib/grid/PendingChangesBar.svelte';
  import { EditSession } from '$lib/grid/edit-session.svelte';
  import { exportAllResults } from '$lib/grid/export-files';
  import Kbd from '$lib/components/ui/Kbd.svelte';
  import { connections } from '$lib/stores/connections.svelte';
  import { openSqlFiles, type QueryTab } from '$lib/stores/tabs.svelte';
  import { cn, formatCount, formatDuration } from '$lib/utils';
  import ErrorPanel from './ErrorPanel.svelte';

  interface Props {
    tab: QueryTab;
  }

  let { tab }: Props = $props();

  const profile = $derived(connections.byId(tab.conn?.profileId));
  const gridResults = $derived(tab.results.map((r, i) => ({ r, i })).filter(({ r }) => r.columns.length > 0));
  const hasOutput = $derived(tab.results.length > 0 || !!tab.error || tab.cancelled);
  const current = $derived(tab.activeResult >= 0 ? tab.results[tab.activeResult] : undefined);

  // One edit session per editable result, recreated on every run.
  let sessions = $state.raw<Record<number, EditSession>>({});
  $effect(() => {
    void tab.runSeq;
    const readOnly = untrack(() => !!profile?.readOnly);
    const next: Record<number, EditSession> = {};
    tab.results.forEach((r, i) => {
      if (r.editable && !readOnly) next[i] = new EditSession(r.columns, r.editable.primaryKey);
    });
    sessions = next;
  });

  function tableRef(r: ResultSet): TableRef | null {
    if (!r.editable || !tab.lastRequest) return null;
    return { conn: tab.lastRequest.conn, schema: r.editable.schema, table: r.editable.table };
  }

  let now = $state(Date.now());
  $effect(() => {
    if (!tab.running) return;
    const t = setInterval(() => (now = Date.now()), 100);
    return () => clearInterval(t);
  });

  const truncatedCount = $derived(gridResults.filter(({ r }) => r.truncated).length);
  const exportAll = $derived(
    gridResults.length > 1
      ? { count: gridResults.length, truncated: truncatedCount, run: (format: 'csv' | 'xlsx') => void exportAllResults(tab.results, format, tab.title) }
      : undefined
  );

  /** Default export file name for the result at `i` of the run. */
  function exportName(r: ResultSet, i: number): string {
    if (r.editable) return r.editable.table;
    if (gridResults.length < 2) return tab.title;
    return `${tab.title} - Result ${gridResults.findIndex((g) => g.i === i) + 1}`;
  }

  function firstLine(sql: string): string {
    const line = sql.replace(/\s+/g, ' ').trim();
    return line.length > 120 ? `${line.slice(0, 120)}…` : line;
  }

  function outcome(r: ResultSet): string {
    if (r.columns.length > 0) return `${formatCount(r.rows.length)} ${r.rows.length === 1 ? 'row' : 'rows'}${r.truncated ? ' (truncated)' : ''}`;
    if (r.rowsAffected != null) return `${formatCount(r.rowsAffected)} ${r.rowsAffected === 1 ? 'row' : 'rows'} affected`;
    return 'OK';
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-bg">
  <!-- Result tabs -->
  <div class="flex h-8 shrink-0 items-stretch gap-0.5 border-b border-border bg-panel px-1.5">
    {#if !hasOutput}
      <span class="flex items-center px-2.5 text-[12px] text-faint">Results</span>
    {/if}
    {#each gridResults as { r, i } (i)}
      <button
        type="button"
        class={cn(
          'relative flex items-center gap-1.5 px-2.5 text-[12px]',
          tab.activeResult === i ? 'text-fg' : 'text-muted hover:text-fg'
        )}
        onclick={() => (tab.activeResult = i)}
      >
        {gridResults.length > 1 ? `Result ${gridResults.findIndex((g) => g.i === i) + 1}` : 'Result'}
        <span class="rounded bg-active px-1 text-[10.5px] text-muted tabular-nums">{formatCount(r.rows.length)}{r.truncated ? '+' : ''}</span>
        {#if tab.activeResult === i}<span class="absolute inset-x-1.5 -bottom-px h-[2px] rounded-full bg-accent"></span>{/if}
      </button>
    {/each}
    {#if hasOutput}
      <button
        type="button"
        class={cn('relative flex items-center gap-1.5 px-2.5 text-[12px]', tab.activeResult === -1 ? 'text-fg' : 'text-muted hover:text-fg')}
        onclick={() => (tab.activeResult = -1)}
      >
        {#if tab.error}<CircleAlert class="size-3.5 text-danger" />{:else}<MessageSquareText class="size-3.5" />{/if}
        Messages
        {#if tab.activeResult === -1}<span class="absolute inset-x-1.5 -bottom-px h-[2px] rounded-full bg-accent"></span>{/if}
      </button>
    {/if}
    <div class="ml-auto flex items-center gap-2 pr-1 text-[11.5px] text-faint">
      {#if exportAll && !tab.running}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger class="btn btn-ghost btn-sm gap-1 px-1.5 text-[11.5px]" data-testid="export-all-results">
            <Download class="size-3.5" />Export all {exportAll.count}<ChevronDown class="size-3 text-faint" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content class="menu-content min-w-[220px]" align="end" sideOffset={4}>
              <DropdownMenu.Item class="menu-item" onSelect={() => exportAll.run('csv')}>
                <Files />CSV files, one per result…
              </DropdownMenu.Item>
              <DropdownMenu.Item class="menu-item" onSelect={() => exportAll.run('xlsx')}>
                <Sheet />Excel workbook, one sheet each…
              </DropdownMenu.Item>
              {#if exportAll.truncated > 0}
                <p class="max-w-[260px] px-2 py-1 text-[11px] leading-snug text-warning">
                  {exportAll.truncated === 1 ? '1 result was' : `${exportAll.truncated} results were`} cut off at the row cap. Fetch all rows first to export everything.
                </p>
              {/if}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <span class="h-3.5 w-px bg-border"></span>
      {/if}
      {#if tab.running}
        <span class="flex items-center gap-1.5 text-accent"><span class="spinner size-3"></span>Running · {formatDuration(now - tab.startedAt)}</span>
      {:else if tab.lastRun}
        {#if current}
          <span>{outcome(current)} · {formatDuration(current.durationMs)}</span>
        {:else if tab.error}
          <span class="text-danger">Failed · {formatDuration(tab.lastRun.durationMs)}</span>
        {:else if tab.cancelled}
          <span>Cancelled · {formatDuration(tab.lastRun.durationMs)}</span>
        {:else}
          <span>{tab.results.length} {tab.results.length === 1 ? 'statement' : 'statements'} · {formatDuration(tab.lastRun.durationMs)}</span>
        {/if}
      {/if}
    </div>
  </div>

  <!-- Body -->
  <div class="relative min-h-0 flex-1">
    {#if !hasOutput && !tab.running}
      <div class="flex h-full flex-col items-center justify-center gap-2 text-[12px] text-faint">
        <p>Run a query to see results here.</p>
        <div class="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5">
          <span class="flex items-center gap-1.5"><Kbd keys="Mod-Enter" /> statement or selection</span>
          <span class="flex items-center gap-1.5"><Kbd keys="Shift-Mod-Enter" /> whole script</span>
          <span class="flex items-center gap-1.5"><Kbd keys="Shift-Mod-f" /> format</span>
        </div>
        {#if !tab.sql.trim()}
          <button type="button" class="btn btn-sm mt-2" onclick={() => void openSqlFiles()} data-testid="open-sql-empty">
            <FolderOpen class="size-3.5" />Open .sql file…<Kbd keys="Mod-o" />
          </button>
        {/if}
      </div>
    {:else if tab.activeResult === -1}
      <div class="h-full overflow-auto p-3">
        {#if tab.error}
          <ErrorPanel {tab} />
        {/if}
        {#if tab.results.length || tab.cancelled}
          <ol class="mt-1 flex flex-col font-mono text-[12px]">
            {#each tab.results as r, i (i)}
              <li class="flex flex-col gap-0.5 border-b border-grid-line py-1.5 last:border-b-0">
                <div class="flex items-baseline gap-2">
                  <CircleCheck class="size-3.5 shrink-0 translate-y-0.5 text-success" />
                  <span class="min-w-0 flex-1 truncate text-muted" title={r.statement}>{firstLine(r.statement)}</span>
                  <span class="shrink-0 font-sans text-[11.5px] text-fg">{outcome(r)}</span>
                  <span class="w-16 shrink-0 text-right font-sans text-[11.5px] text-faint">{formatDuration(r.durationMs)}</span>
                </div>
                {#each r.messages ?? [] as m, j (j)}
                  <div class="pl-5.5 whitespace-pre-wrap text-faint select-text">{m}</div>
                {/each}
              </li>
            {/each}
            {#if tab.cancelled}
              <li class="flex items-center gap-2 py-1.5 text-warning">
                <Square class="size-3 fill-current" />Cancelled by user
              </li>
            {/if}
          </ol>
        {/if}
      </div>
    {:else if current}
      {@const i = tab.activeResult}
      {@const edits = sessions[i] ?? null}
      {@const ref = tableRef(current)}
      <div class="flex h-full min-h-0 flex-col">
        {#if edits && ref}
          <PendingChangesBar session={edits} rows={current.rows} table={ref} onApplied={() => tab.rerun()} />
        {/if}
        <div class="min-h-0 flex-1">
          <ResultsGrid
            columns={current.columns}
            rows={current.rows}
            sortMode="client"
            {edits}
            editable={!!edits}
            dialect={profile?.kind ?? null}
            table={current.editable ? { schema: current.editable.schema, table: current.editable.table } : null}
            exportName={exportName(current, i)}
            exportAllResults={exportAll}
            truncated={current.truncated}
            onFetchAll={() => tab.rerun({ rowCap: 0 })}
            durationMs={current.durationMs}
          />
        </div>
      </div>
    {/if}

    {#if tab.running}
      <div class="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden">
        <div class="loading-bar h-full w-1/3 bg-accent"></div>
      </div>
      {#if !hasOutput}
        <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 text-[12.5px] text-muted">
          <span class="spinner size-5 text-accent"></span>
          <span>Running… <span class="font-mono tabular-nums">{formatDuration(now - tab.startedAt)}</span></span>
          <button class="btn btn-sm" onclick={() => tab.cancel()}>Cancel</button>
        </div>
      {:else}
        <div class="pointer-events-none absolute inset-0 bg-bg/40"></div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .loading-bar {
    animation: slide 1.1s ease-in-out infinite;
  }
  @keyframes slide {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(300%);
    }
  }
</style>
