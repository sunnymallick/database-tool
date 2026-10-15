<!-- Renders the promise-based confirm/choice dialog and the `:name` parameter prompt. -->
<script lang="ts">
  import { AlertDialog } from 'bits-ui';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import Variable from '@lucide/svelte/icons/variable';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import Kbd from '$lib/components/ui/Kbd.svelte';
  import { dialogs } from '$lib/stores/dialogs.svelte';
  import { cn } from '$lib/utils';

  const choice = $derived(dialogs.choice);
  const params = $derived(dialogs.params);
  const danger = $derived(choice?.actions[0]?.variant === 'danger');

  let values = $state<Record<string, string>>({});
  let paramsOpen = $state(false);
  $effect(() => {
    if (params) {
      values = { ...params.values };
      paramsOpen = true;
    } else paramsOpen = false;
  });

  function variantClass(v: string | undefined): string {
    switch (v) {
      case 'primary':
        return 'btn btn-primary';
      case 'danger':
        return 'btn btn-danger';
      case 'ghost':
        return 'btn btn-ghost';
      default:
        return 'btn';
    }
  }

  function submitParams(e?: Event) {
    e?.preventDefault();
    dialogs.resolveParams($state.snapshot(values));
  }
</script>

<AlertDialog.Root
  open={!!choice}
  onOpenChange={(o) => {
    if (!o) dialogs.resolveChoice(null);
  }}
>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="dialog-overlay" />
    <AlertDialog.Content
      class="dialog-content max-w-[460px]"
      onOpenAutoFocus={(e) => {
        // Destructive questions default to Cancel so Enter never deletes by accident.
        if (!danger) return;
        e.preventDefault();
        (document.querySelector('[data-choice-cancel]') as HTMLElement | null)?.focus();
      }}
    >
      {#if choice}
        <div class="flex gap-3 px-5 pt-5 pb-4">
          {#if danger}
            <div class="flex size-8 shrink-0 items-center justify-center rounded-full bg-danger-soft text-danger">
              <TriangleAlert class="size-4" />
            </div>
          {/if}
          <div class="min-w-0 flex-1">
            <AlertDialog.Title class="text-[14px] leading-6 font-semibold">{choice.title}</AlertDialog.Title>
            {#if choice.message}
              <AlertDialog.Description class="mt-1 text-[12.5px] leading-snug text-muted">{choice.message}</AlertDialog.Description>
            {/if}
            {#if choice.detail}
              <pre
                class="mt-3 max-h-48 overflow-auto rounded-md border border-border bg-sunken p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg select-text">{choice.detail}</pre>
            {/if}
          </div>
        </div>
        <div class="flex flex-row-reverse items-center gap-2 rounded-b-xl border-t border-border bg-sunken/40 px-5 py-3">
          {#each choice.actions as action, i (action.id)}
            {#if action.id === 'cancel'}
              <AlertDialog.Cancel
                data-choice-cancel
                class={variantClass(action.variant)}
                onclick={() => dialogs.resolveChoice('cancel')}
              >
                {action.label}
              </AlertDialog.Cancel>
            {:else}
              <AlertDialog.Action
                class={cn(variantClass(action.variant), i === 0 && 'min-w-[88px]')}
                onclick={() => dialogs.resolveChoice(action.id)}
              >
                {action.label}
              </AlertDialog.Action>
            {/if}
          {/each}
        </div>
      {/if}
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>

<Dialog
  bind:open={paramsOpen}
  title="Query parameters"
  description="Values are inserted as SQL literals: numbers stay bare, NULL stays NULL, everything else is quoted."
  width="max-w-[460px]"
  onOpenChange={(o) => {
    if (!o && dialogs.params) dialogs.resolveParams(null);
  }}
>
  {#if params}
    <form id="params-form" class="flex flex-col gap-2.5" onsubmit={submitParams}>
      {#each params.names as name, i (name)}
        <label class="grid grid-cols-[120px_1fr] items-center gap-3">
          <span class="flex min-w-0 items-center gap-1.5 font-mono text-[12px] text-muted">
            <Variable class="size-3.5 shrink-0 text-faint" />
            <span class="truncate">:{name}</span>
          </span>
          <!-- svelte-ignore a11y_autofocus -->
          <input class="input font-mono" bind:value={values[name]} autofocus={i === 0} spellcheck="false" placeholder="NULL, 42, or text" />
        </label>
      {/each}
    </form>
  {/if}
  {#snippet footer()}
    <span class="mr-auto flex items-center gap-1.5 text-[11.5px] text-faint"><Kbd keys="Enter" /> to run</span>
    <button class="btn btn-ghost" onclick={() => dialogs.resolveParams(null)}>Cancel</button>
    <button class="btn btn-primary" type="submit" form="params-form">Run</button>
  {/snippet}
</Dialog>
