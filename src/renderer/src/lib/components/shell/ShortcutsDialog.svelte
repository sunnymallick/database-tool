<!-- Keyboard shortcut cheat sheet. -->
<script lang="ts">
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import Kbd from '$lib/components/ui/Kbd.svelte';
  import { dialogs } from '$lib/stores/dialogs.svelte';

  const groups: { title: string; items: [string, string[]][] }[] = [
    {
      title: 'General',
      items: [
        ['Command palette', ['Mod-k']],
        ['New query tab', ['Mod-t']],
        ['New connection', ['Shift-Mod-n']],
        ['Open SQL file', ['Mod-o']],
        ['Save / Save as', ['Mod-s', 'Shift-Mod-s']],
        ['Close tab', ['Mod-w']],
        ['Next / previous tab', ['Shift-Mod-]', 'Shift-Mod-[']],
        ['Go to tab 1–9', ['Mod-1']],
        ['Toggle sidebar', ['Mod-b']],
        ['Toggle AI assistant', ['Shift-Mod-a']],
        ['Settings', ['Mod-,']],
        ['Keyboard shortcuts', ['Shift-Mod-/']]
      ]
    },
    {
      title: 'Query editor',
      items: [
        ['Run statement at cursor or selection', ['Mod-Enter']],
        ['Run whole script', ['Shift-Mod-Enter']],
        ['Format SQL', ['Shift-Mod-f']],
        ['Toggle comment', ['Mod-/']],
        ['Find / replace', ['Mod-f']],
        ['Autocomplete', ['Ctrl-Space']],
        ['Undo / redo', ['Mod-z', 'Shift-Mod-z']],
        ['Indent / outdent', ['Tab', 'Shift-Tab']]
      ]
    },
    {
      title: 'Results grid',
      items: [
        ['Copy selection (TSV)', ['Mod-c']],
        ['Select all', ['Mod-a']],
        ['Extend selection', ['Shift-ArrowDown']],
        ['Add cell to selection', ['Mod-Click']],
        ['Edit cell', ['Enter', 'F2']],
        ['Cancel edit', ['Escape']],
        ['View full value', ['Shift-Space']],
        ['Mark rows for deletion', ['Mod-Backspace']]
      ]
    },
    {
      title: 'Sidebar',
      items: [
        ['Move selection', ['ArrowUp', 'ArrowDown']],
        ['Expand / collapse', ['ArrowRight', 'ArrowLeft']],
        ['Open table data', ['Enter']]
      ]
    }
  ];
</script>

<Dialog bind:open={dialogs.shortcutsOpen} title="Keyboard shortcuts" width="max-w-[760px]">
  <div class="grid grid-cols-1 gap-x-8 gap-y-5 md:grid-cols-2">
    {#each groups as g (g.title)}
      <section>
        <h3 class="panel-title mb-1.5">{g.title}</h3>
        <ul>
          {#each g.items as [label, keys] (label)}
            <li class="flex h-7 items-center gap-3 border-b border-grid-line text-[12.5px] last:border-b-0">
              <span class="min-w-0 flex-1 truncate text-muted">{label}</span>
              <span class="flex shrink-0 items-center gap-1">
                {#each keys as k, i (k)}
                  {#if i > 0}<span class="text-[11px] text-faint">/</span>{/if}
                  <Kbd keys={k} />
                {/each}
              </span>
            </li>
          {/each}
        </ul>
      </section>
    {/each}
  </div>
</Dialog>
