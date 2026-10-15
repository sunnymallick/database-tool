<!-- Single-value select (bits-ui) styled like `.input`. -->
<script lang="ts">
  import { Select } from 'bits-ui';
  import Check from '@lucide/svelte/icons/check';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import { cn } from '$lib/utils';

  export interface SelectItem {
    value: string;
    label: string;
    hint?: string;
    disabled?: boolean;
  }

  interface Props {
    value: string;
    items: SelectItem[];
    placeholder?: string;
    disabled?: boolean;
    class?: string;
    id?: string;
    size?: 'sm' | 'md';
    'aria-label'?: string;
    onValueChange?: (value: string) => void;
  }

  let {
    value = $bindable(),
    items,
    placeholder = 'Select…',
    disabled = false,
    class: klass,
    id,
    size = 'md',
    'aria-label': ariaLabel,
    onValueChange
  }: Props = $props();

  const selected = $derived(items.find((i) => i.value === value));
</script>

<Select.Root
  type="single"
  bind:value
  items={items.map((i) => ({ value: i.value, label: i.label, disabled: i.disabled }))}
  {disabled}
  onValueChange={(v) => onValueChange?.(v)}
>
  <Select.Trigger
    {id}
    aria-label={ariaLabel}
    class={cn(
      'input flex items-center justify-between gap-2 text-left',
      size === 'sm' && 'h-6 text-xs',
      klass
    )}
  >
    <span class={cn('truncate', !selected && 'text-faint')}>{selected?.label ?? placeholder}</span>
    <ChevronDown class="size-3.5 shrink-0 text-faint" />
  </Select.Trigger>
  <Select.Portal>
    <Select.Content
      class="menu-content max-h-[320px] overflow-auto"
      style="min-width: var(--bits-select-anchor-width)"
      sideOffset={4}
    >
      <Select.Viewport>
        {#each items as item (item.value)}
          <Select.Item value={item.value} label={item.label} disabled={item.disabled} class="menu-item pr-2">
            {#snippet children({ selected: isSelected })}
              <span class="flex size-3.5 shrink-0 items-center justify-center">
                {#if isSelected}<Check class="size-3.5" />{/if}
              </span>
              <span class="truncate">{item.label}</span>
              {#if item.hint}<span class="menu-shortcut">{item.hint}</span>{/if}
            {/snippet}
          </Select.Item>
        {/each}
      </Select.Viewport>
    </Select.Content>
  </Select.Portal>
</Select.Root>
