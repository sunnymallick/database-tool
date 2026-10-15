/**
 * App settings (main-process owned) mirrored into the renderer, plus the
 * resolved light/dark theme.
 */
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types';
import { call, errorMessage, on } from '$lib/api.svelte';
import { toast } from 'svelte-sonner';

class SettingsStore {
  value = $state<AppSettings>({ ...DEFAULT_SETTINGS });
  loaded = $state(false);
  #systemDark = $state(
    typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)').matches : true
  );

  readonly theme = $derived<'dark' | 'light'>(
    this.value.theme === 'system' ? (this.#systemDark ? 'dark' : 'light') : this.value.theme
  );

  async init(): Promise<void> {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', (e) => (this.#systemDark = e.matches));
    on('settings.changed', (s) => (this.value = { ...DEFAULT_SETTINGS, ...s }));
    try {
      this.value = { ...DEFAULT_SETTINGS, ...(await call('settings.get')) };
    } catch (err) {
      toast.error('Could not load settings', { description: errorMessage(err) });
    } finally {
      this.loaded = true;
    }
  }

  async update(patch: Partial<AppSettings>): Promise<void> {
    const prev = this.value;
    this.value = { ...this.value, ...patch };
    try {
      this.value = { ...DEFAULT_SETTINGS, ...(await call('settings.update', patch)) };
    } catch (err) {
      this.value = prev;
      toast.error('Could not save settings', { description: errorMessage(err) });
    }
  }
}

export const settings = new SettingsStore();
