/**
 * Helpers shared by the engine drivers: session serialization, result-set
 * scaffolding, binary previews, error-offset mapping, and the per-statement
 * script loop.
 */
import type { StatementSpan } from '@shared/sql';
import type { QueryError, ResultSet, Value } from '@shared/types';
import { QueryFailure, type ExecuteOptions } from './driver';

/** Serializes async work on one resource (the session connection) in call order. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    // Keep the chain alive after failures; callers still see their own rejection.
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** Binary cells carry at most this many bytes of hex; `length` keeps the full size. */
export const BYTES_PREVIEW_LIMIT = 64 * 1024;

export function bytesValue(buf: Uint8Array): Value {
  const length = buf.byteLength;
  const shown = length > BYTES_PREVIEW_LIMIT ? buf.subarray(0, BYTES_PREVIEW_LIMIT) : buf;
  const hex = Buffer.from(shown.buffer, shown.byteOffset, shown.byteLength).toString('hex');
  return length > BYTES_PREVIEW_LIMIT ? { t: 'bytes', hex, length, truncated: true } : { t: 'bytes', hex, length };
}

/** Bytes from lowercase/uppercase hex text (no prefix). */
export function hexValue(hex: string): Value {
  const length = Math.floor(hex.length / 2);
  if (length > BYTES_PREVIEW_LIMIT) return { t: 'bytes', hex: hex.slice(0, BYTES_PREVIEW_LIMIT * 2).toLowerCase(), length, truncated: true };
  return { t: 'bytes', hex: hex.toLowerCase(), length };
}

/** Decode a `{t:'bytes'}` value for binding. Truncated previews must never be written back. */
export function bytesFromValue(v: Extract<Value, { t: 'bytes' }>): Buffer {
  if (v.truncated) throw new Error('Cannot write a truncated binary value (only a preview was loaded)');
  return Buffer.from(v.hex, 'hex');
}

export function newResult(statement: string, statementIndex: number): ResultSet {
  return { columns: [], rows: [], truncated: false, statement, statementIndex, durationMs: 0 };
}

export function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

export const CANCELLED_CODE = 'CANCELLED';

export function cancelledFailure(statementIndex: number, partial: ResultSet[]): QueryFailure {
  return new QueryFailure({ message: 'Query cancelled', code: CANCELLED_CODE, statementIndex }, partial);
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}

/** UTF-16 index of the `cp`-th code point (servers count characters, JS strings count UTF-16 units). */
export function codePointsToIndex(text: string, cp: number): number {
  let index = 0;
  let count = 0;
  while (index < text.length && count < cp) {
    const code = text.charCodeAt(index);
    index += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
    count++;
  }
  return Math.min(index, text.length);
}

/** Offset of the start of 1-based `line` within `text` (clamped to the text). */
export function lineToOffset(text: string, line: number): number {
  let offset = 0;
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf('\n', offset);
    if (nl === -1) return offset;
    offset = nl + 1;
  }
  return offset;
}

/**
 * Run statements in order, collecting results. Stops at the first failure
 * (throwing QueryFailure with everything that completed) and before starting
 * a statement once the signal has fired.
 */
export async function runStatements<S extends StatementSpan>(
  statements: S[],
  opts: ExecuteOptions,
  runOne: (stmt: S, index: number) => Promise<ResultSet[]>,
  toError: (err: unknown, stmt: S, index: number) => QueryError
): Promise<ResultSet[]> {
  const results: ResultSet[] = [];
  for (let i = 0; i < statements.length; i++) {
    if (opts.signal?.aborted) throw cancelledFailure(i, results);
    try {
      results.push(...(await runOne(statements[i], i)));
    } catch (err) {
      const partial = err instanceof QueryFailure ? err.partial : [];
      // Whatever the engine said (57014, ECANCEL, 1317), a user cancel is reported one way.
      if (opts.signal?.aborted) throw cancelledFailure(i, [...results, ...partial]);
      if (err instanceof QueryFailure) throw new QueryFailure(err.error, [...results, ...partial]);
      throw new QueryFailure(toError(err, statements[i], i), results);
    }
  }
  return results;
}

/** Resolve with `promise`, or reject after `ms`; a late success is handed to `onLate` (to close it). */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string, onLate?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      reject(new Error(message));
    }, ms);
    promise.then(
      (value) => {
        if (done) onLate?.(value);
        else {
          done = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      (err: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** Best-effort close used during teardown: never throws, never waits longer than `ms`. */
export async function closeQuietly(fn: () => Promise<unknown>, ms = 3000): Promise<void> {
  try {
    await withTimeout(fn(), ms, 'close timed out');
  } catch {
    // Teardown errors are not actionable for the user.
  }
}
