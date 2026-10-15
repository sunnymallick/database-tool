import { app, BrowserWindow, shell } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerIpc, router } from './ipc';
import { shutdownAi } from './ipc/ai';
import { buildMenu } from './menu';
import type { DataServices } from './services';

const here = dirname(fileURLToPath(import.meta.url));
let services: DataServices | null = null;

// Chromium's profile folder also holds the single-instance lock. Give dev
// builds and isolated test runs their own, so they can run next to the
// installed app instead of quitting immediately.
if (process.env.DATABASE_TOOL_HOME) app.setPath('userData', join(process.env.DATABASE_TOOL_HOME, 'electron'));
else if (!app.isPackaged) app.setPath('userData', join(app.getPath('appData'), 'Database Tool Dev'));

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Database Tool',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 13 },
    backgroundColor: '#0d1017',
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  win.once('ready-to-show', () => win.show());

  // Never open content windows; send http(s) links to the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(here, '../renderer/index.html'));
  return win;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    services = registerIpc();
    buildMenu((action) => router.emit('menu', action));
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Close database connections before exiting.
  let shuttingDown = false;
  app.on('before-quit', (e) => {
    if (shuttingDown || !services) return;
    e.preventDefault();
    shuttingDown = true;
    shutdownAi();
    const done = () => app.quit();
    Promise.race([services.shutdown(), new Promise((r) => setTimeout(r, 3000))]).then(done, done);
  });
}
