/**
 * Keyboard helpers. Shortcuts are written CodeMirror-style: `Mod-Shift-Enter`,
 * where `Mod` is Cmd on macOS and Ctrl elsewhere.
 */

export const isMac =
  typeof navigator !== 'undefined' &&
  (/Mac|iPhone|iPad/.test(navigator.platform) || (typeof window !== 'undefined' && window.bridge?.platform === 'darwin'));

const MAC_SYMBOLS: Record<string, string> = {
  Mod: '⌘',
  Cmd: '⌘',
  Ctrl: '⌃',
  Alt: '⌥',
  Shift: '⇧',
  Enter: '↵',
  Backspace: '⌫',
  Delete: '⌦',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Tab: '⇥',
  Space: 'Space'
};

const OTHER_NAMES: Record<string, string> = {
  Mod: 'Ctrl',
  Cmd: 'Ctrl',
  Enter: 'Enter',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→'
};

/** Split a shortcut into display keys, e.g. `Mod-Shift-f` -> ['⇧', '⌘', 'F'] on macOS. */
export function shortcutKeys(shortcut: string): string[] {
  const parts = shortcut.split(/-(?!$)/);
  const key = parts.pop() ?? '';
  const mods = parts;
  const order = isMac ? ['Ctrl', 'Alt', 'Shift', 'Mod', 'Cmd'] : ['Mod', 'Ctrl', 'Alt', 'Shift', 'Cmd'];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const names = isMac ? MAC_SYMBOLS : OTHER_NAMES;
  const keyLabel = names[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  return [...mods.map((m) => names[m] ?? m), keyLabel];
}

/** Human-readable shortcut text: `⇧⌘F` on macOS, `Ctrl+Shift+F` elsewhere. */
export function formatShortcut(shortcut: string): string {
  const keys = shortcutKeys(shortcut);
  return isMac ? keys.join('') : keys.join('+');
}

/** True when the keyboard event matches the shortcut exactly (modifiers included). */
export function matchesShortcut(e: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.split(/-(?!$)/);
  const key = parts.pop() ?? '';
  // Off macOS, Ctrl and Mod are the same key.
  const want = new Set(isMac ? parts : parts.map((p) => (p === 'Ctrl' ? 'Mod' : p)));
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (want.has('Mod') !== mod) return false;
  if (want.has('Shift') !== e.shiftKey) return false;
  if (want.has('Alt') !== e.altKey) return false;
  if (isMac && want.has('Ctrl') !== e.ctrlKey) return false;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const target = key.length === 1 ? key.toLowerCase() : key;
  if (k === target) return true;
  // Shifted punctuation and Alt-modified letters: fall back to the physical key.
  if (key.length === 1 && /[a-z0-9]/i.test(key)) return e.code === `Key${key.toUpperCase()}` || e.code === `Digit${key}`;
  const codes: Record<string, string> = { '/': 'Slash', ',': 'Comma', '[': 'BracketLeft', ']': 'BracketRight', '.': 'Period' };
  return codes[key] !== undefined && e.code === codes[key];
}
