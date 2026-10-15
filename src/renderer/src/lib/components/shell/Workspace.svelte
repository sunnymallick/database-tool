<!-- Center workspace: tab strip and the tab views (all mounted; inactive ones hidden). -->
<script lang="ts">
  import Command from '@lucide/svelte/icons/command';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import Import from '@lucide/svelte/icons/import';
  import Server from '@lucide/svelte/icons/server';
  import SquareTerminal from '@lucide/svelte/icons/square-terminal';
  import Keyboard from '@lucide/svelte/icons/keyboard';
  import type { Component } from 'svelte';
  import QueryTabView from '$lib/components/query/QueryTabView.svelte';
  import StructureTab from '$lib/components/structure/StructureTab.svelte';
  import TableDataTab from '$lib/components/table/TableDataTab.svelte';
  import Kbd from '$lib/components/ui/Kbd.svelte';
  import { command } from '$lib/commands';
  import { connections } from '$lib/stores/connections.svelte';
  import { dialogs } from '$lib/stores/dialogs.svelte';
  import { tabs, type QueryTab, type TableTab } from '$lib/stores/tabs.svelte';
  import { cn } from '$lib/utils';
  import TabBar from './TabBar.svelte';

  const noConnections = $derived(connections.loaded && connections.profiles.length === 0);

  const actions: { label: string; icon: Component<{ class?: string }>; shortcut?: string; run: () => void }[] = [
    { label: 'New query', icon: SquareTerminal, shortcut: 'Mod-t', run: () => command('new-query')?.run() },
    { label: 'Open SQL file…', icon: FolderOpen, shortcut: 'Mod-o', run: () => command('open-sql-file')?.run() },
    { label: 'New connection…', icon: Server, shortcut: 'Shift-Mod-n', run: () => dialogs.openConnection(null) },
    { label: 'Search tables and commands', icon: Command, shortcut: 'Mod-k', run: () => (dialogs.paletteOpen = true) },
    { label: 'Keyboard shortcuts', icon: Keyboard, shortcut: 'Shift-Mod-/', run: () => (dialogs.shortcutsOpen = true) }
  ];
</script>

<section class="flex h-full min-h-0 min-w-0 flex-col bg-bg">
  {#if tabs.tabs.length}
    <TabBar />
    <div class="relative min-h-0 flex-1">
      {#each tabs.tabs as t (t.id)}
        {@const active = t.id === tabs.activeId}
        <div class={cn('absolute inset-0', !active && 'invisible')} aria-hidden={!active} inert={!active}>
          {#if t.kind === 'query'}
            <QueryTabView tab={t as QueryTab} {active} />
          {:else if t.kind === 'table'}
            <TableDataTab tab={t as TableTab} {active} />
          {:else}
            <StructureTab tab={t as TableTab} {active} />
          {/if}
        </div>
      {/each}
    </div>
  {:else}
    <div class="flex flex-1 items-center justify-center p-8">
      <div class="w-full max-w-[380px]">
        {#if noConnections}
          <h2 class="text-[15px] font-semibold">Welcome to Database Tool</h2>
          <p class="mt-1 text-[12.5px] leading-relaxed text-muted">
            Connect to PostgreSQL, MySQL, SQL Server, or SQLite. If you used dbTool, you can bring your connection profiles
            over in one step.
          </p>
          <div class="mt-4 flex gap-2">
            <button class="btn btn-primary" onclick={() => dialogs.openConnection(null)}>
              <Server class="size-3.5" /> New connection
            </button>
            <button class="btn" onclick={() => (dialogs.importOpen = true)}>
              <Import class="size-3.5" /> Import from dbTool
            </button>
          </div>
        {:else}
          <p class="panel-title mb-2 px-2">Get started</p>
          <ul class="flex flex-col">
            {#each actions as a (a.label)}
              <li>
                <button
                  type="button"
                  class="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] text-muted hover:bg-hover hover:text-fg"
                  onclick={a.run}
                >
                  <a.icon class="size-4 text-faint" />
                  {a.label}
                  {#if a.shortcut}<Kbd keys={a.shortcut} class="ml-auto" />{/if}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
  {/if}
</section>
