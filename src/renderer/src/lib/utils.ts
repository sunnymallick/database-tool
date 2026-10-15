import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge class names, letting later Tailwind classes override earlier ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function newId(): string {
  return crypto.randomUUID();
}

/** Trailing-edge debounce with `flush` (run now if pending) and `cancel`. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;
  const run = () => {
    timer = null;
    const args = pending;
    pending = null;
    if (args) fn(...args);
  };
  const debounced = (...args: A) => {
    pending = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  debounced.flush = () => {
    if (timer) clearTimeout(timer);
    run();
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  return debounced;
}

/** 12 ms, 1.24 s, 2m 05s */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

const numberFormat = new Intl.NumberFormat('en-US');

export function formatCount(n: number | null | undefined): string {
  return n == null ? '' : numberFormat.format(n);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** "just now", "5 min ago", "yesterday 14:02", "Mar 3 09:15" */
export function formatRelativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = now - t;
  if (diff < 45_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return `today ${time}`;
  const y = new Date(now - 86_400_000);
  if (d.toDateString() === y.toDateString()) return `yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Simple subsequence fuzzy match. Returns a score (higher is better) or -1. */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return 0;
  const t = target.toLowerCase();
  const direct = t.indexOf(q);
  if (direct !== -1) return 1000 - direct * 2 - (t.length - q.length) * 0.5 + (direct === 0 ? 200 : 0);
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx === -1) return -1;
    score += idx === prev + 1 ? 8 : 1;
    if (idx === 0 || /[._\s/-]/.test(t[idx - 1])) score += 6;
    prev = idx;
    ti = idx + 1;
  }
  return score - t.length * 0.1;
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

/** Element is a text field (so global shortcuts should leave keys alone). */
export function isTextInput(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'range', 'color'].includes(type);
  }
  return false;
}
