<!-- Picks the connection the agent's tools act on. -->
<script lang="ts">
  import { DropdownMenu } from 'bits-ui';
  import Check from '@lucide/svelte/icons/check';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Database from '@lucide/svelte/icons/database';
  import Unplug from '@lucide/svelte/icons/unplug';
  import { aiChat } from '$lib/stores/ai.svelte';

  const target = $derived(aiChat.target);
  const ref = $derived(aiChat.targetRef);
  const profile = $derived(aiChat.targetProfile);
  const label = $derived(
    target.mode === 'none'
      ? 'No database'
      : target.mode === 'active' && !ref
        ? 'No active connection'
        : aiChat.connLabel(ref)
  );

  function isPinned(r: { profileId: string; database?: string }) {
    return (
      target.mode === 'pinned' && target.ref.profileId === r.profileId && (target.ref.database ?? '') === (r.database ?? '')
    );
  }

  const itemClass =
    'flex h-7 cursor-default items-center gap-2 rounded px-2 text-[12.5px] outline-none data-highlighted:bg-hover select-none';
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded px-1.5 text-[12px] hover:bg-hover"
    title="Connection the assistant's tools use"
    data-testid="ai-conn-trigger"
  >
    {#if ref}
      <Database class="size-3.5 shrink-0 {profile?.production ? 'text-prod' : 'text-muted'}" />
    {:else}
      <Unplug class="size-3.5 shrink-0 text-faint" />
    {/if}
    <span class="truncate {ref ? 'text-fg' : 'text-muted'}">{label}</span>
    {#if target.mode === 'active' && ref}<span class="shrink-0 text-[10.5px] text-faint">(active tab)</span>{/if}
    <ChevronDown class="size-3 shrink-0 text-faint" />
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      align="start"
      sideOffset={4}
      class="z-50 max-h-80 min-w-[16rem] overflow-y-auto rounded-md border border-border bg-overlay p-1 shadow-pop"
    >
      <DropdownMenu.Item class={itemClass} onSelect={() => aiChat.setTarget({ mode: 'active' })}>
        <Check class="size-3.5 {target.mode === 'active' ? 'opacity-100' : 'opacity-0'}" />
        <span class="flex-1">Follow the active tab</span>
        {#if aiChat.activeRef}<span class="max-w-[8rem] truncate text-[11px] text-faint">{aiChat.connLabel(aiChat.activeRef)}</span>{/if}
      </DropdownMenu.Item>
      <DropdownMenu.Separator class="my-1 h-px bg-border" />
      <DropdownMenu.Group>
        <DropdownMenu.GroupHeading class="px-2 py-1 text-[10.5px] font-semibold tracking-wider text-faint uppercase">
          Connected
        </DropdownMenu.GroupHeading>
        {#each aiChat.connectedOptions as opt (opt.ref.profileId + '/' + (opt.ref.database ?? ''))}
          <DropdownMenu.Item class={itemClass} onSelect={() => aiChat.setTarget({ mode: 'pinned', ref: opt.ref })}>
            <Check class="size-3.5 {isPinned(opt.ref) ? 'opacity-100' : 'opacity-0'}" />
            <span class="flex-1 truncate">{opt.label}</span>
            {#if opt.profile?.production}<span class="badge bg-prod-soft text-prod">prod</span>{/if}
            {#if opt.profile?.readOnly}<span class="badge bg-hover text-muted">read-only</span>{/if}
          </DropdownMenu.Item>
        {:else}
          <div class="px-2 py-1.5 text-[12px] text-faint">No open connections</div>
        {/each}
      </DropdownMenu.Group>
      <DropdownMenu.Separator class="my-1 h-px bg-border" />
      <DropdownMenu.Item class={itemClass} onSelect={() => aiChat.setTarget({ mode: 'none' })}>
        <Check class="size-3.5 {target.mode === 'none' ? 'opacity-100' : 'opacity-0'}" />
        <span>No database</span>
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
