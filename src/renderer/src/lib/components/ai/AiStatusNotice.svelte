<!-- CLI missing / not signed in guidance from ai.status. -->
<script lang="ts">
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Terminal from '@lucide/svelte/icons/terminal';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { aiChat } from '$lib/stores/ai.svelte';
  import AiInline from './AiInline.svelte';
  import { parseInline } from './markdown';

  const s = $derived(aiChat.status);
  const kind = $derived(
    aiChat.statusError ? 'error' : !s ? null : !s.available ? 'missing' : s.loggedIn === false ? 'login' : null
  );
</script>

{#if kind}
  <div class="mx-3 mt-3 rounded-lg border border-warning/50 bg-warning-soft p-3 text-[12px]" data-testid="ai-status-notice">
    <div class="mb-1.5 flex items-center gap-2 font-semibold">
      {#if kind === 'login'}
        <Terminal class="size-4 text-warning" /> Sign in to Claude
      {:else}
        <TriangleAlert class="size-4 text-warning" /> Claude CLI unavailable
      {/if}
    </div>
    {#if kind === 'login'}
      <p class="text-muted">
        The assistant uses your Claude subscription through the Claude CLI. Open a terminal, run
        <code class="rounded bg-sunken px-1 font-mono text-fg">claude</code>, and sign in (type
        <code class="rounded bg-sunken px-1 font-mono text-fg">/login</code> if it does not ask). Then recheck.
      </p>
    {:else}
      <p class="text-muted"><AiInline nodes={parseInline(aiChat.statusError ?? s?.error ?? 'The Claude CLI did not respond.')} /></p>
      {#if s?.cliPath}<p class="mt-1 truncate font-mono text-[11px] text-faint" title={s.cliPath}>{s.cliPath}</p>{/if}
    {/if}
    <button class="btn btn-sm mt-2.5" onclick={() => aiChat.loadStatus(true)} disabled={aiChat.statusLoading}>
      {#if aiChat.statusLoading}<span class="spinner size-3"></span>{:else}<RefreshCw class="size-3.5" />{/if}
      Recheck
    </button>
  </div>
{/if}
