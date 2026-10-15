/**
 * Write gating: which profiles may run agent writes, and the channel that
 * parks a tool call until the user answers its approval card.
 */
import type { ConnectionProfile } from '@shared/types';

export type WritePolicy =
  /** Never run: no database, or the profile is read-only. */
  | 'refuse'
  /** Run only after the user approves this specific call. */
  | 'ask'
  /** Run without asking (allow-writes is on and the profile is not production). */
  | 'auto';

export interface WriteDecision {
  policy: WritePolicy;
  /** Explanation for the model when refused, or for the approval card. */
  reason: string;
}

/**
 * Gating matrix:
 *  - no connection         -> refuse
 *  - read-only profile     -> refuse (always, regardless of allow-writes)
 *  - production profile    -> ask    (always, regardless of allow-writes)
 *  - allowWrites           -> auto
 *  - otherwise             -> ask
 */
export function writePolicy(profile: ConnectionProfile | null | undefined, allowWrites: boolean): WriteDecision {
  if (!profile) {
    return { policy: 'refuse', reason: 'No database is selected in the AI panel, so statements cannot run.' };
  }
  if (profile.readOnly) {
    return {
      policy: 'refuse',
      reason: `The connection "${profile.name}" is read-only. Writes are refused; propose the SQL with propose_sql instead.`
    };
  }
  if (profile.production) {
    return { policy: 'ask', reason: `"${profile.name}" is a production connection; every write needs the user's approval.` };
  }
  if (allowWrites) return { policy: 'auto', reason: 'The user enabled "Allow writes" for this conversation.' };
  return { policy: 'ask', reason: 'Writes need the user\'s approval ("Allow writes" is off).' };
}

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  constructor() {
    this.promise = new Promise<T>((r) => (this.resolve = r));
  }
}

/**
 * Pending approvals keyed by tool_use id. A decision may arrive before the
 * SDK asks (the card can render from the assistant message first), so early
 * answers are remembered until `wait` collects them.
 */
export class ApprovalBroker {
  private pending = new Map<string, Deferred<boolean>>();
  private early = new Map<string, boolean>();
  private closed = false;

  /** Resolves true (approved) or false (rejected, cancelled, or the signal aborted). */
  wait(toolUseId: string, signal?: AbortSignal): Promise<boolean> {
    if (this.closed || signal?.aborted) return Promise.resolve(false);
    const answer = this.early.get(toolUseId);
    if (answer !== undefined) {
      this.early.delete(toolUseId);
      return Promise.resolve(answer);
    }
    let d = this.pending.get(toolUseId);
    if (!d) {
      d = new Deferred<boolean>();
      this.pending.set(toolUseId, d);
    }
    const deferred = d;
    const onAbort = () => this.settle(toolUseId, false);
    signal?.addEventListener('abort', onAbort, { once: true });
    return deferred.promise.finally(() => signal?.removeEventListener('abort', onAbort));
  }

  /** Record the user's answer. Returns false when the turn is already over. */
  answer(toolUseId: string, approved: boolean): boolean {
    if (this.closed) return false;
    if (this.pending.has(toolUseId)) {
      this.settle(toolUseId, approved);
    } else {
      this.early.set(toolUseId, approved);
    }
    return true;
  }

  isPending(toolUseId: string): boolean {
    return this.pending.has(toolUseId);
  }

  /** Reject everything still waiting and refuse future waits (turn cancelled or finished). */
  close(): void {
    this.closed = true;
    for (const id of [...this.pending.keys()]) this.settle(id, false);
    this.early.clear();
  }

  private settle(toolUseId: string, approved: boolean): void {
    const d = this.pending.get(toolUseId);
    if (!d) return;
    this.pending.delete(toolUseId);
    d.resolve(approved);
  }
}

/**
 * Approvals granted through the permission callback, consumed by the
 * run_statement handler. A second, independent check: if the SDK ever ran
 * the tool without consulting the callback, the handler still refuses.
 */
export class WriteGrants {
  private granted: string[] = [];

  grant(sql: string): void {
    this.granted.push(normalizeSql(sql));
  }

  consume(sql: string): boolean {
    const i = this.granted.indexOf(normalizeSql(sql));
    if (i === -1) return false;
    this.granted.splice(i, 1);
    return true;
  }
}

function normalizeSql(sql: string): string {
  return sql.trim();
}
