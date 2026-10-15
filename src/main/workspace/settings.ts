/**
 * settings.json: merged over DEFAULT_SETTINGS, validated and clamped on load
 * and on every update.
 */
import { DEFAULT_SETTINGS, type AppSettings, type ThemeMode } from '@shared/types';
import { AppError } from '../errors';
import { dataFile } from '../paths';
import { readJsonFile, writeJsonAtomic } from './json-file';

const THEMES: readonly ThemeMode[] = ['dark', 'light', 'system'];

/** Integer settings and their allowed range (values are clamped into it). */
const RANGES: Partial<Record<keyof AppSettings, [number, number]>> = {
  editorFontSize: [8, 32],
  rowCap: [10, 1_000_000],
  pageSize: [10, 10_000]
};

const BOOLEANS: (keyof AppSettings)[] = ['editorLineNumbers', 'editorWordWrap', 'confirmProductionWrites', 'aiAllowWrites'];
const STRINGS: (keyof AppSettings)[] = ['aiModel', 'claudeCliPath'];

/** Validate one setting; returns the clean value or throws with a message naming the setting. */
function cleanValue(key: keyof AppSettings, value: unknown): AppSettings[keyof AppSettings] {
  const range = RANGES[key];
  if (range) {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new AppError(`Setting "${key}" must be a number`, 'BAD_SETTING');
    return Math.min(range[1], Math.max(range[0], Math.round(n)));
  }
  if (BOOLEANS.includes(key)) {
    if (typeof value !== 'boolean') throw new AppError(`Setting "${key}" must be true or false`, 'BAD_SETTING');
    return value;
  }
  if (key === 'theme') {
    if (!THEMES.includes(value as ThemeMode)) throw new AppError(`Setting "theme" must be one of ${THEMES.join(', ')}`, 'BAD_SETTING');
    return value as ThemeMode;
  }
  if (STRINGS.includes(key)) {
    if (typeof value !== 'string') throw new AppError(`Setting "${key}" must be text`, 'BAD_SETTING');
    const s = value.trim();
    if (key === 'aiModel' && s === '') throw new AppError('Setting "aiModel" cannot be empty', 'BAD_SETTING');
    return s;
  }
  throw new AppError(`Unknown setting "${key}"`, 'BAD_SETTING');
}

const isKnownKey = (k: string): k is keyof AppSettings => Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, k);

/** Defaults overlaid with every valid stored value; invalid or unknown stored values are dropped. */
export function normalizeSettings(raw: unknown): AppSettings {
  const out: AppSettings = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!isKnownKey(k)) continue;
    try {
      Object.assign(out, { [k]: cleanValue(k, v) });
    } catch {
      // Keep the default for a value that no longer validates.
    }
  }
  return out;
}

export class SettingsStore {
  private cache: AppSettings | null = null;

  constructor(
    private readonly file: string = dataFile('settings.json'),
    private readonly onChange?: (settings: AppSettings) => void
  ) {}

  get(): AppSettings {
    if (!this.cache) this.cache = normalizeSettings(readJsonFile<unknown>(this.file, {}));
    return { ...this.cache };
  }

  /** Apply a partial update. Unknown keys and invalid values are rejected as a whole. */
  update(patch: Partial<AppSettings>): AppSettings {
    if (!patch || typeof patch !== 'object') throw new AppError('Settings update must be an object', 'BAD_SETTING');
    const next = this.get();
    for (const [k, v] of Object.entries(patch)) {
      if (!isKnownKey(k)) throw new AppError(`Unknown setting "${k}"`, 'BAD_SETTING');
      Object.assign(next, { [k]: cleanValue(k, v) });
    }
    writeJsonAtomic(this.file, next);
    this.cache = next;
    this.onChange?.({ ...next });
    return { ...next };
  }
}
