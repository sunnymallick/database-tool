/**
 * Global dialogs: which app-level dialog is open, plus promise-based
 * confirm / choice / parameter prompts rendered by <DialogHost />.
 */
import type { ConnectionProfile } from '@shared/types';

export interface ConfirmOptions {
  title: string;
  message?: string;
  /** Monospace block shown under the message (e.g. the SQL about to run). */
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export interface ChoiceAction {
  id: string;
  label: string;
  variant?: 'primary' | 'danger' | 'default' | 'ghost';
}

export interface ChoiceOptions {
  title: string;
  message?: string;
  detail?: string;
  /** Rendered right-to-left; the first is the default (Enter). */
  actions: ChoiceAction[];
}

interface PendingChoice extends ChoiceOptions {
  resolve: (id: string | null) => void;
}

interface PendingParams {
  names: string[];
  values: Record<string, string>;
  resolve: (values: Record<string, string> | null) => void;
}

export interface ConnectionDialogState {
  open: boolean;
  /** Profile being edited; null for a new connection. */
  profile: ConnectionProfile | null;
}

class DialogsStore {
  connection = $state<ConnectionDialogState>({ open: false, profile: null });
  importOpen = $state(false);
  settingsOpen = $state(false);
  paletteOpen = $state(false);
  shortcutsOpen = $state(false);

  choice = $state<PendingChoice | null>(null);
  params = $state<PendingParams | null>(null);

  /** Last values typed for each `:name` parameter, reused as defaults. */
  #paramMemory: Record<string, string> = {};

  openConnection(profile: ConnectionProfile | null = null): void {
    this.connection = { open: true, profile };
  }

  /** Ask a yes/no question. Resolves true when confirmed. */
  confirm(opts: ConfirmOptions): Promise<boolean> {
    return this.choose({
      title: opts.title,
      message: opts.message,
      detail: opts.detail,
      actions: [
        { id: 'ok', label: opts.confirmLabel ?? 'OK', variant: opts.danger ? 'danger' : 'primary' },
        { id: 'cancel', label: opts.cancelLabel ?? 'Cancel', variant: 'default' }
      ]
    }).then((id) => id === 'ok');
  }

  /** Ask with custom buttons. Resolves the chosen action id, or null when dismissed. */
  choose(opts: ChoiceOptions): Promise<string | null> {
    this.choice?.resolve(null);
    return new Promise((resolve) => {
      this.choice = { ...opts, resolve };
    });
  }

  resolveChoice(id: string | null): void {
    const c = this.choice;
    this.choice = null;
    c?.resolve(id);
  }

  /** Prompt for `:name` parameter values. Resolves null when cancelled. */
  askParams(names: string[]): Promise<Record<string, string> | null> {
    this.params?.resolve(null);
    const values: Record<string, string> = {};
    for (const n of names) values[n] = this.#paramMemory[n] ?? '';
    return new Promise((resolve) => {
      this.params = { names, values, resolve };
    });
  }

  resolveParams(values: Record<string, string> | null): void {
    const p = this.params;
    this.params = null;
    if (values) Object.assign(this.#paramMemory, values);
    p?.resolve(values);
  }
}

export const dialogs = new DialogsStore();
