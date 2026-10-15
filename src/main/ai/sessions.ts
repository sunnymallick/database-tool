/**
 * Conversations and their active turns. One turn at a time per session;
 * events are tagged with session and turn ids and forwarded to the renderer.
 */
import { randomUUID } from 'node:crypto';
import type { AiApproveRequest, AiEvent, AiEventBody, AiSendRequest, AiSendResponse, AiStatus } from '@shared/ai';
import { AppError } from '../errors';
import { ApprovalBroker } from './approvals';
import type { AiProvider } from './provider';

interface ActiveTurn {
  id: string;
  abort: AbortController;
  approvals: ApprovalBroker;
  done: Promise<void>;
}

interface Session {
  id: string;
  /** Provider conversation id carried from turn to turn. */
  resumeId: string | null;
  turn: ActiveTurn | null;
}

export interface SessionManagerOptions {
  newId?: () => string;
  /** How a turn is started after `send` returns (deferred so the IPC reply goes out before the first event). */
  schedule?: (fn: () => void) => void;
}

const MAX_PROMPT_CHARS = 100_000;

export class AiSessionManager {
  private sessions = new Map<string, Session>();
  private readonly newId: () => string;
  private readonly schedule: (fn: () => void) => void;

  constructor(
    private readonly provider: AiProvider,
    private readonly emit: (event: AiEvent) => void,
    opts: SessionManagerOptions = {}
  ) {
    this.newId = opts.newId ?? randomUUID;
    this.schedule = opts.schedule ?? ((fn) => setImmediate(fn));
  }

  status(refresh = false): Promise<AiStatus> {
    return this.provider.status(refresh);
  }

  send(req: AiSendRequest): AiSendResponse {
    const prompt = typeof req.prompt === 'string' ? req.prompt.trim() : '';
    if (!prompt) throw new AppError('Type a message first.', 'AI_EMPTY_PROMPT');
    if (prompt.length > MAX_PROMPT_CHARS) throw new AppError('That message is too long.', 'AI_PROMPT_TOO_LONG');

    const sessionId = req.sessionId || this.newId();
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { id: sessionId, resumeId: null, turn: null };
      this.sessions.set(sessionId, session);
    }
    if (session.turn) {
      throw new AppError('The assistant is still answering. Stop it or wait for it to finish.', 'AI_BUSY');
    }

    const turnId = req.turnId || this.newId();
    const abort = new AbortController();
    const approvals = new ApprovalBroker();
    let finished = false;
    let errored = false;
    const emit = (body: AiEventBody) => {
      if (finished) return;
      if (body.type === 'error') {
        if (errored) return;
        errored = true;
      }
      if (body.type === 'turn_done') finished = true;
      this.emit({ sessionId, turnId, ...body } as AiEvent);
    };

    const s = session;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    s.turn = { id: turnId, abort, approvals, done };

    const run = async () => {
      try {
        const out = await this.provider.runTurn({
          sessionId,
          turnId,
          prompt,
          model: req.model,
          resumeId: s.resumeId,
          conn: req.conn ?? null,
          allowWrites: !!req.allowWrites,
          editor: req.editor ?? null,
          signal: abort.signal,
          approvals,
          emit
        });
        s.resumeId = out.resumeId;
      } catch (err) {
        console.error('[ai] turn failed', err);
        emit({ type: 'error', message: err instanceof Error ? err.message : String(err), code: 'failed' });
      } finally {
        approvals.close();
        if (!finished) emit(abort.signal.aborted ? { type: 'turn_done', cancelled: true } : { type: 'turn_done', failed: true });
        if (s.turn?.id === turnId) s.turn = null;
        resolveDone();
      }
    };
    this.schedule(() => void run());
    return { sessionId, turnId };
  }

  approve(req: AiApproveRequest): void {
    const turn = this.sessions.get(req.sessionId)?.turn;
    // A late click after the turn ended is harmless: the turn's events already settled the card.
    if (!turn) return;
    turn.approvals.answer(req.toolUseId, !!req.approved);
  }

  cancel(sessionId: string): void {
    const turn = this.sessions.get(sessionId)?.turn;
    if (!turn) return;
    turn.approvals.close();
    turn.abort.abort();
  }

  /** Forget the conversation; the next send with this id starts fresh. */
  reset(sessionId: string): void {
    this.cancel(sessionId);
    this.sessions.delete(sessionId);
  }

  /** Resolves when the session has no running turn. */
  async idle(sessionId: string): Promise<void> {
    await this.sessions.get(sessionId)?.turn?.done;
  }

  isBusy(sessionId: string): boolean {
    return !!this.sessions.get(sessionId)?.turn;
  }

  shutdown(): void {
    for (const id of [...this.sessions.keys()]) this.cancel(id);
  }
}
