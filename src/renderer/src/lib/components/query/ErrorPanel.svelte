<!-- Query error: message, engine details, jump-to-position, and "Ask AI to fix". -->
<script lang="ts">
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Copy from '@lucide/svelte/icons/copy';
  import Crosshair from '@lucide/svelte/icons/crosshair';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import { dbKindInfo } from '@shared/types';
  import { askAi } from '$lib/ai-actions';
  import { connections } from '$lib/stores/connections.svelte';
  import type { QueryTab } from '$lib/stores/tabs.svelte';
  import { copyText } from '$lib/utils';

  interface Props {
    tab: QueryTab;
  }

  let { tab }: Props = $props();

  const error = $derived(tab.error);
  const offset = $derived(tab.errorOffset());
  const failedSql = $derived.by(() => {
    const req = tab.lastRequest;
    if (!req) return '';
    return req.sql;
  });

  function lineCol(pos: number): string {
    const before = tab.sql.slice(0, pos);
    const line = before.split('\n').length;
    const col = pos - before.lastIndexOf('\n');
    return `line ${line}, column ${col}`;
  }

  function askAiToFix() {
    if (!error) return;
    const p = connections.byId(tab.conn?.profileId);
    const engine = p ? dbKindInfo(p.kind).label : 'the database';
    const parts = [
      `This query failed on ${engine}:`,
      '```sql',
      failedSql.trim(),
      '```',
      `Error${error.code ? ` (${error.code})` : ''}: ${error.message}`
    ];
    if (error.detail) parts.push(`Detail: ${error.detail}`);
    if (error.hint) parts.push(`Hint: ${error.hint}`);
    parts.push('Explain what is wrong and propose a corrected query.');
    askAi(parts.join('\n'), { conn: tab.conn, includeEditor: true, send: true });
  }

  function copyError() {
    if (!error) return;
    void copyText([error.message, error.detail, error.hint].filter(Boolean).join('\n'));
  }
</script>

{#if error}
  <div class="rounded-lg border border-danger/40 bg-danger-soft p-3">
    <div class="flex items-start gap-2.5">
      <CircleAlert class="mt-0.5 size-4 shrink-0 text-danger" />
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2 text-[12.5px] font-semibold text-danger">
          Query failed
          {#if error.code}<span class="badge h-4 bg-danger/15 font-mono text-[10px] text-danger normal-case">{error.code}</span>{/if}
          {#if error.statementIndex != null && tab.results.length + 1 > 1}
            <span class="text-[11.5px] font-normal text-muted">in statement {error.statementIndex + 1}</span>
          {/if}
          {#if offset != null}
            <span class="text-[11.5px] font-normal text-muted">at {lineCol(offset)}</span>
          {/if}
        </div>
        <pre class="mt-1.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-fg select-text">{error.message}</pre>
        {#if error.detail}
          <p class="mt-1 text-[12px] text-muted select-text"><span class="text-faint">Detail:</span> {error.detail}</p>
        {/if}
        {#if error.hint}
          <p class="mt-1 text-[12px] text-muted select-text"><span class="text-faint">Hint:</span> {error.hint}</p>
        {/if}
        <div class="mt-2.5 flex flex-wrap items-center gap-1.5">
          {#if offset != null}
            <button class="btn btn-sm" onclick={() => tab.reveal(offset)}>
              <Crosshair class="size-3.5" /> Go to error
            </button>
          {/if}
          <button class="btn btn-sm" onclick={askAiToFix}>
            <Sparkles class="size-3.5 text-accent" /> Ask AI to fix
          </button>
          <button class="btn btn-ghost btn-sm" onclick={copyError}>
            <Copy class="size-3.5" /> Copy
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
