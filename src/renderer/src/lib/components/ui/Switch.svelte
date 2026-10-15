<!-- Toggle switch (bits-ui) with an optional inline label and hint. -->
<script lang="ts">
  import { Switch } from 'bits-ui';
  import { cn } from '$lib/utils';

  interface Props {
    checked: boolean;
    label?: string;
    hint?: string;
    disabled?: boolean;
    id?: string;
    class?: string;
    /** Use the danger color when on (e.g. production flag). */
    tone?: 'accent' | 'danger';
    onCheckedChange?: (checked: boolean) => void;
  }

  let {
    checked = $bindable(),
    label,
    hint,
    disabled = false,
    id,
    class: klass,
    tone = 'accent',
    onCheckedChange
  }: Props = $props();
  const uid = $props.id();
  const inputId = $derived(id ?? `sw-${uid}`);
</script>

<div class={cn('flex items-start gap-2.5', klass)}>
  <Switch.Root
    id={inputId}
    bind:checked
    {disabled}
    onCheckedChange={(c) => onCheckedChange?.(c)}
    class={cn(
      'peer mt-[1px] inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full border border-transparent px-[2px] transition-colors disabled:opacity-50',
      'data-[state=unchecked]:bg-border-strong',
      tone === 'danger' ? 'data-[state=checked]:bg-prod' : 'data-[state=checked]:bg-accent'
    )}
  >
    <Switch.Thumb
      class="pointer-events-none block size-[14px] rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[12px]"
    />
  </Switch.Root>
  {#if label}
    <label for={inputId} class="flex min-w-0 flex-col gap-0.5 select-none">
      <span class="text-[12.5px] leading-[18px] text-fg">{label}</span>
      {#if hint}<span class="hint">{hint}</span>{/if}
    </label>
  {/if}
</div>
