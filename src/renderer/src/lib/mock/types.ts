import type { ApiEventName, ApiEvents, ApiMethod, ApiReq, ApiRes } from '@shared/api';

export interface MockContext {
  emit<E extends ApiEventName>(event: E, payload: ApiEvents[E]): void;
}

export type MockHandlers = {
  [K in ApiMethod]?: (req: ApiReq<K>, ctx: MockContext) => Promise<ApiRes<K>> | ApiRes<K>;
};
