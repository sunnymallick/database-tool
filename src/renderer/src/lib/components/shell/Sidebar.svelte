<!-- Left sidebar: connection list + schema tree with a filter box. -->
<script lang="ts">
  import ChevronsDownUp from '@lucide/svelte/icons/chevrons-down-up';
  import Database from '@lucide/svelte/icons/database';
  import Import from '@lucide/svelte/icons/import';
  import Plus from '@lucide/svelte/icons/plus';
  import Search from '@lucide/svelte/icons/search';
  import X from '@lucide/svelte/icons/x';
  import ConnectionTree from '$lib/components/schema/ConnectionTree.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import { connections } from '$lib/stores/connections.svelte';
  import { dialogs } from '$lib/stores/dialogs.svelte';
  import { layout } from '$lib/stores/layout.svelte';

  let filter = $state('');
  let filterInput = $state<HTMLInputElement | null>(null);

  function collapseAll() {
    for (const key of Object.keys(layout.expanded)) {
      if (!key.endsWith(':collapsed')) layout.setExpanded(key, false);
    }
  }
</script>

<aside class="flex h-full min-h-0 flex-col bg-panel" aria-label="Sidebar">
  <div class="flex h-9 shrink-0 items-center gap-1 pr-1.5 pl-3">
    <span class="panel-title">Connections</span>
    <div class="ml-auto flex items-center">
      <IconButton icon={ChevronsDownUp} label="Collapse all" size="sm" onclick={collapseAll} />
      <IconButton icon={Import} label="Import from dbTool" size="sm" onclick={() => (dialogs.importOpen = true)} />
      <IconButton icon={Plus} label="New connection" shortcut="Shift-Mod-n" size="sm" onclick={() => dialogs.openConnection(null)} />
    </div>
  </div>

  {#if connections.loaded && connections.profiles.length === 0}
    <div class="flex flex-1 flex-col items-center justify-center gap-3 px-6 pb-16 text-center">
      <div class="flex size-10 items-center justify-center rounded-xl border border-border bg-raised">
        <Database class="size-5 text-muted" />
      </div>
      <div>
        <p class="font-medium">No connections yet</p>
        <p class="mt-1 text-[12px] leading-snug text-faint">
          Add a PostgreSQL, MySQL, SQL Server, or SQLite connection, or bring your profiles over from dbTool.
        </p>
      </div>
      <div class="flex w-full max-w-[200px] flex-col gap-1.5">
        <button class="btn btn-primary w-full" onclick={() => dialogs.openConnection(null)}>
          <Plus class="size-3.5" /> New connection
        </button>
        <button class="btn w-full" onclick={() => (dialogs.importOpen = true)}>
          <Import class="size-3.5" /> Import from dbTool
        </button>
      </div>
    </div>
  {:else}
    <div class="shrink-0 px-2 pb-1.5">
      <div class="relative">
        <Search class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-faint" />
        <input
          bind:this={filterInput}
          bind:value={filter}
          class="input h-[26px] pr-6 pl-7 text-[12px]"
          placeholder="Filter tables, views, routines"
          aria-label="Filter tree"
          spellcheck="false"
          onkeydown={(e) => {
            if (e.key === 'Escape' && filter) {
              e.preventDefault();
              e.stopPropagation();
              filter = '';
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              (document.querySelector('[role="tree"][aria-label="Connections"]') as HTMLElement | null)?.focus();
            }
          }}
        />
        {#if filter}
          <button
            type="button"
            class="absolute top-1/2 right-1 flex size-5 -translate-y-1/2 items-center justify-center rounded text-faint hover:text-fg"
            aria-label="Clear filter"
            onclick={() => {
              filter = '';
              filterInput?.focus();
            }}
          >
            <X class="size-3" />
          </button>
        {/if}
      </div>
    </div>
    <ConnectionTree {filter} />
  {/if}
</aside>
