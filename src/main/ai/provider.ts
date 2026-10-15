/**
 * Provider seam: the session manager talks to an AiProvider, so the Agent SDK
 * implementation (agent-sdk.ts) can be swapped for an API-key provider or a
 * fake in tests.
 */
import type { AiEventBody, AiStatus, EditorSnapshot } from '@shared/ai';
import type { ConnRef } from '@shared/types';
import type { ApprovalBroker } from './approvals';

export interface TurnInput {
  sessionId: string;
  turnId: string;
  prompt: string;
  model: string;
  /** Provider conversation id from the previous turn, for continuity. */
  resumeId: string | null;
  conn: ConnRef | null;
  allowWrites: boolean;
  editor: EditorSnapshot | null;
  /** Aborts when the user stops the turn or resets the conversation. */
  signal: AbortSignal;
  approvals: ApprovalBroker;
  emit: (event: AiEventBody) => void;
}

export interface TurnOutcome {
  /** Conversation id to resume next turn (null: start fresh). */
  resumeId: string | null;
}

export interface AiProvider {
  status(refresh?: boolean): Promise<AiStatus>;
  /**
   * Run one turn. Emits events through `input.emit`, ending with exactly one
   * `turn_done`. Must not throw for ordinary failures (report them as events).
   */
  runTurn(input: TurnInput): Promise<TurnOutcome>;
}
