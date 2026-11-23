/**
 * Non-secret per-device UI preferences (#107).
 *
 * The only value stored here is the call output volume (0..100). It lives in
 * localStorage because it must survive a reload on this device; it is never
 * sent to the server, never contains a token and is not tied to an account.
 * Failures (private mode, quota, disabled storage) fall back to an in-memory
 * value for the current tab instead of breaking the call UI.
 *
 * `scripts/check-security.mjs` allowlists `localStorage` in this module.
 */
const CALL_OUTPUT_VOLUME_KEY = 'krug.calls.output.volume';
export const DEFAULT_CALL_OUTPUT_VOLUME = 100;
const MIN_VOLUME = 0;
const MAX_VOLUME = 100;

let memoryVolume: number | null = null;

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Integer 0..100; anything malformed falls back to the default. */
export function normalizeOutputVolume(value: unknown): number {
  const numeric = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) {
    return DEFAULT_CALL_OUTPUT_VOLUME;
  }
  return Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, Math.round(numeric)));
}

/** Persisted volume for this device, or 100 when absent/unreadable. */
export function readCallOutputVolume(): number {
  const store = storage();
  if (!store) return memoryVolume ?? DEFAULT_CALL_OUTPUT_VOLUME;
  try {
    const raw = store.getItem(CALL_OUTPUT_VOLUME_KEY);
    if (raw === null) return memoryVolume ?? DEFAULT_CALL_OUTPUT_VOLUME;
    return normalizeOutputVolume(raw);
  } catch {
    return memoryVolume ?? DEFAULT_CALL_OUTPUT_VOLUME;
  }
}

/** Persist the user's explicit volume. Returns the normalized value. */
export function writeCallOutputVolume(value: number): number {
  const normalized = normalizeOutputVolume(value);
  memoryVolume = normalized;
  const store = storage();
  if (!store) return normalized;
  try {
    store.setItem(CALL_OUTPUT_VOLUME_KEY, String(normalized));
  } catch {
    // The setting still applies for the current tab.
  }
  return normalized;
}

/** Test helper: localStorage survives between jsdom tests unless cleared. */
export function resetCallOutputPreferencesForTests(): void {
  memoryVolume = null;
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(CALL_OUTPUT_VOLUME_KEY);
  } catch {
    // ignore
  }
}
