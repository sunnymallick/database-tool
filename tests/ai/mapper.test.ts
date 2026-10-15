import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk/core';
import type { AiEventBody } from '@shared/ai';
import { classifyError, TurnEventMapper } from '../../src/main/ai/mapper';
import type { CallInfo } from '../../src/main/ai/tools';

const SESSION = '8f6c2a52-7c43-4c3e-9a51-2f8b3f2d9e10';
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

/** Message shapes as in sdk.d.ts (fields the mapper does not read are filled realistically). */
const m = {
  init: (): SDKMessage =>
    ({
      type: 'system',
      subtype: 'init',
      apiKeySource: 'none',
      claude_code_version: '2.1.296',
      cwd: '/tmp/ai-workspace',
      tools: ['mcp__db__run_select', 'mcp__db__propose_sql'],
      mcp_servers: [{ name: 'db', status: 'connected', source: 'sdk' }],
      model: 'claude-haiku-5-5',
      permissionMode: 'default',
      slash_commands: [],
      output_style: 'default',
      skills: [],
      plugins: [],
      uuid: uuid(),
      session_id: SESSION
    }) as unknown as SDKMessage,
  stream: (event: Record<string, unknown>): SDKMessage =>
    ({ type: 'stream_event', event, parent_tool_use_id: null, uuid: uuid(), session_id: SESSION }) as unknown as SDKMessage,
  assistant: (id: string, content: unknown[], extra: Record<string, unknown> = {}): SDKMessage =>
    ({
      type: 'assistant',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-5-5',
        content,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 }
      },
      parent_tool_use_id: null,
      uuid: uuid(),
      session_id: SESSION,
      ...extra
    }) as unknown as SDKMessage,
  toolResult: (toolUseId: string, text: string, isError = false): SDKMessage =>
    ({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text }], is_error: isError }]
      },
      parent_tool_use_id: null,
      tool_use_result: [{ type: 'text', text }],
      uuid: uuid(),
      session_id: SESSION
    }) as unknown as SDKMessage,
  success: (): SDKMessage =>
    ({
      type: 'result',
      subtype: 'success',
      duration_ms: 2550,
      duration_api_ms: 2100,
      is_error: false,
      num_turns: 2,
      result: 'Here are the counts.',
      stop_reason: 'end_turn',
      total_cost_usd: 0.0011,
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      uuid: uuid(),
      session_id: SESSION
    }) as unknown as SDKMessage,
  apiError: (text: string): SDKMessage =>
    ({
      type: 'result',
      subtype: 'success',
      duration_ms: 300,
      duration_api_ms: 0,
      is_error: true,
      num_turns: 1,
      result: text,
      stop_reason: null,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      uuid: uuid(),
      session_id: SESSION
    }) as unknown as SDKMessage,
  maxTurns: (): SDKMessage =>
    ({
      type: 'result',
      subtype: 'error_max_turns',
      duration_ms: 9000,
      duration_api_ms: 8000,
      is_error: true,
      num_turns: 40,
      stop_reason: null,
      total_cost_usd: 0.2,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      errors: [],
      uuid: uuid(),
      session_id: SESSION
    }) as unknown as SDKMessage
};

const describeCall = (name: string, input: unknown): CallInfo => ({
  kind: name === 'run_statement' ? 'write' : 'read',
  preview: String((input as { sql?: string })?.sql ?? ''),
  needsApproval: name === 'run_statement',
  production: false
});

function mapper() {
  const events: AiEventBody[] = [];
  const mp = new TurnEventMapper({ emit: (e) => events.push(e), describeCall, conn: { profileId: 'p1' }, model: 'claude-haiku-5-5' });
  return { mp, events };
}

const textOf = (events: AiEventBody[]) => events.flatMap((e) => (e.type === 'text_delta' ? [e.text] : [])).join('');

describe('SDK message -> AiEvent mapping', () => {
  it('maps a streamed turn with a tool call', () => {
    const { mp, events } = mapper();
    const sql = 'SELECT status, COUNT(*) FROM orders GROUP BY status';
    const msgs: SDKMessage[] = [
      m.init(),
      m.stream({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } }),
      m.stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'mcp__db__run_select', input: {} } }),
      m.stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"sql":' } }),
      m.stream({ type: 'content_block_stop', index: 0 }),
      m.assistant('msg_1', [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__db__run_select', input: { sql } }]),
      m.toolResult('toolu_1', JSON.stringify({ columns: [{ name: 'status' }], rows: [['paid', 3]], row_count: 1 })),
      m.stream({ type: 'message_start', message: { id: 'msg_2', type: 'message', role: 'assistant', content: [] } }),
      m.stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      m.stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'There are ' } }),
      m.stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '3 paid orders.' } }),
      m.stream({ type: 'content_block_stop', index: 0 }),
      m.assistant('msg_2', [{ type: 'text', text: 'There are 3 paid orders.' }]),
      m.stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }),
      m.success()
    ];
    for (const msg of msgs) mp.handle(msg);
    mp.finish();

    expect(mp.sdkSessionId).toBe(SESSION);
    expect(mp.initTools).toEqual(['mcp__db__run_select', 'mcp__db__propose_sql']);
    expect(events.map((e) => e.type)).toEqual([
      'status',
      'tool_call',
      'tool_result',
      'text_delta',
      'text_delta',
      'turn_done'
    ]);
    expect(events[1]).toEqual({
      type: 'tool_call',
      toolUseId: 'toolu_1',
      name: 'run_select',
      input: { sql },
      preview: sql,
      kind: 'read',
      needsApproval: false
    });
    expect(events[2]).toEqual({ type: 'tool_result', toolUseId: 'toolu_1', ok: true, summary: '1 row' });
    // Text arrives once (from the stream), not again from the completed assistant message.
    expect(textOf(events)).toBe('There are 3 paid orders.');
    expect(events.at(-1)).toEqual({ type: 'turn_done', costUsd: 0.0011, durationMs: 2550 });
  });

  it('falls back to the assistant message text when nothing streamed', () => {
    const { mp, events } = mapper();
    mp.handle(m.assistant('msg_1', [{ type: 'text', text: 'First.' }]));
    mp.handle(m.assistant('msg_2', [{ type: 'text', text: 'Second.' }]));
    expect(textOf(events)).toBe('First.\n\nSecond.');
  });

  it('emits each tool call once even when the permission layer saw it first', () => {
    const { mp, events } = mapper();
    mp.emitToolCall('toolu_9', 'mcp__db__run_statement', { sql: 'DELETE FROM t' });
    mp.handle(m.assistant('msg_1', [{ type: 'tool_use', id: 'toolu_9', name: 'mcp__db__run_statement', input: { sql: 'DELETE FROM t' } }]));
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(1);
    expect(events[0]).toMatchObject({ needsApproval: true, kind: 'write' });
  });

  it('marks denied tool results', () => {
    const { mp, events } = mapper();
    mp.emitToolCall('toolu_9', 'mcp__db__run_statement', { sql: 'DELETE FROM t' });
    mp.markDenied('toolu_9');
    mp.handle(m.toolResult('toolu_9', 'The user rejected this statement, so it did not run.', true));
    expect(events.at(-1)).toEqual({
      type: 'tool_result',
      toolUseId: 'toolu_9',
      ok: false,
      denied: true,
      summary: 'The user rejected this statement, so it did not run.'
    });
  });

  it('summarizes tool errors from our JSON error payload', () => {
    const { mp, events } = mapper();
    mp.emitToolCall('toolu_2', 'mcp__db__run_select', { sql: 'SELECT nope' });
    mp.handle(m.toolResult('toolu_2', JSON.stringify({ error: 'column "nope" does not exist', code: '42703' }), true));
    expect(events.at(-1)).toMatchObject({ type: 'tool_result', ok: false, summary: 'column "nope" does not exist' });
  });

  it('maps propose_sql to a proposal card with the connection', () => {
    const { mp, events } = mapper();
    mp.handle(
      m.assistant('msg_1', [
        { type: 'tool_use', id: 'toolu_3', name: 'mcp__db__propose_sql', input: { sql: 'SELECT 1', explanation: 'One.' } }
      ])
    );
    expect(events).toEqual([
      { type: 'propose_sql', toolUseId: 'toolu_3', sql: 'SELECT 1', explanation: 'One.', conn: { profileId: 'p1' } }
    ]);
  });

  it('ignores subagent messages', () => {
    const { mp, events } = mapper();
    mp.handle({ ...(m.assistant('msg_1', [{ type: 'text', text: 'nested' }]) as object), parent_tool_use_id: 'toolu_x' } as SDKMessage);
    expect(events).toEqual([]);
  });

  it('turns a not-logged-in API error into sign-in guidance', () => {
    const { mp, events } = mapper();
    mp.handle(m.assistant('msg_1', [{ type: 'text', text: 'Not logged in · Please run /login' }], { error: 'authentication_failed' }));
    mp.handle(m.apiError('Not logged in · Please run /login'));
    mp.finish({ error: new Error('Claude Code process exited with code 1') });
    const err = events.find((e) => e.type === 'error');
    expect(err).toMatchObject({ code: 'not_logged_in' });
    expect((err as { message: string }).message).toMatch(/run `claude`/);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'turn_done', failed: true });
  });

  it('reports max-turns as a readable error', () => {
    const { mp, events } = mapper();
    mp.handle(m.maxTurns());
    mp.finish();
    expect(events.map((e) => e.type)).toEqual(['error', 'turn_done']);
    expect(events[0]).toMatchObject({ message: expect.stringMatching(/too many steps/) });
  });

  it('reports a cancelled turn without an error', () => {
    const { mp, events } = mapper();
    mp.handle(m.stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial' } }));
    mp.finish({ cancelled: true });
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'turn_done']);
    expect(events[1]).toEqual({ type: 'turn_done', cancelled: true });
  });

  it('reports a crash with the stderr tail when no result arrived', () => {
    const { mp, events } = mapper();
    mp.finish({ error: new Error('Claude Code process exited with code 1'), stderrTail: 'boom' });
    expect(events[0]).toMatchObject({ type: 'error', code: 'failed' });
    expect((events[0] as { message: string }).message).toMatch(/exited with code 1\nboom/);
  });

  it('emits nothing after the turn is finished', () => {
    const { mp, events } = mapper();
    mp.finish({ cancelled: true });
    mp.handle(m.stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'late' } }));
    mp.finish();
    expect(events).toHaveLength(1);
  });

  it('surfaces API retries and compaction as status', () => {
    const { mp, events } = mapper();
    mp.handle({
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 2000,
      error_status: 529,
      error: 'overloaded',
      uuid: uuid(),
      session_id: SESSION
    } as unknown as SDKMessage);
    mp.handle({ type: 'system', subtype: 'status', status: 'compacting', uuid: uuid(), session_id: SESSION } as unknown as SDKMessage);
    expect(events).toEqual([
      { type: 'status', message: 'Claude API overloaded; retrying in 2s (attempt 1 of 10)…' },
      { type: 'status', message: 'Compacting the conversation…' }
    ]);
  });
});

describe('classifyError', () => {
  it.each([
    ['Invalid API key · Please run /login', null, 'not_logged_in'],
    ['OAuth token has expired', null, 'not_logged_in'],
    ['', 'authentication_failed', 'not_logged_in'],
    ['model: claude-fable-5-1 not found', null, 'model_unavailable'],
    ['Claude AI usage limit reached|1760000000', null, 'rate_limited'],
    ['Native CLI binary for darwin-arm64 not found', null, 'cli_missing'],
    ['something else broke', null, 'failed']
  ] as const)('%s / %s -> %s', (text, kind, code) => {
    expect(classifyError(text, kind).code).toBe(code);
  });
});
