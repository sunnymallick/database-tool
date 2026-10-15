import type { ApiErrorInfo } from '@shared/api';

/** An error whose message is safe to show the user, with an optional machine-readable code. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function toErrorInfo(err: unknown): ApiErrorInfo {
  if (err instanceof AppError) return { message: err.message, code: err.code, details: err.details };
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return { message: err.message, code: typeof code === 'string' ? code : undefined };
  }
  return { message: String(err) };
}
