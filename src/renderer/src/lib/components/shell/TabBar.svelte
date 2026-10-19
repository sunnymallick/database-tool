<!-- Workspace tab strip: activate, close, middle-click close, drag to reorder, context menu. -->
<script lang="ts">
  import { ContextMenu } from 'bits-ui';
  import Plus from '@lucide/svelte/icons/plus';
  import SquareTerminal from '@lucide/svelte/icons/square-terminal';
  import Table2 from '@lucide/svelte/icons/table-2';
  import TableProperties from '@lucide/svelte/icons/table-properties';
  import Eye from '@lucide/svelte/icons/eye';
  import X from '@lucide/svelte/icons/x';
  import { ai } from '$lib/bridge';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import { connections } from '$lib/stores/connections.svelte';
  import { tabs, type Tab } from '$lib/stores/tabs.svelte';
  import { cn, copyText } from '$lib/utils';

  let strip = $state<HTMLDivElement | null>(null);
  let menuTab = $state<Tab | null>(null);
  let dragIndex = $state<number | null>(null);
  let dropIndex = $state<number | null>(null);
  let renaming = $state<string | null>(null);
  let renameValue = $state('');

  // Keep the active tab visible.
  $effect(() => {
    const id = tabs.activeId;
    if (!strip || !id) return;
    const el = strip.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });

  function tooltip(t: Tab): string {
    const conn = connections.label(t.conn, { alwaysDb: true });
    if (t.kind === 'query') return [t.filePath ?? t.title, conn].join('\n');
    return `${t.schema ? `${t.schema}.` : ''}${t.table}${t.kind === 'structure' ? ' (structure)' : ''}\n${conn}`;
  }

  function startRename(t: Tab) {
    if (t.kind !== 'query') return;
    renaming = t.id;
    renameValue = t.title;
  }

  function commitRename() {
    const t = tabs.tabs.find((x) => x.id === renaming);
    if (t?.kind === 'query') {
      const v = renameValue.trim();
      t.customTitle = v && v !== t.title ? v : t.customTitle;
    }
    renaming = null;
  }

  function onWheel(e: WheelEvent) {
    if (!strip || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    strip.scrollLeft += e.deltaY;
  }
</script>

<div class="flex h-9 shrink-0 items-stretch border-b border-border bg-panel">
  <ContextMenu.Root>
    <ContextMenu.Trigger class="flex min-w-0 flex-1">
      <div
        bind:this={strip}
        class="tab-strip flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden"
        role="tablist"
        aria-label="Open tabs"
        tabindex="-1"
        onwheel={onWheel}
        oncontextmenu={(e) => {
          if (!(e.target as HTMLElement).closest('[data-tab-id]')) menuTab = null;
        }}
      >
        {#each tabs.tabs as t, i (t.id)}
          {@const p = connections.byId(t.conn?.profileId)}
          {@const active = t.id === tabs.activeId}
          {@const prod = !!p?.production}
          {@const aiState = ai.activity(t.conn)}
          <div
            data-tab-id={t.id}
            role="tab"
            tabindex={active ? 0 : -1}
            aria-selected={active}
            title={tooltip(t)}
            draggable={renaming !== t.id}
            class={cn(
              'group relative flex max-w-[220px] min-w-[96px] shrink-0 cursor-default items-center gap-1.5 border-r border-border pr-1 pl-3 text-[12.5px] select-none',
              active ? 'bg-bg text-fg' : 'text-muted hover:bg-hover hover:text-fg',
              prod && 'text-prod',
              prod && active && 'bg-prod-soft',
              dropIndex === i && dragIndex !== null && dragIndex !== i && 'shadow-[inset_2px_0_0_var(--accent)]'
            )}
            onclick={() => tabs.activate(t.id)}
            onauxclick={(e) => {
              if (e.button === 1) void tabs.close(t.id);
            }}
            ondblclick={() => startRename(t)}
            oncontextmenu={() => (menuTab = t)}
            onkeydown={(e) => {
              if (e.key === 'ArrowRight') tabs.cycle(1);
              else if (e.key === 'ArrowLeft') tabs.cycle(-1);
            }}
            ondragstart={(e) => {
              dragIndex = i;
              e.dataTransfer?.setData('text/plain', t.id);
              if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
            }}
            ondragover={(e) => {
              if (dragIndex === null) return;
              e.preventDefault();
              dropIndex = i;
            }}
            ondrop={(e) => {
              e.preventDefault();
              if (dragIndex !== null) tabs.move(dragIndex, i);
              dragIndex = dropIndex = null;
            }}
            ondragend={() => (dragIndex = dropIndex = null)}
          >
            <!-- Accent line: production red, otherwise the connection color on the active tab. -->
            {#if prod}
              <span class="absolute inset-x-0 top-0 h-[2px] bg-prod"></span>
            {:else if active}
              <span class="absolute inset-x-0 top-0 h-[2px]" style="background: {p?.color ?? 'var(--accent)'}"></span>
            {/if}
            {#if t.kind === 'query'}
              <SquareTerminal class={cn('size-3.5 shrink-0', prod ? 'text-prod' : 'text-faint')} />
            {:else if t.kind === 'structure'}
              <TableProperties class={cn('size-3.5 shrink-0', prod ? 'text-prod' : 'text-faint')} />
            {:else if t.tableKind !== 'table'}
              <Eye class={cn('size-3.5 shrink-0', prod ? 'text-prod' : 'text-faint')} />
            {:else}
              <Table2 class={cn('size-3.5 shrink-0', prod ? 'text-prod' : 'text-faint')} />
            {/if}
            {#if renaming === t.id}
              <!-- svelte-ignore a11y_autofocus -->
              <input
                class="input h-5 min-w-0 flex-1 px-1 text-[12px]"
                bind:value={renameValue}
                autofocus
                onblur={commitRename}
                onkeydown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') commitRename();
                  else if (e.key === 'Escape') renaming = null;
                }}
              />
            {:else}
              <span class="min-w-0 flex-1 truncate">{t.title}</span>
            {/if}
            {#if aiState}
              <span
                class={cn('size-1.5 shrink-0 rounded-full', aiState === 'awaiting' ? 'bg-warning' : 'animate-pulse bg-accent')}
                title={aiState === 'awaiting' ? 'The AI assistant is waiting for your approval' : 'The AI assistant is answering'}
                data-testid="tab-ai-activity"
              ></span>
            {/if}
            {#if t.kind === 'query' && t.running}
              <span class="spinner size-3 shrink-0 text-accent"></span>
            {/if}
            <button
              type="button"
              tabindex="-1"
              aria-label="Close tab"
              class={cn(
                'relative flex size-5 shrink-0 items-center justify-center rounded text-faint hover:bg-active hover:text-fg',
                !active && !t.dirty && 'opacity-0 group-hover:opacity-100'
              )}
              onclick={(e) => {
                e.stopPropagation();
                void tabs.close(t.id);
              }}
            >
              {#if t.dirty}
                <span class="size-2 rounded-full bg-muted group-hover:hidden"></span>
                <X class="hidden size-3.5 group-hover:block" />
              {:else}
                <X class="size-3.5" />
              {/if}
            </button>
          </div>
        {/each}
      </div>
    </ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content class="menu-content" onCloseAutoFocus={(e) => e.preventDefault()}>
        {#if menuTab}
          {@const t = menuTab}
          <ContextMenu.Item class="menu-item" onSelect={() => tabs.close(t.id)}>Close</ContextMenu.Item>
          <ContextMenu.Item class="menu-item" disabled={tabs.tabs.length < 2} onSelect={() => tabs.closeOthers(t.id)}>
            Close others
          </ContextMenu.Item>
          <ContextMenu.Item
            class="menu-item"
            disabled={tabs.tabs.findIndex((x) => x.id === t.id) === tabs.tabs.length - 1}
            onSelect={() => tabs.closeToRight(t.id)}
          >
            Close tabs to the right
          </ContextMenu.Item>
          <ContextMenu.Item class="menu-item" onSelect={() => tabs.closeAll()}>Close all</ContextMenu.Item>
          {#if t.kind === 'query'}
            <ContextMenu.Separator class="menu-separator" />
            <ContextMenu.Item class="menu-item" onSelect={() => startRename(t)}>Rename…</ContextMenu.Item>
            {#if t.filePath}
              {@const path = t.filePath}
              <ContextMenu.Item class="menu-item" onSelect={() => copyText(path)}>Copy file path</ContextMenu.Item>
            {/if}
          {/if}
        {:else}
          <ContextMenu.Item class="menu-item" onSelect={() => tabs.openQuery()}>New query tab</ContextMenu.Item>
        {/if}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>
  <div class="flex shrink-0 items-center border-l border-transparent px-1">
    <IconButton icon={Plus} label="New query tab" shortcut="Mod-t" size="sm" onclick={() => tabs.openQuery()} />
  </div>
</div>

<style>
  .tab-strip {
    scrollbar-width: none;
  }
  .tab-strip::-webkit-scrollbar {
    display: none;
  }
</style>
