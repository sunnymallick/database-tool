import type { PreloadBridge } from '../shared/api';

declare global {
  interface Window {
    /** Present inside Electron; absent in the browser-only dev mode (the mock backend is used instead). */
    bridge?: PreloadBridge;
  }
}

export {};
