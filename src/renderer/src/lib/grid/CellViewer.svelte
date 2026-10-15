<!--
  Modal viewer / editor for one cell: pretty-printed JSON or the full text,
  with copy, and (when editable) a text editor with JSON validation.
-->
<script lang="ts">
  import Copy from '@lucide/svelte/icons/copy';
  import Pencil from '@lucide/svelte/icons/pencil';
  import WrapText from '@lucide/svelte/icons/text-wrap';
  import type { ResultColumn, Value } from '@shared/types';
  import { classifyType, displayValue, editText, valueFromInput } from '@shared/values';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import Kbd from '$lib/components/ui/Kbd.svelte';
  import { cn, copyText } from '$lib/utils';
  import { toast } from 'svelte-sonner';
  import { plainText } from './export';

  interface Props {
    open: boolean;
    column: ResultColumn | null;
    /** Current value; undefined for an unset (DEFAULT) insert cell. */
    value: Value | undefined;
    /** Original value before pending edits (drives parsing of the edited text). */
    original?: Value;
    editable?: boolean;
    startInEdit?: boolean;
    onSave?: (value: Value) => void;
    onSetNull?: () => void;
  }

  let {
    open = $bindable(),
    column,
    value,
    original,
    editable = false,
    startInEdit = false,
    onSave,
    onSetNull
  }: Props = $props();

  let editing = $state(false);
  let text = $state('');
  let wrap = $state(true);
  let textarea = $state<HTMLTextAreaElement | null>(null);

  const isJsonColumn = $derived(
    value?.t === 'json' || (column ? classifyType(column.type) === 'json' : false)
  );

  const pretty = $derived.by(() => {
    if (!value) return '';
    if (value.t === 'json') {
      if (typeof value.v === 'string') {
        try {
          return JSON.stringify(JSON.parse(value.v), null, 2);
        } catch {
          return value.v;
        }
      }
      return JSON.stringify(value.v, null, 2);
    }
    if (value.t === 'text' && /^\s*[[{]/.test(value.v)) {
      try {
        return JSON.stringify(JSON.parse(value.v), null, 2);
      } catch {
        return value.v;
      }
    }
    return plainText(value, '');
  });

  const jsonError = $derived.by(() => {
    if (!editing || !isJsonColumn || text.trim() === '') return null;
    try {
      JSON.parse(text);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  });

  const meta = $derived.by(() => {
    if (!value) return 'DEFAULT';
    switch (value.t) {
      case 'null':
        return 'NULL';
      case 'bytes':
        return `${value.length.toLocaleString()} bytes${value.truncated ? ' (truncated)' : ''}`;
      case 'text':
        return `${value.v.length.toLocaleString()} chars`;
      default:
        return value.t;
    }
  });

  // Reset whenever the dialog opens.
  $effect(() => {
    if (!open) return;
    editing = editable && startInEdit;
    text = value ? (value.t === 'json' ? pretty : editText(value)) : '';
    if (editing) queueMicrotask(() => textarea?.focus());
  });

  function beginEdit() {
    text = value ? (value.t === 'json' ? pretty : editText(value)) : '';
    editing = true;
    queueMicrotask(() => textarea?.focus());
  }

  function save() {
    if (jsonError || !column) return;
    const v = valueFromInput(text, { original: original ?? value, columnType: column.type });
    onSave?.(v);
    open = false;
  }

  async function copy() {
    await copyText(editing ? text : value ? pretty : '');
    toast.success('Copied to clipboard');
  }

  function onKey(e: KeyboardEvent) {
    if (editing && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      save();
    }
  }
</script>

<Dialog
  bind:open
  title={column?.name ?? 'Value'}
  description={column ? `${column.type || 'unknown type'} · ${meta}` : meta}
  width="max-w-[720px]"
  bodyClass="pb-3"
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="flex flex-col gap-2" onkeydown={onKey}>
    {#if editing}
      <textarea
        bind:this={textarea}
        bind:value={text}
        spellcheck="false"
        class={cn(
          'textarea h-[360px] resize-none text-[12px] leading-[1.55]',
          !wrap && 'whitespace-pre',
          jsonError && 'border-danger focus:border-danger'
        )}
        aria-label="Cell value"
      ></textarea>
      <div class="flex min-h-[18px] items-center gap-2 text-[11.5px]">
        {#if jsonError}
          <span class="text-danger">Invalid JSON: {jsonError}</span>
        {:else if isJsonColumn}
          <span class="text-faint">Valid JSON</span>
        {:else}
          <span class="text-faint">Leave empty to store NULL. <Kbd keys="Mod-Enter" /> saves.</span>
        {/if}
      </div>
    {:else if !value || value.t === 'null'}
      <div class="flex h-[120px] items-center justify-center rounded-md border border-border bg-sunken font-mono text-[12px] text-faint italic">
        {value ? 'NULL' : 'DEFAULT'}
      </div>
    {:else}
      <pre
        class={cn(
          'max-h-[420px] min-h-[120px] overflow-auto rounded-md border border-border bg-sunken p-3 font-mono text-[12px] leading-[1.55] select-text',
          wrap ? 'break-words whitespace-pre-wrap' : 'whitespace-pre'
        )}>{value.t === 'bytes' && value.length <= 32 ? displayValue(value) : pretty}</pre>
    {/if}
  </div>

  {#snippet footer()}
    <button type="button" class="btn btn-ghost mr-auto" aria-pressed={wrap} onclick={() => (wrap = !wrap)}>
      <WrapText class="size-3.5" />
      {wrap ? 'Wrapping' : 'No wrap'}
    </button>
    <button type="button" class="btn" onclick={copy}>
      <Copy class="size-3.5" />
      Copy
    </button>
    {#if editable}
      {#if editing}
        <button
          type="button"
          class="btn"
          onclick={() => {
            onSetNull?.();
            open = false;
          }}>Set NULL</button
        >
        <button type="button" class="btn" onclick={() => (editing = false)}>Cancel</button>
        <button type="button" class="btn btn-primary" disabled={!!jsonError} onclick={save}>Save</button>
      {:else}
        <button type="button" class="btn btn-primary" onclick={beginEdit}>
          <Pencil class="size-3.5" />
          Edit
        </button>
      {/if}
    {:else}
      <button type="button" class="btn btn-primary" onclick={() => (open = false)}>Done</button>
    {/if}
  {/snippet}
</Dialog>
