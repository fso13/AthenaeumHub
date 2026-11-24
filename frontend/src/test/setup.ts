import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { resetSessionForTests } from '../auth/session';
import { resetReauthForTests } from '../auth/reauth';
import { resetAuthRuntimeForTests } from '../auth/runtime';
import { clearAppStorage } from '../auth/storage';
import { resetPasswordAuthForTests } from '../auth/PasswordAuthProvider';
import { resetRouterForTests } from '../router/router';
import { resetThemeForTests } from '../theme/themePreference';
import { resetPinnedChatsForTests } from '../sidebar/pins';
import { resetDeviceWorkspaceForTests } from '../workspace/deviceWorkspace';
import { resetMockDb } from '../mocks/db';
import { resetMockRealtime } from '../mocks/realtime';
import { resetCallOutputPreferencesForTests } from '../prefs/devicePreferences';
import { resetLastChatForTests } from '../sidebar/lastChat';
import { mockDb, server } from './server';

let originalFetch: typeof fetch;

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });

  // jsdom exposes its own AbortSignal while MSW's fetch proxy delegates to
  // Node's fetch, which brand-checks the signal. Tests don't exercise aborts,
  // so we strip the signal for the MSW proxy only (production code keeps it).
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    originalFetch(input, init ? { ...init, signal: undefined } : init)) as typeof fetch;
});

beforeEach(() => {
  resetMockRealtime();
  resetMockDb(mockDb);
  resetSessionForTests();
  resetPasswordAuthForTests();
  resetAuthRuntimeForTests();
  resetReauthForTests();
  clearAppStorage();
  resetDeviceWorkspaceForTests();
  resetRouterForTests('/');
  resetThemeForTests();
  resetPinnedChatsForTests();
  resetCallOutputPreferencesForTests();
  resetLastChatForTests();
});

afterEach(() => {
  cleanup();
  resetMockRealtime();
  server.resetHandlers();
  server.events.removeAllListeners();
  vi.useRealTimers();
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  server.close();
});
