import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { createApi } from '../api/endpoints';
import { createE2eeDeviceApi } from '../api/e2eeDeviceApi';
import { ApiClient } from '../api/http';
import { getAccessToken, getDeviceId } from '../auth/session';
import { configureAuthRuntime } from '../auth/runtime';
import type { AppConfig } from '../config/env';
import { createMockRealtimeSocketFactory } from '../mocks/realtime';
import { createChatStore, type ChatStore } from '../store/chatStore';
import type { E2eeBridge } from '../e2ee/app/chatBridge';
import { mockDb } from './server';

export const testConfig: AppConfig = {
  apiBaseUrl: 'http://api.test/api/v1',
  useMocks: true,
  devSession: true,
  authMode: 'dev',
  deviceName: 'Сова — тест',
  appVersion: '0.1.0',
  requestTimeoutMs: 5_000,
  historyPageSize: 30,
  readReceiptDebounceMs: 30,
  syncIntervalMs: 600_000,
  // Existing F-01/F-04 suites stay deterministic. E3 suites opt in explicitly
  // and inject the mock/fake WebSocket factory.
  realtimeEnabled: false,
  wsUrl: '',
  realtimeHeartbeatMs: 25_000,
  realtimeTimeoutMs: 60_000,
  realtimeMaxPerHour: 60,
  typingTtlMs: 5_000,
  presenceTtlMs: 60_000,
  webrtcIceServers: [],
  uploadMaxFileBytes: 2 * 1024 * 1024 * 1024,
  uploadPartConcurrency: 3,
  uploadPartTimeoutMs: 60_000,
  uploadScanPollMs: 20,
  uploadScanTimeoutMs: 5_000,
};

export function createTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...testConfig, ...overrides };
}

export interface TestE2eeOptions {
  readonly enabled: boolean;
  readonly bridge: E2eeBridge;
}

export interface TestCallOptions {
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'>;
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
}

export function createTestStore(
  config: AppConfig,
  e2ee: TestE2eeOptions | null = null,
  calls: TestCallOptions = {},
): ChatStore {
  configureAuthRuntime({ mode: config.authMode });
  const client = new ApiClient({
    baseUrl: config.apiBaseUrl,
    timeoutMs: config.requestTimeoutMs,
    getToken: getAccessToken,
    getDeviceId,
  });
  return createChatStore({
    api: createApi(client, config),
    config,
    socketFactory: config.realtimeEnabled ? createMockRealtimeSocketFactory(mockDb) : undefined,
    e2eeDevice: createE2eeDeviceApi(client),
    // Existing suites stay on the legacy path; E2EE suites opt in explicitly.
    e2eeEnabled: e2ee?.enabled ?? false,
    e2eeBridge: e2ee?.bridge,
    callMediaDevices: calls.mediaDevices,
    callCreatePeerConnection: calls.createPeerConnection,
  });
}

export function renderApp(
  overrides: Partial<AppConfig> = {},
  e2ee: TestE2eeOptions | null = null,
  calls: TestCallOptions = {},
) {
  const config = createTestConfig(overrides);
  const store = createTestStore(config, e2ee, calls);
  const user = userEvent.setup();
  const result = render(<App store={store} config={config} />);
  return { ...result, store, user, config };
}

export function createPasswordConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return createTestConfig({
    ...overrides,
    authMode: 'password',
    devSession: false,
  });
}

/** Auth BFF (password) render used by the auth RTL suite; MSW serves `/auth/*`. */
export function renderPasswordApp(overrides: Partial<AppConfig> = {}) {
  const config = createPasswordConfig(overrides);
  const store = createTestStore(config);
  const user = userEvent.setup();
  const result = render(<App store={store} config={config} />);
  return { ...result, store, user, config };
}
