<!--
  Command palette (Cmd+K): open tables across connected databases, switch
  tabs, and run app commands. Prefix with `>` for commands only.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { Command, Dialog } from 'bits-ui';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Eye from '@lucide/svelte/icons/eye';
  import Search from '@lucide/svelte/icons/search';
  import SquareTerminal from '@lucide/svelte/icons/square-terminal';
  import Table2 from '@lucide/svelte/icons/table-2';
  import TableProperties from '@lucide/svelte/icons/table-properties';
  import type { ConnRef, TableInfo } from '@shared/types';
  import Kbd from '$lib/components/ui/Kbd.svelte';
  import { commands, type AppCommand } from '$lib/commands';
  import { isMac } from '$lib/keys';
  import { connections } from '$lib/stores/connections.svelte';
  import { dialogs } from '$lib/stores/dialogs.svelte';
  import { schema } from '$lib/stores/schema.svelte';
  import { tabs, type Tab } from '$lib/stores/tabs.svelte';
  import { fuzzyScore } from '$lib/utils';

  let search = $state('');

  // On open: clear the query and load catalogs for every connected database.
  $effect(() => {
    if (!dialogs.paletteOpen) return;
    untrack(() => {
      search = '';
      for (const s of Object.values(connections.statuses)) {
        if (s.state !== 'connected') continue;
        const p = connections.byId(s.profileId);
        if (!p) continue;
        const ref: ConnRef = p.kind === 'sqlite' ? { profileId: p.id } : { profileId: p.id, database: s.database };
        if (!schema.metaOf(ref)) void schema.loadMeta(ref);
      }
    });
  });

  const commandsOnly = $derived(search.trimStart().startsWith('>'));
  const q = $derived(commandsOnly ? search.trimStart().slice(1).trim() : search.trim());

  const loadingMeta = $derived(Object.values(schema.meta).some((m) => m.status === 'loading'));

  const tableResults = $derived.by(() => {
    if (commandsOnly || !q) return [];
    const scored: { ref: ConnRef; table: TableInfo; score: number; key: string }[] = [];
    for (const { ref, table } of schema.allLoadedTables()) {
      const s = Math.max(fuzzyScore(q, table.name), fuzzyScore(q, `${table.schema}.${table.name}`) - 5);
      if (s >= 0) scored.push({ ref, table, score: s, key: `${connections.refKey(ref)}|${table.schema}.${table.name}` });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, 40);
  });

  const tabResults = $derived.by(() => {
    if (commandsOnly) return [];
    const list = tabs.tabs.map((t) => ({ t, score: q ? fuzzyScore(q, t.title) : 0 })).filter((x) => x.score >= 0);
    if (q) list.sort((a, b) => b.score - a.score);
    return list.slice(0, q ? 8 : 9).map((x) => x.t);
  });

  const commandResults = $derived.by(() => {
    const enabled = commands.filter((c) => c.id !== 'command-palette' && (!c.enabled || c.enabled()));
    if (!q) return enabled;
    return enabled
      .map((c) => ({ c, score: Math.max(fuzzyScore(q, c.label), c.keywords ? fuzzyScore(q, c.keywords) - 20 : -1) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.c);
  });

  function close() {
    dialogs.paletteOpen = false;
  }

  function openTable(ref: ConnRef, t: TableInfo, structure: boolean) {
    close();
    if (structure) tabs.openStructure(ref, t.schema, t.name, t.kind);
    else tabs.openTable(ref, t.schema, t.name, t.kind);
  }

  function runCommand(c: AppCommand) {
    close();
    // Let the dialog close (and return focus) before the command opens anything.
    setTimeout(() => c.run(), 0);
  }

  function switchTab(t: Tab) {
    close();
    tabs.activate(t.id);
  }

  let modHeld = $state(false);
  function onKeydown(e: KeyboardEvent) {
    modHeld = isMac ? e.metaKey : e.ctrlKey;
  }
</script>

<svelte:window onkeydown={onKeydown} onkeyup={onKeydown} />

<Dialog.Root bind:open={dialogs.paletteOpen}>
  <Dialog.Portal>
    <Dialog.Overlay class="dialog-overlay bg-scrim/60" />
    <Dialog.Content
      class="fixed top-[14vh] left-1/2 z-50 w-[calc(100vw-32px)] max-w-[600px] -translate-x-1/2 overflow-hidden rounded-xl border border-border-strong bg-overlay shadow-pop outline-none"
      aria-label="Command palette"
    >
      <Dialog.Title class="sr-only">Command palette</Dialog.Title>
      <Command.Root shouldFilter={false} loop class="flex max-h-[min(520px,70vh)] flex-col">
        <div class="flex h-11 shrink-0 items-center gap-2.5 border-b border-border px-3.5">
          <Search class="size-4 shrink-0 text-faint" />
          <Command.Input
            bind:value={search}
            class="h-full min-w-0 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-faint"
            placeholder="Search tables, tabs, and commands…  (type > for commands)"
          />
          {#if loadingMeta}<span class="spinner size-3.5 text-faint"></span>{/if}
        </div>
        <Command.List class="min-h-0 flex-1 overflow-auto p-1.5">
          <Command.Viewport>
            <Command.Empty class="px-3 py-8 text-center text-[12.5px] text-faint">
              {#if q}No results for “{q}”.{:else}Nothing to show.{/if}
            </Command.Empty>

            {#if tableResults.length}
              <Command.Group>
                <Command.GroupHeading class="menu-label">Tables</Command.GroupHeading>
                <Command.GroupItems>
                  {#each tableResults as r (r.key)}
                    {@const p = connections.byId(r.ref.profileId)}
                    <Command.Item
                      value={`table:${r.key}`}
                      class="palette-item"
                      onSelect={() => openTable(r.ref, r.table, modHeld)}
                    >
                      {#if r.table.kind === 'table'}
                        <Table2 class="size-4 shrink-0 text-accent/80" />
                      {:else}
                        <Eye class="size-4 shrink-0 text-[var(--syn-type)]" />
                      {/if}
                      <span class="truncate font-medium">{r.table.name}</span>
                      {#if r.table.schema}<span class="shrink-0 text-[12px] text-faint">{r.table.schema}</span>{/if}
                      <span class="ml-auto flex min-w-0 shrink items-center gap-1.5 pl-3 text-[11.5px] text-faint">
                        {#if p?.production}<span class="badge h-4 bg-prod px-1 text-[9px] text-white">Prod</span>{/if}
                        <span class="truncate">{connections.label(r.ref, { alwaysDb: p?.kind !== 'sqlite' })}</span>
                      </span>
                    </Command.Item>
                  {/each}
                </Command.GroupItems>
              </Command.Group>
            {/if}

            {#if tabResults.length}
              <Command.Group>
                <Command.GroupHeading class="menu-label">Open tabs</Command.GroupHeading>
                <Command.GroupItems>
                  {#each tabResults as t (t.id)}
                    <Command.Item value={`tab:${t.id}`} class="palette-item" onSelect={() => switchTab(t)}>
                      {#if t.kind === 'query'}
                        <SquareTerminal class="size-4 shrink-0 text-faint" />
                      {:else if t.kind === 'structure'}
                        <TableProperties class="size-4 shrink-0 text-faint" />
                      {:else}
                        <Table2 class="size-4 shrink-0 text-faint" />
                      {/if}
                      <span class="truncate">{t.title}</span>
                      {#if t.id === tabs.activeId}<span class="text-[11px] text-faint">current</span>{/if}
                      <span class="ml-auto truncate pl-3 text-[11.5px] text-faint">{connections.label(t.conn)}</span>
                    </Command.Item>
                  {/each}
                </Command.GroupItems>
              </Command.Group>
            {/if}

            {#if commandResults.length}
              <Command.Group>
                <Command.GroupHeading class="menu-label">Commands</Command.GroupHeading>
                <Command.GroupItems>
                  {#each commandResults as c (c.id)}
                    <Command.Item value={`cmd:${c.id}`} class="palette-item" onSelect={() => runCommand(c)}>
                      <ChevronRight class="size-4 shrink-0 text-faint" />
                      <span class="truncate">{c.label}</span>
                      <span class="text-[11px] text-faint">{c.group}</span>
                      {#if c.shortcut}<Kbd keys={c.shortcut} class="ml-auto" />{/if}
                    </Command.Item>
                  {/each}
                </Command.GroupItems>
              </Command.Group>
            {/if}
          </Command.Viewport>
        </Command.List>
        <div class="flex h-8 shrink-0 items-center gap-3 border-t border-border px-3 text-[11px] text-faint">
          <span class="flex items-center gap-1"><Kbd keys="ArrowUp" /><Kbd keys="ArrowDown" /> navigate</span>
          <span class="flex items-center gap-1"><Kbd keys="Enter" /> open</span>
          <span class="flex items-center gap-1"><Kbd keys="Mod-Enter" /> open structure</span>
          <span class="ml-auto flex items-center gap-1"><Kbd keys="Escape" /> close</span>
        </div>
      </Command.Root>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.palette-item) {
    display: flex;
    height: 34px;
    align-items: center;
    gap: 10px;
    border-radius: 7px;
    padding: 0 10px;
    font-size: 13px;
    color: var(--fg);
    cursor: default;
    user-select: none;
  }
  :global(.palette-item[data-selected]) {
    background: var(--accent-soft);
  }
</style>
