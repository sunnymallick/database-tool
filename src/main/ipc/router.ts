import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { EVENT_CHANNEL, INVOKE_CHANNEL, type ApiResult } from '@shared/api';
import { toErrorInfo } from '../errors';
import type { Router } from './types';

type AnyHandler = (req: unknown) => unknown;

const handlers = new Map<string, AnyHandler>();

export const router: Router = {
  handle(method, fn) {
    if (handlers.has(method)) throw new Error(`duplicate IPC handler: ${method}`);
    handlers.set(method, fn as AnyHandler);
  },
  emit(event, payload) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(EVENT_CHANNEL, event, payload);
    }
  }
};

/** Only our own window content may call into main. */
function trustedSender(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? '';
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  return url.startsWith('file://') || (!!devUrl && url.startsWith(devUrl));
}

export function installRouter(): void {
  ipcMain.handle(INVOKE_CHANNEL, async (e, method: string, req: unknown): Promise<ApiResult<unknown>> => {
    if (!trustedSender(e)) return { ok: false, error: { message: 'untrusted sender', code: 'FORBIDDEN' } };
    const fn = handlers.get(method);
    if (!fn) return { ok: false, error: { message: `not implemented: ${method}`, code: 'NO_HANDLER' } };
    try {
      return { ok: true, data: await fn(req) };
    } catch (err) {
      console.error(`[ipc] ${method} failed:`, err);
      return { ok: false, error: toErrorInfo(err) };
    }
  });
}
