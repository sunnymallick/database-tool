<!-- Model picker. -->
<script lang="ts">
  import { DropdownMenu } from 'bits-ui';
  import Check from '@lucide/svelte/icons/check';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import { aiModelLabel } from '@shared/ai';
  import { aiChat } from '$lib/stores/ai.svelte';

  const itemClass =
    'flex h-7 cursor-default items-center gap-2 rounded px-2 text-[12.5px] outline-none data-highlighted:bg-hover select-none';
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="flex h-6 items-center gap-1 rounded px-1.5 text-[12px] text-muted hover:bg-hover hover:text-fg"
    title="Model"
    data-testid="ai-model-trigger"
  >
    {aiModelLabel(aiChat.model)}
    <ChevronDown class="size-3 text-faint" />
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content align="end" sideOffset={4} class="z-50 min-w-[11rem] rounded-md border border-border bg-overlay p-1 shadow-pop">
      {#each aiChat.modelOptions as m (m.id)}
        <DropdownMenu.Item class={itemClass} onSelect={() => aiChat.setModel(m.id)}>
          <Check class="size-3.5 {aiChat.model === m.id ? 'opacity-100' : 'opacity-0'}" />
          <span class="flex-1">{m.label}</span>
          {#if m.id === aiChat.status?.defaultModel}<span class="text-[10.5px] text-faint">default</span>{/if}
        </DropdownMenu.Item>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
