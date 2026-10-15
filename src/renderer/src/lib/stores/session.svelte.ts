/**
 * Restores and autosaves the renderer workspace (layout + open tabs) through
 * `session.load` / `session.save`.
 */
import { call } from '$lib/api.svelte';
import { debounce } from '$lib/utils';
import { layout, type LayoutState } from './layout.svelte';
import { tabs, type PersistedTab } from './tabs.svelte';

interface SessionV1 {
  version: 1;
  layout: LayoutState;
  tabs: PersistedTab[];
  activeId: string | null;
}

function isSession(x: unknown): x is SessionV1 {
  return !!x && typeof x === 'object' && (x as SessionV1).version === 1;
}

/** Returns true when a previous session was restored. */
export async function restoreSession(): Promise<boolean> {
  try {
    const data = await call('session.load');
    if (!isSession(data)) return false;
    layout.restore(data.layout);
    tabs.restore({ tabs: data.tabs, activeId: data.activeId });
    return true;
  } catch {
    return false;
  }
}

function snapshot(): SessionV1 {
  return { version: 1, layout: layout.serialize(), ...tabs.serialize() };
}

/** Save the session whenever it changes (debounced). Returns a stop function. */
export function startSessionAutosave(): () => void {
  const save = debounce((s: SessionV1) => {
    void call('session.save', s).catch(() => {});
  }, 700);
  const stopEffect = $effect.root(() => {
    let first = true;
    $effect(() => {
      const s = snapshot();
      // Skip the initial run: nothing has changed since restore.
      if (first) {
        first = false;
        return;
      }
      save(s);
    });
  });
  const flush = () => save.flush();
  const onHide = () => {
    if (document.visibilityState === 'hidden') save.flush();
  };
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', onHide);
  return () => {
    stopEffect();
    save.flush();
    window.removeEventListener('beforeunload', flush);
    document.removeEventListener('visibilitychange', onHide);
  };
}
