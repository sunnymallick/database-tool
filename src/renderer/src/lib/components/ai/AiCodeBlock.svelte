<!-- Fenced code block with copy (and open-in-tab for SQL). -->
<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import Copy from '@lucide/svelte/icons/copy';
  import SquareArrowOutUpRight from '@lucide/svelte/icons/square-arrow-out-up-right';
  import { workbench } from '$lib/bridge';
  import { aiChat } from '$lib/stores/ai.svelte';
  import AiSql from './AiSql.svelte';
  import { copyText } from './clipboard';

  let { code, lang }: { code: string; lang: string } = $props();

  const isSql = $derived(['sql', 'pgsql', 'postgresql', 'mysql', 'tsql', 'sqlite', 'plsql', 'mssql'].includes(lang));
  let copied = $state(false);

  async function copy() {
    if (await copyText(code)) {
      copied = true;
      setTimeout(() => (copied = false), 1200);
    }
  }
</script>

<div class="group my-2 overflow-hidden rounded-md border border-border bg-sunken">
  <div class="flex h-7 items-center gap-1 border-b border-border px-2 text-[11px] text-faint">
    <span class="font-mono">{lang || 'text'}</span>
    <span class="flex-1"></span>
    {#if isSql}
      <button
        class="btn btn-ghost btn-sm"
        title="Open in a new query tab"
        onclick={() => workbench.openQueryTab({ sql: code, conn: aiChat.targetRef })}
      >
        <SquareArrowOutUpRight class="size-3.5" /> Open
      </button>
    {/if}
    <button class="btn btn-ghost btn-sm" title="Copy" onclick={copy}>
      {#if copied}<Check class="size-3.5 text-success" /> Copied{:else}<Copy class="size-3.5" /> Copy{/if}
    </button>
  </div>
  <div class="max-h-80 overflow-auto px-3 py-2">
    {#if isSql}
      <AiSql sql={code} />
    {:else}
      <pre class="m-0 font-mono text-[12px] leading-[1.55] whitespace-pre select-text"><code>{code}</code></pre>
    {/if}
  </div>
</div>
