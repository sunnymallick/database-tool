import { describe, expect, it } from 'vitest';
import type { AiEvent, AiSendRequest, AiStatus } from '@shared/ai';
import { AiSessionManager } from '../../src/main/ai/sessions';
import type { AiProvider, TurnInput, TurnOutcome } from '../../src/main/ai/provider';

class FakeProvider implements AiProvider {
  inputs: TurnInput[] = [];
  script: (input: TurnInput) => Promise<TurnOutcome> = async (input) => {
    input.emit({ type: 'text_delta', text: 'hi' });
    input.emit({ type: 'turn_done' });
    return { resumeId: `sdk-${this.inputs.length}` };
  };
  async status(): Promise<AiStatus> {
    return { available: true, cliPath: '/x', cliSource: 'bundled', version: '1', loggedIn: true, models: [], defaultModel: 'm' };
  }
  runTurn(input: TurnInput): Promise<TurnOutcome> {
    this.inputs.push(input);
    return this.script(input);
  }
}

function setup() {
  const provider = new FakeProvider();
  const events: AiEvent[] = [];
  let id = 0;
  const manager = new AiSessionManager(provider, (e) => events.push(e), {
    newId: () => `id-${++id}`,
    schedule: (fn) => queueMicrotask(fn)
  });
  return { provider, events, manager };
}

const req = (over: Partial<AiSendRequest> = {}): AiSendRequest => ({
  prompt: 'How many orders?',
  conn: { profileId: 'p1' },
  model: 'claude-haiku-5-5',
  allowWrites: false,
  editor: null,
  ...over
});

describe('AiSessionManager', () => {
  it('returns ids immediately and tags streamed events', async () => {
    const { manager, events } = setup();
    const res = manager.send(req());
    expect(res).toEqual({ sessionId: 'id-1', turnId: 'id-2' });
    expect(events).toEqual([]);
    await manager.idle(res.sessionId);
    expect(events).toEqual([
      { sessionId: 'id-1', turnId: 'id-2', type: 'text_delta', text: 'hi' },
      { sessionId: 'id-1', turnId: 'id-2', type: 'turn_done' }
    ]);
  });

  it('uses client-chosen session and turn ids', async () => {
    const { manager } = setup();
    expect(manager.send(req({ sessionId: 'mine', turnId: 'turn-a' }))).toEqual({ sessionId: 'mine', turnId: 'turn-a' });
    await manager.idle('mine');
  });

  it('resumes the provider conversation on the next turn', async () => {
    const { manager, provider } = setup();
    const { sessionId } = manager.send(req());
    await manager.idle(sessionId);
    manager.send(req({ sessionId }));
    await manager.idle(sessionId);
    expect(provider.inputs.map((i) => i.resumeId)).toEqual([null, 'sdk-1']);
  });

  it('allows one active turn per session', async () => {
    const { manager, provider } = setup();
    let release!: () => void;
    provider.script = (input) =>
      new Promise((resolve) => {
        release = () => {
          input.emit({ type: 'turn_done' });
          resolve({ resumeId: null });
        };
      });
    const { sessionId } = manager.send(req());
    await Promise.resolve();
    expect(() => manager.send(req({ sessionId }))).toThrow(/still answering/);
    release();
    await manager.idle(sessionId);
    expect(() => manager.send(req({ sessionId }))).not.toThrow();
  });

  it('rejects empty prompts', () => {
    const { manager } = setup();
    expect(() => manager.send(req({ prompt: '   ' }))).toThrow(/Type a message/);
  });

  it('always ends a turn with turn_done, even if the provider throws', async () => {
    const { manager, provider, events } = setup();
    provider.script = async () => {
      throw new Error('kaboom');
    };
    const { sessionId } = manager.send(req());
    await manager.idle(sessionId);
    expect(events.map((e) => e.type)).toEqual(['error', 'turn_done']);
    expect(events[1]).toMatchObject({ failed: true });
    expect(manager.isBusy(sessionId)).toBe(false);
  });

  it('routes approvals to the running turn and cancel aborts it', async () => {
    const { manager, provider, events } = setup();
    let approved: boolean | null = null;
    provider.script = async (input) => {
      input.emit({ type: 'tool_call', toolUseId: 'w1', name: 'run_statement', input: {}, preview: '', kind: 'write', needsApproval: true });
      approved = await input.approvals.wait('w1', input.signal);
      input.emit({ type: 'tool_result', toolUseId: 'w1', ok: approved, summary: '' });
      // Simulate a model that keeps working until the user stops it.
      await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve()));
      return { resumeId: 'sdk' };
    };
    const { sessionId } = manager.send(req());
    await new Promise((r) => setTimeout(r, 0));
    manager.approve({ sessionId, toolUseId: 'w1', approved: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(approved).toBe(true);
    manager.cancel(sessionId);
    await manager.idle(sessionId);
    expect(events.at(-1)).toMatchObject({ type: 'turn_done', cancelled: true });
  });

  it('cancel rejects a pending approval', async () => {
    const { manager, provider } = setup();
    let approved: boolean | null = null;
    provider.script = async (input) => {
      approved = await input.approvals.wait('w1', input.signal);
      input.emit({ type: 'turn_done', cancelled: true });
      return { resumeId: null };
    };
    const { sessionId } = manager.send(req());
    await new Promise((r) => setTimeout(r, 0));
    manager.cancel(sessionId);
    await manager.idle(sessionId);
    expect(approved).toBe(false);
  });

  it('reset forgets the conversation', async () => {
    const { manager, provider } = setup();
    const { sessionId } = manager.send(req({ sessionId: 's' }));
    await manager.idle(sessionId);
    manager.reset('s');
    manager.send(req({ sessionId: 's' }));
    await manager.idle('s');
    expect(provider.inputs.map((i) => i.resumeId)).toEqual([null, null]);
  });

  it('ignores approvals for sessions without a running turn', () => {
    const { manager } = setup();
    expect(() => manager.approve({ sessionId: 'nope', toolUseId: 'x', approved: true })).not.toThrow();
  });
});
