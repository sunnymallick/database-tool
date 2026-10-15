import { describe, expect, it, vi } from 'vitest';
import { ApprovalBroker, WriteGrants, writePolicy } from '../../src/main/ai/approvals';
import { createToolAllowlistHook, decidePermission, REJECTED_MESSAGE, type PermissionDeps } from '../../src/main/ai/permissions';
import { makeProfile } from './fakes';

const RUN_STATEMENT = 'mcp__db__run_statement';

function deps(overrides: Partial<PermissionDeps> = {}) {
  const d: PermissionDeps & { calls: string[]; denied: string[] } = {
    profile: makeProfile(),
    allowWrites: false,
    approvals: new ApprovalBroker(),
    grants: new WriteGrants(),
    calls: [],
    denied: [],
    emitToolCall: (id) => d.calls.push(id),
    markDenied: (id) => d.denied.push(id),
    ...overrides
  };
  return d;
}

describe('write policy matrix', () => {
  const cases: [string, Parameters<typeof makeProfile>[0] | null, boolean, string][] = [
    ['no database', null, false, 'refuse'],
    ['no database, allow-writes', null, true, 'refuse'],
    ['read-only', { readOnly: true }, false, 'refuse'],
    ['read-only, allow-writes', { readOnly: true }, true, 'refuse'],
    ['read-only production, allow-writes', { readOnly: true, production: true }, true, 'refuse'],
    ['production', { production: true }, false, 'ask'],
    ['production, allow-writes', { production: true }, true, 'ask'],
    ['normal', {}, false, 'ask'],
    ['normal, allow-writes', {}, true, 'auto']
  ];
  it.each(cases)('%s -> %s', (_label, profile, allowWrites, expected) => {
    expect(writePolicy(profile ? makeProfile(profile) : null, allowWrites).policy).toBe(expected);
  });
});

describe('canUseTool decisions', () => {
  it('allows read and UI tools without asking', async () => {
    const d = deps();
    for (const name of ['list_schemas', 'list_tables', 'describe_table', 'run_select', 'read_editor', 'propose_sql']) {
      const r = await decidePermission(d, `mcp__db__${name}`, { sql: 'x' }, `t-${name}`);
      expect(r.behavior).toBe('allow');
    }
    expect(d.calls).toEqual([]);
  });

  it('denies tools that are not ours', async () => {
    const d = deps();
    for (const name of ['Bash', 'Read', 'mcp__other__run_select', 'mcp__db__unknown']) {
      const r = await decidePermission(d, name, {}, `t-${name}`);
      expect(r.behavior).toBe('deny');
    }
    expect(d.denied).toHaveLength(4);
  });

  it('read-only: refuses without asking, even with allow-writes', async () => {
    const d = deps({ profile: makeProfile({ readOnly: true }), allowWrites: true });
    const wait = vi.spyOn(d.approvals, 'wait');
    const r = await decidePermission(d, RUN_STATEMENT, { sql: 'DELETE FROM t' }, 'w1');
    expect(r).toMatchObject({ behavior: 'deny' });
    expect((r as { message: string }).message).toMatch(/read-only/);
    expect(wait).not.toHaveBeenCalled();
    expect(d.denied).toEqual(['w1']);
    expect(d.calls).toEqual(['w1']);
  });

  it('no database: refuses', async () => {
    const d = deps({ profile: null, allowWrites: true });
    const r = await decidePermission(d, RUN_STATEMENT, { sql: 'DELETE FROM t' }, 'w1');
    expect(r.behavior).toBe('deny');
  });

  it('normal + allow-writes: runs without asking', async () => {
    const d = deps({ allowWrites: true });
    const wait = vi.spyOn(d.approvals, 'wait');
    const r = await decidePermission(d, RUN_STATEMENT, { sql: 'DELETE FROM t' }, 'w1');
    expect(r).toMatchObject({ behavior: 'allow', updatedInput: { sql: 'DELETE FROM t' } });
    expect(wait).not.toHaveBeenCalled();
  });

  it('normal without allow-writes: waits, then allows and grants on approve', async () => {
    const d = deps();
    const pending = decidePermission(d, RUN_STATEMENT, { sql: 'DELETE FROM t' }, 'w1');
    await Promise.resolve();
    expect(d.calls).toEqual(['w1']);
    expect(d.approvals.isPending('w1')).toBe(true);
    d.approvals.answer('w1', true);
    expect(await pending).toMatchObject({ behavior: 'allow' });
    expect(d.grants.consume('DELETE FROM t')).toBe(true);
  });

  it('production + allow-writes: still waits for approval', async () => {
    const d = deps({ profile: makeProfile({ production: true }), allowWrites: true });
    const pending = decidePermission(d, RUN_STATEMENT, { sql: 'UPDATE t SET a = 1' }, 'w1');
    await Promise.resolve();
    expect(d.approvals.isPending('w1')).toBe(true);
    d.approvals.answer('w1', false);
    const r = await pending;
    expect(r).toMatchObject({ behavior: 'deny', message: REJECTED_MESSAGE });
    expect(d.denied).toEqual(['w1']);
    expect(d.grants.consume('UPDATE t SET a = 1')).toBe(false);
  });

  it('an answer that arrives before the SDK asks is kept', async () => {
    const d = deps();
    d.approvals.answer('w1', true);
    expect(await decidePermission(d, RUN_STATEMENT, { sql: 'DELETE FROM t' }, 'w1')).toMatchObject({ behavior: 'allow' });
  });

  it('cancelling the turn rejects a pending approval', async () => {
    const d = deps();
    const ac = new AbortController();
    const pending = decidePermission(d, RUN_STATEMENT, { sql: 'DELETE FROM t' }, 'w1', ac.signal);
    ac.abort();
    expect(await pending).toMatchObject({ behavior: 'deny' });
  });

  it('closing the broker rejects everything waiting', async () => {
    const d = deps();
    const a = decidePermission(d, RUN_STATEMENT, { sql: 'DELETE FROM a' }, 'w1');
    const b = decidePermission(d, RUN_STATEMENT, { sql: 'DELETE FROM b' }, 'w2');
    d.approvals.close();
    expect((await a).behavior).toBe('deny');
    expect((await b).behavior).toBe('deny');
    expect(d.approvals.answer('w3', true)).toBe(false);
  });
});

describe('PreToolUse allowlist hook', () => {
  const base = { session_id: 's', transcript_path: '', cwd: '/', hook_event_name: 'PreToolUse' as const, tool_input: {} };

  it('denies built-in tools', async () => {
    const hook = createToolAllowlistHook(() => {});
    const out = await hook({ ...base, tool_name: 'Bash', tool_use_id: 'x' }, 'x', { signal: new AbortController().signal });
    expect(out).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } });
  });

  it('lets our tools through and surfaces the call', async () => {
    const seen: string[] = [];
    const hook = createToolAllowlistHook((id) => seen.push(id));
    const out = await hook({ ...base, tool_name: 'mcp__db__run_select', tool_use_id: 'x' }, 'x', {
      signal: new AbortController().signal
    });
    expect(out).toEqual({});
    expect(seen).toEqual(['x']);
  });
});
