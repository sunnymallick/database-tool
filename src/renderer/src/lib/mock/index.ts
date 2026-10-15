/**
 * In-memory backend used when the renderer runs in a plain browser
 * (`pnpm dev:web`). Data handlers live in ./data.ts (workbench slice),
 * AI handlers in ./ai.ts (AI slice).
 */
import type { ApiMethod, PreloadBridge } from '@shared/api';
import { aiMock } from './ai';
import { dataMock } from './data';
import type { MockContext } from './types';

export function createMockBridge(): PreloadBridge {
  const listeners = new Set<(event: string, payload: unknown) => void>();
  const ctx: MockContext = {
    emit: (event, payload) => {
      setTimeout(() => listeners.forEach((l) => l(event, structuredClone(payload))), 0);
    }
  };
  const handlers = { ...dataMock, ...aiMock };
  console.info('[mock] running with the in-memory mock backend');
  return {
    platform: 'darwin',
    async invoke(method, req) {
      const fn = handlers[method as ApiMethod] as ((req: unknown, ctx: MockContext) => unknown) | undefined;
      if (!fn) return { ok: false, error: { message: `mock: not implemented: ${method}`, code: 'NO_HANDLER' } };
      await new Promise((r) => setTimeout(r, 30 + Math.random() * 90));
      try {
        return { ok: true, data: structuredClone(await fn(req, ctx)) };
      } catch (err) {
        return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
      }
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
