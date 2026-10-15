/**
 * AI panel state: the conversation, the streaming turn, panel settings
 * (model, connection target, allow-writes, include-editor), and CLI status.
 *
 * A module singleton, so the conversation survives the panel being closed
 * and `ai.ask()` works before the panel is first shown.
 */
import {
  AI_MODELS,
  DEFAULT_AI_MODEL,
  aiModelLabel,
  type AiErrorCode,
  type AiEvent,
  type AiStatus,
  type AiToolKind,
  type EditorSnapshot
} from '@shared/ai';
import type { AppSettings, ConnRef, ConnectionProfile, ConnectionStatus } from '@shared/types';
import { call, errorMessage, on } from '$lib/api.svelte';
import { registerAi, workbench, type AskAiOptions } from '$lib/bridge';

export type ToolState = 'running' | 'awaiting' | 'ok' | 'error' | 'denied' | 'stopped';

export type ChatItem =
  | { kind: 'user'; id: string; text: string; context: string | null }
  | { kind: 'text'; id: string; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      toolKind: AiToolKind;
      preview: string;
      needsApproval: boolean;
      production: boolean;
      state: ToolState;
      summary: string;
      /** The user's answer on an approval card. */
      decision: 'approved' | 'rejected' | null;
      /** Connection label at the time of the call (approval cards show it). */
      connLabel: string;
    }
  | { kind: 'proposal'; id: string; sql: string; explanation: string | null; conn: ConnRef | null }
  | { kind: 'error'; id: string; message: string; code: AiErrorCode | null; retryPrompt: string | null }
  | { kind: 'meta'; id: string; text: string; title: string | null };

/** Which connection the agent's tools act on. */
export type ConnTarget = { mode: 'active' } | { mode: 'none' } | { mode: 'pinned'; ref: ConnRef };

export interface ConnOption {
  ref: ConnRef;
  label: string;
  profile: ConnectionProfile | null;
}

function newId(): string {
  return crypto.randomUUID();
}

function sameRef(a: ConnRef | null, b: ConnRef | null): boolean {
  if (!a || !b) return a === b;
  return a.profileId === b.profileId && (a.database ?? '') === (b.database ?? '');
}

export const SUGGESTED_PROMPTS: readonly { label: string; prompt: string; needsEditor?: boolean }[] = [
  { label: 'Summarize this database', prompt: 'Summarize this database: the main tables, how they relate, and roughly how much data each holds.' },
  { label: 'Explain the query in my editor', prompt: 'Explain the query in my editor step by step, and point out anything that could be wrong or slow.', needsEditor: true },
  { label: 'Find tables related to orders', prompt: 'Find the tables related to orders and explain how they connect (keys and joins).' },
  { label: 'Write a query for revenue by month', prompt: 'Write a query for revenue by month. Check the schema first, then propose the SQL.' }
];

class AiChatStore {
  // -- CLI status -----------------------------------------------------------
  status = $state<AiStatus | null>(null);
  statusLoading = $state(false);
  statusError = $state<string | null>(null);

  // -- conversation ---------------------------------------------------------
  sessionId = $state(newId());
  items = $state<ChatItem[]>([]);
  /** The running turn, or null when idle. */
  turnId = $state<string | null>(null);
  /** Transient progress text while a turn runs. */
  progress = $state<string | null>(null);
  readonly busy = $derived(this.turnId !== null);
  private lastPrompt: string | null = null;
  private turnStartedAt = 0;
  private turnModel = DEFAULT_AI_MODEL;

  // -- panel settings -------------------------------------------------------
  model = $state<string>(DEFAULT_AI_MODEL);
  allowWrites = $state(false);
  includeEditor = $state(true);
  target = $state<ConnTarget>({ mode: 'active' });
  input = $state('');
  /** Bumped to ask the composer to focus (e.g. after `ai.ask`). */
  focusRequest = $state(0);

  // -- connections ------------------------------------------------------------
  profiles = $state<ConnectionProfile[]>([]);
  statuses = $state<ConnectionStatus[]>([]);
  /** Bumped by the panel on a timer so the active-tab connection is re-read. */
  activeTick = $state(0);

  readonly activeRef = $derived.by((): ConnRef | null => {
    void this.activeTick;
    return workbench.activeConn();
  });

  readonly activeEditor = $derived.by((): EditorSnapshot | null => {
    void this.activeTick;
    return workbench.activeEditor();
  });

  /** The connection the next message's tools will act on. */
  readonly targetRef = $derived.by((): ConnRef | null => {
    if (this.target.mode === 'none') return null;
    if (this.target.mode === 'pinned') return this.target.ref;
    return this.activeRef;
  });

  readonly targetProfile = $derived(this.targetRef ? this.profileById(this.targetRef.profileId) : null);

  /** Connected profiles the user can pin. */
  readonly connectedOptions = $derived.by((): ConnOption[] => {
    const out: ConnOption[] = [];
    for (const s of this.statuses) {
      if (s.state !== 'connected') continue;
      const profile = this.profileById(s.profileId);
      const ref: ConnRef = { profileId: s.profileId, ...(s.database ? { database: s.database } : {}) };
      out.push({ ref, profile, label: this.connLabel(ref) });
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  });

  readonly modelOptions = $derived(this.status?.models?.length ? this.status.models : [...AI_MODELS]);

  private listening = false;
  private initialized = false;

  // ---------------------------------------------------------------------------

  profileById(id: string): ConnectionProfile | null {
    return this.profiles.find((p) => p.id === id) ?? null;
  }

  connLabel(ref: ConnRef | null): string {
    if (!ref) return 'No database';
    const p = this.profileById(ref.profileId);
    if (!p) return ref.database ? `${ref.profileId} / ${ref.database}` : ref.profileId;
    if (p.kind === 'sqlite' || !ref.database || ref.database === p.database) return p.name;
    return `${p.name} / ${ref.database}`;
  }

  /** Subscribe to main-process events and load status, settings, and connections (once). */
  init(): void {
    this.listen();
    if (this.initialized) return;
    this.initialized = true;
    void this.loadStatus(false);
    void this.loadSettings();
    void this.loadConnections();
  }

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    on('ai.event', (e) => this.onEvent(e));
    on('settings.changed', (s) => this.applySettings(s));
    on('connections.changed', (list) => (this.profiles = list));
    on('connections.status', (s) => {
      const i = this.statuses.findIndex((x) => x.profileId === s.profileId && x.database === s.database);
      if (i === -1) this.statuses.push(s);
      else this.statuses[i] = s;
    });
  }

  async loadStatus(refresh: boolean): Promise<void> {
    this.statusLoading = true;
    this.statusError = null;
    try {
      this.status = await call('ai.status', { refresh });
      if (!this.modelOptions.some((m) => m.id === this.model)) this.model = this.status.defaultModel;
    } catch (err) {
      this.statusError = errorMessage(err);
    } finally {
      this.statusLoading = false;
    }
  }

  private applySettings(s: AppSettings): void {
    if (s.aiModel) this.model = s.aiModel;
    this.allowWrites = !!s.aiAllowWrites;
  }

  private async loadSettings(): Promise<void> {
    try {
      this.applySettings(await call('settings.get'));
    } catch {
      // keep defaults
    }
  }

  private async loadConnections(): Promise<void> {
    try {
      this.profiles = await call('connections.list');
    } catch {
      // the panel still works with "follow active tab" / "no database"
    }
    try {
      this.statuses = await call('connections.statuses');
    } catch {
      // ignore
    }
  }

  private persist(patch: Partial<AppSettings>): void {
    call('settings.update', patch).catch(() => {
      // Not fatal: the panel keeps the value for this session.
    });
  }

  setModel(id: string): void {
    this.model = id;
    this.persist({ aiModel: id });
  }

  setAllowWrites(on: boolean): void {
    this.allowWrites = on;
    this.persist({ aiAllowWrites: on });
  }

  setTarget(t: ConnTarget): void {
    this.target = t;
  }

  // -- conversation -----------------------------------------------------------

  /** Send `prompt` (or the input box). Returns false when nothing was sent. */
  async send(prompt?: string): Promise<boolean> {
    this.init();
    const fromInput = prompt === undefined;
    const text = (prompt ?? this.input).trim();
    if (!text || this.busy) return false;

    const conn = this.targetRef;
    const editor = this.includeEditor ? workbench.activeEditor() : null;
    const turnId = newId();
    const context = [editor ? `Editor: ${editor.title}` : null, conn ? this.connLabel(conn) : 'No database']
      .filter(Boolean)
      .join(' · ');
    this.items.push({ kind: 'user', id: newId(), text, context });
    if (fromInput) this.input = '';
    this.lastPrompt = text;
    this.turnId = turnId;
    this.turnStartedAt = Date.now();
    this.turnModel = this.model;
    this.progress = null;
    try {
      await call('ai.send', {
        sessionId: this.sessionId,
        turnId,
        prompt: text,
        conn,
        model: this.model,
        allowWrites: this.allowWrites,
        editor
      });
      return true;
    } catch (err) {
      if (this.turnId === turnId) {
        this.turnId = null;
        this.progress = null;
        this.items.push({ kind: 'error', id: newId(), message: errorMessage(err), code: null, retryPrompt: text });
      }
      return false;
    }
  }

  retry(prompt: string | null): void {
    const p = prompt ?? this.lastPrompt;
    if (p) void this.send(p);
  }

  stop(): void {
    if (!this.turnId) return;
    this.progress = 'Stopping…';
    call('ai.cancel', { sessionId: this.sessionId }).catch(() => {});
  }

  answer(toolUseId: string, approved: boolean): void {
    const item = this.items.find((i) => i.kind === 'tool' && i.id === toolUseId);
    if (item && item.kind === 'tool') {
      item.decision = approved ? 'approved' : 'rejected';
      item.state = approved ? 'running' : 'denied';
      if (!approved) item.summary = 'Rejected';
    }
    call('ai.approve', { sessionId: this.sessionId, toolUseId, approved }).catch((err) => {
      this.items.push({ kind: 'error', id: newId(), message: errorMessage(err), code: null, retryPrompt: null });
    });
  }

  newChat(): void {
    const old = this.sessionId;
    call('ai.reset', { sessionId: old }).catch(() => {});
    this.sessionId = newId();
    this.items = [];
    this.turnId = null;
    this.progress = null;
    this.lastPrompt = null;
    this.focusRequest++;
  }

  /** Bridge entry point: open the panel and prefill or send a prompt. */
  ask(prompt: string, opts: AskAiOptions = {}): void {
    this.init();
    workbench.setAiPanelOpen(true);
    if (opts.conn !== undefined) {
      // Asking about the active tab's own connection keeps "follow the active tab".
      this.target = !opts.conn
        ? { mode: 'none' }
        : sameRef(opts.conn, workbench.activeConn())
          ? { mode: 'active' }
          : { mode: 'pinned', ref: opts.conn };
    }
    if (opts.includeEditor !== undefined) this.includeEditor = opts.includeEditor;
    if (opts.send && !this.busy) {
      void this.send(prompt);
    } else {
      this.input = prompt;
    }
    this.focusRequest++;
  }

  // -- events -----------------------------------------------------------------

  private onEvent(e: AiEvent): void {
    if (e.sessionId !== this.sessionId || e.turnId !== this.turnId) return;
    const last = this.items[this.items.length - 1];
    switch (e.type) {
      case 'text_delta':
        this.progress = null;
        if (last && last.kind === 'text') last.text += e.text;
        else this.items.push({ kind: 'text', id: newId(), text: e.text.replace(/^\n+/, '') });
        break;
      case 'tool_call': {
        this.progress = null;
        const existing = this.items.find((i) => i.kind === 'tool' && i.id === e.toolUseId);
        if (existing) break;
        this.items.push({
          kind: 'tool',
          id: e.toolUseId,
          name: e.name,
          toolKind: e.kind,
          preview: e.preview,
          needsApproval: e.needsApproval,
          production: !!e.production,
          state: e.needsApproval ? 'awaiting' : 'running',
          summary: '',
          decision: null,
          connLabel: this.connLabel(this.targetRef)
        });
        break;
      }
      case 'tool_result': {
        const item = this.items.find((i) => i.kind === 'tool' && i.id === e.toolUseId);
        if (item && item.kind === 'tool') {
          item.state = e.denied ? 'denied' : e.ok ? 'ok' : 'error';
          item.summary = e.denied && item.decision === 'rejected' ? 'Rejected' : e.summary;
        }
        break;
      }
      case 'propose_sql':
        this.progress = null;
        this.items.push({ kind: 'proposal', id: e.toolUseId, sql: e.sql, explanation: e.explanation ?? null, conn: e.conn });
        break;
      case 'status':
        this.progress = e.message;
        break;
      case 'error':
        this.items.push({ kind: 'error', id: newId(), message: e.message, code: e.code ?? null, retryPrompt: this.lastPrompt });
        if (e.code === 'not_logged_in' || e.code === 'cli_missing') void this.loadStatus(true);
        break;
      case 'turn_done': {
        for (const item of this.items) {
          if (item.kind === 'tool' && (item.state === 'running' || item.state === 'awaiting')) {
            item.state = 'stopped';
            item.summary = e.cancelled ? 'Stopped' : 'Did not finish';
          }
        }
        const secs = ((e.durationMs ?? Date.now() - this.turnStartedAt) / 1000).toFixed(1);
        if (e.cancelled) {
          this.items.push({ kind: 'meta', id: newId(), text: 'Stopped', title: null });
        } else if (!e.failed) {
          this.items.push({
            kind: 'meta',
            id: newId(),
            text: `${aiModelLabel(this.turnModel)} · ${secs}s`,
            title: e.costUsd !== undefined ? `About $${e.costUsd.toFixed(4)} at API rates (covered by your Claude plan)` : null
          });
        }
        this.turnId = null;
        this.progress = null;
        break;
      }
    }
  }
}

export const aiChat = new AiChatStore();

// Registered at load (the workbench imports the panel eagerly), so other UI can
// call `ai.ask()` even while the panel is closed.
registerAi({ ask: (prompt, opts) => aiChat.ask(prompt, opts) });

/** For the composer and tests: whether an approval is still waiting. */
export function pendingApprovals(items: ChatItem[]): number {
  return items.filter((i) => i.kind === 'tool' && i.state === 'awaiting').length;
}

