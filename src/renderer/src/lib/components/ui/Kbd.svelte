<!-- Shortcut keycaps, e.g. <Kbd keys="Mod-Shift-Enter" />. -->
<script lang="ts">
  import { shortcutKeys, isMac } from '$lib/keys';
  import { cn } from '$lib/utils';

  interface Props {
    keys: string;
    class?: string;
  }

  let { keys, class: klass }: Props = $props();
  const parts = $derived(shortcutKeys(keys));
</script>

{#if isMac}
  <kbd class={cn('kbd tracking-wider', klass)}>{parts.join('')}</kbd>
{:else}
  <span class={cn('inline-flex items-center gap-0.5', klass)}>
    {#each parts as p, i (i)}<kbd class="kbd">{p}</kbd>{/each}
  </span>
{/if}
