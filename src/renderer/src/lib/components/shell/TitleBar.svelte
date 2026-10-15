<!--
  macOS hidden-inset title bar (38px). The traffic lights sit at x≈14, so the
  bar leaves ~84px on the left inside Electron. The bar is a drag region;
  every control inside opts out with `no-drag`.
-->
<script lang="ts">
  import PanelLeft from '@lucide/svelte/icons/panel-left';
  import Search from '@lucide/svelte/icons/search';
  import Settings from '@lucide/svelte/icons/settings';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import { isElectron } from '$lib/api.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Kbd from '$lib/components/ui/Kbd.svelte';
  import { isMac } from '$lib/keys';
  import { dialogs } from '$lib/stores/dialogs.svelte';
  import { layout } from '$lib/stores/layout.svelte';
  import { cn } from '$lib/utils';

  const inset = isElectron && isMac;
</script>

<header
  class={cn(
    'drag-region flex h-[38px] shrink-0 items-center gap-1 border-b border-border bg-panel pr-2',
    inset ? 'pl-[84px]' : 'pl-2'
  )}
>
  <div class="no-drag flex items-center">
    <IconButton
      icon={PanelLeft}
      label={layout.sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
      shortcut="Mod-b"
      active={!layout.sidebarCollapsed}
      onclick={() => layout.toggleSidebar()}
    />
  </div>
  {#if !inset}
    <span class="ml-1 text-[12.5px] font-semibold tracking-tight text-muted select-none">Database Tool</span>
  {/if}

  <div class="flex min-w-0 flex-1 justify-center px-3">
    <button
      type="button"
      class="no-drag group flex h-[26px] w-full max-w-[420px] min-w-0 items-center gap-2 rounded-md border border-border bg-sunken/70 px-2.5 text-[12px] text-faint transition-colors hover:border-border-strong hover:text-muted"
      onclick={() => (dialogs.paletteOpen = true)}
    >
      <Search class="size-3.5 shrink-0" />
      <span class="truncate">Search tables, tabs, and commands…</span>
      <Kbd keys="Mod-k" class="ml-auto" />
    </button>
  </div>

  <div class="no-drag flex items-center gap-0.5">
    <IconButton
      icon={Sparkles}
      label={layout.aiOpen ? 'Hide AI assistant' : 'Show AI assistant'}
      shortcut="Shift-Mod-a"
      active={layout.aiOpen}
      iconClass={layout.aiOpen ? 'text-accent' : ''}
      onclick={() => layout.toggleAi()}
    />
    <IconButton icon={Settings} label="Settings" shortcut="Mod-," onclick={() => (dialogs.settingsOpen = true)} />
  </div>
</header>
