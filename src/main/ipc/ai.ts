/**
 * OWNER: AI slice. Registers ai.* handlers. Must not import 'electron'.
 */
import { AgentSdkProvider } from '../ai/agent-sdk';
import type { AiProvider } from '../ai/provider';
import { AiSessionManager } from '../ai/sessions';
import type { DataServices } from '../services';
import type { Router } from './types';

let manager: AiSessionManager | null = null;

export function registerAiHandlers(router: Router, services: DataServices, provider?: AiProvider): AiSessionManager {
  const sessions = new AiSessionManager(provider ?? new AgentSdkProvider(services), (event) =>
    router.emit('ai.event', event)
  );
  manager = sessions;

  router.handle('ai.status', (req) => sessions.status(!!req?.refresh));
  router.handle('ai.send', (req) => sessions.send(req));
  router.handle('ai.approve', (req) => sessions.approve(req));
  router.handle('ai.cancel', (req) => sessions.cancel(req.sessionId));
  router.handle('ai.reset', (req) => sessions.reset(req.sessionId));
  return sessions;
}

/** Stop every running turn (their CLI subprocesses exit). Call on app quit. */
export function shutdownAi(): void {
  manager?.shutdown();
}
