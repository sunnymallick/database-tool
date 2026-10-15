/**
 * Turns the Agent SDK's message stream into the panel's AiEvents.
 *
 * Text streams from `stream_event` deltas (includePartialMessages); tool calls
 * come from the completed assistant message (or earlier from the permission
 * callback / PreToolUse hook, deduplicated by tool_use id); tool results come
 * from the user messages that carry tool_result blocks.
 */
import type { SDKAssistantMessageError, SDKMessage } from '@anthropic-ai/claude-agent-sdk/core';
import { AI_TOOL_LABELS, type AiErrorCode, type AiEventBody, type AiToolName } from '@shared/ai';
import type { ConnRef } from '@shared/types';
import { summarizeToolOutput, type CallInfo } from './tools';

export const MCP_SERVER_NAME = 'db';
export const MCP_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

export function shortToolName(name: string): string {
  return name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
}

export interface MapperOptions {
  emit: (event: AiEventBody) => void;
  describeCall: (name: string, input: unknown) => CallInfo;
  conn: ConnRef | null;
  model?: string;
}

export interface ClassifiedError {
  message: string;
  code: AiErrorCode;
}

const LOGIN_HINT =
  'Claude is not signed in. Open a terminal, run `claude`, and sign in with your Claude account (type /login if it does not ask). Then press Retry.';

/** Map an error text (and the SDK's error class, when known) to a message the user can act on. */
export function classifyError(text: string, kind?: SDKAssistantMessageError | null, model?: string): ClassifiedError {
  const t = text.trim();
  if (
    kind === 'authentication_failed' ||
    kind === 'oauth_org_not_allowed' ||
    /not logged in|please run \/login|\/login|invalid api key|authentication[_ ]error|oauth token|token (has )?expired|unauthorized|\b401\b/i.test(t)
  ) {
    return { code: 'not_logged_in', message: LOGIN_HINT };
  }
  if (kind === 'model_not_found' || /model.{0,40}(not found|not available|does not exist|isn't available|is not supported)|invalid model|unknown model/i.test(t)) {
    return {
      code: 'model_unavailable',
      message: `The model ${model ? `"${model}" ` : ''}is not available to your Claude account. Pick another model in the panel header.${t ? ` (${clip(t, 200)})` : ''}`
    };
  }
  if (kind === 'rate_limit' || kind === 'billing_error' || /usage limit|rate limit|limit reached|credit balance|out of credits/i.test(t)) {
    return { code: 'rate_limited', message: `Claude usage limit reached. ${clip(t, 300)}`.trim() };
  }
  if (/native cli binary .*not found|claude code (native binary|executable) .*not found|\bENOENT\b|failed to launch/i.test(t)) {
    return {
      code: 'cli_missing',
      message: `The Claude CLI could not be started. ${clip(t, 300)} Check the CLI path in Settings, or clear it to use the bundled CLI.`
    };
  }
  return { code: 'failed', message: clip(t || 'The assistant stopped because of an unknown error.', 1_000) };
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

interface ResultInfo {
  ok: boolean;
  costUsd?: number;
  durationMs?: number;
}

type ContentBlock = { type: string; [k: string]: unknown };

export class TurnEventMapper {
  /** SDK session id to resume next turn. */
  sdkSessionId: string | null = null;
  /** Tools the CLI reported in its init message (for diagnostics). */
  initTools: string[] | null = null;
  result: ResultInfo | null = null;
  private errorEmitted = false;
  private finished = false;
  private emittedToolCalls = new Set<string>();
  private toolNames = new Map<string, string>();
  private denied = new Set<string>();
  private messagesWithStreamedText = new Set<string>();
  private currentMessageId: string | null = null;
  private lastEmitted: 'text' | 'other' | null = null;
  private textBreakPending = false;
  private assistantError: SDKAssistantMessageError | null = null;

  constructor(private readonly opts: MapperOptions) {}

  private emit(event: AiEventBody): void {
    if (this.finished) return;
    if (event.type === 'text_delta') this.lastEmitted = 'text';
    else if (event.type !== 'status') this.lastEmitted = 'other';
    this.opts.emit(event);
  }

  /** Emit the tool card once per tool_use id (any of the three sources may call this first). */
  emitToolCall(toolUseId: string, fullName: string, input: unknown): void {
    const name = shortToolName(fullName);
    this.toolNames.set(toolUseId, name);
    if (this.emittedToolCalls.has(toolUseId)) return;
    this.emittedToolCalls.add(toolUseId);
    if (name === 'propose_sql') {
      const args = (input ?? {}) as { sql?: unknown; explanation?: unknown };
      const sql = typeof args.sql === 'string' ? args.sql : '';
      if (!sql.trim()) return;
      this.emit({
        type: 'propose_sql',
        toolUseId,
        sql,
        explanation: typeof args.explanation === 'string' && args.explanation.trim() ? args.explanation : undefined,
        conn: this.opts.conn
      });
      return;
    }
    const info = this.opts.describeCall(name, input);
    this.emit({
      type: 'tool_call',
      toolUseId,
      name,
      input,
      preview: info.preview,
      kind: info.kind,
      needsApproval: info.needsApproval,
      ...(info.production ? { production: true } : {})
    });
  }

  /** The permission layer refused this call; its tool_result is a denial, not a failure. */
  markDenied(toolUseId: string): void {
    this.denied.add(toolUseId);
  }

  handle(msg: SDKMessage): void {
    if ('session_id' in msg && typeof msg.session_id === 'string' && msg.session_id) {
      this.sdkSessionId = msg.session_id;
    }
    switch (msg.type) {
      case 'system':
        this.handleSystem(msg);
        return;
      case 'stream_event':
        if (msg.parent_tool_use_id === null) this.handleStreamEvent(msg.event as unknown as ContentBlock);
        return;
      case 'assistant':
        if (msg.parent_tool_use_id !== null) return;
        if (msg.error) this.assistantError = msg.error;
        this.handleAssistant(msg.message as unknown as { id?: string; content?: ContentBlock[] });
        return;
      case 'user':
        if (msg.parent_tool_use_id !== null) return;
        this.handleUser(msg.message as unknown as { content?: unknown });
        return;
      case 'result':
        this.handleResult(msg);
        return;
      case 'auth_status':
        if (msg.error) this.emit({ type: 'status', message: `Sign-in problem: ${clip(msg.error, 200)}` });
        return;
      case 'rate_limit_event':
        if (msg.rate_limit_info.status === 'rejected') {
          const at = msg.rate_limit_info.resetsAt;
          const when = at ? ` It resets at ${new Date(at * (at < 1e12 ? 1000 : 1)).toLocaleString()}.` : '';
          this.emit({ type: 'status', message: `Claude usage limit reached.${when}` });
        }
        return;
      default:
        return;
    }
  }

  private handleSystem(msg: Extract<SDKMessage, { type: 'system' }>): void {
    switch (msg.subtype) {
      case 'init':
        this.initTools = (msg as { tools?: string[] }).tools ?? null;
        return;
      case 'status':
        if ((msg as { status?: string | null }).status === 'compacting') {
          this.emit({ type: 'status', message: 'Compacting the conversation…' });
        }
        return;
      case 'api_retry': {
        const m = msg as { attempt: number; max_retries: number; retry_delay_ms: number; error: string };
        const secs = Math.max(1, Math.round(m.retry_delay_ms / 1000));
        this.emit({
          type: 'status',
          message: `Claude API ${m.error.replace(/_/g, ' ')}; retrying in ${secs}s (attempt ${m.attempt} of ${m.max_retries})…`
        });
        return;
      }
      default:
        return;
    }
  }

  private handleStreamEvent(ev: ContentBlock): void {
    switch (ev.type) {
      case 'message_start': {
        const id = (ev.message as { id?: string } | undefined)?.id;
        this.currentMessageId = id ?? null;
        return;
      }
      case 'content_block_start': {
        const block = ev.content_block as ContentBlock | undefined;
        if (block?.type === 'text') {
          this.textBreakPending = this.lastEmitted === 'text';
        } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
          const name = shortToolName(block.name);
          const label = (AI_TOOL_LABELS as Record<string, string | undefined>)[name as AiToolName] ?? name;
          this.emit({ type: 'status', message: `Preparing: ${label}…` });
        }
        return;
      }
      case 'content_block_delta': {
        const delta = ev.delta as { type?: string; text?: string } | undefined;
        if (delta?.type === 'text_delta' && delta.text) {
          if (this.currentMessageId) this.messagesWithStreamedText.add(this.currentMessageId);
          this.emitText(delta.text);
        }
        return;
      }
      default:
        return;
    }
  }

  private emitText(text: string): void {
    if (this.textBreakPending) {
      this.textBreakPending = false;
      this.emit({ type: 'text_delta', text: `\n\n${text}` });
    } else {
      this.emit({ type: 'text_delta', text });
    }
  }

  private handleAssistant(message: { id?: string; content?: ContentBlock[] }): void {
    const streamed = !!message.id && this.messagesWithStreamedText.has(message.id);
    for (const block of message.content ?? []) {
      if (block.type === 'text' && !streamed && typeof block.text === 'string' && block.text) {
        // Partial messages were off or missed: deliver the whole block at once.
        this.textBreakPending = this.lastEmitted === 'text';
        this.emitText(block.text);
      } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        this.emitToolCall(block.id, block.name, block.input);
      }
    }
  }

  private handleUser(message: { content?: unknown }): void {
    if (!Array.isArray(message.content)) return;
    for (const raw of message.content as ContentBlock[]) {
      if (raw.type !== 'tool_result' || typeof raw.tool_use_id !== 'string') continue;
      const id = raw.tool_use_id;
      const name = this.toolNames.get(id) ?? '';
      const text = toolResultText(raw.content);
      const isError = raw.is_error === true;
      const denied = this.denied.has(id);
      this.emit({
        type: 'tool_result',
        toolUseId: id,
        ok: !isError,
        summary: denied ? clip(text.replace(/\s+/g, ' ').trim(), 240) : summarizeToolOutput(name, text, isError),
        ...(denied ? { denied: true } : {})
      });
    }
  }

  private handleResult(msg: Extract<SDKMessage, { type: 'result' }>): void {
    const base = { costUsd: msg.total_cost_usd, durationMs: msg.duration_ms };
    if (msg.subtype === 'success' && !msg.is_error) {
      this.result = { ok: true, ...base };
      return;
    }
    this.result = { ok: false, ...base };
    let text: string;
    if (msg.subtype === 'success') text = msg.result;
    else if (msg.subtype === 'error_max_turns') {
      text = 'The assistant stopped after too many steps. Ask it to continue, or narrow the request.';
    } else if (msg.subtype === 'error_max_budget_usd') text = 'The assistant stopped at its spending limit.';
    else text = msg.errors?.length ? msg.errors.join('; ') : 'The assistant stopped because of an error.';
    this.emitError(classifyError(text, this.assistantError, this.opts.model));
  }

  emitError(err: ClassifiedError): void {
    if (this.errorEmitted) return;
    this.errorEmitted = true;
    this.emit({ type: 'error', message: err.message, code: err.code });
  }

  /**
   * End the turn: exactly one `turn_done`, preceded by an `error` when the
   * turn failed and none was reported yet.
   */
  finish(opts: { cancelled?: boolean; error?: unknown; stderrTail?: string } = {}): void {
    if (this.finished) return;
    const r = this.result;
    if (opts.cancelled) {
      this.emit({ type: 'turn_done', cancelled: true, ...(r ? { costUsd: r.costUsd, durationMs: r.durationMs } : {}) });
    } else if (r && r.ok && !this.errorEmitted) {
      this.emit({ type: 'turn_done', costUsd: r.costUsd, durationMs: r.durationMs });
    } else {
      if (!this.errorEmitted) {
        const text =
          opts.error !== undefined
            ? `${opts.error instanceof Error ? opts.error.message : String(opts.error)}${opts.stderrTail ? `\n${opts.stderrTail}` : ''}`
            : `The assistant stopped without finishing its reply.${opts.stderrTail ? ` ${opts.stderrTail}` : ''}`;
        this.emitError(classifyError(text, this.assistantError, this.opts.model));
      }
      this.emit({ type: 'turn_done', failed: true, ...(r ? { costUsd: r.costUsd, durationMs: r.durationMs } : {}) });
    }
    this.finished = true;
  }

  get isFinished(): boolean {
    return this.finished;
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && (c as { type?: string }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}
