/**
 * D1-FE1: per-device light/dark preference.
 *
 * This is UI-only, non-secret state (a single `light`/`dark` string). It lives
 * next to the workspace id because that is the only other device preference;
 * tokens, user data and message content never go to localStorage. The server
 * remains authoritative for everything else.
 *
 * `scripts/check-security.mjs` allowlists `localStorage` in this module and in
 * `workspace/deviceWorkspace.ts`.
 */
export type Theme = 'light' | 'dark';

const THEME_KEY = 'krug.theme';

let memoryTheme: Theme | null = null;

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

/** Persisted explicit choice, or null when the OS preference should win. */
export function readThemePreference(): Theme | null {
  const store = storage();
  if (!store) return memoryTheme;
  try {
    const value = store.getItem(THEME_KEY);
    return isTheme(value) ? value : null;
  } catch {
    return memoryTheme;
  }
}

/** Persist the user's explicit choice. Failures are non-fatal. */
export function writeThemePreference(theme: Theme): void {
  memoryTheme = theme;
  const store = storage();
  if (!store) return;
  try {
    store.setItem(THEME_KEY, theme);
  } catch {
    // The choice still works for the current tab.
  }
}

export function clearThemePreference(): void {
  memoryTheme = null;
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(THEME_KEY);
  } catch {
    // ignore
  }
}

/** Resolve the OS preference; SSR/jsdom without matchMedia defaults to light. */
export function systemTheme(): Theme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function resolveTheme(preference: Theme | null): Theme {
  return preference ?? systemTheme();
}

/** Test helper: localStorage/dataset survive between jsdom tests otherwise. */
export function resetThemeForTests(): void {
  clearThemePreference();
  if (typeof document !== 'undefined') {
    delete document.documentElement.dataset.theme;
    document.documentElement.style.colorScheme = '';
  }
}
