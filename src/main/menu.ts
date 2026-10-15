import { app, Menu, type MenuItemConstructorOptions } from 'electron';
import type { MenuAction } from '@shared/types';

/**
 * Native application menu. App-specific items forward a MenuAction to the
 * renderer. Query shortcuts (run, format) are bound in the editor instead,
 * because macOS menu accelerators would swallow them before CodeMirror.
 */
export function buildMenu(send: (action: MenuAction) => void): void {
  const isMac = process.platform === 'darwin';
  const item = (label: string, action: MenuAction, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => send(action)
  });

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              item('Settings…', 'open-settings', 'CmdOrCtrl+,'),
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          } satisfies MenuItemConstructorOptions
        ]
      : []),
    {
      label: 'File',
      submenu: [
        item('New Query Tab', 'new-query', 'CmdOrCtrl+T'),
        item('New Connection…', 'new-connection', 'CmdOrCtrl+Shift+N'),
        { type: 'separator' },
        item('Open SQL File…', 'open-sql-file', 'CmdOrCtrl+O'),
        item('Save', 'save-sql-file', 'CmdOrCtrl+S'),
        item('Save As…', 'save-sql-file-as', 'CmdOrCtrl+Shift+S'),
        { type: 'separator' },
        item('Close Tab', 'close-tab', 'CmdOrCtrl+W'),
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
        ...(isMac ? [] : ([{ type: 'separator' }, { role: 'quit' }] satisfies MenuItemConstructorOptions[]))
      ]
    },
    { role: 'editMenu' },
    {
      label: 'Query',
      submenu: [item('Run Statement', 'run-query'), item('Format SQL', 'format-sql')]
    },
    {
      label: 'View',
      submenu: [
        item('Command Palette…', 'command-palette', 'CmdOrCtrl+K'),
        item('Toggle Sidebar', 'toggle-sidebar', 'CmdOrCtrl+B'),
        item('Toggle AI Assistant', 'toggle-ai', 'CmdOrCtrl+Shift+A'),
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' },
    { role: 'help', submenu: [item('Keyboard Shortcuts', 'show-shortcuts')] }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
