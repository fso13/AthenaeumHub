import type { AuthMode } from '../config/env';
import { clearAuthStorage, getStoredDeviceId, readAuthSession, setStoredDeviceId } from './storage';

/**
 * Module-level auth runtime shared by the API client (which is not a React
 * component). Tokens stay in memory; the sessionStorage fallback is only used
 * to survive page reloads (AUTH-D-06). In password mode the stored session is
 * the source of truth after a reload.
 */
let mode: AuthMode = 'dev';
let memoryToken: string | null = null;
let memoryDeviceId: string | null = null;

export function configureAuthRuntime(next: { mode: AuthMode }): void {
  mode = next.mode;
  memoryToken = null;
  memoryDeviceId = null;
}

export function getAuthRuntimeMode(): AuthMode {
  return mode;
}

export function getRuntimeAccessToken(): string | null {
  if (mode !== 'password') return null;
  return memoryToken ?? readAuthSession()?.accessToken ?? null;
}

export function setRuntimeAccessToken(token: string | null): void {
  memoryToken = token;
}

export function getRuntimeDeviceId(): string | null {
  if (mode !== 'password') return null;
  return memoryDeviceId ?? getStoredDeviceId();
}

export function setRuntimeDeviceId(deviceId: string): void {
  memoryDeviceId = deviceId;
  setStoredDeviceId(deviceId);
}

/**
 * Clears tokens, pending verification and device id, then awaits the account
 * E2EE wipe. The provider calls this on logout/account switch before
 * navigating; `clearAuthStorage()` itself is async because the IndexedDB wipe
 * cannot be synchronous.
 */
export async function clearRuntimeAuth(
  scope: { readonly userId?: string | null } = {},
): Promise<void> {
  memoryToken = null;
  memoryDeviceId = null;
  await clearAuthStorage({ userId: scope.userId ?? null });
}

/** Test-only reset; does not clear the whole browser session. */
export function resetAuthRuntimeForTests(): void {
  mode = 'dev';
  memoryToken = null;
  memoryDeviceId = null;
}
