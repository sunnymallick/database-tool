<!--
  Table data tab: paged rows (db.rows), WHERE filter, server-side sort, total
  count, pager, and inline editing with the pending-changes flow.
-->
<script lang="ts">
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import ChevronsLeft from '@lucide/svelte/icons/chevrons-left';
  import ChevronsRight from '@lucide/svelte/icons/chevrons-right';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Funnel from '@lucide/svelte/icons/funnel';
  import Info from '@lucide/svelte/icons/info';
  import Plus from '@lucide/svelte/icons/plus';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import SquareTerminal from '@lucide/svelte/icons/square-terminal';
  import TableProperties from '@lucide/svelte/icons/table-properties';
  import X from '@lucide/svelte/icons/x';
  import { untrack } from 'svelte';
  import type { SortSpec, TablePage, TableRef, Value } from '@shared/types';
  import { call, errorMessage } from '$lib/api.svelte';
  import ConnectionBadge from '$lib/components/table/ConnectionBadge.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import { EditSession } from '$lib/grid/edit-session.svelte';
  import PendingChangesBar from '$lib/grid/PendingChangesBar.svelte';
  import ResultsGrid from '$lib/grid/ResultsGrid.svelte';
  import { displayName, equalsCondition, ident } from '$lib/sql-text';
  import { connections } from '$lib/stores/connections.svelte';
  import { dialogs } from '$lib/stores/dialogs.svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import { tabs, type TableTab } from '$lib/stores/tabs.svelte';
  import { cn, formatCount } from '$lib/utils';

  interface Props {
    tab: TableTab;
    /** Data loads the first time the tab becomes active (restored sessions stay quiet). */
    active?: boolean;
  }

  let { tab, active = true }: Props = $props();
  let activated = $state(false);
  $effect(() => {
    if (active) activated = true;
  });

  const profile = $derived(connections.byId(tab.conn.profileId));
  const kind = $derived(profile?.kind ?? 'postgres');
  const pageSize = $derived(Math.max(1, settings.value.pageSize || 200));

  let whereDraft = $state('');
  let where = $state('');
  let sort = $state<SortSpec[]>([]);
  let offset = $state(0);
  let page = $state.raw<TablePage | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let seq = 0;
  let session = $state.raw<EditSession | null>(null);

  const ref = $derived<TableRef>({ conn: tab.conn, schema: tab.schema, table: tab.table });
  const total = $derived(page?.total ?? null);
  const rows = $derived(page?.result.rows ?? []);
  const isView = $derived(tab.tableKind !== 'table');
  const noPk = $derived(!!page && !isView && page.primaryKey.length === 0);
  const editable = $derived(!!page && !isView && !noPk && !profile?.readOnly && !!session?.canEdit);
  const lastPage = $derived(total != null ? Math.max(0, Math.ceil(total / pageSize) - 1) : null);
  const pageIndex = $derived(Math.floor(offset / pageSize));

  async function load() {
    const my = ++seq;
    loading = true;
    try {
      if (!(await connections.ensureConnected(tab.conn))) {
        error = connections.statusOf(tab.conn)?.error ?? 'Not connected';
        return;
      }
      const res = await call('db.rows', {
        table: $state.snapshot(ref) as TableRef,
        where: where.trim() || undefined,
        orderBy: $state.snapshot(sort) as SortSpec[],
        limit: pageSize,
        offset,
        countTotal: true
      });
      if (my !== seq) return;
      page = res;
      error = null;
      session = new EditSession(res.result.columns, res.primaryKey);
    } catch (err) {
      if (my !== seq) return;
      error = errorMessage(err);
    } finally {
      if (my === seq) loading = false;
    }
  }

  // Reload when the query inputs change or a reload is requested.
  $effect(() => {
    void [where, sort, offset, pageSize, tab.reloadSeq];
    if (!activated) return;
    untrack(() => void load());
  });

  /** Ask before throwing away pending edits. */
  async function guard(): Promise<boolean> {
    if (!session?.hasChanges) return true;
    return dialogs.confirm({
      title: `Discard ${session.count} pending ${session.count === 1 ? 'change' : 'changes'}?`,
      message: 'Reloading the table drops edits that have not been applied.',
      confirmLabel: 'Discard changes',
      danger: true
    });
  }

  async function applyFilter(next: string) {
    if (!(await guard())) {
      whereDraft = where;
      return;
    }
    whereDraft = next;
    where = next;
    offset = 0;
  }

  async function setSort(next: SortSpec[]) {
    if (!(await guard())) return;
    sort = next;
    offset = 0;
  }

  async function goto(nextOffset: number) {
    if (!(await guard())) return;
    offset = Math.max(0, nextOffset);
  }

  async function refresh() {
    if (!(await guard())) return;
    tab.reloadSeq++;
  }

  function filterBy(column: string, v: Value) {
    const cond = equalsCondition(kind, column, v);
    void applyFilter(where.trim() ? `(${where.trim()}) AND ${cond}` : cond);
  }

  function openAsQuery() {
    const parts = [`SELECT *`, `FROM ${displayName(kind, tab.schema, tab.table)}`];
    if (where.trim()) parts.push(`WHERE ${where.trim()}`);
    if (sort.length) parts.push(`ORDER BY ${sort.map((s) => `${ident(kind, s.column)}${s.desc ? ' DESC' : ''}`).join(', ')}`);
    let sql = parts.join('\n');
    if (kind === 'mssql') sql = sql.replace(/^SELECT \*/, `SELECT TOP ${pageSize} *`);
    else sql += `\nLIMIT ${pageSize}`;
    tabs.openQuery({ conn: tab.conn, sql: `${sql};` });
  }

  function addRow() {
    session?.addRow();
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <!-- Toolbar -->
  <div
    class={cn(
      'flex h-10 shrink-0 items-center gap-2 border-b px-2',
      profile?.production ? 'border-prod/60 bg-prod-soft' : 'border-border bg-panel'
    )}
  >
    <ConnectionBadge conn={tab.conn} schema={tab.schema} table={tab.table} tableKind={tab.tableKind} />
    {#if profile?.production}
      <span class="badge h-5 shrink-0 bg-prod text-white"><ShieldAlert class="size-3" />Production</span>
    {/if}
    <form
      class="relative ml-1 flex min-w-[160px] flex-1 items-center"
      onsubmit={(e) => {
        e.preventDefault();
        void applyFilter(whereDraft);
      }}
    >
      <span class="pointer-events-none absolute left-2 flex items-center gap-1 font-mono text-[11px] font-semibold text-[var(--syn-keyword)]">
        <Funnel class="size-3 text-faint" />WHERE
      </span>
      <input
        class={cn('input h-7 pr-7 pl-[68px] font-mono text-[12px]', where && 'border-accent/60')}
        placeholder="Filter rows, e.g. status = 'paid' AND total > 100"
        bind:value={whereDraft}
        spellcheck="false"
        aria-label="WHERE filter"
        onkeydown={(e) => {
          if (e.key === 'Escape' && whereDraft) {
            e.preventDefault();
            void applyFilter('');
          }
        }}
      />
      {#if whereDraft || where}
        <button
          type="button"
          class="absolute right-1 flex size-5 items-center justify-center rounded text-faint hover:text-fg"
          aria-label="Clear filter"
          onclick={() => applyFilter('')}
        >
          <X class="size-3" />
        </button>
      {/if}
    </form>
    <div class="flex shrink-0 items-center gap-0.5">
      <IconButton icon={RefreshCw} label="Refresh" iconClass={loading ? 'animate-spin' : ''} onclick={refresh} />
      <IconButton icon={Plus} label="Add row" disabled={!editable} onclick={addRow} />
      <div class="mx-1 h-4 w-px bg-border"></div>
      <IconButton icon={TableProperties} label="Structure" onclick={() => tabs.openStructure(tab.conn, tab.schema, tab.table, tab.tableKind)} />
      <IconButton icon={SquareTerminal} label="Open as query" onclick={openAsQuery} />
    </div>
  </div>

  {#if isView || noPk || profile?.readOnly}
    <div class="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-sunken/60 px-3 text-[11.5px] text-muted">
      <Info class="size-3.5 shrink-0 text-faint" />
      {#if profile?.readOnly}
        This connection is read-only, so rows cannot be edited.
      {:else if isView}
        Views are read-only.
      {:else}
        This table has no primary key, so its rows are read-only.
      {/if}
    </div>
  {/if}

  {#if session && editable}
    <PendingChangesBar {session} {rows} table={ref} onApplied={() => tab.reloadSeq++} />
  {/if}

  <div class="relative min-h-0 flex-1">
    {#if error && !page}
      <div class="flex h-full items-center justify-center p-6">
        <div class="flex max-w-lg items-start gap-2.5 rounded-lg border border-danger/40 bg-danger-soft p-3">
          <CircleAlert class="mt-0.5 size-4 shrink-0 text-danger" />
          <div class="min-w-0">
            <p class="text-[12.5px] font-semibold text-danger">Could not load {tab.table}</p>
            <pre class="mt-1 font-mono text-[12px] whitespace-pre-wrap select-text">{error}</pre>
            <button class="btn btn-sm mt-2" onclick={() => tab.reloadSeq++}>Retry</button>
          </div>
        </div>
      </div>
    {:else if page}
      <ResultsGrid
        columns={page.result.columns}
        rows={page.result.rows}
        sortMode="server"
        {sort}
        onSortChange={setSort}
        edits={session}
        {editable}
        rowNumberStart={offset + 1}
        dialect={kind}
        table={{ schema: tab.schema, table: tab.table }}
        exportName={tab.table}
        durationMs={page.result.durationMs}
        {loading}
        resetKey={`${offset}|${where}`}
        onFilter={filterBy}
      >
        {#snippet footerStart()}
          {#if error}
            <span class="flex items-center gap-1 text-danger" title={error}><CircleAlert class="size-3" />{error}</span>
          {/if}
        {/snippet}
        {#snippet footerEnd()}
          <div class="flex shrink-0 items-center gap-0.5 whitespace-nowrap">
            <IconButton icon={ChevronsLeft} label="First page" size="sm" disabled={offset === 0 || loading} onclick={() => goto(0)} />
            <IconButton icon={ChevronLeft} label="Previous page" size="sm" disabled={offset === 0 || loading} onclick={() => goto(offset - pageSize)} />
            <span class="px-1.5 tabular-nums">
              {#if rows.length}
                {formatCount(offset + 1)}–{formatCount(offset + rows.length)}{total != null ? ` of ${formatCount(total)}` : ''}
              {:else}
                0 rows
              {/if}
            </span>
            <IconButton
              icon={ChevronRight}
              label="Next page"
              size="sm"
              disabled={loading || (lastPage != null ? pageIndex >= lastPage : rows.length < pageSize)}
              onclick={() => goto(offset + pageSize)}
            />
            <IconButton
              icon={ChevronsRight}
              label="Last page"
              size="sm"
              disabled={loading || lastPage == null || pageIndex >= lastPage}
              onclick={() => lastPage != null && goto(lastPage * pageSize)}
            />
          </div>
        {/snippet}
      </ResultsGrid>
    {:else}
      <div class="flex h-full items-center justify-center gap-2 text-[12.5px] text-faint">
        <span class="spinner size-4 text-accent"></span>Loading {tab.table}…
      </div>
    {/if}
  </div>
</div>

