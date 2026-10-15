<!--
  Sidebar tree: connections -> databases -> schemas -> tables / views /
  routines. Virtualized flat rows, lazy loading, keyboard navigation, and one
  shared context menu.
-->
<script lang="ts">
  import { ContextMenu } from 'bits-ui';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Copy from '@lucide/svelte/icons/copy';
  import Database from '@lucide/svelte/icons/database';
  import Eye from '@lucide/svelte/icons/eye';
  import Folder from '@lucide/svelte/icons/folder';
  import Layers from '@lucide/svelte/icons/layers';
  import Lock from '@lucide/svelte/icons/lock';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Plug from '@lucide/svelte/icons/plug';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Server from '@lucide/svelte/icons/server';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import SquareFunction from '@lucide/svelte/icons/square-function';
  import SquareTerminal from '@lucide/svelte/icons/square-terminal';
  import Table2 from '@lucide/svelte/icons/table-2';
  import TableProperties from '@lucide/svelte/icons/table-properties';
  import Trash from '@lucide/svelte/icons/trash';
  import Unplug from '@lucide/svelte/icons/unplug';
  import CopyPlus from '@lucide/svelte/icons/copy-plus';
  import FileCode from '@lucide/svelte/icons/file-code';
  import { toast } from 'svelte-sonner';
  import type { ConnRef, ConnectionProfile, RoutineInfo, TableInfo } from '@shared/types';
  import { call, errorMessage } from '$lib/api.svelte';
  import { askAi } from '$lib/ai-actions';
  import { connections } from '$lib/stores/connections.svelte';
  import { dialogs } from '$lib/stores/dialogs.svelte';
  import { layout } from '$lib/stores/layout.svelte';
  import { schema } from '$lib/stores/schema.svelte';
  import { tabs } from '$lib/stores/tabs.svelte';
  import { cn, copyText } from '$lib/utils';
  import { displayName, selectTopSql } from '$lib/sql-text';
  import StatusDot from '$lib/components/connections/StatusDot.svelte';
  import { buildTree, dbKey, folderLabel, schemaKey, type TreeRow } from './tree-model';

  interface Props {
    filter?: string;
  }

  let { filter = '' }: Props = $props();

  const ROW = 26;
  const tree = $derived(buildTree(filter));
  const rows = $derived(tree.rows);

  let scroller = $state<HTMLDivElement | null>(null);
  let scrollTop = $state(0);
  let viewport = $state(400);
  let selectedKey = $state<string | null>(null);
  let menuRow = $state<TreeRow | null>(null);

  const first = $derived(Math.max(0, Math.floor(scrollTop / ROW) - 8));
  const last = $derived(Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW) + 8));
  const visible = $derived(rows.slice(first, last).map((row, i) => ({ row, index: first + i })));

  // Load whatever expanded nodes still need data.
  $effect(() => {
    for (const req of tree.toLoad) {
      if (req.kind === 'schemas') void loadSchemas(req.ref);
      else if (req.kind === 'tables') void schema.loadTables(req.ref, req.schema);
      else void schema.loadRoutines(req.ref, req.schema);
    }
  });

  $effect(() => {
    if (!scroller) return;
    const ro = new ResizeObserver(() => (viewport = scroller?.clientHeight ?? 400));
    ro.observe(scroller);
    return () => ro.disconnect();
  });

  async function loadSchemas(ref: ConnRef) {
    const data = await schema.loadSchemas(ref);
    const p = connections.byId(ref.profileId);
    if (!data || !p) return;
    const db = p.kind === 'sqlite' ? '' : (ref.database ?? p.database);
    // First expansion: open the default schema.
    const anyOpen = data.schemas.some((s) => layout.isExpanded(schemaKey(p.id, db, s)));
    const def = data.schemas.includes(data.defaultSchema) ? data.defaultSchema : data.schemas[0];
    if (!anyOpen && def) layout.setExpanded(schemaKey(p.id, db, def), true);
  }

  // -- expansion -------------------------------------------------------------

  function isExpandable(row: TreeRow): boolean {
    return row.type === 'group' || row.type === 'profile' || row.type === 'database' || row.type === 'schema' || row.type === 'folder';
  }

  function rowExpanded(row: TreeRow): boolean {
    return 'expanded' in row ? row.expanded : false;
  }

  async function setOpen(row: TreeRow, open: boolean) {
    switch (row.type) {
      case 'group':
        layout.setExpanded(`${row.key}:collapsed`, !open);
        break;
      case 'folder':
        if (row.folder === 'tables') layout.setExpanded(`${row.key}:collapsed`, !open);
        else layout.setExpanded(row.key, open);
        break;
      case 'profile':
        if (!open) {
          layout.setExpanded(row.key, false);
          break;
        }
        layout.setExpanded(row.key, true);
        if (await connections.ensureConnected(row.ref)) {
          const p = row.profile;
          if (p.kind !== 'sqlite') {
            const anyOpen = connections.databasesOf(p).some((d) => layout.isExpanded(dbKey(p.id, d)));
            if (!anyOpen) layout.setExpanded(dbKey(p.id, p.database), true);
          }
        }
        break;
      case 'database':
        layout.setExpanded(row.key, open);
        if (open) void connections.ensureConnected(row.ref);
        break;
      case 'schema':
        layout.setExpanded(row.key, open);
        break;
    }
  }

  function toggle(row: TreeRow) {
    if (isExpandable(row)) void setOpen(row, !rowExpanded(row));
  }

  // -- selection & keyboard ----------------------------------------------------

  function select(row: TreeRow) {
    selectedKey = row.key;
    if ('ref' in row && row.ref) connections.selected = row.ref;
  }

  function activate(row: TreeRow) {
    if (row.type === 'table') openData(row.ref, row.table);
    else if (row.type === 'routine') void openRoutine(row.ref, row.routine);
    else if (row.type === 'status') row.retry?.();
    else toggle(row);
  }

  function scrollToIndex(i: number) {
    if (!scroller) return;
    const top = i * ROW;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + ROW > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + ROW - scroller.clientHeight;
  }

  function onKeydown(e: KeyboardEvent) {
    if (!rows.length) return;
    let idx = rows.findIndex((r) => r.key === selectedKey);
    const row = idx >= 0 ? rows[idx] : null;
    const move = (to: number) => {
      const i = Math.max(0, Math.min(rows.length - 1, to));
      select(rows[i]);
      scrollToIndex(i);
    };
    switch (e.key) {
      case 'ArrowDown':
        move(idx + 1);
        break;
      case 'ArrowUp':
        move(idx <= 0 ? 0 : idx - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(rows.length - 1);
        break;
      case 'PageDown':
        move(idx + Math.floor(viewport / ROW));
        break;
      case 'PageUp':
        move(idx - Math.floor(viewport / ROW));
        break;
      case 'ArrowRight':
        if (!row) return move(0);
        if (isExpandable(row) && !rowExpanded(row)) void setOpen(row, true);
        else if (isExpandable(row)) move(idx + 1);
        break;
      case 'ArrowLeft':
        if (!row) return;
        if (isExpandable(row) && rowExpanded(row)) void setOpen(row, false);
        else if (row.parent) {
          idx = rows.findIndex((r) => r.key === row.parent);
          if (idx >= 0) move(idx);
        }
        break;
      case 'Enter':
        if (row) activate(row);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  // -- actions -------------------------------------------------------------------

  function openData(ref: ConnRef, t: TableInfo) {
    tabs.openTable(ref, t.schema, t.name, t.kind);
  }

  function openStructure(ref: ConnRef, t: TableInfo) {
    tabs.openStructure(ref, t.schema, t.name, t.kind);
  }

  function newQuery(ref: ConnRef, sql = '') {
    tabs.openQuery({ conn: ref, sql });
  }

  async function openRoutine(ref: ConnRef, r: RoutineInfo) {
    try {
      const def = await call('db.routineDefinition', { conn: ref, schema: r.schema, name: r.name, kind: r.kind });
      tabs.openQuery({ conn: ref, sql: def, title: r.name });
    } catch (err) {
      toast.error(`Could not load ${r.kind} ${r.name}`, { description: errorMessage(err) });
    }
  }

  function refresh(row: TreeRow) {
    if (row.type === 'profile') {
      schema.invalidate(row.ref, true);
      toast.success(`Refreshed ${row.profile.name}`);
    } else if ('ref' in row) {
      schema.invalidate(row.ref);
    }
  }

  async function removeProfile(p: ConnectionProfile) {
    const ok = await dialogs.confirm({
      title: `Delete “${p.name}”?`,
      message: 'The connection profile and its stored password are removed. Your databases are not touched.',
      confirmLabel: 'Delete connection',
      danger: true
    });
    if (!ok) return;
    try {
      await connections.remove(p);
      toast.success(`Deleted ${p.name}`);
    } catch (err) {
      toast.error('Delete failed', { description: errorMessage(err) });
    }
  }

  function askAiAboutTable(ref: ConnRef, t: TableInfo) {
    const p = connections.byId(ref.profileId);
    const name = displayName(p?.kind ?? 'postgres', t.schema, t.name);
    askAi(
      `Tell me about the ${t.kind === 'table' ? 'table' : 'view'} ${name}: what it stores, how it relates to other tables, and a few useful queries.`,
      { conn: ref }
    );
  }

  function onContextMenu(row: TreeRow) {
    menuRow = row;
    select(row);
  }

  function hostLine(p: ConnectionProfile): string {
    if (p.kind === 'sqlite') return p.filePath || 'SQLite';
    const inst = p.options.instanceName ? `\\${p.options.instanceName}` : '';
    return `${p.username ? `${p.username}@` : ''}${p.host}${inst}:${p.port}${p.database ? `/${p.database}` : ''}`;
  }

  function compactCount(n: number | undefined): string {
    if (n == null || n < 0) return '';
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
</script>

<ContextMenu.Root>
  <ContextMenu.Trigger class="flex min-h-0 flex-1 flex-col">
    <div
      bind:this={scroller}
      class="min-h-0 flex-1 overflow-auto px-1.5 pb-2 outline-none focus-visible:ring-1 focus-visible:ring-focus focus-visible:ring-inset"
      role="tree"
      aria-label="Connections"
      tabindex="0"
      onscroll={() => (scrollTop = scroller?.scrollTop ?? 0)}
      onkeydown={onKeydown}
    >
      <div class="relative" style="height: {rows.length * ROW}px">
        {#each visible as { row, index } (row.key)}
          <!-- Keyboard navigation is handled by the tree container (roving selection). -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div
            class={cn('row-item absolute right-0 left-0', row.type === 'group' && 'hover:bg-transparent')}
            style="top: {index * ROW}px; padding-left: {6 + row.depth * 14}px"
            role="treeitem"
            aria-selected={selectedKey === row.key}
            aria-expanded={isExpandable(row) ? rowExpanded(row) : undefined}
            aria-level={row.depth + 1}
            tabindex="-1"
            data-selected={selectedKey === row.key}
            data-key={row.key}
            onclick={() => select(row)}
            ondblclick={() => activate(row)}
            oncontextmenu={() => onContextMenu(row)}
          >
            {#if isExpandable(row)}
              <button
                type="button"
                tabindex="-1"
                class="-ml-0.5 flex size-4 shrink-0 items-center justify-center rounded text-faint hover:text-fg"
                aria-label={rowExpanded(row) ? 'Collapse' : 'Expand'}
                onclick={(e) => {
                  e.stopPropagation();
                  select(row);
                  toggle(row);
                }}
                ondblclick={(e) => e.stopPropagation()}
              >
                <ChevronRight class={cn('size-3.5 transition-transform duration-100', rowExpanded(row) && 'rotate-90')} />
              </button>
            {:else}
              <span class="w-4 shrink-0"></span>
            {/if}

            {#if row.type === 'group'}
              <span class="truncate text-[11px] font-semibold tracking-wider text-faint uppercase">{row.name}</span>
              <span class="ml-1 text-[11px] text-faint/70">{row.count}</span>
            {:else if row.type === 'profile'}
              {@const p = row.profile}
              {@const connState = connections.profileState(p)}
              <Server
                class="size-3.5 shrink-0"
                style={p.color ? `color: ${p.color}` : undefined}
              />
              <span class="min-w-0 truncate font-medium" title={`${p.name}\n${hostLine(p)}`}>{p.name}</span>
              {#if p.production}
                <span class="badge h-4 shrink-0 bg-prod px-1 text-[9.5px] text-white">Prod</span>
              {/if}
              {#if p.readOnly}
                <span title="Read-only connection" class="shrink-0 text-faint"><Lock class="size-3" /></span>
              {/if}
              <span class="ml-auto flex shrink-0 items-center pl-1">
                <StatusDot state={connState} error={connections.profileError(p)} />
              </span>
            {:else if row.type === 'database'}
              {@const connState = connections.stateOf(row.ref)}
              <Database class={cn('size-3.5 shrink-0', connState === 'connected' ? 'text-muted' : 'text-faint')} />
              <span class={cn('min-w-0 truncate', connState !== 'connected' && 'text-muted')}>{row.name}</span>
              {#if row.isDefault && row.profile.extraDatabases.length > 0}
                <span class="shrink-0 text-[11px] text-faint">default</span>
              {/if}
              <span class="ml-auto flex shrink-0 items-center pl-1">
                <StatusDot state={connState} error={connections.statusOf(row.ref)?.error} />
              </span>
            {:else if row.type === 'schema'}
              <Layers class="size-3.5 shrink-0 text-faint" />
              <span class="min-w-0 truncate">{row.schema}</span>
            {:else if row.type === 'folder'}
              <Folder class="size-3.5 shrink-0 text-faint" />
              <span class="truncate text-muted">{folderLabel(row.folder)}</span>
              {#if row.count != null}<span class="text-[11px] text-faint">{row.count}</span>{/if}
            {:else if row.type === 'table'}
              {#if row.table.kind === 'table'}
                <Table2 class="size-3.5 shrink-0 text-accent/80" />
              {:else}
                <Eye class="size-3.5 shrink-0 text-[var(--syn-type)]" />
              {/if}
              <span class="min-w-0 truncate" title={row.table.comment ?? undefined}>{row.table.name}</span>
              {#if row.table.kind === 'materialized_view'}<span class="text-[10.5px] text-faint">mat</span>{/if}
              {#if row.table.rowEstimate != null}
                <span class="ml-auto shrink-0 pl-2 text-[11px] text-faint tabular-nums">{compactCount(row.table.rowEstimate)}</span>
              {/if}
            {:else if row.type === 'routine'}
              <SquareFunction class="size-3.5 shrink-0 text-[var(--syn-function)]" />
              <span class="min-w-0 truncate">{row.routine.name}</span>
              <span class="min-w-0 truncate font-mono text-[11px] text-faint" title={row.routine.signature}>
                ({row.routine.signature ?? ''}){row.routine.returns ? ` → ${row.routine.returns}` : ''}
              </span>
            {:else if row.type === 'status'}
              {#if row.status === 'loading'}
                <span class="spinner size-3 text-faint"></span>
                <span class="text-[12px] text-faint">{row.message}</span>
              {:else if row.status === 'error' || row.status === 'disconnected'}
                {#if row.status === 'error'}<CircleAlert class="size-3.5 shrink-0 text-danger" />{/if}
                <span class={cn('min-w-0 truncate text-[12px]', row.status === 'error' ? 'text-danger' : 'text-faint')} title={row.message}>
                  {row.message}
                </span>
                {#if row.retry}
                  <button
                    type="button"
                    class="ml-auto shrink-0 text-[11.5px] text-accent hover:underline"
                    onclick={(e) => {
                      e.stopPropagation();
                      row.retry?.();
                    }}
                  >
                    {row.status === 'error' ? 'Retry' : 'Connect'}
                  </button>
                {/if}
              {:else}
                <span class="text-[12px] text-faint italic">{row.message}</span>
              {/if}
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </ContextMenu.Trigger>

  <ContextMenu.Portal>
    <ContextMenu.Content class="menu-content" onCloseAutoFocus={(e) => e.preventDefault()}>
      {#if menuRow?.type === 'profile'}
        {@const p = menuRow.profile}
        {@const ref = menuRow.ref}
        {@const connState = connections.profileState(p)}
        <div class="menu-label truncate">{p.name}</div>
        {#if connState === 'connected' || connState === 'connecting'}
          <ContextMenu.Item class="menu-item" onSelect={() => connections.disconnectProfile(p)}>
            <Unplug /> Disconnect
          </ContextMenu.Item>
        {:else}
          <ContextMenu.Item class="menu-item" onSelect={() => menuRow && setOpen(menuRow, true)}>
            <Plug /> Connect
          </ContextMenu.Item>
        {/if}
        <ContextMenu.Item class="menu-item" onSelect={() => newQuery(ref)}>
          <SquareTerminal /> New query
        </ContextMenu.Item>
        <ContextMenu.Item class="menu-item" disabled={connState !== 'connected'} onSelect={() => menuRow && refresh(menuRow)}>
          <RefreshCw /> Refresh
        </ContextMenu.Item>
        <ContextMenu.Separator class="menu-separator" />
        <ContextMenu.Item class="menu-item" onSelect={() => dialogs.openConnection(p)}>
          <Pencil /> Edit…
        </ContextMenu.Item>
        <ContextMenu.Item class="menu-item" onSelect={() => connections.duplicate(p)}>
          <CopyPlus /> Duplicate
        </ContextMenu.Item>
        <ContextMenu.Separator class="menu-separator" />
        <ContextMenu.Item class="menu-item menu-item-danger" onSelect={() => removeProfile(p)}>
          <Trash /> Delete…
        </ContextMenu.Item>
      {:else if menuRow?.type === 'database'}
        {@const ref = menuRow.ref}
        {@const connState = connections.stateOf(ref)}
        <div class="menu-label truncate">{menuRow.name}</div>
        {#if connState === 'connected' || connState === 'connecting'}
          <ContextMenu.Item class="menu-item" onSelect={() => connections.disconnect(ref)}>
            <Unplug /> Disconnect
          </ContextMenu.Item>
        {:else}
          <ContextMenu.Item class="menu-item" onSelect={() => menuRow && setOpen(menuRow, true)}>
            <Plug /> Connect
          </ContextMenu.Item>
        {/if}
        <ContextMenu.Item class="menu-item" onSelect={() => newQuery(ref)}>
          <SquareTerminal /> New query
        </ContextMenu.Item>
        <ContextMenu.Item class="menu-item" disabled={connState !== 'connected'} onSelect={() => menuRow && refresh(menuRow)}>
          <RefreshCw /> Refresh
        </ContextMenu.Item>
      {:else if menuRow?.type === 'schema' || menuRow?.type === 'folder'}
        {@const ref = menuRow.ref}
        <ContextMenu.Item class="menu-item" onSelect={() => newQuery(ref)}>
          <SquareTerminal /> New query
        </ContextMenu.Item>
        <ContextMenu.Item class="menu-item" onSelect={() => menuRow && refresh(menuRow)}>
          <RefreshCw /> Refresh
        </ContextMenu.Item>
        {#if menuRow.type === 'schema'}
          {@const name = menuRow.schema}
          <ContextMenu.Item class="menu-item" onSelect={() => copyText(name)}>
            <Copy /> Copy name
          </ContextMenu.Item>
        {/if}
      {:else if menuRow?.type === 'table'}
        {@const ref = menuRow.ref}
        {@const t = menuRow.table}
        {@const kind = menuRow.profile.kind}
        <div class="menu-label truncate">{t.schema ? `${t.schema}.` : ''}{t.name}</div>
        <ContextMenu.Item class="menu-item" onSelect={() => openData(ref, t)}>
          <Table2 /> Open data
        </ContextMenu.Item>
        <ContextMenu.Item class="menu-item" onSelect={() => openStructure(ref, t)}>
          <TableProperties /> Structure
        </ContextMenu.Item>
        <ContextMenu.Item class="menu-item" onSelect={() => newQuery(ref, selectTopSql(kind, t.schema, t.name, 100))}>
          <SquareTerminal /> New query: SELECT … {kind === 'mssql' ? 'TOP' : 'LIMIT'} 100
        </ContextMenu.Item>
        <ContextMenu.Separator class="menu-separator" />
        <ContextMenu.Item class="menu-item" onSelect={() => copyText(t.name)}>
          <Copy /> Copy name
        </ContextMenu.Item>
        <ContextMenu.Item class="menu-item" onSelect={() => copyText(displayName(kind, t.schema, t.name))}>
          <Copy /> Copy qualified name
        </ContextMenu.Item>
        <ContextMenu.Separator class="menu-separator" />
        <ContextMenu.Item class="menu-item" onSelect={() => askAiAboutTable(ref, t)}>
          <Sparkles /> Ask AI about this {t.kind === 'table' ? 'table' : 'view'}
        </ContextMenu.Item>
      {:else if menuRow?.type === 'routine'}
        {@const ref = menuRow.ref}
        {@const r = menuRow.routine}
        <div class="menu-label truncate">{r.name}</div>
        <ContextMenu.Item class="menu-item" onSelect={() => openRoutine(ref, r)}>
          <FileCode /> Show definition
        </ContextMenu.Item>
        <ContextMenu.Item class="menu-item" onSelect={() => copyText(r.name)}>
          <Copy /> Copy name
        </ContextMenu.Item>
      {:else if menuRow?.type === 'group'}
        <ContextMenu.Item class="menu-item" onSelect={() => dialogs.openConnection(null)}>
          <Server /> New connection…
        </ContextMenu.Item>
      {:else}
        <ContextMenu.Item class="menu-item" onSelect={() => dialogs.openConnection(null)}>
          <Server /> New connection…
        </ContextMenu.Item>
      {/if}
    </ContextMenu.Content>
  </ContextMenu.Portal>
</ContextMenu.Root>

{#if rows.length === 0 && filter}
  <p class="px-4 py-3 text-[12px] text-faint">No matches for “{filter}” in loaded schemas.</p>
{/if}
