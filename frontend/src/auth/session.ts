import type { Session } from '../api/types';
import { getRuntimeAccessToken, getRuntimeDeviceId } from './runtime';

/**
 * Dev-mode (`POST /dev/session`) session. In password mode tokens live in the
 * auth runtime/storage; `getAccessToken()` falls back to it so the API client
 * works in both modes.
 */
let accessToken: string | null = null;
let deviceId: string | null = null;
let session: Session | null = null;

export function getAccessToken(): string | null {
  return getRuntimeAccessToken() ?? accessToken;
}

export function getDeviceId(): string | null {
  return getRuntimeDeviceId() ?? deviceId;
}

export function getSession(): Session | null {
  return session;
}

export function setSession(next: Session): void {
  session = next;
  accessToken = next.access_token;
  deviceId = next.device.id;
}

export function clearSession(): void {
  session = null;
  accessToken = null;
  deviceId = null;
}

/** Test helper; production code never needs to drop the dev session. */
export function resetSessionForTests(): void {
  clearSession();
}
