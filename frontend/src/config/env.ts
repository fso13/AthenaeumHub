/**
 * Runtime configuration. Only VITE_* variables are exposed to the browser.
 * Access/refresh tokens are intentionally NOT part of the configuration: they
 * live in memory/sessionStorage scoped to the auth module (see auth/storage.ts).
 */

/**
 * `dev` keeps the F-01 `POST /dev/session` fallback and renders the chat
 * without a login screen. `password` is the Auth BFF flow: the browser talks
 * only to `/api/v1/auth/*` (login/register/verify/refresh/logout) and never to
 * Keycloak. There is no OIDC redirect/callback in either mode.
 */
export type AuthMode = 'dev' | 'password';

export interface AppConfig {
  /** e.g. "http://localhost:8081/api/v1" or "/api/v1" */
  apiBaseUrl: string;
  /** MSW contract mocks instead of the real backend. */
  useMocks: boolean;
  /** Call POST /dev/session on boot and on 401 (dev backend profile). */
  devSession: boolean;
  /** dev = F-01 /dev/session fallback; password = Auth BFF email+password forms. */
  authMode: AuthMode;
  /** Human-readable device name for POST /devices. */
  deviceName: string;
  /** app_version sent to POST /devices (contract maxLength 40). */
  appVersion: string;
  /** REST timeout from SYSTEM-ANALYSIS §7.1. */
  requestTimeoutMs: number;
  /** Page size for history requests (contract limit: 1..100). */
  historyPageSize: number;
  /** Debounce before POST /read. */
  readReceiptDebounceMs: number;
  /** Background sync interval while the tab is visible. */
  syncIntervalMs: number;
  /** E3 WebSocket client. `VITE_WS_URL` overrides the ticket `ws_url`. */
  realtimeEnabled: boolean;
  /** `''` → use `ticket.ws_url` (dev loopback is mapped to the Vite `/ws` proxy). */
  wsUrl: string;
  /** Client ping interval; server sends `heartbeat_ms` in `hello` (25 s default). */
  realtimeHeartbeatMs: number;
  /** No frame/pong within this window → close and reconnect (server timeout 60 s). */
  realtimeTimeoutMs: number;
  /** Contract §7.5: at most 60 reconnect attempts per hour. */
  realtimeMaxPerHour: number;
  /** Ephemeral `typing` TTL when the server frame has no `expires_at`. */
  typingTtlMs: number;
  /** Ephemeral `presence` TTL (contract: 60 s, not persisted). */
  presenceTtlMs: number;
  /**
   * WebRTC ICE servers for 1:1 calls. Empty by default: no third-party STUN is
   * contacted, so only host candidates are gathered. `VITE_WEBRTC_ICE_SERVERS`
   * is a comma/space separated URL list (`stun:`, `stuns:`, `turn:`, `turns:`).
   * No TURN is deployed in the MVP; see frontend/CALLS-REPORT.md.
   */
  webrtcIceServers: RTCIceServer[];

  /** Client-side web cap from SYSTEM-ANALYSIS §12.1 (desktop v1 is 10 GiB). */
  uploadMaxFileBytes: number;
  /** Analysis §12.4: 3 parts per device in flight. */
  uploadPartConcurrency: number;
  /** Per-part request timeout (analysis: 60 s). */
  uploadPartTimeoutMs: number;
  /** Poll cadence while the upload is SCANNING (managed AV). */
  uploadScanPollMs: number;
  /** Give up polling after this long; the scan job itself may still finish. */
  uploadScanTimeoutMs: number;
}

function readString(value: string | boolean | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/**
 * `VITE_WEBRTC_ICE_SERVERS` accepts a comma/whitespace separated URL list.
 * Invalid schemes are ignored instead of being passed to RTCPeerConnection,
 * which would throw during call setup. Empty → no STUN/TURN at all.
 */
export function parseIceServers(value: string | boolean | undefined): RTCIceServer[] {
  if (typeof value !== 'string' || value.trim() === '') return [];
  const servers: RTCIceServer[] = [];
  for (const entry of value.split(/[,\s]+/)) {
    const urls = entry.trim();
    if (!/^(?:stun|stuns|turn|turns):/i.test(urls)) continue;
    servers.push({ urls });
  }
  return servers;
}

export function resolveConfig(env: Record<string, string | boolean | undefined>): AppConfig {
  const useMocks = readBoolean(
    typeof env.VITE_USE_MOCKS === 'string' ? env.VITE_USE_MOCKS : undefined,
    Boolean(env.DEV),
  );
  const explicitBase = readString(env.VITE_API_BASE_URL);
  const apiBaseUrl = explicitBase || (useMocks ? '/api/v1' : 'http://localhost:8081/api/v1');
  const authMode: AuthMode =
    readString(env.VITE_AUTH_MODE).toLowerCase() === 'password' ? 'password' : 'dev';

  return {
    apiBaseUrl,
    useMocks,
    devSession: readBoolean(
      typeof env.VITE_DEV_SESSION === 'string' ? env.VITE_DEV_SESSION : undefined,
      true,
    ),
    authMode,
    deviceName: readString(env.VITE_DEVICE_NAME) || 'Сова — браузер',
    appVersion: readString(env.VITE_APP_VERSION) || '0.1.0',
    requestTimeoutMs: 10_000,
    historyPageSize: 30,
    readReceiptDebounceMs: 700,
    syncIntervalMs: 30_000,
    realtimeEnabled: readBoolean(
      typeof env.VITE_REALTIME_ENABLED === 'string' ? env.VITE_REALTIME_ENABLED : undefined,
      true,
    ),
    wsUrl: readString(env.VITE_WS_URL),
    realtimeHeartbeatMs: 25_000,
    realtimeTimeoutMs: 60_000,
    realtimeMaxPerHour: 60,
    typingTtlMs: 5_000,
    presenceTtlMs: 60_000,
    webrtcIceServers: parseIceServers(env.VITE_WEBRTC_ICE_SERVERS),
    uploadMaxFileBytes: 2 * 1024 * 1024 * 1024,
    uploadPartConcurrency: 3,
    uploadPartTimeoutMs: 60_000,
    uploadScanPollMs: 2_000,
    uploadScanTimeoutMs: 60_000,
  };
}

export const defaultConfig: AppConfig = resolveConfig(
  import.meta.env as unknown as Record<string, string | boolean | undefined>,
);
