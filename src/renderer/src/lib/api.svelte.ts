/**
 * Typed client for the main-process API (src/shared/api.ts). Import as `$lib/api.svelte`.
 *
 * Inside Electron it talks to the preload bridge. In a plain browser
 * (`pnpm dev:web`) it falls back to the in-memory mock backend in ./mock,
 * so the UI can be developed and screenshotted without Electron.
 */
import type {
  ApiErrorInfo,
  ApiEventName,
  ApiEvents,
  ApiMethod,
  ApiReq,
  ApiRes,
  ApiResult,
  PreloadBridge
} from '@shared/api';

export class ApiError extends Error {
  readonly code?: string;
  readonly details?: unknown;
  constructor(info: ApiErrorInfo) {
    super(info.message);
    this.name = 'ApiError';
    this.code = info.code;
    this.details = info.details;
  }
}

export const isElectron = typeof window !== 'undefined' && !!window.bridge;

let transportPromise: Promise<PreloadBridge> | null = null;

function transport(): Promise<PreloadBridge> {
  if (!transportPromise) {
    transportPromise = window.bridge
      ? Promise.resolve(window.bridge)
      : import('./mock').then((m) => m.createMockBridge());
  }
  return transportPromise;
}

type ReqArgs<K extends ApiMethod> = [ApiReq<K>] extends [void] ? [req?: undefined] : [req: ApiReq<K>];

/** Call a main-process method. Rejects with ApiError on failure. */
export async function call<K extends ApiMethod>(method: K, ...args: ReqArgs<K>): Promise<ApiRes<K>> {
  const t = await transport();
  // Svelte 5 $state proxies cannot cross structured clone; send a plain snapshot.
  const req = args[0] === undefined ? undefined : $state.snapshot(args[0]);
  const res = (await t.invoke(method, req)) as ApiResult<ApiRes<K>>;
  if (!res.ok) throw new ApiError(res.error);
  return res.data;
}

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();
let subscribed = false;

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  void transport().then((t) =>
    t.on((event, payload) => {
      for (const fn of listeners.get(event) ?? []) {
        try {
          fn(payload);
        } catch (err) {
          console.error(`[api] listener for ${event} failed`, err);
        }
      }
    })
  );
}

/** Subscribe to a main-process event. Returns an unsubscribe function. */
export function on<E extends ApiEventName>(event: E, fn: (payload: ApiEvents[E]) => void): () => void {
  ensureSubscribed();
  let set = listeners.get(event);
  if (!set) listeners.set(event, (set = new Set()));
  set.add(fn as Listener);
  return () => set.delete(fn as Listener);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
