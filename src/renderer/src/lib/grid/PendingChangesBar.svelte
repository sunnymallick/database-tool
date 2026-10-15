<!--
  Bar shown while an EditSession has pending changes: Discard, Preview SQL,
  Apply. Apply runs db.applyChanges (with a production confirmation).
-->
<script lang="ts">
  import Eye from '@lucide/svelte/icons/eye';
  import Lock from '@lucide/svelte/icons/lock';
  import PencilLine from '@lucide/svelte/icons/pencil-line';
  import { toast } from 'svelte-sonner';
  import type { TableRef, Value } from '@shared/types';
  import { call, errorMessage } from '$lib/api.svelte';
  import Tip from '$lib/components/ui/Tip.svelte';
  import { connections } from '$lib/stores/connections.svelte';
  import { dialogs } from '$lib/stores/dialogs.svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import { cn, plural } from '$lib/utils';
  import ChangesPreviewDialog from './ChangesPreviewDialog.svelte';
  import type { EditSession } from './edit-session.svelte';

  interface Props {
    session: EditSession;
    rows: Value[][];
    table: TableRef;
    onApplied: () => void;
    class?: string;
  }

  let { session, rows, table, onApplied, class: klass }: Props = $props();

  const profile = $derived(connections.byId(table.conn.profileId));
  const production = $derived(!!profile?.production);
  const readOnly = $derived(!!profile?.readOnly);

  let previewOpen = $state(false);
  let statements = $state<string[]>([]);
  let previewing = $state(false);
  let applying = $state(false);

  const breakdown = $derived(
    [
      session.updatedRowCount ? `${session.updatedRowCount} updated` : '',
      session.inserts.length ? `${session.inserts.length} inserted` : '',
      session.deletedCount ? `${session.deletedCount} deleted` : ''
    ]
      .filter(Boolean)
      .join(' · ')
  );

  async function preview() {
    previewing = true;
    try {
      const res = await call('db.applyChanges', { table, changes: session.toChangeSet(rows), preview: true });
      statements = res.statements;
      previewOpen = true;
    } catch (err) {
      toast.error('Could not render the change SQL', { description: errorMessage(err) });
    } finally {
      previewing = false;
    }
  }

  async function apply() {
    if (readOnly || applying) return;
    const count = session.count;
    if (production && settings.value.confirmProductionWrites) {
      const ok = await dialogs.confirm({
        title: `Apply ${plural(count, 'change')} on production?`,
        message: `“${connections.label(table.conn)}” is a production connection. ${table.schema ? `${table.schema}.` : ''}${table.table} will be modified.`,
        confirmLabel: 'Apply on production',
        danger: true
      });
      if (!ok) return;
    }
    applying = true;
    try {
      const res = await call('db.applyChanges', { table, changes: session.toChangeSet(rows), preview: false });
      toast.success(`Applied ${plural(count, 'change')}`, {
        description: `${plural(res.applied, 'row')} affected in ${table.table}`
      });
      previewOpen = false;
      session.discard();
      onApplied();
    } catch (err) {
      toast.error('Could not apply changes', { description: errorMessage(err) });
    } finally {
      applying = false;
    }
  }
</script>

{#if session.hasChanges}
  <div
    class={cn(
      'flex h-9 shrink-0 items-center gap-2 border-t border-border bg-warning-soft px-3 text-[12px]',
      klass
    )}
    role="status"
  >
    <PencilLine class="size-3.5 shrink-0 text-warning" />
    <span class="font-medium text-fg">{plural(session.count, 'pending change')}</span>
    <span class="truncate text-muted">{breakdown}</span>
    <span class="flex-1"></span>
    <button type="button" class="btn btn-ghost btn-sm" disabled={applying} onclick={() => session.discard()}>
      Discard
    </button>
    <button type="button" class="btn btn-sm" disabled={previewing || applying} onclick={preview}>
      {#if previewing}<span class="spinner size-3"></span>{:else}<Eye class="size-3.5" />{/if}
      Preview SQL
    </button>
    {#if readOnly}
      <Tip text="This connection is read-only">
        {#snippet trigger(props)}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <span {...props} class="inline-flex" tabindex="0">
            <button type="button" class="btn btn-primary btn-sm" disabled>
              <Lock class="size-3" />
              Apply
            </button>
          </span>
        {/snippet}
      </Tip>
    {:else}
      <button
        type="button"
        class={cn('btn btn-sm', production ? 'btn-danger' : 'btn-primary')}
        disabled={applying}
        onclick={apply}
      >
        {#if applying}<span class="spinner size-3"></span>{/if}
        {production ? 'Apply on production' : 'Apply'}
      </button>
    {/if}
  </div>
{/if}

<ChangesPreviewDialog
  bind:open={previewOpen}
  {statements}
  dialect={profile?.kind ?? null}
  {applying}
  {production}
  {readOnly}
  onApply={apply}
/>
