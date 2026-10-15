/**
 * AI panel contract. Owned by the AI slice: it may reshape these types as long
 * as `src/shared/api.ts` keeps compiling (api.ts only references the named
 * exports AiApproveRequest, AiEvent, AiSendRequest, AiSendResponse, AiStatus).
 */
import type { ConnRef } from './types';

export interface AiModelOption {
  id: string;
  label: string;
}

/** Models offered in the panel. The first entry is the default. */
export const AI_MODELS: readonly AiModelOption[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' }
] as const;

export const DEFAULT_AI_MODEL = AI_MODELS[0].id;

export function aiModelLabel(id: string): string {
  return AI_MODELS.find((m) => m.id === id)?.label ?? id;
}

export interface AiStatus {
  /** The `claude` CLI was found and responds to `--version`. */
  available: boolean;
  cliPath: string | null;
  /** `bundled`: the Agent SDK's own binary. `configured`: settings.claudeCliPath. */
  cliSource: 'bundled' | 'configured' | null;
  version: string | null;
  /**
   * From `claude auth status`: true/false when known, null when the check
   * could not run (the CLI still reports a clear error on the first turn).
   */
  loggedIn: boolean | null;
  /** e.g. `claude.ai`, `api_key`. */
  authMethod?: string;
  /** e.g. `pro`, `max`. */
  subscriptionType?: string;
  /** Why the CLI is unusable, with a hint the UI can show as-is. */
  error?: string;
  models: AiModelOption[];
  defaultModel: string;
}

/** The user's active query editor, captured when a message is sent. */
export interface EditorSnapshot {
  tabId: string;
  title: string;
  sql: string;
  /** Selected text, if any. */
  selection: string | null;
  conn: ConnRef | null;
}

export interface AiSendRequest {
  /**
   * Conversation id. Omit (or pass an id main has not seen) to start a new
   * conversation; the renderer may pick the id itself so it can match events
   * that arrive before `ai.send` resolves.
   */
  sessionId?: string;
  /** Client-generated id for this turn; main generates one when omitted. */
  turnId?: string;
  prompt: string;
  /** Connection the agent's database tools act on; null = no database. */
  conn: ConnRef | null;
  model: string;
  /** Let run_statement skip per-call approval. Never applies to production or read-only profiles. */
  allowWrites: boolean;
  editor: EditorSnapshot | null;
}

export interface AiSendResponse {
  sessionId: string;
  turnId: string;
}

export interface AiApproveRequest {
  sessionId: string;
  toolUseId: string;
  approved: boolean;
}

export type AiToolKind = 'read' | 'write' | 'ui';

/** Tool names the agent can call (without the `mcp__db__` prefix). */
export const AI_TOOL_NAMES = [
  'list_schemas',
  'list_tables',
  'describe_table',
  'run_select',
  'run_statement',
  'read_editor',
  'propose_sql'
] as const;

export type AiToolName = (typeof AI_TOOL_NAMES)[number];

export const AI_TOOL_KINDS: Record<AiToolName, AiToolKind> = {
  list_schemas: 'read',
  list_tables: 'read',
  describe_table: 'read',
  run_select: 'read',
  run_statement: 'write',
  read_editor: 'ui',
  propose_sql: 'ui'
};

/** Short human label for a tool card. */
export const AI_TOOL_LABELS: Record<AiToolName, string> = {
  list_schemas: 'List schemas',
  list_tables: 'List tables',
  describe_table: 'Describe table',
  run_select: 'Run query',
  run_statement: 'Run statement',
  read_editor: 'Read editor',
  propose_sql: 'Propose SQL'
};

/** Event payload without the routing ids. */
export type AiEventBody =
  | { type: 'text_delta'; text: string }
  | {
      type: 'tool_call';
      toolUseId: string;
      name: string;
      input: unknown;
      /** Human-readable preview: the SQL for SQL tools. */
      preview: string;
      kind: AiToolKind;
      /** The turn is blocked until `ai.approve` is called for this toolUseId. */
      needsApproval: boolean;
      /** The target connection is marked production (approval UI shows a red warning). */
      production?: boolean;
    }
  | {
      type: 'tool_result';
      toolUseId: string;
      ok: boolean;
      summary: string;
      /** The call never ran: the user rejected it or the app refused it (read-only, no database). */
      denied?: boolean;
    }
  | { type: 'propose_sql'; toolUseId: string; sql: string; explanation?: string; conn: ConnRef | null }
  | { type: 'status'; message: string }
  | {
      type: 'turn_done';
      costUsd?: number;
      durationMs?: number;
      /** The user stopped the turn. */
      cancelled?: boolean;
      /** The turn ended on an error (an `error` event precedes this one). */
      failed?: boolean;
    }
  | { type: 'error'; message: string; code?: AiErrorCode };

/** Machine-readable error classes the panel can react to. */
export type AiErrorCode = 'not_logged_in' | 'cli_missing' | 'model_unavailable' | 'rate_limited' | 'busy' | 'failed';

/**
 * Every turn emits any number of text/tool/status events, at most one
 * `error`, and always exactly one final `turn_done`.
 */
export type AiEvent = { sessionId: string; turnId: string } & AiEventBody;
