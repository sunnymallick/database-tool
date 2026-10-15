<!--
  Tooltip around an arbitrary trigger. The trigger element is rendered by the
  `trigger` snippet (spread the props onto it) so no wrapper button is added:

    <Tip text="Run" shortcut="Mod-Enter">
      {#snippet trigger(props)}<button {...props} class="btn">Run</button>{/snippet}
    </Tip>
-->
<script lang="ts">
  import { Tooltip } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import Kbd from './Kbd.svelte';

  interface Props {
    text: string;
    shortcut?: string;
    side?: 'top' | 'bottom' | 'left' | 'right';
    disabled?: boolean;
    trigger: Snippet<[Record<string, unknown>]>;
  }

  let { text, shortcut, side = 'bottom', disabled = false, trigger }: Props = $props();
</script>

<Tooltip.Root delayDuration={450} {disabled} ignoreNonKeyboardFocus>
  <Tooltip.Trigger>
    {#snippet child({ props })}
      {@render trigger(props)}
    {/snippet}
  </Tooltip.Trigger>
  <Tooltip.Portal>
    <Tooltip.Content class="tooltip-content" {side} sideOffset={6}>
      <span>{text}</span>
      {#if shortcut}<Kbd keys={shortcut} />{/if}
    </Tooltip.Content>
  </Tooltip.Portal>
</Tooltip.Root>
