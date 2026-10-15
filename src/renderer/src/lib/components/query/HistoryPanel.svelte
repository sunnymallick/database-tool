<!-- Query history side panel: search, filter to this connection, insert / open / copy. -->
<script lang="ts">
  import ArrowDownToLine from '@lucide/svelte/icons/arrow-down-to-line';
  import Copy from '@lucide/svelte/icons/copy';
  import SquarePlus from '@lucide/svelte/icons/square-plus';
  import Search from '@lucide/svelte/icons/search';
  import Trash from '@lucide/svelte/icons/trash';
  import X from '@lucide/svelte/icons/x';
  import { toast } from 'svelte-sonner';
  import type { HistoryEntry } from '@shared/types';
  import { call, errorMessage } from '$lib/api.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Checkbox from '$lib/components/ui/Checkbox.svelte';
  import { dialogs } from '$lib/stores/dialogs.svelte';
  import { queryEvents, tabs, type QueryTab } from '$lib/stores/tabs.svelte';
  import { copyText, debounce, formatCount, formatDuration, formatRelativeTime } from '$lib/utils';

  interface Props {
    tab: QueryTab;
    onClose: () => void;
  }

  let { tab, onClose }: Props = $props();

  let search = $state('');
  let thisConnection = $state(false);
  let entries = $state.raw<HistoryEntry[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);

  async function load(q: string, onlyThis: boolean, profileId: string | undefined) {
    loading = true;
    try {
      entries = await call('history.list', {
        limit: 300,
        search: q.trim() || undefined,
        profileId: onlyThis ? profileId : undefined
      });
      error = null;
    } catch (err) {
      error = errorMessage(err);
    } finally {
      loading = false;
    }
  }

  const loadDebounced = debounce(load, 200);

  $effect(() => {
    void queryEvents.historyVersion;
    loadDebounced(search, thisConnection, tab.conn?.profileId);
  });

  async function clearAll() {
    const ok = await dialogs.confirm({
      title: 'Clear query history?',
      message: 'Every saved history entry is deleted. This cannot be undone.',
      confirmLabel: 'Clear history',
      danger: true
    });
    if (!ok) return;
    try {
      await call('history.clear');
      entries = [];
    } catch (err) {
      toast.error('Could not clear history', { description: errorMessage(err) });
    }
  }

  function connFor(e: HistoryEntry) {
    return e.database ? { profileId: e.profileId, database: e.database } : { profileId: e.profileId };
  }
</script>

<div class="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1.5 pl-3">
  <span class="panel-title">History</span>
  <div class="ml-auto flex items-center">
    <IconButton icon={Trash} label="Clear history" size="sm" disabled={!entries.length} onclick={clearAll} />
    <IconButton icon={X} label="Close panel" size="sm" onclick={onClose} />
  </div>
</div>
<div class="flex shrink-0 flex-col gap-2 border-b border-border p-2">
  <div class="relative">
    <Search class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-faint" />
    <input class="input h-[26px] pl-7 text-[12px]" placeholder="Search history" bind:value={search} spellcheck="false" />
  </div>
  <Checkbox bind:checked={thisConnection} label="Only this connection" class="px-0.5" />
</div>
<div class="min-h-0 flex-1 overflow-auto">
  {#if error}
    <p class="p-3 text-[12px] text-danger">{error}</p>
  {:else if !entries.length}
    <p class="p-4 text-center text-[12px] text-faint">{loading ? 'Loading…' : search ? 'No matching queries.' : 'Queries you run appear here.'}</p>
  {:else}
    <ul>
      {#each entries as e (e.id)}
        <li
          class="group relative border-b border-grid-line px-3 py-2 hover:bg-hover"
          ondblclick={() => tab.insertText(e.sql)}
          title="Double-click to insert at the cursor"
        >
          <pre class="line-clamp-3 font-mono text-[11.5px] leading-snug whitespace-pre-wrap text-fg">{e.sql.trim()}</pre>
          <div class="mt-1 flex items-center gap-1.5 text-[11px] text-faint">
            <span class="truncate">{e.connectionName}{e.database ? ` / ${e.database}` : ''}</span>
            <span>·</span>
            <span class="shrink-0">{formatRelativeTime(e.ts)}</span>
            {#if e.error}
              <span class="ml-auto shrink-0 text-danger" title={e.error}>failed</span>
            {:else}
              <span class="ml-auto shrink-0 tabular-nums">
                {e.rowCount != null ? `${formatCount(e.rowCount)} rows · ` : ''}{formatDuration(e.durationMs)}
              </span>
            {/if}
          </div>
          <div class="absolute top-1.5 right-1.5 hidden items-center rounded-md border border-border bg-overlay shadow-pop group-hover:flex">
            <IconButton icon={ArrowDownToLine} label="Insert at cursor" size="sm" onclick={() => tab.insertText(e.sql)} />
            <IconButton icon={SquarePlus} label="Open in new tab" size="sm" onclick={() => tabs.openQuery({ sql: e.sql, conn: connFor(e) })} />
            <IconButton icon={Copy} label="Copy" size="sm" onclick={() => copyText(e.sql)} />
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>
