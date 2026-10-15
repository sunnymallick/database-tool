<!--
  One-click import of dbTool connection profiles. Reads its open state from
  `dialogs.importOpen`.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { toast } from 'svelte-sonner';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import { dbKindInfo, type ConnectionProfile, type ImportResult } from '@shared/types';
  import { call, errorMessage } from '$lib/api.svelte';
  import Checkbox from '$lib/components/ui/Checkbox.svelte';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import { dialogs } from '$lib/stores/dialogs.svelte';
  import { plural } from '$lib/utils';

  let includePasswords = $state(false);
  let importing = $state(false);
  let result = $state<ImportResult | null>(null);
  let error = $state<string | null>(null);

  let wasOpen = false;
  $effect(() => {
    const open = dialogs.importOpen;
    if (open && !wasOpen)
      untrack(() => {
        includePasswords = false;
        importing = false;
        result = null;
        error = null;
      });
    wasOpen = open;
  });

  function target(p: ConnectionProfile): string {
    if (dbKindInfo(p.kind).fileBased) return p.filePath;
    const host = p.port ? `${p.host}:${p.port}` : p.host;
    return p.database ? `${host}/${p.database}` : host;
  }

  async function runImport(): Promise<void> {
    if (importing) return;
    importing = true;
    error = null;
    try {
      result = await call('connections.importDbtool', { includePasswords });
      const n = result.imported.length;
      if (n > 0) toast.success(`Imported ${plural(n, 'connection')} from dbTool`);
    } catch (err) {
      error = errorMessage(err);
      toast.error('Import failed', { description: error });
    } finally {
      importing = false;
    }
  }
</script>

<Dialog
  bind:open={dialogs.importOpen}
  title="Import from dbTool"
  description="Copies connection profiles from the dbTool app on this Mac."
  width="max-w-[520px]"
>
  {#if !result}
    <div class="flex flex-col gap-4 pt-1">
      <div class="flex flex-col gap-1.5 text-[12.5px] leading-relaxed text-muted">
        <p>
          Reads <span class="rounded bg-sunken px-1 py-px font-mono text-[11.5px] text-fg"
            >~/Library/Application Support/dbTool/connections.json</span
          > and adds each profile here, keeping names, colors, extra databases, and the production and read-only flags.
        </p>
        <p>SSH tunnels are not supported yet: those profiles are imported with a warning and connect directly. Existing connections are not changed.</p>
      </div>
      <div class="rounded-lg border border-border bg-sunken/50 p-3">
        <Checkbox
          bind:checked={includePasswords}
          label="Also import passwords"
          hint="macOS will ask for permission to read each password from dbTool's Keychain entries. Choose “Always Allow” to avoid repeated prompts."
          disabled={importing}
        />
      </div>
      {#if error}
        <div class="flex items-start gap-2 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-[12px] text-danger" role="alert">
          <CircleAlert class="mt-px size-3.5 shrink-0" />
          <span class="min-w-0 break-words">{error}</span>
        </div>
      {/if}
    </div>
  {:else}
    <div class="flex flex-col gap-4 pt-1">
      <div class="flex items-center gap-2 text-[12.5px]">
        {#if result.imported.length > 0}
          <CircleCheck class="size-4 text-success" />
          <span>Imported <strong class="font-semibold">{plural(result.imported.length, 'connection')}</strong>.</span>
        {:else}
          <CircleAlert class="size-4 text-faint" />
          <span class="text-muted">No new connections were imported.</span>
        {/if}
        {#if includePasswords}
          <span class="ml-auto inline-flex items-center gap-1 text-[11.5px] text-muted">
            <KeyRound class="size-3" />{plural(result.passwordsImported, 'password')}
          </span>
        {/if}
      </div>

      {#if result.imported.length > 0}
        <section class="flex flex-col gap-1.5">
          <h3 class="panel-title">Imported</h3>
          <ul class="max-h-[200px] overflow-auto rounded-md border border-border">
            {#each result.imported as p (p.id)}
              <li class="flex h-8 items-center gap-2 border-b border-border px-2.5 last:border-b-0">
                <span
                  class="size-2 shrink-0 rounded-full"
                  style:background-color={p.color ?? 'var(--border-strong)'}
                ></span>
                <span class="truncate font-medium">{p.name}</span>
                {#if p.production}<span class="badge bg-prod-soft text-prod">Prod</span>{/if}
                <span class="ml-auto shrink-0 text-[11.5px] text-muted">{dbKindInfo(p.kind).label}</span>
                <span class="max-w-[180px] shrink truncate font-mono text-[11px] text-faint" title={target(p)}>{target(p)}</span>
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if result.skipped.length > 0}
        <section class="flex flex-col gap-1.5">
          <h3 class="panel-title">Skipped</h3>
          <ul class="max-h-[160px] overflow-auto rounded-md border border-border">
            {#each result.skipped as s, i (i)}
              <li class="flex min-h-8 items-center gap-2 border-b border-border px-2.5 py-1 last:border-b-0">
                <span class="truncate font-medium">{s.name}</span>
                <span class="ml-auto text-right text-[11.5px] text-muted">{s.reason}</span>
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if result.warnings && result.warnings.length > 0}
        <section class="flex flex-col gap-1.5">
          <h3 class="panel-title">Warnings</h3>
          <ul class="max-h-[160px] overflow-auto rounded-md border border-warning/40 bg-warning-soft">
            {#each result.warnings as w, i (i)}
              <li class="flex min-h-8 items-center gap-2 border-b border-warning/20 px-2.5 py-1 last:border-b-0">
                <span class="truncate font-medium">{w.name}</span>
                <span class="ml-auto text-right text-[11.5px] text-warning">{w.message}</span>
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      <p class="truncate font-mono text-[11px] text-faint" title={result.sourcePath}>Source: {result.sourcePath}</p>
    </div>
  {/if}

  {#snippet footer()}
    {#if result}
      <button type="button" class="btn btn-primary" onclick={() => (dialogs.importOpen = false)}>Done</button>
    {:else}
      <button type="button" class="btn btn-ghost" onclick={() => (dialogs.importOpen = false)} disabled={importing}>
        Cancel
      </button>
      <button type="button" class="btn btn-primary" onclick={runImport} disabled={importing}>
        {#if importing}<span class="spinner size-3"></span>Importing…{:else}Import{/if}
      </button>
    {/if}
  {/snippet}
</Dialog>
