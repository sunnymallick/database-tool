<!-- Saved snippets side panel: save the selection/query, search, insert, open, edit, delete. -->
<script lang="ts">
  import ArrowDownToLine from '@lucide/svelte/icons/arrow-down-to-line';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Plus from '@lucide/svelte/icons/plus';
  import Search from '@lucide/svelte/icons/search';
  import SquarePlus from '@lucide/svelte/icons/square-plus';
  import Trash from '@lucide/svelte/icons/trash';
  import X from '@lucide/svelte/icons/x';
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import type { Snippet } from '@shared/types';
  import { call, errorMessage } from '$lib/api.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import { dialogs } from '$lib/stores/dialogs.svelte';
  import { tabs, type QueryTab } from '$lib/stores/tabs.svelte';
  import { fuzzyScore, newId } from '$lib/utils';

  interface Props {
    tab: QueryTab;
    /** SQL to prefill a new snippet with (set by "Save selection as snippet"). */
    draft: string | null;
    onClose: () => void;
  }

  let { tab, draft = $bindable(), onClose }: Props = $props();

  let snippets = $state.raw<Snippet[]>([]);
  let search = $state('');
  let loading = $state(true);
  let editing = $state<{ id: string; name: string; description: string; sql: string } | null>(null);

  const filtered = $derived.by(() => {
    const q = search.trim();
    if (!q) return snippets;
    return snippets
      .map((s) => ({ s, score: Math.max(fuzzyScore(q, s.name), s.sql.toLowerCase().includes(q.toLowerCase()) ? 1 : -1) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.s);
  });

  async function load() {
    try {
      snippets = (await call('snippets.list')).sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      toast.error('Could not load snippets', { description: errorMessage(err) });
    } finally {
      loading = false;
    }
  }

  onMount(load);

  // "Save selection as snippet" opens the form prefilled.
  $effect(() => {
    if (draft !== null) {
      editing = { id: '', name: '', description: '', sql: draft };
      draft = null;
    }
  });

  async function save(e: Event) {
    e.preventDefault();
    if (!editing || !editing.name.trim() || !editing.sql.trim()) return;
    try {
      await call('snippets.save', {
        id: editing.id || newId(),
        name: editing.name.trim(),
        description: editing.description.trim() || undefined,
        sql: editing.sql,
        updatedAt: new Date().toISOString()
      });
      toast.success(editing.id ? 'Snippet updated' : 'Snippet saved');
      editing = null;
      await load();
    } catch (err) {
      toast.error('Could not save snippet', { description: errorMessage(err) });
    }
  }

  async function remove(s: Snippet) {
    const ok = await dialogs.confirm({ title: `Delete snippet “${s.name}”?`, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await call('snippets.delete', { id: s.id });
      await load();
    } catch (err) {
      toast.error('Could not delete snippet', { description: errorMessage(err) });
    }
  }
</script>

<div class="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1.5 pl-3">
  <span class="panel-title">Snippets</span>
  <div class="ml-auto flex items-center">
    <IconButton
      icon={Plus}
      label="New snippet from selection"
      size="sm"
      onclick={() => (editing = { id: '', name: '', description: '', sql: tab.selection() ?? tab.sql })}
    />
    <IconButton icon={X} label="Close panel" size="sm" onclick={onClose} />
  </div>
</div>

{#if editing}
  <form class="flex shrink-0 flex-col gap-2 border-b border-border bg-sunken/40 p-2.5" onsubmit={save}>
    <!-- svelte-ignore a11y_autofocus -->
    <input class="input" placeholder="Snippet name" bind:value={editing.name} autofocus aria-label="Snippet name" />
    <input class="input" placeholder="Description (optional)" bind:value={editing.description} aria-label="Description" />
    <textarea class="textarea h-24 resize-y text-[11.5px]" bind:value={editing.sql} spellcheck="false" aria-label="SQL"></textarea>
    <div class="flex justify-end gap-1.5">
      <button type="button" class="btn btn-ghost btn-sm" onclick={() => (editing = null)}>Cancel</button>
      <button type="submit" class="btn btn-primary btn-sm" disabled={!editing.name.trim() || !editing.sql.trim()}>
        {editing.id ? 'Update' : 'Save snippet'}
      </button>
    </div>
  </form>
{/if}

<div class="shrink-0 border-b border-border p-2">
  <div class="relative">
    <Search class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-faint" />
    <input class="input h-[26px] pl-7 text-[12px]" placeholder="Search snippets" bind:value={search} spellcheck="false" />
  </div>
</div>
<div class="min-h-0 flex-1 overflow-auto">
  {#if !filtered.length}
    <p class="p-4 text-center text-[12px] text-faint">
      {loading ? 'Loading…' : search ? 'No matching snippets.' : 'Save a query or selection to reuse it later.'}
    </p>
  {:else}
    <ul>
      {#each filtered as s (s.id)}
        <li
          class="group relative border-b border-grid-line px-3 py-2 hover:bg-hover"
          ondblclick={() => tab.insertText(s.sql)}
          title="Double-click to insert at the cursor"
        >
          <div class="truncate pr-16 text-[12.5px] font-medium">{s.name}</div>
          {#if s.description}<div class="truncate text-[11.5px] text-faint">{s.description}</div>{/if}
          <pre class="mt-1 line-clamp-2 font-mono text-[11px] leading-snug whitespace-pre-wrap text-muted">{s.sql.trim()}</pre>
          <div class="absolute top-1.5 right-1.5 hidden items-center rounded-md border border-border bg-overlay shadow-pop group-hover:flex">
            <IconButton icon={ArrowDownToLine} label="Insert at cursor" size="sm" onclick={() => tab.insertText(s.sql)} />
            <IconButton icon={SquarePlus} label="Open in new tab" size="sm" onclick={() => tabs.openQuery({ sql: s.sql, conn: tab.conn, title: s.name })} />
            <IconButton
              icon={Pencil}
              label="Edit"
              size="sm"
              onclick={() => (editing = { id: s.id, name: s.name, description: s.description ?? '', sql: s.sql })}
            />
            <IconButton icon={Trash} label="Delete" size="sm" onclick={() => remove(s)} />
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>
