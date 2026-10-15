<!--
  One tool call: a compact, expandable row. Calls waiting for approval render
  as an approval card (red when the connection is production).
-->
<script lang="ts">
  import Ban from '@lucide/svelte/icons/ban';
  import Check from '@lucide/svelte/icons/check';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import CircleStop from '@lucide/svelte/icons/circle-stop';
  import Database from '@lucide/svelte/icons/database';
  import FileCode from '@lucide/svelte/icons/file-code';
  import OctagonAlert from '@lucide/svelte/icons/octagon-alert';
  import Play from '@lucide/svelte/icons/play';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import Table2 from '@lucide/svelte/icons/table-2';
  import { AI_TOOL_LABELS, type AiToolName } from '@shared/ai';
  import { aiChat, type ChatItem } from '$lib/stores/ai.svelte';
  import AiSql from './AiSql.svelte';

  let { item }: { item: Extract<ChatItem, { kind: 'tool' }> } = $props();

  const label = $derived((AI_TOOL_LABELS as Record<string, string>)[item.name as AiToolName] ?? item.name);
  const isSql = $derived(item.name === 'run_select' || item.name === 'run_statement');
  const awaiting = $derived(item.state === 'awaiting');
  let expanded = $state(false);
  const oneLine = $derived(item.preview.replace(/\s+/g, ' ').trim());
</script>

{#if awaiting || (item.needsApproval && item.decision)}
  <div
    class="my-2 overflow-hidden rounded-lg border {item.production
      ? 'border-prod/60 bg-prod-soft'
      : 'border-warning/50 bg-warning-soft'}"
    data-testid="ai-approval"
  >
    <div class="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
      {#if item.production}
        <OctagonAlert class="size-4 shrink-0 text-prod" />
        <span class="text-[12.5px] font-semibold text-prod">Approve a write on PRODUCTION</span>
      {:else}
        <ShieldAlert class="size-4 shrink-0 text-warning" />
        <span class="text-[12.5px] font-semibold">Approve this statement?</span>
      {/if}
    </div>
    <div class="px-3 pb-1 text-[11.5px] text-muted">
      {#if item.production}
        This changes data on <span class="font-semibold text-prod">{item.connLabel}</span>, a production database.
      {:else}
        The assistant wants to run this on <span class="font-semibold text-fg">{item.connLabel}</span>.
      {/if}
    </div>
    <div class="mx-3 mb-2.5 max-h-56 overflow-auto rounded-md border border-border bg-sunken px-2.5 py-2">
      <AiSql sql={item.preview} />
    </div>
    {#if awaiting}
      <div class="flex items-center justify-end gap-2 border-t border-border/60 px-3 py-2">
        <button class="btn btn-sm" onclick={() => aiChat.answer(item.id, false)} data-testid="ai-reject">
          <Ban class="size-3.5" /> Reject
        </button>
        <button
          class="btn btn-sm {item.production ? 'btn-danger' : 'btn-primary'}"
          onclick={() => aiChat.answer(item.id, true)}
          data-testid="ai-approve"
        >
          <Play class="size-3.5" />
          {item.production ? 'Run on production' : 'Approve and run'}
        </button>
      </div>
    {:else}
      <div class="flex items-center gap-1.5 border-t border-border/60 px-3 py-1.5 text-[11.5px]">
        {#if item.decision === 'rejected' || item.state === 'denied'}
          <Ban class="size-3.5 text-muted" /><span class="text-muted">Rejected. Nothing was run.</span>
        {:else if item.state === 'running'}
          <span class="spinner size-3 text-accent"></span><span class="text-muted">Running…</span>
        {:else if item.state === 'ok'}
          <Check class="size-3.5 text-success" /><span class="text-muted">Approved · {item.summary}</span>
        {:else if item.state === 'error'}
          <CircleAlert class="size-3.5 text-danger" /><span class="text-danger">{item.summary}</span>
        {:else}
          <CircleStop class="size-3.5 text-muted" /><span class="text-muted">{item.summary || 'Stopped'}</span>
        {/if}
      </div>
    {/if}
  </div>
{:else}
  <div class="my-1.5 rounded-md border border-border bg-raised/60" data-testid="ai-tool">
    <button
      class="flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left hover:bg-hover"
      onclick={() => (expanded = !expanded)}
      aria-expanded={expanded}
    >
      <ChevronRight class="size-3 shrink-0 text-faint transition-transform {expanded ? 'rotate-90' : ''}" />
      {#if item.name === 'read_editor'}
        <FileCode class="size-3.5 shrink-0 text-muted" />
      {:else if item.name === 'list_tables' || item.name === 'describe_table'}
        <Table2 class="size-3.5 shrink-0 text-muted" />
      {:else}
        <Database class="size-3.5 shrink-0 {item.toolKind === 'write' ? 'text-warning' : 'text-muted'}" />
      {/if}
      <span class="shrink-0 text-[12px] font-medium">{label}</span>
      <span class="min-w-0 flex-1 truncate font-mono text-[11.5px] text-faint">{oneLine}</span>
      <span class="flex shrink-0 items-center gap-1 text-[11px]">
        {#if item.state === 'running'}
          <span class="spinner size-3 text-accent"></span>
        {:else if item.state === 'ok'}
          <span class="max-w-[9rem] truncate text-muted">{item.summary}</span><Check class="size-3.5 text-success" />
        {:else if item.state === 'error'}
          <CircleAlert class="size-3.5 text-danger" />
        {:else if item.state === 'denied'}
          <span class="text-muted">Refused</span><Ban class="size-3.5 text-muted" />
        {:else}
          <CircleStop class="size-3.5 text-faint" />
        {/if}
      </span>
    </button>
    {#if expanded || item.state === 'error' || item.state === 'denied'}
      <div class="border-t border-border px-2.5 py-2">
        {#if expanded && item.preview}
          {#if isSql}
            <div class="mb-1.5 max-h-56 overflow-auto rounded border border-border bg-sunken px-2 py-1.5"><AiSql sql={item.preview} /></div>
          {:else}
            <div class="mb-1.5 font-mono text-[11.5px] break-all text-muted select-text">{item.preview}</div>
          {/if}
        {/if}
        {#if item.summary}
          <div
            class="text-[11.5px] break-words select-text {item.state === 'error' ? 'text-danger' : 'text-muted'}"
          >
            {item.summary}
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}
