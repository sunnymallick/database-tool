<!-- SQL the assistant proposed (never executed) with editor actions. -->
<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import Copy from '@lucide/svelte/icons/copy';
  import Replace from '@lucide/svelte/icons/replace';
  import SquareArrowOutUpRight from '@lucide/svelte/icons/square-arrow-out-up-right';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import TextCursorInput from '@lucide/svelte/icons/text-cursor-input';
  import { workbench } from '$lib/bridge';
  import type { ChatItem } from '$lib/stores/ai.svelte';
  import AiInline from './AiInline.svelte';
  import AiSql from './AiSql.svelte';
  import { copyText } from './clipboard';
  import { parseInline } from './markdown';

  let { item }: { item: Extract<ChatItem, { kind: 'proposal' }> } = $props();

  let feedback = $state<{ text: string; ok: boolean } | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function flash(text: string, ok = true) {
    feedback = { text, ok };
    clearTimeout(timer);
    timer = setTimeout(() => (feedback = null), 1800);
  }

  async function copy() {
    flash((await copyText(item.sql)) ? 'Copied' : 'Copy failed', true);
  }

  function openTab() {
    workbench.openQueryTab({ sql: item.sql, conn: item.conn, title: 'AI query' });
    flash('Opened in a new tab');
  }

  function replace() {
    if (workbench.replaceActiveEditorSql(item.sql)) flash('Editor replaced');
    else flash('Focus a query tab first', false);
  }

  function insert() {
    if (workbench.insertIntoActiveEditor(item.sql)) flash('Inserted at cursor');
    else flash('Focus a query tab first', false);
  }
</script>

<div class="my-2 overflow-hidden rounded-lg border border-accent/40 bg-raised" data-testid="ai-proposal">
  <div class="flex items-center gap-1.5 px-3 pt-2 pb-1">
    <Sparkles class="size-3.5 text-accent" />
    <span class="text-[12px] font-semibold">Proposed SQL</span>
    <span class="text-[11px] text-faint">· not run</span>
    <span class="flex-1"></span>
    {#if feedback}
      <span class="flex items-center gap-1 text-[11px] {feedback.ok ? 'text-success' : 'text-warning'}">
        {#if feedback.ok}<Check class="size-3" />{/if}{feedback.text}
      </span>
    {/if}
  </div>
  {#if item.explanation}
    <div class="px-3 pb-1.5 text-[12px] text-muted"><AiInline nodes={parseInline(item.explanation)} /></div>
  {/if}
  <div class="mx-3 max-h-72 overflow-auto rounded-md border border-border bg-sunken px-2.5 py-2">
    <AiSql sql={item.sql} />
  </div>
  <div class="flex flex-wrap items-center gap-1 px-2 py-2">
    <button class="btn btn-ghost btn-sm" onclick={copy} title="Copy to clipboard"><Copy class="size-3.5" /> Copy</button>
    <button class="btn btn-ghost btn-sm" onclick={openTab} title="Open in a new query tab">
      <SquareArrowOutUpRight class="size-3.5" /> New tab
    </button>
    <button class="btn btn-ghost btn-sm" onclick={replace} title="Replace the SQL in the focused editor">
      <Replace class="size-3.5" /> Replace
    </button>
    <button class="btn btn-ghost btn-sm" onclick={insert} title="Insert at the cursor of the focused editor">
      <TextCursorInput class="size-3.5" /> Insert
    </button>
  </div>
</div>
