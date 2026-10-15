<!-- First-run view with suggested prompts. -->
<script lang="ts">
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import { aiChat, SUGGESTED_PROMPTS } from '$lib/stores/ai.svelte';

  const ref = $derived(aiChat.targetRef);
  const profile = $derived(aiChat.targetProfile);
  const writeNote = $derived(
    profile?.readOnly
      ? 'This connection is read-only, so writes are refused.'
      : profile?.production
        ? 'This is a production connection: every write asks first.'
        : aiChat.allowWrites
          ? 'Writes run without asking while "Allow writes" is on.'
          : 'Writes always ask first.'
  );

  function pick(p: (typeof SUGGESTED_PROMPTS)[number]) {
    if (p.needsEditor) aiChat.includeEditor = true;
    void aiChat.send(p.prompt);
  }
</script>

<div class="flex flex-col items-center px-5 pt-10 pb-4 text-center" data-testid="ai-empty">
  <div class="mb-3 flex size-10 items-center justify-center rounded-xl bg-accent-soft">
    <Sparkles class="size-5 text-accent" />
  </div>
  <div class="text-[14px] font-semibold">Ask about your data</div>
  <p class="mt-1 max-w-[18rem] text-[12px] text-muted">
    {#if ref}
      Questions run read-only queries on <span class="font-medium text-fg">{aiChat.connLabel(ref)}</span>. {writeNote}
    {:else}
      No database selected. Pick a connection above, or ask general SQL questions.
    {/if}
  </p>
  <div class="mt-5 flex w-full max-w-[20rem] flex-col gap-1.5">
    {#each SUGGESTED_PROMPTS as p (p.label)}
      <button
        class="group flex items-center gap-2 rounded-md border border-border bg-raised px-3 py-2 text-left text-[12.5px] hover:border-border-strong hover:bg-hover disabled:opacity-45"
        onclick={() => pick(p)}
        disabled={aiChat.busy || aiChat.status?.available === false}
      >
        <span class="flex-1">{p.label}</span>
        <ArrowUpRight class="size-3.5 text-faint group-hover:text-accent" />
      </button>
    {/each}
  </div>
</div>
