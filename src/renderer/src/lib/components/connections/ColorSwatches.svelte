<!-- Accent color picker for a connection: "None" plus a fixed palette. -->
<script lang="ts">
  import Ban from '@lucide/svelte/icons/ban';
  import Check from '@lucide/svelte/icons/check';
  import { cn } from '$lib/utils';

  interface Props {
    value: string | null;
    id?: string;
  }

  let { value = $bindable(), id }: Props = $props();

  const COLORS: { value: string; name: string }[] = [
    { value: '#4f8cff', name: 'Blue' },
    { value: '#43b883', name: 'Green' },
    { value: '#e9b44c', name: 'Amber' },
    { value: '#e5484d', name: 'Red' },
    { value: '#a78bfa', name: 'Purple' },
    { value: '#2dd4bf', name: 'Teal' },
    { value: '#f472b6', name: 'Pink' },
    { value: '#94a3b8', name: 'Slate' }
  ];

  const isCustom = $derived(!!value && !COLORS.some((c) => c.value.toLowerCase() === value?.toLowerCase()));
</script>

<div {id} class="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Color">
  <button
    type="button"
    role="radio"
    aria-checked={value === null}
    aria-label="No color"
    title="No color"
    class={cn(
      'flex size-[22px] items-center justify-center rounded-full border border-border-strong text-faint transition-shadow hover:text-muted',
      value === null && 'ring-2 ring-accent ring-offset-2 ring-offset-panel'
    )}
    onclick={() => (value = null)}
  >
    <Ban class="size-3" />
  </button>
  {#each COLORS as c (c.value)}
    {@const selected = value?.toLowerCase() === c.value}
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={c.name}
      title={c.name}
      class={cn(
        'flex size-[22px] items-center justify-center rounded-full transition-shadow',
        selected && 'ring-2 ring-accent ring-offset-2 ring-offset-panel'
      )}
      style:background-color={c.value}
      onclick={() => (value = c.value)}
    >
      {#if selected}<Check class="size-3 text-white" strokeWidth={3} />{/if}
    </button>
  {/each}
  {#if isCustom}
    <span
      class="flex size-[22px] items-center justify-center rounded-full ring-2 ring-accent ring-offset-2 ring-offset-panel"
      style:background-color={value}
      title={`Custom ${value}`}
    >
      <Check class="size-3 text-white" strokeWidth={3} />
    </span>
  {/if}
</div>
