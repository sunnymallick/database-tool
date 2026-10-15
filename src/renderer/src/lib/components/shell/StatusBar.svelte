<!-- Bottom status bar: active connection, server version, last query, safety flags. -->
<script lang="ts">
  import Lock from '@lucide/svelte/icons/lock';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import FlaskConical from '@lucide/svelte/icons/flask-conical';
  import { isElectron } from '$lib/api.svelte';
  import StatusDot from '$lib/components/connections/StatusDot.svelte';
  import { connections, resolveDb } from '$lib/stores/connections.svelte';
  import { tabs } from '$lib/stores/tabs.svelte';
  import { cn, formatCount, formatDuration } from '$lib/utils';

  const conn = $derived(tabs.activeConn());
  const profile = $derived(connections.byId(conn?.profileId));
  const status = $derived(connections.statusOf(conn));
  const connState = $derived(status?.state ?? 'disconnected');
  const db = $derived(conn && profile ? resolveDb(conn, profile) : '');
  const query = $derived(tabs.activeQuery);

  let now = $state(Date.now());
  $effect(() => {
    if (!query?.running) return;
    const t = setInterval(() => (now = Date.now()), 100);
    return () => clearInterval(t);
  });

  const lastRun = $derived(query?.lastRun ?? null);
</script>

<footer
  class={cn(
    'flex h-6 shrink-0 items-center gap-3 border-t px-3 text-[11.5px] text-muted select-none',
    profile?.production ? 'border-prod/50 bg-prod-soft' : 'border-border bg-panel'
  )}
>
  {#if profile}
    <span class="flex min-w-0 items-center gap-1.5">
      <StatusDot state={connState} error={status?.error} />
      <span class={cn('truncate font-medium', profile.production ? 'text-prod' : 'text-fg')}>{profile.name}</span>
      {#if db}<span class="truncate text-faint">/ {db}</span>{/if}
    </span>
    {#if status?.serverVersion && connState === 'connected'}
      <span class="hidden truncate text-faint md:inline">{status.serverVersion}</span>
    {:else if connState === 'error'}
      <span class="truncate text-danger" title={status?.error}>{status?.error ?? 'Connection error'}</span>
    {:else if connState !== 'connected'}
      <span class="text-faint">{connState === 'connecting' ? 'Connecting…' : 'Not connected'}</span>
    {/if}
    {#if profile.production}
      <span class="badge h-4 bg-prod text-white"><ShieldAlert class="size-3" />Production</span>
    {/if}
    {#if profile.readOnly}
      <span class="badge h-4 bg-warning-soft text-warning"><Lock class="size-3" />Read-only</span>
    {/if}
  {:else}
    <span class="text-faint">No connection selected</span>
  {/if}

  <span class="ml-auto flex shrink-0 items-center gap-3">
    {#if query?.running}
      <span class="flex items-center gap-1.5 text-accent">
        <span class="spinner size-3"></span>
        Running · {formatDuration(now - query.startedAt)}
      </span>
    {:else if lastRun}
      <span class={cn(!lastRun.ok && !lastRun.cancelled && 'text-danger')}>
        {#if lastRun.cancelled}
          Cancelled
        {:else if !lastRun.ok}
          Failed
        {:else if lastRun.rowsAffected != null && lastRun.rows === 0}
          {formatCount(lastRun.rowsAffected)} affected
        {:else}
          {formatCount(lastRun.rows)} {lastRun.rows === 1 ? 'row' : 'rows'}
        {/if}
        · {formatDuration(lastRun.durationMs)}
      </span>
    {/if}
    {#if !isElectron}
      <span class="flex items-center gap-1 text-faint" title="Running in a browser against the in-memory mock backend">
        <FlaskConical class="size-3" />Mock backend
      </span>
    {/if}
  </span>
</footer>
