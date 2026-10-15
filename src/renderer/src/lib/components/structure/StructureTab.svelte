<!--
  Table structure: columns, indexes, foreign keys, referenced-by, checks, and DDL.
-->
<script lang="ts">
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Copy from '@lucide/svelte/icons/copy';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import Link2 from '@lucide/svelte/icons/link-2';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Table2 from '@lucide/svelte/icons/table-2';
  import { untrack } from 'svelte';
  import { toast } from 'svelte-sonner';
  import type { ForeignKeyInfo, TableStructure } from '@shared/types';
  import { call, errorMessage } from '$lib/api.svelte';
  import SqlEditor from '$lib/editor/SqlEditor.svelte';
  import ConnectionBadge from '$lib/components/table/ConnectionBadge.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import { connections } from '$lib/stores/connections.svelte';
  import { tabs, type TableTab } from '$lib/stores/tabs.svelte';
  import { cn, copyText, formatCount } from '$lib/utils';

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

  type Section = 'columns' | 'indexes' | 'foreignKeys' | 'referencedBy' | 'checks' | 'ddl';

  const profile = $derived(connections.byId(tab.conn.profileId));
  let section = $state<Section>('columns');
  let structure = $state.raw<TableStructure | null>(null);
  let ddl = $state<string | null>(null);
  let ddlError = $state<string | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  async function load() {
    loading = true;
    ddl = null;
    ddlError = null;
    const ref = { conn: $state.snapshot(tab.conn), schema: tab.schema, table: tab.table };
    try {
      if (!(await connections.ensureConnected(ref.conn))) {
        error = connections.statusOf(ref.conn)?.error ?? 'Not connected';
        return;
      }
      structure = await call('db.structure', ref);
      error = null;
    } catch (err) {
      error = errorMessage(err);
    } finally {
      loading = false;
    }
    try {
      ddl = await call('db.ddl', ref);
    } catch (err) {
      ddlError = errorMessage(err);
    }
  }

  $effect(() => {
    void tab.reloadSeq;
    if (!activated) return;
    untrack(() => void load());
  });

  const sections = $derived<{ id: Section; label: string; count?: number }[]>([
    { id: 'columns', label: 'Columns', count: structure?.columns.length },
    { id: 'indexes', label: 'Indexes', count: structure?.indexes.length },
    { id: 'foreignKeys', label: 'Foreign keys', count: structure?.foreignKeys.length },
    { id: 'referencedBy', label: 'Referenced by', count: structure?.referencedBy.length },
    { id: 'checks', label: 'Checks', count: structure?.checks.length },
    { id: 'ddl', label: 'DDL' }
  ]);

  function openRef(fk: ForeignKeyInfo, incoming: boolean) {
    if (incoming) tabs.openTable(tab.conn, fk.schema, fk.table);
    else tabs.openTable(tab.conn, fk.refSchema, fk.refTable);
  }

  function openRefStructure(fk: ForeignKeyInfo, incoming: boolean) {
    if (incoming) tabs.openStructure(tab.conn, fk.schema, fk.table);
    else tabs.openStructure(tab.conn, fk.refSchema, fk.refTable);
  }

  function qualified(schemaName: string, table: string) {
    return schemaName && schemaName !== tab.schema ? `${schemaName}.${table}` : table;
  }

  async function copyDdl() {
    if (!ddl) return;
    await copyText(ddl);
    toast.success('DDL copied');
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <div
    class={cn(
      'flex h-10 shrink-0 items-center gap-2 border-b px-2',
      profile?.production ? 'border-prod/60 bg-prod-soft' : 'border-border bg-panel'
    )}
  >
    <ConnectionBadge conn={tab.conn} schema={tab.schema} table={tab.table} tableKind={tab.tableKind} />
    {#if structure?.rowEstimate != null}
      <span class="shrink-0 text-[11.5px] text-faint">~{formatCount(structure.rowEstimate)} rows</span>
    {/if}
    <div class="ml-auto flex items-center gap-0.5">
      <IconButton icon={Table2} label="Open data" onclick={() => tabs.openTable(tab.conn, tab.schema, tab.table, tab.tableKind)} />
      <IconButton icon={RefreshCw} label="Refresh" iconClass={loading ? 'animate-spin' : ''} onclick={() => tab.reloadSeq++} />
    </div>
  </div>

  {#if structure?.comment}
    <div class="shrink-0 border-b border-border bg-sunken/50 px-3 py-1.5 text-[12px] text-muted">{structure.comment}</div>
  {/if}

  <div class="flex h-8 shrink-0 items-stretch gap-0.5 border-b border-border bg-panel px-1.5">
    {#each sections as s (s.id)}
      <button
        type="button"
        class={cn('relative flex items-center gap-1.5 px-2.5 text-[12px]', section === s.id ? 'text-fg' : 'text-muted hover:text-fg')}
        onclick={() => (section = s.id)}
      >
        {s.label}
        {#if s.count != null}<span class="rounded bg-active px-1 text-[10.5px] text-muted tabular-nums">{s.count}</span>{/if}
        {#if section === s.id}<span class="absolute inset-x-1.5 -bottom-px h-[2px] rounded-full bg-accent"></span>{/if}
      </button>
    {/each}
  </div>

  <div class="min-h-0 flex-1 overflow-auto bg-bg">
    {#if error && !structure}
      <div class="flex items-start gap-2 p-4 text-[12.5px] text-danger">
        <CircleAlert class="mt-0.5 size-4 shrink-0" />
        <div>
          <p class="font-semibold">Could not load the structure</p>
          <pre class="mt-1 font-mono text-[12px] whitespace-pre-wrap text-fg select-text">{error}</pre>
        </div>
      </div>
    {:else if !structure}
      <div class="flex h-full items-center justify-center gap-2 text-[12.5px] text-faint">
        <span class="spinner size-4 text-accent"></span>Loading structure…
      </div>
    {:else if section === 'columns'}
      <table class="struct">
        <thead>
          <tr><th class="w-10">#</th><th>Name</th><th>Type</th><th>Nullable</th><th>Default</th><th>Key</th><th>Comment</th></tr>
        </thead>
        <tbody>
          {#each structure.columns as c (c.name)}
            <tr>
              <td class="text-faint tabular-nums">{c.ordinal}</td>
              <td class="font-medium">
                <span class="flex items-center gap-1.5">
                  {#if c.isPrimaryKey}<KeyRound class="size-3 text-warning" />{/if}
                  <span class="select-text">{c.name}</span>
                </span>
              </td>
              <td class="font-mono text-[var(--syn-type)]">{c.type}</td>
              <td>{#if c.nullable}<span class="text-muted">NULL</span>{:else}<span class="font-medium">NOT NULL</span>{/if}</td>
              <td class="font-mono text-muted select-text">{c.defaultValue ?? ''}</td>
              <td>
                <span class="flex flex-wrap gap-1">
                  {#if c.isPrimaryKey}<span class="badge h-4 bg-warning-soft text-[9.5px] text-warning">PK</span>{/if}
                  {#if c.isIdentity}<span class="badge h-4 bg-accent-soft text-[9.5px] text-accent">Identity</span>{/if}
                  {#if c.isGenerated}<span class="badge h-4 bg-active text-[9.5px] text-muted">Generated</span>{/if}
                  {#if structure.foreignKeys.some((fk) => fk.columns.includes(c.name))}
                    <span class="badge h-4 bg-active text-[9.5px] text-muted">FK</span>
                  {/if}
                </span>
              </td>
              <td class="text-muted select-text">{c.comment ?? ''}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {:else if section === 'indexes'}
      {#if structure.indexes.length === 0}
        <p class="p-4 text-[12.5px] text-faint">No indexes.</p>
      {:else}
        <table class="struct">
          <thead><tr><th>Name</th><th>Columns</th><th>Type</th><th>Definition</th></tr></thead>
          <tbody>
            {#each structure.indexes as ix (ix.name)}
              <tr>
                <td class="font-medium select-text">{ix.name}</td>
                <td class="font-mono">{ix.columns.join(', ')}</td>
                <td>
                  <span class="flex flex-wrap gap-1">
                    {#if ix.primary}<span class="badge h-4 bg-warning-soft text-[9.5px] text-warning">Primary</span>{/if}
                    {#if ix.unique && !ix.primary}<span class="badge h-4 bg-accent-soft text-[9.5px] text-accent">Unique</span>{/if}
                    {#if ix.method}<span class="text-muted">{ix.method}</span>{/if}
                  </span>
                </td>
                <td class="font-mono text-[11.5px] text-muted select-text">{ix.definition ?? ''}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {:else if section === 'foreignKeys' || section === 'referencedBy'}
      {@const incoming = section === 'referencedBy'}
      {@const list = incoming ? structure.referencedBy : structure.foreignKeys}
      {#if list.length === 0}
        <p class="p-4 text-[12.5px] text-faint">{incoming ? 'No other table references this one.' : 'No foreign keys.'}</p>
      {:else}
        <table class="struct">
          <thead>
            <tr><th>Name</th><th>{incoming ? 'From' : 'Columns'}</th><th></th><th>{incoming ? 'Columns' : 'References'}</th><th>On update</th><th>On delete</th></tr>
          </thead>
          <tbody>
            {#each list as fk (fk.name + fk.table)}
              <tr>
                <td class="font-medium select-text">{fk.name}</td>
                {#if incoming}
                  <td>
                    <button class="link inline-flex items-center gap-1 font-mono" title="Open data (⌥-click for structure)" onclick={(e) => (e.altKey ? openRefStructure(fk, true) : openRef(fk, true))}>
                      <Link2 class="size-3" />{qualified(fk.schema, fk.table)}({fk.columns.join(', ')})
                    </button>
                  </td>
                  <td><ArrowRight class="size-3.5 text-faint" /></td>
                  <td class="font-mono">{fk.refColumns.join(', ')}</td>
                {:else}
                  <td class="font-mono">{fk.columns.join(', ')}</td>
                  <td><ArrowRight class="size-3.5 text-faint" /></td>
                  <td>
                    <button class="link inline-flex items-center gap-1 font-mono" title="Open data (⌥-click for structure)" onclick={(e) => (e.altKey ? openRefStructure(fk, false) : openRef(fk, false))}>
                      <Link2 class="size-3" />{qualified(fk.refSchema, fk.refTable)}({fk.refColumns.join(', ')})
                    </button>
                  </td>
                {/if}
                <td class="text-muted">{fk.onUpdate ?? ''}</td>
                <td class="text-muted">{fk.onDelete ?? ''}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {:else if section === 'checks'}
      {#if structure.checks.length === 0}
        <p class="p-4 text-[12.5px] text-faint">No check constraints.</p>
      {:else}
        <table class="struct">
          <thead><tr><th>Name</th><th>Definition</th></tr></thead>
          <tbody>
            {#each structure.checks as ck (ck.name)}
              <tr>
                <td class="font-medium select-text">{ck.name}</td>
                <td class="font-mono text-muted select-text">{ck.definition}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {:else if section === 'ddl'}
      <div class="flex h-full min-h-0 flex-col">
        <div class="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2">
          <span class="text-[11.5px] text-faint">Generated by the server; read-only.</span>
          <button class="btn btn-sm ml-auto" disabled={!ddl} onclick={copyDdl}><Copy class="size-3.5" />Copy</button>
        </div>
        <div class="min-h-0 flex-1">
          {#if ddlError}
            <p class="p-4 font-mono text-[12px] text-danger">{ddlError}</p>
          {:else if ddl === null}
            <p class="p-4 text-[12.5px] text-faint">Loading DDL…</p>
          {:else}
            <SqlEditor doc={ddl} kind={profile?.kind ?? null} readOnly />
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .struct {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    font-size: 12.5px;
  }
  .struct th {
    position: sticky;
    top: 0;
    z-index: 1;
    height: 28px;
    padding: 0 12px;
    text-align: left;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    color: var(--faint);
    background: var(--grid-header);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  .struct td {
    height: 28px;
    padding: 3px 12px;
    border-bottom: 1px solid var(--grid-line);
    vertical-align: middle;
  }
  .struct tbody tr:hover td {
    background: var(--hover);
  }
</style>
