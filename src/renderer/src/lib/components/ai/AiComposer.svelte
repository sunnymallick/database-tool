<!-- Message input: Enter sends, Shift+Enter adds a line. -->
<script lang="ts">
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import FileCode from '@lucide/svelte/icons/file-code';
  import Square from '@lucide/svelte/icons/square';
  import { aiChat, pendingApprovals } from '$lib/stores/ai.svelte';

  let textarea = $state<HTMLTextAreaElement | null>(null);

  const editor = $derived(aiChat.activeEditor);
  const unavailable = $derived(aiChat.status?.available === false);
  const waiting = $derived(pendingApprovals(aiChat.items));
  const canSend = $derived(!aiChat.busy && !unavailable && aiChat.input.trim().length > 0);

  /** Grow with the text between the CSS min and max heights. */
  const MAX_HEIGHT = 280;

  function autosize() {
    if (!textarea) return;
    // A hidden panel measures 0; leave the CSS minimum in charge until it is visible.
    if (textarea.offsetParent === null) return;
    textarea.style.height = 'auto';
    const h = textarea.scrollHeight;
    if (h > 0) textarea.style.height = `${Math.min(h, MAX_HEIGHT)}px`;
  }

  $effect(() => {
    void aiChat.input;
    autosize();
  });

  // Re-measure when the dock's width changes or it is shown again (wrapping changes the height).
  $effect(() => {
    const el = textarea;
    if (!el) return;
    let lastWidth = -1;
    const ro = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      if (width === lastWidth) return;
      lastWidth = width;
      autosize();
    });
    ro.observe(el);
    return () => ro.disconnect();
  });

  $effect(() => {
    if (aiChat.focusRequest > 0) {
      textarea?.focus();
      textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    }
  });

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (canSend) void aiChat.send();
    } else if (e.key === 'Escape' && aiChat.busy) {
      e.preventDefault();
      aiChat.stop();
    }
  }
</script>

<div class="shrink-0 border-t border-border bg-panel p-2.5">
  {#if waiting > 0}
    <div class="mb-2 text-[11.5px] text-warning">The assistant is waiting for your approval above.</div>
  {/if}
  <div class="rounded-lg border border-border bg-sunken focus-within:border-accent focus-within:ring-2 focus-within:ring-focus">
    <textarea
      bind:this={textarea}
      bind:value={aiChat.input}
      onkeydown={onKeydown}
      rows="4"
      placeholder={unavailable ? 'The Claude CLI is unavailable' : 'Ask about your data…'}
      class="block max-h-[280px] min-h-[88px] w-full resize-none bg-transparent px-3 pt-2.5 pb-1.5 text-[13px] leading-[1.45] text-fg placeholder:text-faint focus:outline-none"
      aria-label="Message the AI assistant"
      data-testid="ai-input"
    ></textarea>
    <div class="flex items-center gap-1.5 border-t border-border/60 px-1.5 py-1.5">
      <button
        class="flex h-6 max-w-[60%] min-w-0 items-center gap-1 rounded px-1.5 text-[11.5px] {aiChat.includeEditor && editor
          ? 'bg-accent-soft text-accent'
          : 'text-faint hover:bg-hover hover:text-muted'}"
        onclick={() => (aiChat.includeEditor = !aiChat.includeEditor)}
        aria-pressed={aiChat.includeEditor}
        title={editor
          ? aiChat.includeEditor
            ? `Sharing "${editor.title}" with the assistant. Click to stop sharing.`
            : 'Click to share the active editor with the assistant'
          : 'No query tab is focused'}
        data-testid="ai-include-editor"
      >
        <FileCode class="size-3.5 shrink-0" />
        <span class="truncate">
          {#if !aiChat.includeEditor}Editor off{:else if editor}{editor.title}{:else}No editor{/if}
        </span>
      </button>
      <span class="flex-1"></span>
      <span class="hidden text-[10.5px] text-faint sm:inline">
        {aiChat.busy ? 'Esc to stop' : '⇧↵ new line'}
      </span>
      {#if aiChat.busy}
        <button class="btn btn-sm" onclick={() => aiChat.stop()} title="Stop (Esc)" data-testid="ai-stop">
          <Square class="size-3 fill-current" /> Stop
        </button>
      {:else}
        <button
          class="btn btn-primary btn-icon btn-sm"
          onclick={() => aiChat.send()}
          disabled={!canSend}
          title="Send (Enter)"
          aria-label="Send"
          data-testid="ai-send"
        >
          <ArrowUp class="size-3.5" />
        </button>
      {/if}
    </div>
  </div>
</div>
