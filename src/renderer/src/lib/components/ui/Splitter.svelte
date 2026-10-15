<!--
  Drag handle that resizes a neighbouring pane. Reports the pointer delta
  since drag start; the owner clamps and stores the size.

    <Splitter orientation="vertical" onStart={() => (start = width)} onDrag={(d) => (width = clamp(start + d, 200, 480))} />
-->
<script lang="ts">
  import { cn } from '$lib/utils';

  interface Props {
    /** `vertical` = a vertical bar resizing horizontally (col-resize). */
    orientation?: 'vertical' | 'horizontal';
    class?: string;
    onStart?: () => void;
    onDrag: (delta: number) => void;
    onEnd?: () => void;
    onDoubleClick?: () => void;
    label?: string;
  }

  let { orientation = 'vertical', class: klass, onStart, onDrag, onEnd, onDoubleClick, label = 'Resize' }: Props = $props();
  let dragging = $state(false);
  let origin = 0;

  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    origin = orientation === 'vertical' ? e.clientX : e.clientY;
    dragging = true;
    onStart?.();
  }
  function move(e: PointerEvent) {
    if (!dragging) return;
    onDrag((orientation === 'vertical' ? e.clientX : e.clientY) - origin);
  }
  function up(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    onEnd?.();
  }
</script>

<div
  role="separator"
  aria-orientation={orientation}
  aria-label={label}
  class={cn(
    'group relative z-10 shrink-0 touch-none select-none',
    orientation === 'vertical' ? '-mx-[3px] w-[7px] cursor-col-resize' : '-my-[3px] h-[7px] cursor-row-resize',
    klass
  )}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  ondblclick={() => onDoubleClick?.()}
>
  <div
    class={cn(
      'pointer-events-none absolute bg-accent opacity-0 transition-opacity group-hover:opacity-60',
      dragging && 'opacity-100 group-hover:opacity-100',
      orientation === 'vertical' ? 'inset-y-0 left-[3px] w-px' : 'inset-x-0 top-[3px] h-px'
    )}
  ></div>
</div>
{#if dragging}
  <!-- Keep the resize cursor everywhere while dragging. -->
  <div class={cn('fixed inset-0 z-[100]', orientation === 'vertical' ? 'cursor-col-resize' : 'cursor-row-resize')}></div>
{/if}
