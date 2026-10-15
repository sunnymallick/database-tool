import type { ApiEventName, ApiEvents, ApiMethod, ApiReq, ApiRes } from '@shared/api';

/**
 * Handler registration surface. Modules that register handlers receive a
 * Router instead of importing Electron, so they stay testable under plain Node.
 */
export interface Router {
  handle<K extends ApiMethod>(method: K, fn: (req: ApiReq<K>) => Promise<ApiRes<K>> | ApiRes<K>): void;
  emit<E extends ApiEventName>(event: E, payload: ApiEvents[E]): void;
}
