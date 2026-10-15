<!-- Breadcrumb for table-like tabs: connection / database / schema.table. -->
<script lang="ts">
  import Eye from '@lucide/svelte/icons/eye';
  import Table2 from '@lucide/svelte/icons/table-2';
  import type { ConnRef, TableKind } from '@shared/types';
  import StatusDot from '$lib/components/connections/StatusDot.svelte';
  import { connections, resolveDb } from '$lib/stores/connections.svelte';

  interface Props {
    conn: ConnRef;
    schema: string;
    table: string;
    tableKind: TableKind;
  }

  let { conn, schema: schemaName, table, tableKind }: Props = $props();

  const profile = $derived(connections.byId(conn.profileId));
  const db = $derived(profile ? resolveDb(conn, profile) : '');
</script>

<div class="flex min-w-0 shrink items-center gap-1.5 text-[12.5px]">
  <StatusDot state={connections.stateOf(conn)} error={connections.statusOf(conn)?.error} />
  <span
    class="hidden max-w-[360px] truncate text-muted lg:inline"
    class:text-prod={profile?.production}
    title={`${profile?.name ?? 'Unknown connection'}${db ? ` / ${db}` : ''}`}
  >
    {profile?.name ?? 'Unknown connection'}{db ? ` / ${db}` : ''}
  </span>
  <span class="hidden text-faint lg:inline">/</span>
  {#if tableKind === 'table'}
    <Table2 class="size-3.5 shrink-0 text-accent/80" />
  {:else}
    <Eye class="size-3.5 shrink-0 text-[var(--syn-type)]" />
  {/if}
  <span class="min-w-0 truncate font-medium">
    {#if schemaName && !(profile?.kind === 'sqlite' && schemaName === 'main')}<span class="font-normal text-muted">{schemaName}.</span>{/if}{table}
  </span>
  {#if tableKind !== 'table'}
    <span class="badge h-4 shrink-0 bg-active text-[9.5px] text-muted">{tableKind === 'view' ? 'View' : 'Mat. view'}</span>
  {/if}
</div>
