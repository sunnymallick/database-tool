<!--
  Extra databases on the same server, shown as their own sidebar nodes.
  Chips + add input; saved profiles can load the server's list.
-->
<script lang="ts">
  import Plus from '@lucide/svelte/icons/plus';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import X from '@lucide/svelte/icons/x';
  import Checkbox from '$lib/components/ui/Checkbox.svelte';
  import { schema } from '$lib/stores/schema.svelte';

  interface Props {
    databases: string[];
    /** The profile's default database (never listed as an extra). */
    defaultDb: string;
    /** Saved profile id; null for a profile that has not been saved yet. */
    profileId: string | null;
    id?: string;
  }

  let { databases = $bindable(), defaultDb, profileId, id }: Props = $props();

  let draft = $state('');
  let requested = $state(false);

  const server = $derived(profileId && requested ? schema.databases[profileId] : undefined);
  const serverList = $derived((server?.data ?? []).filter((d) => d !== defaultDb));

  function add(name: string): void {
    const n = name.trim();
    if (!n || n === defaultDb || databases.includes(n)) return;
    databases = [...databases, n];
  }

  function remove(name: string): void {
    databases = databases.filter((d) => d !== name);
  }

  function toggle(name: string, on: boolean): void {
    if (on) add(name);
    else remove(name);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      add(draft);
      draft = '';
    } else if (e.key === 'Backspace' && draft === '' && databases.length) {
      remove(databases[databases.length - 1]);
    }
  }

  function load(): void {
    if (!profileId) return;
    requested = true;
    void schema.loadDatabases({ profileId }, true);
  }
</script>

<div class="flex flex-col gap-2">
  <div
    class="flex min-h-7 flex-wrap items-center gap-1 rounded-md border border-border bg-sunken px-1 py-[3px] focus-within:border-accent focus-within:ring-2 focus-within:ring-focus"
  >
    {#each databases as db (db)}
      <span class="inline-flex h-5 items-center gap-1 rounded bg-raised pr-0.5 pl-1.5 font-mono text-[11.5px] text-fg ring-1 ring-border">
        {db}
        <button
          type="button"
          class="flex size-4 items-center justify-center rounded text-faint hover:bg-hover hover:text-fg"
          aria-label={`Remove ${db}`}
          onclick={() => remove(db)}
        >
          <X class="size-3" />
        </button>
      </span>
    {/each}
    <input
      {id}
      class="h-5 min-w-[120px] flex-1 bg-transparent px-1 font-mono text-[12px] text-fg outline-none placeholder:font-sans placeholder:text-faint"
      placeholder={databases.length ? 'Add another…' : 'Database name, Enter to add'}
      bind:value={draft}
      onkeydown={onKeydown}
      onblur={() => {
        add(draft);
        draft = '';
      }}
      autocomplete="off"
      spellcheck="false"
    />
    {#if draft.trim()}
      <button
        type="button"
        class="btn btn-ghost btn-sm btn-icon"
        aria-label="Add database"
        onclick={() => {
          add(draft);
          draft = '';
        }}
      >
        <Plus class="size-3.5" />
      </button>
    {/if}
  </div>

  {#if profileId}
    <div class="flex items-center gap-2">
      <button type="button" class="btn btn-sm" onclick={load} disabled={server?.status === 'loading'}>
        {#if server?.status === 'loading'}
          <span class="spinner size-3"></span>
        {:else}
          <RefreshCw class="size-3" />
        {/if}
        Load from server
      </button>
      {#if server?.status === 'error'}
        <span class="truncate text-[11.5px] text-danger" title={server.error}>{server.error}</span>
      {:else if server?.status === 'ready' && serverList.length === 0}
        <span class="hint">No other databases on this server.</span>
      {:else}
        <span class="hint">Uses the saved connection settings.</span>
      {/if}
    </div>
    {#if server?.status === 'ready' && serverList.length > 0}
      <div class="grid max-h-[132px] grid-cols-2 gap-x-3 gap-y-1.5 overflow-auto rounded-md border border-border bg-sunken/50 p-2">
        {#each serverList as db (db)}
          <Checkbox
            checked={databases.includes(db)}
            label={db}
            onCheckedChange={(on) => toggle(db, on)}
            class="min-w-0 [&_span]:truncate [&_span]:font-mono [&_span]:text-[12px]"
          />
        {/each}
      </div>
    {/if}
  {:else}
    <p class="hint">Save and test the connection to load the list from the server.</p>
  {/if}
</div>
