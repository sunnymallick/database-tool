<!-- A query tab: toolbar, SQL editor, results, and the history/snippets side panel. -->
<script lang="ts">
  import type { EditorView } from '@codemirror/view';
  import BookmarkPlus from '@lucide/svelte/icons/bookmark-plus';
  import BookBookmark from '@lucide/svelte/icons/book-bookmark';
  import ListVideo from '@lucide/svelte/icons/list-video';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import Lock from '@lucide/svelte/icons/lock';
  import Play from '@lucide/svelte/icons/play';
  import RotateCcwClock from '@lucide/svelte/icons/rotate-ccw-clock';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Square from '@lucide/svelte/icons/square';
  import WandSparkles from '@lucide/svelte/icons/wand-sparkles';
  import { askAi } from '$lib/ai-actions';
  import SqlEditor from '$lib/editor/SqlEditor.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Splitter from '$lib/components/ui/Splitter.svelte';
  import Tip from '$lib/components/ui/Tip.svelte';
  import { connections } from '$lib/stores/connections.svelte';
  import { schema } from '$lib/stores/schema.svelte';
  import { openSqlFiles, type QueryTab } from '$lib/stores/tabs.svelte';
  import { formatShortcut } from '$lib/keys';
  import { clamp, cn, formatDuration } from '$lib/utils';
  import ConnectionPicker from './ConnectionPicker.svelte';
  import HistoryPanel from './HistoryPanel.svelte';
  import ResultsPanel from './ResultsPanel.svelte';
  import SnippetsPanel from './SnippetsPanel.svelte';

  interface Props {
    tab: QueryTab;
    active: boolean;
  }

  let { tab, active }: Props = $props();

  const profile = $derived(connections.byId(tab.conn?.profileId));
  const connected = $derived(connections.isConnected(tab.conn));
  const meta = $derived(schema.metaOf(tab.conn)?.data ?? null);

  // Completion data for the tab's connection.
  $effect(() => {
    const ref = tab.conn;
    if (ref && connected && !schema.metaOf(ref)) void schema.loadMeta(ref);
  });

  let body = $state<HTMLDivElement | null>(null);
  let startRatio = 0;
  let snippetDraft = $state<string | null>(null);

  let now = $state(Date.now());
  $effect(() => {
    if (!tab.running) return;
    const t = setInterval(() => (now = Date.now()), 100);
    return () => clearInterval(t);
  });

  function onReady(view: EditorView) {
    tab.view = view;
    if (active) view.focus();
  }

  function saveSnippet() {
    const text = tab.selection() ?? tab.sql;
    snippetDraft = text.trim() ? text : '';
    tab.sidePanel = 'snippets';
  }
</script>

<div class="flex h-full min-h-0 min-w-0">
  <div class="flex min-w-0 flex-1 flex-col">
    <!-- Toolbar -->
    <div
      class={cn(
        '@container flex h-10 shrink-0 items-center gap-1 border-b px-2',
        profile?.production ? 'border-prod/60 bg-prod-soft' : 'border-border bg-panel'
      )}
    >
      <div class="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
        {#if tab.running}
          <Tip text="Cancel query">
            {#snippet trigger(props)}
              <button {...props} class="btn h-7 shrink-0 border-danger/40 text-danger hover:bg-danger-soft" onclick={() => tab.cancel()}>
                <Square class="size-3 fill-current" />
                Cancel
                <span class="font-mono text-[11px] tabular-nums opacity-80">{formatDuration(now - tab.startedAt)}</span>
              </button>
            {/snippet}
          </Tip>
        {:else}
          <Tip text="Run statement at cursor or selection" shortcut="Mod-Enter">
            {#snippet trigger(props)}
              <button
                {...props}
                class={cn('btn h-7 shrink-0 pr-2 pl-2.5', profile?.production ? 'btn-danger' : 'btn-primary')}
                onclick={() => tab.run('auto')}
              >
                <Play class="size-3.5 fill-current" />
                Run
              </button>
            {/snippet}
          </Tip>
        {/if}
        <IconButton icon={ListVideo} label="Run whole script" shortcut="Shift-Mod-Enter" disabled={tab.running} onclick={() => tab.run('script')} />
        <IconButton icon={WandSparkles} label="Format SQL" shortcut="Shift-Mod-f" onclick={() => tab.format()} />
        <IconButton icon={FolderOpen} label="Open .sql files" shortcut="Mod-o" onclick={() => void openSqlFiles()} />
        <div class="mx-1 h-4 w-px shrink-0 bg-border"></div>
        <ConnectionPicker conn={tab.conn} onChange={(c) => (tab.conn = c)} />
        {#if profile?.production}
          <span class="badge ml-1 h-5 shrink-0 bg-prod text-white" title="Production connection">
            <ShieldAlert class="size-3" /><span class="hidden @3xl:inline">Production</span>
          </span>
        {/if}
        {#if profile?.readOnly}
          <span class="badge ml-1 h-5 shrink-0 bg-warning-soft text-warning" title="Write statements are blocked on this connection">
            <Lock class="size-3" /><span class="hidden @3xl:inline">Read-only</span>
          </span>
        {/if}
      </div>

      <div class="flex shrink-0 items-center gap-0.5">
        <IconButton
          icon={RotateCcwClock}
          label="Query history"
          active={tab.sidePanel === 'history'}
          onclick={() => (tab.sidePanel = tab.sidePanel === 'history' ? null : 'history')}
        />
        <IconButton
          icon={BookBookmark}
          label="Snippets"
          active={tab.sidePanel === 'snippets'}
          onclick={() => (tab.sidePanel = tab.sidePanel === 'snippets' ? null : 'snippets')}
        />
        <IconButton icon={BookmarkPlus} label="Save selection as snippet" onclick={saveSnippet} />
        <div class="mx-1 h-4 w-px bg-border"></div>
        <Tip text="Ask the AI assistant about this query">
          {#snippet trigger(props)}
            <button
              {...props}
              aria-label="Ask AI"
              class="btn btn-ghost h-7 gap-1.5 px-2"
              onclick={() => askAi('', { includeEditor: true, conn: tab.conn })}
            >
              <Sparkles class="size-3.5 text-accent" />
              <span class="hidden @2xl:inline">Ask AI</span>
            </button>
          {/snippet}
        </Tip>
      </div>
    </div>

    <!-- Editor + results -->
    <div bind:this={body} class="flex min-h-0 flex-1 flex-col">
      <div class="min-h-[64px]" style="flex: {1 - tab.resultsRatio} 1 0%">
        <SqlEditor
          doc={tab.sql}
          kind={profile?.kind ?? null}
          {meta}
          placeholder={`Write SQL here. ${formatShortcut('Mod-Enter')} runs the statement at the cursor, ${formatShortcut('Shift-Mod-Enter')} the whole script.`}
          onChange={(d) => (tab.sql = d)}
          onRun={(mode) => tab.run(mode)}
          onFormat={() => tab.format()}
          {onReady}
        />
      </div>
      <Splitter
        orientation="horizontal"
        label="Resize results"
        onStart={() => (startRatio = tab.resultsRatio)}
        onDrag={(d) => {
          const h = body?.clientHeight ?? 600;
          tab.resultsRatio = clamp(startRatio - d / h, 0.12, 0.88);
        }}
        onDoubleClick={() => (tab.resultsRatio = 0.45)}
      />
      <div class="flex min-h-[80px] flex-col border-t border-border" style="flex: {tab.resultsRatio} 1 0%">
        <ResultsPanel {tab} />
      </div>
    </div>
  </div>

  {#if tab.sidePanel}
    <div class="flex w-[300px] shrink-0 flex-col border-l border-border bg-panel">
      {#if tab.sidePanel === 'history'}
        <HistoryPanel {tab} onClose={() => (tab.sidePanel = null)} />
      {:else}
        <SnippetsPanel {tab} bind:draft={snippetDraft} onClose={() => (tab.sidePanel = null)} />
      {/if}
    </div>
  {/if}
</div>

