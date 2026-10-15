/**
 * OWNER: AI slice. Mock handlers for ai.* methods that stream scripted
 * AiEvents, so the AI panel can be built and screenshotted in a browser.
 *
 * Scenarios by prompt:
 *  - default: streamed text, a run_select call + result, a markdown table,
 *    a propose_sql card, turn_done
 *  - contains insert/update/delete: an approval-gated run_statement that
 *    continues after ai.approve (add "prod" for the production variant)
 *  - contains "error": a failure; contains "login": the not-signed-in error
 * Status variants via the page URL: ?ai=nocli or ?ai=login.
 */
import { AI_MODELS, DEFAULT_AI_MODEL, type AiEventBody, type AiStatus } from '@shared/ai';
import type { ConnRef } from '@shared/types';
import type { MockContext, MockHandlers } from './types';

interface MockTurn {
  sessionId: string;
  turnId: string;
  abort: AbortController;
  approvals: Map<string, (approved: boolean) => void>;
}

const turns = new Map<string, MockTurn>();
let counter = 0;
const id = (p: string) => `${p}_${Date.now().toString(36)}${(++counter).toString(36)}`;

function variant(): string {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('ai') ?? '';
  } catch {
    return '';
  }
}

function status(): AiStatus {
  const base = { models: [...AI_MODELS], defaultModel: DEFAULT_AI_MODEL };
  const v = variant();
  if (v === 'nocli') {
    return {
      available: false,
      cliPath: '/Applications/Database Tool.app/Contents/Resources/claude',
      cliSource: 'bundled',
      version: null,
      loggedIn: null,
      error: 'The Claude CLI at /Applications/Database Tool.app/Contents/Resources/claude did not respond to --version (timed out after 10s).',
      ...base
    };
  }
  return {
    available: true,
    cliPath: '/mock/claude',
    cliSource: 'bundled',
    version: '2.1.296',
    loggedIn: v !== 'login',
    authMethod: 'claude.ai',
    subscriptionType: 'max',
    ...base
  };
}

class Cancelled extends Error {}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Cancelled());
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Cancelled());
    });
  });
}

async function runScript(turn: MockTurn, prompt: string, conn: ConnRef | null, ctx: MockContext): Promise<void> {
  const signal = turn.abort.signal;
  const emit = (e: AiEventBody) => {
    if (!signal.aborted) ctx.emit('ai.event', { sessionId: turn.sessionId, turnId: turn.turnId, ...e } as never);
  };
  const stream = async (text: string) => {
    let i = 0;
    while (i < text.length) {
      const n = 3 + Math.floor(Math.random() * 9);
      emit({ type: 'text_delta', text: text.slice(i, i + n) });
      i += n;
      await sleep(14 + Math.random() * 20, signal);
    }
  };
  const approval = (toolUseId: string) =>
    new Promise<boolean>((resolve, reject) => {
      turn.approvals.set(toolUseId, resolve);
      signal.addEventListener('abort', () => reject(new Cancelled()));
    });
  const started = Date.now();
  const p = prompt.toLowerCase();

  await sleep(350, signal);
  if (p.includes('login')) {
    emit({
      type: 'error',
      code: 'not_logged_in',
      message: 'Claude is not signed in. Open a terminal, run `claude`, and sign in with your Claude account (type /login if it does not ask). Then press Retry.'
    });
    emit({ type: 'turn_done', failed: true });
    return;
  }
  if (p.includes('error')) {
    await stream('Let me look at that');
    emit({ type: 'error', code: 'failed', message: 'Claude Code process exited with code 1: API Error: 529 overloaded_error' });
    emit({ type: 'turn_done', failed: true });
    return;
  }

  if (/\b(insert|update|delete|add a|remove)\b/.test(p)) {
    const production = p.includes('prod');
    await stream("I'll check the table first, then add the row.");
    const d = id('toolu');
    emit({ type: 'status', message: 'Preparing: Describe table…' });
    await sleep(300, signal);
    emit({ type: 'tool_call', toolUseId: d, name: 'describe_table', input: { table: 'customers' }, preview: 'customers', kind: 'read', needsApproval: false });
    await sleep(400, signal);
    emit({ type: 'tool_result', toolUseId: d, ok: true, summary: '7 columns' });
    const w = id('toolu');
    const sql = "INSERT INTO customers (email, full_name, country)\nVALUES ('smoke.test@example.com', 'Smoke Test', 'US');";
    emit({ type: 'status', message: 'Preparing: Run statement…' });
    await sleep(400, signal);
    emit({
      type: 'tool_call',
      toolUseId: w,
      name: 'run_statement',
      input: { sql },
      preview: sql,
      kind: 'write',
      needsApproval: true,
      ...(production ? { production: true } : {})
    });
    const ok = await approval(w);
    await sleep(300, signal);
    if (ok) {
      emit({ type: 'tool_result', toolUseId: w, ok: true, summary: '1 row affected' });
      await stream('Done. I added **Smoke Test** (`smoke.test@example.com`) to `customers`; `id`, `created_at` and `is_active` took their defaults.');
    } else {
      emit({ type: 'tool_result', toolUseId: w, ok: false, denied: true, summary: 'The user rejected this statement, so it did not run.' });
      await stream('Understood, I did not run the insert and nothing changed. Tell me if you want different values.');
    }
    emit({ type: 'turn_done', durationMs: Date.now() - started, costUsd: 0.0016 });
    return;
  }

  await stream("I'll check the order statuses in the database.");
  const s = id('toolu');
  const select = 'SELECT status, COUNT(*) AS orders\nFROM orders\nGROUP BY status\nORDER BY orders DESC;';
  emit({ type: 'status', message: 'Preparing: Run query…' });
  await sleep(350, signal);
  emit({ type: 'tool_call', toolUseId: s, name: 'run_select', input: { sql: select }, preview: select, kind: 'read', needsApproval: false });
  await sleep(700, signal);
  emit({ type: 'tool_result', toolUseId: s, ok: true, summary: '5 rows' });
  await stream(
    [
      '\n\nThere are **1,500 orders** across five statuses:',
      '',
      '| Status | Orders |',
      '|---|---:|',
      '| shipped | 311 |',
      '| pending | 308 |',
      '| delivered | 303 |',
      '| cancelled | 290 |',
      '| paid | 288 |',
      '',
      'The split is even, so no status dominates. Here is a version you can run yourself, with the share of each status:'
    ].join('\n')
  );
  const prop = id('toolu');
  emit({
    type: 'propose_sql',
    toolUseId: prop,
    sql: 'SELECT status,\n       COUNT(*) AS orders,\n       ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct\nFROM orders\nGROUP BY status\nORDER BY orders DESC;',
    explanation: 'Counts orders per status and adds each status’s share of all orders.',
    conn
  });
  await sleep(250, signal);
  emit({ type: 'tool_result', toolUseId: prop, ok: true, summary: 'Shown to the user' });
  await stream('Want me to break this down by month as well? See the [window functions docs](https://www.postgresql.org/docs/current/tutorial-window.html).');
  emit({ type: 'turn_done', durationMs: Date.now() - started, costUsd: 0.0021 });
}

export const aiMock: MockHandlers = {
  'ai.status': () => status(),

  'ai.send': (req, ctx) => {
    const sessionId = req.sessionId || id('session');
    const turnId = req.turnId || id('turn');
    if (turns.has(sessionId)) throw new Error('The assistant is still answering. Stop it or wait for it to finish.');
    const turn: MockTurn = { sessionId, turnId, abort: new AbortController(), approvals: new Map() };
    turns.set(sessionId, turn);
    void runScript(turn, req.prompt, req.conn, ctx)
      .catch((err) => {
        if (err instanceof Cancelled) {
          ctx.emit('ai.event', { sessionId, turnId, type: 'turn_done', cancelled: true });
        } else {
          ctx.emit('ai.event', { sessionId, turnId, type: 'error', message: String(err), code: 'failed' });
          ctx.emit('ai.event', { sessionId, turnId, type: 'turn_done', failed: true });
        }
      })
      .finally(() => {
        if (turns.get(sessionId) === turn) turns.delete(sessionId);
      });
    return { sessionId, turnId };
  },

  'ai.approve': (req) => {
    const resolve = turns.get(req.sessionId)?.approvals.get(req.toolUseId);
    resolve?.(req.approved);
  },

  'ai.cancel': (req) => {
    turns.get(req.sessionId)?.abort.abort();
  },

  'ai.reset': (req) => {
    turns.get(req.sessionId)?.abort.abort();
    turns.delete(req.sessionId);
  }
};
