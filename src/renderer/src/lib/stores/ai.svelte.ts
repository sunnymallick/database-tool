/**
 * AI panel state: one conversation per connection, panel settings
 * (model, connection target, allow-writes, include-editor), and CLI status.
 *
 * Each connection (profile + database) gets its own agent session, so a
 * sandbox chat never sees a production chat's context. The panel shows the
 * conversation for the target connection; other conversations keep
 * streaming in the background.
 *
 * A module singleton, so conversations survive the panel being closed
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
import { SvelteMap } from 'svelte/reactivity';
import { call, errorMessage, on } from '$lib/api.svelte';
import { registerAi, workbench, type AiActivity, type AskAiOptions } from '$lib/bridge';

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

/** One agent session, bound to a single connection (or to none). */
class AiConversation {
  readonly sessionId = newId();
  items = $state<ChatItem[]>([]);
  /** The running turn, or null when idle. */
  turnId = $state<string | null>(null);
  /** Transient progress text while a turn runs. */
  progress = $state<string | null>(null);
  input = $state('');
  readonly busy = $derived(this.turnId !== null);
  lastPrompt: string | null = null;
  turnStartedAt = 0;
  turnModel = DEFAULT_AI_MODEL;

  constructor(readonly ref: ConnRef | null) {}
}

/** Shown while the target connection has no conversation yet; never mutated. */
const EMPTY = new AiConversation(null);

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

  // -- conversations, keyed by connection ------------------------------------
  private conversations = new SvelteMap<string, AiConversation>();

  // -- panel settings -------------------------------------------------------
  model = $state<string>(DEFAULT_AI_MODEL);
  allowWrites = $state(false);
  includeEditor = $state(true);
  target = $state<ConnTarget>({ mode: 'active' });
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

  /** The conversation the panel shows: the target connection's. */
  readonly current = $derived(this.conversations.get(this.convKey(this.targetRef)) ?? EMPTY);

  get items(): ChatItem[] {
    return this.current.items;
  }

  get progress(): string | null {
    return this.current.progress;
  }

  get busy(): boolean {
    return this.current.busy;
  }

  get input(): string {
    return this.current.input;
  }

  set input(v: string) {
    if (v || this.current !== EMPTY) this.ensure().input = v;
  }

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

  /** Conversation key: refs that resolve to the same database share a chat. */
  convKey(ref: ConnRef | null): string {
    if (!ref) return 'none';
    const p = this.profileById(ref.profileId);
    const db = p?.kind === 'sqlite' ? '' : (ref.database ?? p?.database ?? '');
    return `${ref.profileId}/${db}`;
  }

  /** The target connection's conversation, created on first use. */
  private ensure(): AiConversation {
    const ref = this.targetRef;
    const key = this.convKey(ref);
    let c = this.conversations.get(key);
    if (!c) {
      c = new AiConversation(ref);
      this.conversations.set(key, c);
    }
    return c;
  }

  /** Whether `ref`'s chat is answering or waiting for an approval. */
  activity(ref: ConnRef | null): AiActivity {
    const c = this.conversations.get(this.convKey(ref));
    if (!c?.busy) return null;
    return pendingApprovals(c.items) > 0 ? 'awaiting' : 'busy';
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

    const c = this.ensure();
    const conn = c.ref;
    const editor = this.includeEditor ? workbench.activeEditor() : null;
    const turnId = newId();
    const context = [editor ? `Editor: ${editor.title}` : null, conn ? this.connLabel(conn) : 'No database']
      .filter(Boolean)
      .join(' · ');
    c.items.push({ kind: 'user', id: newId(), text, context });
    if (fromInput) c.input = '';
    c.lastPrompt = text;
    c.turnId = turnId;
    c.turnStartedAt = Date.now();
    c.turnModel = this.model;
    c.progress = null;
    try {
      await call('ai.send', {
        sessionId: c.sessionId,
        turnId,
        prompt: text,
        conn,
        model: this.model,
        allowWrites: this.allowWrites,
        editor
      });
      return true;
    } catch (err) {
      if (c.turnId === turnId) {
        c.turnId = null;
        c.progress = null;
        c.items.push({ kind: 'error', id: newId(), message: errorMessage(err), code: null, retryPrompt: text });
      }
      return false;
    }
  }

  retry(prompt: string | null): void {
    const p = prompt ?? this.current.lastPrompt;
    if (p) void this.send(p);
  }

  stop(): void {
    const c = this.current;
    if (!c.turnId) return;
    c.progress = 'Stopping…';
    call('ai.cancel', { sessionId: c.sessionId }).catch(() => {});
  }

  answer(toolUseId: string, approved: boolean): void {
    const c = this.current;
    const item = c.items.find((i) => i.kind === 'tool' && i.id === toolUseId);
    if (item && item.kind === 'tool') {
      item.decision = approved ? 'approved' : 'rejected';
      item.state = approved ? 'running' : 'denied';
      if (!approved) item.summary = 'Rejected';
    }
    call('ai.approve', { sessionId: c.sessionId, toolUseId, approved }).catch((err) => {
      c.items.push({ kind: 'error', id: newId(), message: errorMessage(err), code: null, retryPrompt: null });
    });
  }

  /** Start over on the target connection only; other connections' chats are kept. */
  newChat(): void {
    const old = this.current;
    if (old !== EMPTY) {
      call('ai.reset', { sessionId: old.sessionId }).catch(() => {});
      this.conversations.delete(this.convKey(this.targetRef));
      if (old.input) this.ensure().input = old.input;
    }
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
        : this.convKey(opts.conn) === this.convKey(workbench.activeConn())
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
    const c = [...this.conversations.values()].find((x) => x.sessionId === e.sessionId);
    if (!c || e.turnId !== c.turnId) return;
    const last = c.items[c.items.length - 1];
    switch (e.type) {
      case 'text_delta':
        c.progress = null;
        if (last && last.kind === 'text') last.text += e.text;
        else c.items.push({ kind: 'text', id: newId(), text: e.text.replace(/^\n+/, '') });
        break;
      case 'tool_call': {
        c.progress = null;
        const existing = c.items.find((i) => i.kind === 'tool' && i.id === e.toolUseId);
        if (existing) break;
        c.items.push({
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
          connLabel: this.connLabel(c.ref)
        });
        break;
      }
      case 'tool_result': {
        const item = c.items.find((i) => i.kind === 'tool' && i.id === e.toolUseId);
        if (item && item.kind === 'tool') {
          item.state = e.denied ? 'denied' : e.ok ? 'ok' : 'error';
          item.summary = e.denied && item.decision === 'rejected' ? 'Rejected' : e.summary;
        }
        break;
      }
      case 'propose_sql':
        c.progress = null;
        c.items.push({ kind: 'proposal', id: e.toolUseId, sql: e.sql, explanation: e.explanation ?? null, conn: e.conn });
        break;
      case 'status':
        c.progress = e.message;
        break;
      case 'error':
        c.items.push({ kind: 'error', id: newId(), message: e.message, code: e.code ?? null, retryPrompt: c.lastPrompt });
        if (e.code === 'not_logged_in' || e.code === 'cli_missing') void this.loadStatus(true);
        break;
      case 'turn_done': {
        for (const item of c.items) {
          if (item.kind === 'tool' && (item.state === 'running' || item.state === 'awaiting')) {
            item.state = 'stopped';
            item.summary = e.cancelled ? 'Stopped' : 'Did not finish';
          }
        }
        const secs = ((e.durationMs ?? Date.now() - c.turnStartedAt) / 1000).toFixed(1);
        if (e.cancelled) {
          c.items.push({ kind: 'meta', id: newId(), text: 'Stopped', title: null });
        } else if (!e.failed) {
          c.items.push({
            kind: 'meta',
            id: newId(),
            text: `${aiModelLabel(c.turnModel)} · ${secs}s`,
            title: e.costUsd !== undefined ? `About $${e.costUsd.toFixed(4)} at API rates (covered by your Claude plan)` : null
          });
        }
        c.turnId = null;
        c.progress = null;
        break;
      }
    }
  }
}

export const aiChat = new AiChatStore();

export const aiBridge = {
  ask: (prompt: string, opts?: AskAiOptions) => aiChat.ask(prompt, opts),
  activity: (conn: ConnRef | null) => aiChat.activity(conn)
};

// Registered at load (the workbench imports the panel eagerly), so other UI can
// call `ai.ask()` even while the panel is closed.
registerAi(aiBridge);

/** For the composer and tests: whether an approval is still waiting. */
export function pendingApprovals(items: ChatItem[]): number {
  return items.filter((i) => i.kind === 'tool' && i.state === 'awaiting').length;
}

