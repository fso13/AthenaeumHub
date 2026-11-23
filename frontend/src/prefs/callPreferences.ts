/**
 * #178: local, per-device call defaults and device choices.
 *
 * These are UI preferences only (no secrets): microphone/camera defaults and
 * the last selected device ids. Device permission itself always stays with the
 * browser prompt; this module never bypasses it.
 */
export interface CallPreferences {
  microphoneOnByDefault: boolean;
  cameraOnByDefault: boolean;
  microphoneDeviceId: string | null;
  cameraDeviceId: string | null;
}

const STORAGE_KEY = 'krug.calls.preferences';

export const DEFAULT_CALL_PREFERENCES: CallPreferences = {
  microphoneOnByDefault: true,
  cameraOnByDefault: true,
  microphoneDeviceId: null,
  cameraDeviceId: null,
};

function readRaw(): Partial<CallPreferences> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Partial<CallPreferences>)
      : {};
  } catch {
    return {};
  }
}

export function readCallPreferences(): CallPreferences {
  const raw = readRaw();
  return {
    microphoneOnByDefault:
      typeof raw.microphoneOnByDefault === 'boolean'
        ? raw.microphoneOnByDefault
        : DEFAULT_CALL_PREFERENCES.microphoneOnByDefault,
    cameraOnByDefault:
      typeof raw.cameraOnByDefault === 'boolean'
        ? raw.cameraOnByDefault
        : DEFAULT_CALL_PREFERENCES.cameraOnByDefault,
    microphoneDeviceId:
      typeof raw.microphoneDeviceId === 'string' && raw.microphoneDeviceId.length > 0
        ? raw.microphoneDeviceId
        : null,
    cameraDeviceId:
      typeof raw.cameraDeviceId === 'string' && raw.cameraDeviceId.length > 0
        ? raw.cameraDeviceId
        : null,
  };
}

export function writeCallPreferences(next: Partial<CallPreferences>): CallPreferences {
  const merged = { ...readCallPreferences(), ...next };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // Private mode/quota: preferences remain session-defaults only.
  }
  return merged;
}
