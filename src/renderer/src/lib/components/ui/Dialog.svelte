<!--
  App dialog: bits-ui Dialog with a header (title, optional description),
  scrollable body, and an optional footer snippet.
-->
<script lang="ts">
  import { Dialog } from 'bits-ui';
  import X from '@lucide/svelte/icons/x';
  import type { Snippet } from 'svelte';
  import { cn } from '$lib/utils';

  interface Props {
    open: boolean;
    title: string;
    description?: string;
    /** Tailwind width class, e.g. `max-w-[560px]`. */
    width?: string;
    class?: string;
    bodyClass?: string;
    children: Snippet;
    footer?: Snippet;
    /** Extra header content (right side, before the close button). */
    headerExtra?: Snippet;
    onOpenChange?: (open: boolean) => void;
    onOpenAutoFocus?: (e: Event) => void;
    /** Prevent closing on outside click (forms with unsaved input). */
    modalLock?: boolean;
  }

  let {
    open = $bindable(),
    title,
    description,
    width = 'max-w-[520px]',
    class: klass,
    bodyClass,
    children,
    footer,
    headerExtra,
    onOpenChange,
    onOpenAutoFocus,
    modalLock = false
  }: Props = $props();

  let body = $state<HTMLDivElement | null>(null);

  /** Focus the first field (or [autofocus] element) instead of the header close button. */
  function focusFirstField(e: Event) {
    if (onOpenAutoFocus) {
      onOpenAutoFocus(e);
      return;
    }
    const target = body?.querySelector<HTMLElement>(
      '[autofocus], input:not([type=hidden]):not([disabled]), textarea:not([disabled]), [role=combobox]'
    );
    if (target) {
      e.preventDefault();
      target.focus();
    }
  }
</script>

<Dialog.Root
  bind:open
  onOpenChange={(o) => onOpenChange?.(o)}
>
  <Dialog.Portal>
    <Dialog.Overlay class="dialog-overlay" />
    <Dialog.Content
      class={cn('dialog-content', width, klass)}
      onOpenAutoFocus={focusFirstField}
      interactOutsideBehavior={modalLock ? 'ignore' : 'close'}
    >
      <div class="flex shrink-0 items-start gap-3 px-5 pt-4 pb-3">
        <div class="min-w-0 flex-1">
          <Dialog.Title class="text-[14px] leading-6 font-semibold">{title}</Dialog.Title>
          {#if description}
            <Dialog.Description class="mt-0.5 text-[12.5px] leading-snug text-muted">{description}</Dialog.Description>
          {/if}
        </div>
        {@render headerExtra?.()}
        <Dialog.Close class="btn btn-ghost btn-icon btn-sm -mr-1.5" aria-label="Close">
          <X class="size-4" />
        </Dialog.Close>
      </div>
      <div bind:this={body} class={cn('min-h-0 flex-1 overflow-auto px-5 pb-4', bodyClass)}>
        {@render children()}
      </div>
      {#if footer}
        <div class="flex shrink-0 items-center justify-end gap-2 rounded-b-xl border-t border-border bg-sunken/40 px-5 py-3">
          {@render footer()}
        </div>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
