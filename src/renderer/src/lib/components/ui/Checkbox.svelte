<!-- Checkbox (bits-ui) with an optional label and hint. -->
<script lang="ts">
  import { Checkbox } from 'bits-ui';
  import Check from '@lucide/svelte/icons/check';
  import Minus from '@lucide/svelte/icons/minus';
  import { cn } from '$lib/utils';

  interface Props {
    checked: boolean;
    indeterminate?: boolean;
    label?: string;
    hint?: string;
    disabled?: boolean;
    id?: string;
    class?: string;
    onCheckedChange?: (checked: boolean) => void;
  }

  let {
    checked = $bindable(),
    indeterminate = false,
    label,
    hint,
    disabled = false,
    id,
    class: klass,
    onCheckedChange
  }: Props = $props();
  const uid = $props.id();
  const inputId = $derived(id ?? `cb-${uid}`);
</script>

<div class={cn('flex items-start gap-2', klass)}>
  <Checkbox.Root
    id={inputId}
    bind:checked
    {indeterminate}
    {disabled}
    onCheckedChange={(c) => onCheckedChange?.(c)}
    class="mt-[2px] inline-flex size-[14px] shrink-0 items-center justify-center rounded-[4px] border border-border-strong bg-sunken text-accent-fg transition-colors data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent disabled:opacity-50"
  >
    {#snippet children({ checked: c, indeterminate: ind })}
      {#if ind}<Minus class="size-3" strokeWidth={3} />{:else if c}<Check class="size-3" strokeWidth={3} />{/if}
    {/snippet}
  </Checkbox.Root>
  {#if label}
    <label for={inputId} class="flex min-w-0 flex-col gap-0.5 select-none">
      <span class="text-[12.5px] leading-[18px] text-fg">{label}</span>
      {#if hint}<span class="hint">{hint}</span>{/if}
    </label>
  {/if}
</div>
