import { clearE2eeAccountStateOnLogout } from '../e2ee/account/logout';
import type { StoredAuthSession, StoredPendingVerification } from './types';

/**
 * AUTH-D-06 / #103: the SPA keeps only the short-lived access token and the
 * user projection in sessionStorage; the refresh token is an HttpOnly cookie
 * and never reaches JavaScript (so it is never persisted here). localStorage is
 * never used for auth material (only the non-secret workspace id lives in
 * `workspace/deviceWorkspace.ts`). This is the only module allowed to touch
 * sessionStorage; scripts/check-security.mjs enforces that allow-list.
 * Passwords, email codes and refresh tokens are never persisted here.
 *
 * Keys are namespaced with `krug.` so logout can clear only app state.
 */
const ROOT_PREFIX = 'krug.';
const DEVICE_ID_KEY = 'krug.device.id';
const PENDING_DEVICE_KEY = 'krug.device.pending-key';
const PENDING_WORKSPACE_KEY = 'krug.workspace.pending-key';
const AUTH_SESSION_KEY = 'krug.auth.session';
const AUTH_PENDING_KEY = 'krug.auth.pending';
const REMEMBERED_EMAIL_KEY = 'krug.auth.remembered-email';

let fallbackStorage: Storage | null = null;

function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  const storage = {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
  return storage as Storage;
}

function memoryStorage(): Storage {
  fallbackStorage ??= createMemoryStorage();
  return fallbackStorage;
}

/** Session storage with a safe fallback for non-browser/jsdom edge cases. */
export function sessionStore(): Storage {
  if (typeof window === 'undefined') return memoryStorage();
  try {
    return window.sessionStorage;
  } catch {
    return memoryStorage();
  }
}

export function readStored(key: string): string | null {
  try {
    return sessionStore().getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    sessionStore().setItem(key, value);
  } catch {
    // A full/quota/private-mode storage must not break authentication in memory.
  }
}

export function removeStored(key: string): void {
  try {
    sessionStore().removeItem(key);
  } catch {
    // ignore
  }
}

function isStoredAuthSession(value: unknown): value is StoredAuthSession {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const user = candidate.user as Record<string, unknown> | undefined;
  return (
    typeof candidate.accessToken === 'string' &&
    candidate.accessToken.length > 0 &&
    typeof candidate.expiresAt === 'number' &&
    Number.isFinite(candidate.expiresAt) &&
    typeof user === 'object' &&
    user !== null &&
    typeof user.id === 'string' &&
    user.id.length > 0 &&
    typeof user.displayName === 'string' &&
    typeof user.email === 'string'
  );
}

export function writeAuthSession(session: StoredAuthSession): void {
  writeStored(AUTH_SESSION_KEY, JSON.stringify(session));
}

export function readAuthSession(): StoredAuthSession | null {
  const raw = readStored(AUTH_SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    // #103 migration: a session written by an older build may still contain a
    // refresh token. It must be purged immediately rather than left readable in
    // sessionStorage; the cookie is the only refresh-token carrier now.
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Object.prototype.hasOwnProperty.call(parsed, 'refreshToken')
    ) {
      clearAuthSession();
      return null;
    }
    return isStoredAuthSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearAuthSession(): void {
  removeStored(AUTH_SESSION_KEY);
}

/** Non-secret login convenience: only the email, only sessionStorage. */
export function readRememberedEmail(): string | null {
  const email = readStored(REMEMBERED_EMAIL_KEY)?.trim() ?? '';
  return email.length > 0 && email.length <= 254 ? email : null;
}

export function writeRememberedEmail(email: string): void {
  const normalized = email.trim();
  if (normalized.length === 0 || normalized.length > 254) return;
  writeStored(REMEMBERED_EMAIL_KEY, normalized);
}

export function clearRememberedEmail(): void {
  removeStored(REMEMBERED_EMAIL_KEY);
}

function isStoredPendingVerification(value: unknown): value is StoredPendingVerification {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.email === 'string' &&
    candidate.email.length > 0 &&
    (candidate.expiresAt === null ||
      (typeof candidate.expiresAt === 'number' && Number.isFinite(candidate.expiresAt))) &&
    typeof candidate.resendUntil === 'number' &&
    Number.isFinite(candidate.resendUntil)
  );
}

export function writePendingVerification(pending: StoredPendingVerification): void {
  writeStored(AUTH_PENDING_KEY, JSON.stringify(pending));
}

export function readPendingVerification(): StoredPendingVerification | null {
  const raw = readStored(AUTH_PENDING_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isStoredPendingVerification(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearPendingVerification(): void {
  removeStored(AUTH_PENDING_KEY);
}

export function getStoredDeviceId(): string | null {
  return readStored(DEVICE_ID_KEY);
}

export function setStoredDeviceId(deviceId: string): void {
  writeStored(DEVICE_ID_KEY, deviceId);
}

export function getPendingDeviceKey(): string | null {
  return readStored(PENDING_DEVICE_KEY);
}

export function setPendingDeviceKey(key: string): void {
  writeStored(PENDING_DEVICE_KEY, key);
}

export function clearPendingDeviceKey(): void {
  removeStored(PENDING_DEVICE_KEY);
}

export function getPendingWorkspaceKey(): string | null {
  return readStored(PENDING_WORKSPACE_KEY);
}

export function setPendingWorkspaceKey(key: string): void {
  writeStored(PENDING_WORKSPACE_KEY, key);
}

export function clearPendingWorkspaceKey(): void {
  removeStored(PENDING_WORKSPACE_KEY);
}

export function clearAppStorage(): void {
  try {
    const storage = sessionStore();
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(ROOT_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // ignore
  }
}

/**
 * Production logout cleanup. Clears the session-scoped auth material first,
 * then wipes the **current account/device** E2EE IndexedDB state through the
 * CR1b P1-04 / E7-F5F hook. The device id must be captured before
 * `DEVICE_ID_KEY` is removed; the user id comes from the auth provider.
 * The E2EE step is best-effort inside the hook so logout cannot be blocked by a
 * broken/absent IndexedDB.
 */
export async function clearAuthStorage(
  scope: { readonly userId?: string | null; readonly deviceId?: string | null } = {},
): Promise<void> {
  const deviceId = scope.deviceId ?? getStoredDeviceId();
  clearAppStorage();
  await clearE2eeAccountStateOnLogout({ userId: scope.userId ?? null, deviceId });
}
