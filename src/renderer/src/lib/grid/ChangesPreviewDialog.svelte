<!-- Shows the SQL that pending grid edits will run, with Copy and Apply. -->
<script lang="ts">
  import Copy from '@lucide/svelte/icons/copy';
  import { toast } from 'svelte-sonner';
  import type { DbKind } from '@shared/types';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import SqlEditor from '$lib/editor/SqlEditor.svelte';
  import { cn, copyText, plural } from '$lib/utils';

  interface Props {
    open: boolean;
    statements: string[];
    dialect?: DbKind | null;
    applying?: boolean;
    production?: boolean;
    readOnly?: boolean;
    onApply: () => void;
  }

  let {
    open = $bindable(),
    statements,
    dialect = null,
    applying = false,
    production = false,
    readOnly = false,
    onApply
  }: Props = $props();

  const sqlText = $derived(statements.map((s) => s.replace(/;\s*$/, '')).join(';\n\n') + (statements.length ? ';' : ''));

  async function copy() {
    await copyText(sqlText);
    toast.success('Copied SQL');
  }
</script>

<Dialog
  bind:open
  title="Preview changes"
  description={`${plural(statements.length, 'statement')} will run in order${production ? ' on a production connection' : ''}.`}
  width="max-w-[760px]"
  bodyClass="pb-4"
>
  <div
    class={cn(
      'h-[min(420px,55vh)] overflow-hidden rounded-md border',
      production ? 'border-prod/60' : 'border-border'
    )}
  >
    <SqlEditor doc={sqlText} kind={dialect} readOnly lineNumbers wrap={false} />
  </div>

  {#snippet footer()}
    <button type="button" class="btn mr-auto" onclick={copy}>
      <Copy class="size-3.5" />
      Copy SQL
    </button>
    <button type="button" class="btn" onclick={() => (open = false)}>Close</button>
    <button
      type="button"
      class={cn('btn', production ? 'btn-danger' : 'btn-primary')}
      disabled={applying || readOnly || statements.length === 0}
      title={readOnly ? 'This connection is read-only' : undefined}
      onclick={onApply}
    >
      {#if applying}<span class="spinner size-3"></span>{/if}
      {production ? 'Apply on production' : 'Apply changes'}
    </button>
  {/snippet}
</Dialog>
