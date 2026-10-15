<!-- Connection status indicator: green connected, amber connecting, red error, hollow when disconnected. -->
<script lang="ts">
  import type { ConnectionState } from '@shared/types';
  import { cn } from '$lib/utils';

  interface Props {
    state: ConnectionState;
    error?: string;
    class?: string;
  }

  let { state, error, class: klass }: Props = $props();

  const label = $derived(
    state === 'connected' ? 'Connected' : state === 'connecting' ? 'Connecting…' : state === 'error' ? `Error: ${error ?? 'connection failed'}` : 'Disconnected'
  );
</script>

<span
  class={cn(
    'status-dot',
    state === 'connected' && 'bg-success shadow-[0_0_0_2px_var(--success-soft)]',
    state === 'connecting' && 'animate-pulse bg-warning',
    state === 'error' && 'bg-danger',
    state === 'disconnected' && 'border border-border-strong bg-transparent',
    klass
  )}
  title={label}
  role="img"
  aria-label={label}
></span>
