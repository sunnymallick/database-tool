<!-- Inline markdown nodes. Links open in the system browser through main. -->
<script lang="ts">
  import { call } from '$lib/api.svelte';
  import AiInline from './AiInline.svelte';
  import type { Inline } from './markdown';

  let { nodes }: { nodes: Inline[] } = $props();

  function open(e: MouseEvent, href: string) {
    e.preventDefault();
    call('shell.openExternal', { url: href }).catch(() => {});
  }
</script>

{#each nodes as n, i (i)}{#if n.t === 'text'}{n.v}{:else if n.t === 'br'}<br />{:else if n.t === 'code'}<code
      class="rounded bg-sunken px-1 py-px font-mono text-[0.92em] text-fg">{n.v}</code
    >{:else if n.t === 'strong'}<strong class="font-semibold"><AiInline nodes={n.c} /></strong
    >{:else if n.t === 'em'}<em><AiInline nodes={n.c} /></em>{:else if n.t === 'del'}<del class="text-muted"
      ><AiInline nodes={n.c} /></del
    >{:else if n.t === 'link'}<a
      href={n.href}
      title={n.href}
      class="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
      onclick={(e) => open(e, n.href)}><AiInline nodes={n.c} /></a
    >{/if}{/each}
