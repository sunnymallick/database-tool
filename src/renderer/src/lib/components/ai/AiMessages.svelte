<!-- The conversation, auto-scrolling while the user is at the bottom. -->
<script lang="ts">
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import { tick } from 'svelte';
  import { aiChat } from '$lib/stores/ai.svelte';
  import AiEmptyState from './AiEmptyState.svelte';
  import AiInline from './AiInline.svelte';
  import AiMarkdown from './AiMarkdown.svelte';
  import AiProposalCard from './AiProposalCard.svelte';
  import AiStatusNotice from './AiStatusNotice.svelte';
  import AiToolCard from './AiToolCard.svelte';
  import { parseInline } from './markdown';

  let scroller = $state<HTMLDivElement | null>(null);
  let stick = true;

  function onScroll() {
    if (!scroller) return;
    stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
  }

  // Follow new content (including streamed text) while pinned to the bottom.
  $effect(() => {
    const last = aiChat.items[aiChat.items.length - 1];
    void aiChat.items.length;
    void (last && last.kind === 'text' ? last.text.length : 0);
    void aiChat.progress;
    void aiChat.busy;
    if (!stick) return;
    void tick().then(() => scroller?.scrollTo({ top: scroller.scrollHeight }));
  });

  // A new message from the user always scrolls down.
  $effect(() => {
    const last = aiChat.items[aiChat.items.length - 1];
    if (last?.kind === 'user') stick = true;
  });

  const lastIndex = $derived(aiChat.items.length - 1);
  // A running or approval-waiting tool card already shows progress.
  const toolActive = $derived.by(() => {
    const last = aiChat.items[lastIndex];
    return last?.kind === 'tool' && (last.state === 'running' || last.state === 'awaiting');
  });
</script>

<div class="min-h-0 flex-1 overflow-y-auto" bind:this={scroller} onscroll={onScroll} data-testid="ai-messages">
  <AiStatusNotice />
  {#if aiChat.items.length === 0}
    <AiEmptyState />
  {:else}
    <div class="flex flex-col px-3 py-3 text-[13px] leading-[1.55]">
      {#each aiChat.items as item, i (item.id)}
        {#if item.kind === 'user'}
          <div class="mt-3 mb-2 flex flex-col items-end first:mt-0">
            <div class="max-w-[92%] rounded-lg rounded-br-sm bg-accent-soft px-3 py-2 whitespace-pre-wrap break-words select-text">
              {item.text}
            </div>
            {#if item.context}<div class="mt-1 text-[10.5px] text-faint">{item.context}</div>{/if}
          </div>
        {:else if item.kind === 'text'}
          <div class="ai-prose my-1 break-words select-text">
            <AiMarkdown text={item.text} streaming={aiChat.busy && i === lastIndex} />
          </div>
        {:else if item.kind === 'tool'}
          <AiToolCard {item} />
        {:else if item.kind === 'proposal'}
          <AiProposalCard {item} />
        {:else if item.kind === 'error'}
          <div class="my-2 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2.5 text-[12.5px]" data-testid="ai-error">
            <div class="flex gap-2">
              <CircleAlert class="mt-0.5 size-4 shrink-0 text-danger" />
              <div class="min-w-0 flex-1 break-words select-text"><AiInline nodes={parseInline(item.message)} /></div>
            </div>
            {#if item.retryPrompt}
              <div class="mt-2 flex justify-end gap-2">
                {#if item.code === 'not_logged_in' || item.code === 'cli_missing'}
                  <button class="btn btn-sm" onclick={() => aiChat.loadStatus(true)}>Recheck CLI</button>
                {/if}
                <button class="btn btn-sm" onclick={() => aiChat.retry(item.retryPrompt)} disabled={aiChat.busy}>
                  <RotateCcw class="size-3.5" /> Retry
                </button>
              </div>
            {/if}
          </div>
        {:else if item.kind === 'meta'}
          <div class="mt-0.5 mb-1 text-[10.5px] text-faint" title={item.title}>{item.text}</div>
        {/if}
      {/each}
      {#if aiChat.busy && toolActive}
        <!-- progress is on the tool card -->
      {:else if aiChat.busy && aiChat.items[lastIndex]?.kind !== 'text'}
        <div class="my-2 flex items-center gap-2 text-[12px] text-muted" data-testid="ai-progress">
          <span class="spinner size-3 text-accent"></span>
          <span class="truncate">{aiChat.progress ?? 'Thinking…'}</span>
        </div>
      {:else if aiChat.busy && aiChat.progress}
        <div class="my-1 truncate text-[11px] text-faint">{aiChat.progress}</div>
      {/if}
    </div>
  {/if}
</div>
