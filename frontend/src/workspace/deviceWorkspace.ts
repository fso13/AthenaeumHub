/**
 * Per-device workspace selection (R-02 / FR-WS-2).
 *
 * The browser persists exactly one non-secret value: the id of the workspace the
 * user selected on this device. Tokens, emails, names and message data never go
 * here — auth material lives in `auth/storage.ts` (sessionStorage) and the
 * server always re-checks membership, so a forged id only falls back to the
 * server default.
 *
 * `scripts/check-security.mjs` allows `localStorage` in this module and in
 * `theme/themePreference.ts` (explicit light/dark choice) only. Keep the
 * surface to the workspace id.
 */
const WORKSPACE_ID_KEY = 'krug.workspace.id';
const MAX_ID_LENGTH = 64;

let memoryWorkspaceId: string | null = null;

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Returns the persisted id, or null when absent/invalid/unavailable. */
export function readDeviceWorkspaceId(): string | null {
  const store = storage();
  if (!store) return memoryWorkspaceId;
  try {
    const value = store.getItem(WORKSPACE_ID_KEY);
    if (!value || value.length > MAX_ID_LENGTH) return null;
    return value;
  } catch {
    return memoryWorkspaceId;
  }
}

/** Persist only the workspace id. Failures (private mode/quota) are non-fatal. */
export function writeDeviceWorkspaceId(workspaceId: string): void {
  if (!workspaceId || workspaceId.length > MAX_ID_LENGTH) return;
  memoryWorkspaceId = workspaceId;
  const store = storage();
  if (!store) return;
  try {
    store.setItem(WORKSPACE_ID_KEY, workspaceId);
  } catch {
    // The selection still works in memory for this tab.
  }
}

export function clearDeviceWorkspaceId(): void {
  memoryWorkspaceId = null;
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(WORKSPACE_ID_KEY);
  } catch {
    // ignore
  }
}

/** Test helper: localStorage survives between jsdom tests unless cleared. */
export function resetDeviceWorkspaceForTests(): void {
  clearDeviceWorkspaceId();
}
