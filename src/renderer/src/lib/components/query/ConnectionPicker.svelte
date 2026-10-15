<!--
  Connection + database selector for a tab. The database menu lists the
  profile's configured databases plus, once loaded, every database on the server.
-->
<script lang="ts">
  import { DropdownMenu } from 'bits-ui';
  import Check from '@lucide/svelte/icons/check';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Database from '@lucide/svelte/icons/database';
  import Plus from '@lucide/svelte/icons/plus';
  import Server from '@lucide/svelte/icons/server';
  import type { ConnRef } from '@shared/types';
  import StatusDot from '$lib/components/connections/StatusDot.svelte';
  import { connections, resolveDb } from '$lib/stores/connections.svelte';
  import { dialogs } from '$lib/stores/dialogs.svelte';
  import { schema } from '$lib/stores/schema.svelte';
  import { cn } from '$lib/utils';

  interface Props {
    conn: ConnRef | null;
    onChange: (conn: ConnRef) => void;
  }

  let { conn, onChange }: Props = $props();

  const profile = $derived(connections.byId(conn?.profileId));
  const db = $derived(conn && profile ? resolveDb(conn, profile) : '');
  const connState = $derived(connections.stateOf(conn));

  const serverDbs = $derived(profile ? schema.databases[profile.id] : undefined);
  const dbOptions = $derived.by(() => {
    if (!profile || profile.kind === 'sqlite') return [];
    const configured = connections.databasesOf(profile);
    const fromServer = serverDbs?.data ?? [];
    return [...new Set([...configured, ...fromServer, db].filter(Boolean))];
  });

  function pickProfile(id: string) {
    const p = connections.byId(id);
    if (!p) return;
    onChange(p.kind === 'sqlite' ? { profileId: p.id } : { profileId: p.id, database: p.database });
    void connections.ensureConnected(p.kind === 'sqlite' ? { profileId: p.id } : { profileId: p.id, database: p.database }, { quiet: true });
  }

  function pickDb(name: string) {
    if (!profile) return;
    const ref = { profileId: profile.id, database: name };
    onChange(ref);
    void connections.ensureConnected(ref, { quiet: true });
  }

  function loadServerDbs(open: boolean) {
    if (open && profile && profile.kind !== 'sqlite' && conn && !serverDbs) void schema.loadDatabases(conn);
  }
</script>

<div class="flex min-w-0 items-center">
  <DropdownMenu.Root>
    <DropdownMenu.Trigger
      class={cn(
        'btn btn-ghost h-7 max-w-[300px] min-w-0 gap-1.5 px-2 font-normal',
        !profile && 'text-faint',
        profile?.production && 'text-prod hover:text-prod'
      )}
      aria-label="Connection"
      title={profile?.name}
    >
      {#if profile}
        <StatusDot state={connState} error={connections.statusOf(conn)?.error} />
        <span class="truncate font-medium">{profile.name}</span>
      {:else}
        <Server class="size-3.5" />
        <span>Choose connection</span>
      {/if}
      <ChevronDown class="size-3.5 shrink-0 text-faint" />
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content class="menu-content max-h-[420px] w-max max-w-[min(520px,90vw)] min-w-[260px] overflow-auto" align="start" sideOffset={4}>
        {#each connections.groups as group (group.name)}
          {#if connections.groups.length > 1 || group.name}
            <div class="menu-label">{group.name || 'Ungrouped'}</div>
          {/if}
          {#each group.items as p (p.id)}
            <DropdownMenu.Item class="menu-item" onSelect={() => pickProfile(p.id)}>
              <span class="flex size-3.5 items-center justify-center">
                {#if p.id === profile?.id}<Check class="size-3.5" />{/if}
              </span>
              <StatusDot state={connections.profileState(p)} />
              <span class="min-w-0 truncate" title={p.name}>{p.name}</span>
              {#if p.production}<span class="badge ml-auto h-4 bg-prod px-1 text-[9.5px] text-white">Prod</span>{/if}
            </DropdownMenu.Item>
          {/each}
        {/each}
        {#if connections.profiles.length}<DropdownMenu.Separator class="menu-separator" />{/if}
        <DropdownMenu.Item class="menu-item" onSelect={() => dialogs.openConnection(null)}>
          <Plus /> New connection…
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>

  {#if profile && profile.kind !== 'sqlite'}
    <span class="text-faint">/</span>
    <DropdownMenu.Root onOpenChange={loadServerDbs}>
      <DropdownMenu.Trigger class="btn btn-ghost h-7 max-w-[340px] min-w-0 gap-1.5 px-2 font-normal" aria-label="Database" title={db || profile.database}>
        <Database class="size-3.5 shrink-0 text-faint" />
        <span class="truncate">{db || 'default'}</span>
        <ChevronDown class="size-3.5 shrink-0 text-faint" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="menu-content max-h-[360px] w-max max-w-[min(560px,90vw)] min-w-[220px] overflow-auto" align="start" sideOffset={4}>
          <div class="menu-label">Database</div>
          {#each dbOptions as name (name)}
            <DropdownMenu.Item class="menu-item" onSelect={() => pickDb(name)}>
              <span class="flex size-3.5 items-center justify-center">
                {#if name === db}<Check class="size-3.5" />{/if}
              </span>
              <span class="min-w-0 truncate" title={name}>{name}</span>
              {#if name === profile.database}<span class="menu-shortcut shrink-0">default</span>{/if}
            </DropdownMenu.Item>
          {/each}
          {#if serverDbs?.status === 'loading'}
            <div class="flex items-center gap-2 px-2 py-1.5 text-[12px] text-faint"><span class="spinner size-3"></span>Loading…</div>
          {:else if serverDbs?.status === 'error'}
            <div class="px-2 py-1.5 text-[12px] text-danger">{serverDbs.error}</div>
          {/if}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  {/if}
</div>
