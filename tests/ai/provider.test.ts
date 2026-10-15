/**
 * The Agent SDK provider with a scripted fake `query()`: checks the options we
 * pass to the SDK and drives the real permission callback, MCP tool handlers,
 * and event mapping end to end (no CLI, no network).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CanUseTool, Options, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk/core';
import type { AiEventBody } from '@shared/ai';
import { AgentSdkProvider } from '../../src/main/ai/agent-sdk';
import { ApprovalBroker } from '../../src/main/ai/approvals';
import { fakeRegistry, fakeServices, makeProfile } from './fakes';

beforeAll(() => {
  process.env.DATABASE_TOOL_HOME = mkdtempSync(join(tmpdir(), 'dbtool-ai-test-'));
});

const SESSION = '11111111-2222-4333-8444-555555555555';

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

function mcpHandler(options: Options, name: string): Handler {
  const server = (options.mcpServers?.db as unknown as { instance: { _registeredTools: Record<string, { handler: Handler }> } }).instance;
  return server._registeredTools[name].handler;
}

/** A fake query() that asks to run one tool call through the real callback and handler. */
function scriptedQuery(captured: { options?: Options; prompt?: unknown }, call: { name: string; input: Record<string, unknown> }) {
  return ((params: { prompt: unknown; options?: Options }) => {
    captured.options = params.options;
    captured.prompt = params.prompt;
    const options = params.options!;
    async function* run(): AsyncGenerator<SDKMessage> {
      yield { type: 'system', subtype: 'init', tools: ['mcp__db__run_select'], session_id: SESSION } as unknown as SDKMessage;
      yield {
        type: 'assistant',
        message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'toolu_1', name: `mcp__db__${call.name}`, input: call.input }] },
        parent_tool_use_id: null,
        session_id: SESSION
      } as unknown as SDKMessage;
      const canUseTool = options.canUseTool as CanUseTool;
      const decision = await canUseTool(`mcp__db__${call.name}`, call.input, {
        signal: options.abortController!.signal,
        toolUseID: 'toolu_1',
        requestId: 'req_1'
      });
      let content: { type: string; text: string }[];
      let isError: boolean;
      if (decision?.behavior === 'allow') {
        const out = await mcpHandler(options, call.name)(call.input, {});
        content = out.content;
        isError = !!out.isError;
      } else {
        content = [{ type: 'text', text: decision?.behavior === 'deny' ? decision.message : 'denied' }];
        isError = true;
      }
      yield {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content, is_error: isError }] },
        parent_tool_use_id: null,
        session_id: SESSION
      } as unknown as SDKMessage;
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'ok',
        duration_ms: 10,
        total_cost_usd: 0.001,
        session_id: SESSION
      } as unknown as SDKMessage;
    }
    return run();
  }) as unknown as typeof sdkQuery;
}

function setup(profileOverrides = {}, call = { name: 'run_select', input: { sql: 'SELECT 1' } as Record<string, unknown> }) {
  const profile = makeProfile(profileOverrides);
  const registry = fakeRegistry([profile]);
  const services = fakeServices(registry);
  const captured: { options?: Options; prompt?: unknown } = {};
  const provider = new AgentSdkProvider(services, { queryFn: scriptedQuery(captured, call) });
  const events: AiEventBody[] = [];
  const approvals = new ApprovalBroker();
  const abort = new AbortController();
  const run = (allowWrites = false, onEvent?: (e: AiEventBody) => void) =>
    provider.runTurn({
      sessionId: 's1',
      turnId: 't1',
      prompt: 'How many orders?',
      model: 'claude-haiku-5-5',
      resumeId: 'prev-session',
      conn: { profileId: profile.id },
      allowWrites,
      editor: null,
      signal: abort.signal,
      approvals,
      emit: (e) => {
        events.push(e);
        onEvent?.(e);
      }
    });
  return { provider, registry, services, captured, events, approvals, abort, run };
}

describe('AgentSdkProvider', () => {
  it('passes locked-down SDK options', async () => {
    const prevClaudeCode = process.env.CLAUDECODE;
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    const { captured, run } = setup();
    const out = await run();
    process.env.CLAUDECODE = prevClaudeCode;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;

    const o = captured.options!;
    expect(captured.prompt).toBe('How many orders?');
    expect(o.model).toBe('claude-haiku-5-5');
    expect(o.tools).toEqual([]);
    expect(o.allowedTools).toEqual([]);
    expect(o.disallowedTools).toContain('Bash');
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.permissionMode).toBe('default');
    expect(o.includePartialMessages).toBe(true);
    expect(o.resume).toBe('prev-session');
    expect(o.cwd).toBe(join(process.env.DATABASE_TOOL_HOME!, 'ai-workspace'));
    expect(o.pathToClaudeCodeExecutable).toBeUndefined();
    expect(o.env?.CLAUDECODE).toBeUndefined();
    expect(o.env?.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(o.env?.PATH).toBe(process.env.PATH);
    expect(Object.keys(o.mcpServers ?? {})).toEqual(['db']);
    const sp = o.systemPrompt as { type: string; prompt: string[]; snapshot: boolean };
    expect(sp.type).toBe('custom');
    expect(sp.snapshot).toBe(false);
    expect(sp.prompt[2]).toContain('Connection: "Shop" (PostgreSQL 17.0)');
    expect(sp.prompt[2]).toContain('- orders(id int4, status text)');
    expect(out.resumeId).toBe(SESSION);
  });

  it('registers our seven tools; only run_statement requires interaction', async () => {
    const { captured, run } = setup();
    await run();
    const tools = (captured.options!.mcpServers!.db as unknown as {
      instance: { _registeredTools: Record<string, { _meta?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean } }> };
    }).instance._registeredTools;
    expect(Object.keys(tools).sort()).toEqual(
      ['describe_table', 'list_schemas', 'list_tables', 'propose_sql', 'read_editor', 'run_select', 'run_statement'].sort()
    );
    expect(tools.run_statement._meta?.['anthropic/requiresUserInteraction']).toBe(true);
    expect(tools.run_select._meta?.['anthropic/requiresUserInteraction']).toBeUndefined();
    expect(tools.run_select.annotations?.readOnlyHint).toBe(true);
  });

  it('runs a read tool end to end', async () => {
    const { run, events, registry } = setup();
    await run();
    expect(registry.driver.executed.map((e) => e.sql)).toEqual(['SELECT 1']);
    expect(events.filter((e) => e.type !== 'status').map((e) => e.type)).toEqual(['tool_call', 'tool_result', 'turn_done']);
  });

  it('waits for approval, then runs an approved write', async () => {
    const { run, events, registry, approvals } = setup({}, { name: 'run_statement', input: { sql: 'DELETE FROM orders WHERE id = 1' } });
    await run(false, (e) => {
      if (e.type === 'tool_call' && e.needsApproval) setTimeout(() => approvals.answer(e.toolUseId, true), 5);
    });
    expect(registry.driver.executed.map((e) => e.sql)).toEqual(['DELETE FROM orders WHERE id = 1']);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: true, summary: '1 row affected' });
  });

  it('does not run a rejected write and still finishes cleanly', async () => {
    const { run, events, registry, approvals } = setup({}, { name: 'run_statement', input: { sql: 'DELETE FROM orders' } });
    await run(false, (e) => {
      if (e.type === 'tool_call' && e.needsApproval) setTimeout(() => approvals.answer(e.toolUseId, false), 5);
    });
    expect(registry.driver.executed).toEqual([]);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false, denied: true });
    expect(events.at(-1)).toMatchObject({ type: 'turn_done' });
    expect(events.at(-1)).not.toHaveProperty('failed');
  });

  it('refuses writes on read-only profiles without asking', async () => {
    const { run, events, registry } = setup({ readOnly: true }, { name: 'run_statement', input: { sql: 'DELETE FROM orders' } });
    await run(true);
    expect(registry.driver.executed).toEqual([]);
    expect(events.find((e) => e.type === 'tool_call')).toMatchObject({ needsApproval: false });
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false, denied: true });
  });

  it('asks on production even with allow-writes on', async () => {
    const { run, events, approvals } = setup({ production: true }, { name: 'run_statement', input: { sql: 'DELETE FROM orders' } });
    await run(true, (e) => {
      if (e.type === 'tool_call') setTimeout(() => approvals.answer(e.toolUseId, false), 5);
    });
    expect(events.find((e) => e.type === 'tool_call')).toMatchObject({ needsApproval: true, production: true });
  });

  it('reports a missing configured CLI without calling the SDK', async () => {
    const profile = makeProfile();
    const services = fakeServices(fakeRegistry([profile]));
    const base = services.getSettings();
    services.getSettings = () => ({ ...base, claudeCliPath: '/nope/claude' });
    let called = false;
    const provider = new AgentSdkProvider(services, {
      queryFn: (() => {
        called = true;
        throw new Error('should not run');
      }) as unknown as typeof sdkQuery
    });
    const events: AiEventBody[] = [];
    await provider.runTurn({
      sessionId: 's',
      turnId: 't',
      prompt: 'hi',
      model: 'claude-haiku-5-5',
      resumeId: null,
      conn: null,
      allowWrites: false,
      editor: null,
      signal: new AbortController().signal,
      approvals: new ApprovalBroker(),
      emit: (e) => events.push(e)
    });
    expect(called).toBe(false);
    expect(events.map((e) => e.type)).toEqual(['error', 'turn_done']);
    expect(events[0]).toMatchObject({ code: 'cli_missing' });
  });
});
