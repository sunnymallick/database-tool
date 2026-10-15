<!--
  Application shell: title bar, sidebar, tabbed workspace, AI dock, status bar,
  and the app-level dialogs.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Tooltip } from 'bits-ui';
  import { Toaster } from 'svelte-sonner';
  import { on } from '$lib/api.svelte';
  import { handleGlobalKeydown, runMenuAction } from '$lib/commands';
  import AiPanel from '$lib/components/ai/AiPanel.svelte';
  import ConnectionDialog from '$lib/components/connections/ConnectionDialog.svelte';
  import ImportDialog from '$lib/components/connections/ImportDialog.svelte';
  import SettingsDialog from '$lib/components/dialogs/SettingsDialog.svelte';
  import CommandPalette from '$lib/components/shell/CommandPalette.svelte';
  import DialogHost from '$lib/components/shell/DialogHost.svelte';
  import ShortcutsDialog from '$lib/components/shell/ShortcutsDialog.svelte';
  import Sidebar from '$lib/components/shell/Sidebar.svelte';
  import StatusBar from '$lib/components/shell/StatusBar.svelte';
  import TitleBar from '$lib/components/shell/TitleBar.svelte';
  import Workspace from '$lib/components/shell/Workspace.svelte';
  import Splitter from '$lib/components/ui/Splitter.svelte';
  import { connections } from '$lib/stores/connections.svelte';
  import { AI_MAX, AI_MIN, layout, SIDEBAR_MAX, SIDEBAR_MIN } from '$lib/stores/layout.svelte';
  import { restoreSession, startSessionAutosave } from '$lib/stores/session.svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import { tabs } from '$lib/stores/tabs.svelte';
  import { installWorkbenchBridge } from '$lib/workbench';
  import { clamp, cn } from '$lib/utils';

  // Register before children mount so the AI panel can reach the workbench immediately.
  const stopBridge = installWorkbenchBridge();

  let ready = $state(false);
  let sidebarStart = 0;
  let aiStart = 0;

  // Theme: data-theme on <html>, following settings (and the OS for "system").
  $effect(() => {
    document.documentElement.dataset.theme = settings.theme;
  });

  onMount(() => {
    const offMenu = on('menu', runMenuAction);
    let stopAutosave: (() => void) | null = null;
    let disposed = false;

    void (async () => {
      await Promise.all([settings.init(), connections.init()]);
      const restored = await restoreSession();
      if (disposed) return;
      // First run with connections but nothing open: start with an empty query tab.
      if (!restored && connections.profiles.length > 0 && tabs.tabs.length === 0) {
        tabs.openQuery({ conn: defaultConn() });
      }
      stopAutosave = startSessionAutosave();
      ready = true;
    })();

    return () => {
      disposed = true;
      stopBridge();
      offMenu();
      stopAutosave?.();
    };
  });

  function defaultConn() {
    const connected = Object.values(connections.statuses).find((s) => s.state === 'connected');
    if (!connected) return null;
    const p = connections.byId(connected.profileId);
    if (!p) return null;
    return p.kind === 'sqlite' ? { profileId: p.id } : { profileId: p.id, database: connected.database };
  }
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<Tooltip.Provider delayDuration={450} skipDelayDuration={150}>
  <div class={cn('flex h-full flex-col transition-opacity duration-150', ready ? 'opacity-100' : 'opacity-0')}>
    <TitleBar />
    <div class="flex min-h-0 flex-1">
      {#if !layout.sidebarCollapsed}
        <div class="flex shrink-0 border-r border-border" style="width: {layout.sidebarWidth}px">
          <div class="min-w-0 flex-1"><Sidebar /></div>
        </div>
        <Splitter
          label="Resize sidebar"
          onStart={() => (sidebarStart = layout.sidebarWidth)}
          onDrag={(d) => (layout.sidebarWidth = clamp(sidebarStart + d, SIDEBAR_MIN, SIDEBAR_MAX))}
          onDoubleClick={() => (layout.sidebarWidth = 264)}
        />
      {/if}
      <main class="min-w-0 flex-1">
        <Workspace />
      </main>
      <!-- The AI panel stays mounted so its conversation survives toggling. -->
      {#if layout.aiOpen}
        <Splitter
          label="Resize AI panel"
          onStart={() => (aiStart = layout.aiWidth)}
          onDrag={(d) => (layout.aiWidth = clamp(aiStart - d, AI_MIN, AI_MAX))}
          onDoubleClick={() => (layout.aiWidth = 380)}
        />
      {/if}
      <aside
        class={cn('shrink-0 border-l border-border', !layout.aiOpen && 'hidden')}
        style="width: {layout.aiWidth}px"
        aria-label="AI assistant"
      >
        <AiPanel />
      </aside>
    </div>
    <StatusBar />
  </div>

  <ConnectionDialog />
  <ImportDialog />
  <SettingsDialog />
  <CommandPalette />
  <ShortcutsDialog />
  <DialogHost />
  <Toaster theme={settings.theme} position="bottom-right" offset={{ bottom: 36, right: layout.aiOpen ? layout.aiWidth + 16 : 16 }} closeButton visibleToasts={4} />
</Tooltip.Provider>
