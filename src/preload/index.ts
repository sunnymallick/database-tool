import { contextBridge, ipcRenderer } from 'electron';
import { EVENT_CHANNEL, INVOKE_CHANNEL, type PreloadBridge } from '@shared/api';

const bridge: PreloadBridge = {
  invoke: (method, req) => ipcRenderer.invoke(INVOKE_CHANNEL, method, req),
  on: (listener) => {
    const wrapped = (_e: Electron.IpcRendererEvent, event: string, payload: unknown) => listener(event, payload);
    ipcRenderer.on(EVENT_CHANNEL, wrapped);
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, wrapped);
  },
  platform: process.platform
};

contextBridge.exposeInMainWorld('bridge', bridge);
