/**
 * AiProvider on the Claude Agent SDK, using the user's Claude subscription
 * login through the SDK's bundled `claude` binary (or a configured one).
 *
 * Each user message is one `query()` call that resumes the previous turn's
 * SDK session. The model only sees our in-process MCP tools: built-ins are
 * removed (`tools: []`), filesystem settings/CLAUDE.md/MCP configs are not
 * loaded, and a PreToolUse hook refuses anything else.
 */
import {
  createSdkMcpServer,
  query,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  tool,
  type CanUseTool,
  type HookCallback,
  type McpSdkServerConfigWithInstance,
  type Options,
  type SDKMessage,
  type SdkMcpToolDefinition
} from '@anthropic-ai/claude-agent-sdk/core';
import { AI_MODELS, DEFAULT_AI_MODEL, type AiStatus } from '@shared/ai';
import type { DataServices } from '../services';
import { WriteGrants, writePolicy } from './approvals';
import { aiWorkspaceDir, probeCli, resolveCli, sanitizedEnv, type ResolvedCli } from './cli';
import { loadConnectionContext, MetaCache } from './context';
import { MCP_SERVER_NAME, TurnEventMapper } from './mapper';
import { createCanUseTool, createToolAllowlistHook } from './permissions';
import { buildDynamicPrompt, staticPrompt } from './prompt';
import type { AiProvider, TurnInput, TurnOutcome } from './provider';
import { TOOL_SPECS, ToolHost } from './tools';

/** Agentic steps (model round-trips) per user message. */
export const MAX_TURNS = 40;
const STATUS_TTL_MS = 60_000;

/** Built-ins named explicitly on top of `tools: []`, in case a CLI version keeps one available. */
export const DENIED_BUILTINS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Agent',
  'Task',
  'Skill'
];

export const LOGIN_HINT =
  'Claude is not signed in. Open a terminal, run `claude`, and sign in with your Claude account (type /login if it does not ask). Then press Recheck.';

/** The in-process MCP server exposing our tools, bound to one turn's ToolHost. */
export function createDbMcpServer(host: ToolHost): McpSdkServerConfigWithInstance {
  const defs: SdkMcpToolDefinition[] = TOOL_SPECS.map((spec) => {
    const def = tool(
      spec.name,
      spec.description,
      spec.shape,
      async (args) => {
        const out = await host.call(spec.name, args);
        return { content: [{ type: 'text' as const, text: out.text }], isError: out.isError };
      },
      {
        annotations: { readOnlyHint: spec.readOnly, destructiveHint: !spec.readOnly, openWorldHint: false },
        alwaysLoad: true
      }
    ) as SdkMcpToolDefinition;
    // Writes always go through the permission callback, even if some allow rule matched.
    return spec.readOnly ? def : { ...def, _meta: { ...def._meta, 'anthropic/requiresUserInteraction': true } };
  });
  return createSdkMcpServer({ name: MCP_SERVER_NAME, version: '1.0.0', tools: defs, alwaysLoad: true });
}

export interface SdkOptionInputs {
  model: string;
  resumeId: string | null;
  cli: ResolvedCli;
  dynamicPrompt: string;
  mcpServer: McpSdkServerConfigWithInstance;
  canUseTool: CanUseTool;
  allowlistHook: HookCallback;
  abortController: AbortController;
  onStderr: (data: string) => void;
}

/** The exact `query()` options; see the report in the AI slice notes for why each is set. */
export function buildSdkOptions(p: SdkOptionInputs): Options {
  return {
    model: p.model,
    systemPrompt: {
      type: 'custom',
      prompt: [staticPrompt(), SYSTEM_PROMPT_DYNAMIC_BOUNDARY, p.dynamicPrompt],
      // Connection, schema, and editor change between turns: render fresh every request.
      snapshot: false
    },
    mcpServers: { [MCP_SERVER_NAME]: p.mcpServer },
    strictMcpConfig: true,
    tools: [],
    disallowedTools: DENIED_BUILTINS,
    // Nothing is pre-approved: every call goes through canUseTool, which allows
    // read/UI tools and gates run_statement (and avoids the SDK's
    // "canUseTool shadowed by allowedTools" warning).
    allowedTools: [],
    permissionMode: 'default',
    canUseTool: p.canUseTool,
    hooks: { PreToolUse: [{ hooks: [p.allowlistHook] }] },
    settingSources: [],
    cwd: aiWorkspaceDir(),
    env: sanitizedEnv(),
    includePartialMessages: true,
    abortController: p.abortController,
    maxTurns: MAX_TURNS,
    stderr: p.onStderr,
    ...(p.resumeId ? { resume: p.resumeId } : {}),
    ...(p.cli.explicitPath ? { pathToClaudeCodeExecutable: p.cli.explicitPath } : {})
  };
}

class TailBuffer {
  private text = '';
  constructor(private readonly max = 2_000) {}
  push(chunk: string): void {
    this.text = (this.text + chunk).slice(-this.max);
  }
  value(): string {
    return this.text.trim();
  }
}

export interface AgentSdkProviderOptions {
  /** Injected for tests. */
  queryFn?: typeof query;
  /** Every raw SDK message, for diagnostics (smoke script). */
  onMessage?: (msg: SDKMessage) => void;
}

export class AgentSdkProvider implements AiProvider {
  private statusCache: { at: number; value: AiStatus } | null = null;
  private statusInFlight: Promise<AiStatus> | null = null;
  private readonly metaCache = new MetaCache();
  private readonly queryFn: typeof query;
  private readonly onMessage?: (msg: SDKMessage) => void;

  constructor(
    private readonly services: DataServices,
    opts: AgentSdkProviderOptions = {}
  ) {
    this.queryFn = opts.queryFn ?? query;
    this.onMessage = opts.onMessage;
  }

  status(refresh = false): Promise<AiStatus> {
    if (!refresh && this.statusCache && Date.now() - this.statusCache.at < STATUS_TTL_MS) {
      return Promise.resolve(this.statusCache.value);
    }
    if (!this.statusInFlight) {
      this.statusInFlight = this.computeStatus()
        .then((value) => {
          this.statusCache = { at: Date.now(), value };
          return value;
        })
        .finally(() => (this.statusInFlight = null));
    }
    return this.statusInFlight;
  }

  private async computeStatus(): Promise<AiStatus> {
    const base = { models: [...AI_MODELS], defaultModel: DEFAULT_AI_MODEL };
    const configured = this.services.getSettings().claudeCliPath.trim();
    const cli = resolveCli(configured);
    if ('error' in cli) {
      return {
        available: false,
        cliPath: configured || null,
        cliSource: configured ? 'configured' : null,
        version: null,
        loggedIn: null,
        error: cli.error,
        ...base
      };
    }
    const probe = await probeCli(cli.path);
    return {
      available: !probe.error,
      cliPath: cli.path,
      cliSource: cli.source,
      version: probe.version,
      loggedIn: probe.loggedIn,
      ...(probe.authMethod ? { authMethod: probe.authMethod } : {}),
      ...(probe.subscriptionType ? { subscriptionType: probe.subscriptionType } : {}),
      ...(probe.error ? { error: probe.error } : probe.loggedIn === false ? { error: LOGIN_HINT } : {}),
      ...base
    };
  }

  async runTurn(input: TurnInput): Promise<TurnOutcome> {
    const { registry } = this.services;
    const profile = input.conn ? (registry.getProfile(input.conn.profileId) ?? null) : null;
    const conn = profile ? input.conn : null;
    const grants = new WriteGrants();
    const host = new ToolHost({
      registry,
      conn,
      profile,
      editor: input.editor,
      allowWrites: input.allowWrites,
      grants,
      signal: input.signal,
      recordHistory: (sql, r) => {
        if (!profile || !conn) return;
        this.services.recordHistory({
          profileId: profile.id,
          database: conn.database,
          connectionName: `${profile.name} (AI)`,
          sql,
          durationMs: r.durationMs,
          rowCount: r.rowCount,
          error: r.error
        });
      }
    });
    const mapper = new TurnEventMapper({
      emit: input.emit,
      describeCall: (name, args) => host.describeCall(name, args),
      conn,
      model: input.model
    });
    const done = (): TurnOutcome => ({ resumeId: mapper.sdkSessionId ?? input.resumeId });

    const cli = resolveCli(this.services.getSettings().claudeCliPath);
    if ('error' in cli) {
      mapper.emitError({ code: 'cli_missing', message: cli.error });
      mapper.finish();
      return done();
    }

    const ctx = await loadConnectionContext(registry, conn, this.metaCache, (message) =>
      input.emit({ type: 'status', message })
    );
    if (ctx.error && conn) input.emit({ type: 'status', message: `Database unavailable: ${ctx.error}` });
    if (input.signal.aborted) {
      mapper.finish({ cancelled: true });
      return done();
    }

    const editorProfile = input.editor?.conn ? registry.getProfile(input.editor.conn.profileId) : undefined;
    const dynamicPrompt = buildDynamicPrompt({
      profile: ctx.profile,
      conn: ctx.conn,
      database: ctx.database,
      serverVersion: ctx.serverVersion,
      meta: ctx.meta,
      connectionError: ctx.error,
      write: writePolicy(ctx.profile, input.allowWrites),
      editor: input.editor,
      editorConnectionName: editorProfile?.name ?? null
    });

    const emitToolCall = (id: string, name: string, args: unknown) => mapper.emitToolCall(id, name, args);
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    input.signal.addEventListener('abort', onAbort, { once: true });
    const stderr = new TailBuffer();

    const options = buildSdkOptions({
      model: input.model || DEFAULT_AI_MODEL,
      resumeId: input.resumeId,
      cli,
      dynamicPrompt,
      mcpServer: createDbMcpServer(host),
      canUseTool: createCanUseTool({
        profile: ctx.profile,
        allowWrites: input.allowWrites,
        approvals: input.approvals,
        grants,
        emitToolCall,
        markDenied: (id) => mapper.markDenied(id)
      }),
      allowlistHook: createToolAllowlistHook(emitToolCall),
      abortController,
      onStderr: (d) => stderr.push(d)
    });

    try {
      const q = this.queryFn({ prompt: input.prompt, options });
      for await (const msg of q) {
        this.onMessage?.(msg);
        mapper.handle(msg);
      }
      mapper.finish({ cancelled: input.signal.aborted });
    } catch (err) {
      if (input.signal.aborted) mapper.finish({ cancelled: true });
      else mapper.finish({ error: err, stderrTail: stderr.value() });
    } finally {
      input.signal.removeEventListener('abort', onAbort);
    }
    if (mapper.initTools) {
      const foreign = mapper.initTools.filter((t) => !t.startsWith(`mcp__${MCP_SERVER_NAME}__`));
      if (foreign.length) console.warn('[ai] the CLI exposed tools besides ours (the hook refuses them):', foreign.join(', '));
    }
    return done();
  }
}
