<!--
  OWNER: AI slice. The workbench renders this in the right-hand dock when the
  AI panel is open. It takes no props; it reads context through $lib/bridge.
-->
<script lang="ts">
  import MessageSquarePlus from '@lucide/svelte/icons/message-square-plus';
  import PanelRightClose from '@lucide/svelte/icons/panel-right-close';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { onMount } from 'svelte';
  import { registerAi, workbench } from '$lib/bridge';
  import { aiChat } from '$lib/stores/ai.svelte';
  import AiComposer from './AiComposer.svelte';
  import AiConnectionMenu from './AiConnectionMenu.svelte';
  import AiMessages from './AiMessages.svelte';
  import AiModelMenu from './AiModelMenu.svelte';

  const profile = $derived(aiChat.targetProfile);
  const writesGated = $derived(!!profile && (profile.readOnly || profile.production));

  onMount(() => {
    aiChat.init();
    const unregister = registerAi({ ask: (prompt, opts) => aiChat.ask(prompt, opts) });
    // The workbench's active tab is read through a plain function; re-read it periodically.
    const timer = setInterval(() => aiChat.activeTick++, 1000);
    return () => {
      clearInterval(timer);
      unregister();
      // Keep `ai.ask()` working while the panel is closed.
      registerAi({ ask: (prompt, opts) => aiChat.ask(prompt, opts) });
    };
  });

  function toggleWrites() {
    aiChat.setAllowWrites(!aiChat.allowWrites);
  }
</script>

<div class="flex h-full min-w-0 flex-col bg-panel" data-testid="ai-panel">
  <!-- Title row -->
  <div class="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1.5 pl-3">
    <Sparkles class="size-3.5 text-accent" />
    <span class="panel-title ml-1">AI Assistant</span>
    <span class="flex-1"></span>
    <AiModelMenu />
    <button class="btn btn-ghost btn-icon btn-sm" title="New chat" aria-label="New chat" onclick={() => aiChat.newChat()} data-testid="ai-new-chat">
      <MessageSquarePlus class="size-3.5" />
    </button>
    <button class="btn btn-ghost btn-icon btn-sm" title="Close" aria-label="Close AI panel" onclick={() => workbench.setAiPanelOpen(false)}>
      <PanelRightClose class="size-3.5" />
    </button>
  </div>

  <!-- Context row: connection + write permission -->
  <div
    class="flex h-8 shrink-0 items-center gap-1.5 border-b border-border px-1.5 {profile?.production ? 'bg-prod-soft' : ''}"
  >
    <div class="min-w-0 flex-1"><AiConnectionMenu /></div>
    {#if profile?.production}<span class="badge shrink-0 bg-prod text-white">prod</span>{/if}
    {#if profile?.readOnly}<span class="badge shrink-0 bg-hover text-muted" title="Writes are refused on this connection">read-only</span>{/if}
    <button
      role="switch"
      aria-checked={aiChat.allowWrites}
      onclick={toggleWrites}
      class="flex h-6 shrink-0 items-center gap-1.5 rounded px-1.5 text-[11.5px] hover:bg-hover {aiChat.allowWrites
        ? 'text-warning'
        : 'text-muted'}"
      title={aiChat.allowWrites
        ? 'Writes run without asking (production connections still ask; read-only ones refuse). Click to require approval.'
        : 'Every write the assistant wants to run needs your approval. Click to allow writes without asking.'}
      data-testid="ai-allow-writes"
    >
      <span
        class="relative inline-flex h-3.5 w-6 items-center rounded-full transition-colors {aiChat.allowWrites
          ? 'bg-warning'
          : 'bg-border-strong'}"
      >
        <span
          class="absolute size-2.5 rounded-full bg-white shadow transition-transform {aiChat.allowWrites
            ? 'translate-x-3'
            : 'translate-x-0.5'}"
        ></span>
      </span>
      Allow writes
    </button>
  </div>

  {#if aiChat.allowWrites}
    <div class="flex shrink-0 items-start gap-2 border-b border-warning/40 bg-warning-soft px-3 py-1.5 text-[11.5px]" data-testid="ai-writes-warning">
      <TriangleAlert class="mt-px size-3.5 shrink-0 text-warning" />
      <span>
        {#if profile?.readOnly}
          This connection is read-only, so writes are still refused.
        {:else if profile?.production}
          Production connection: every write still needs your approval.
        {:else}
          The assistant can change data without asking.{#if !writesGated} Production connections still ask; read-only ones refuse.{/if}
        {/if}
      </span>
    </div>
  {/if}

  <AiMessages />
  <AiComposer />
</div>
