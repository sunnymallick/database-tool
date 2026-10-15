<!-- Icon-only button with a tooltip (label doubles as aria-label). -->
<script lang="ts">
  import type { Component } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils';
  import Tip from './Tip.svelte';

  interface Props extends Omit<HTMLButtonAttributes, 'children'> {
    icon: Component<{ class?: string }>;
    label: string;
    shortcut?: string;
    active?: boolean;
    size?: 'sm' | 'md';
    tipSide?: 'top' | 'bottom' | 'left' | 'right';
    iconClass?: string;
  }

  let {
    icon: Icon,
    label,
    shortcut,
    active = false,
    size = 'md',
    tipSide = 'bottom',
    iconClass,
    class: klass,
    ...rest
  }: Props = $props();
</script>

<Tip text={label} {shortcut} side={tipSide}>
  {#snippet trigger(props)}
    <button
      type="button"
      {...props}
      {...rest}
      aria-label={label}
      aria-pressed={active || undefined}
      class={cn(
        'btn btn-ghost btn-icon',
        size === 'sm' && 'btn-sm',
        active && 'bg-active text-fg',
        klass
      )}
    >
      <Icon class={cn(size === 'sm' ? 'size-3.5' : 'size-4', iconClass)} />
    </button>
  {/snippet}
</Tip>
