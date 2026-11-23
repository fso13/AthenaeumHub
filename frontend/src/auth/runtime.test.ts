import { describe, expect, it } from 'vitest';
import {
  clearRuntimeAuth,
  configureAuthRuntime,
  getRuntimeAccessToken,
  getRuntimeDeviceId,
  resetAuthRuntimeForTests,
  setRuntimeAccessToken,
  setRuntimeDeviceId,
} from './runtime';
import { readAuthSession, writeAuthSession } from './storage';

const SESSION = {
  accessToken: 'stored-access-token',
  expiresAt: Date.now() + 60_000,
  user: {
    id: '11111111-1111-4111-8111-111111111111',
    displayName: 'Дмитрий Крылов',
    email: 'dmitry@example.test',
  },
};

describe('auth runtime', () => {
  it('ignores stored tokens in dev mode', () => {
    writeAuthSession(SESSION);
    configureAuthRuntime({ mode: 'dev' });

    expect(getRuntimeAccessToken()).toBeNull();
    expect(getRuntimeDeviceId()).toBeNull();
  });

  it('reads the persisted session in password mode and prefers the memory token', () => {
    writeAuthSession(SESSION);
    configureAuthRuntime({ mode: 'password' });

    expect(getRuntimeAccessToken()).toBe('stored-access-token');

    setRuntimeAccessToken('fresh-access-token');
    expect(getRuntimeAccessToken()).toBe('fresh-access-token');

    setRuntimeAccessToken(null);
    expect(getRuntimeAccessToken()).toBe('stored-access-token');
  });

  it('persists the device id in password mode only', () => {
    configureAuthRuntime({ mode: 'password' });
    setRuntimeDeviceId('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    expect(getRuntimeDeviceId()).toBe('dddddddd-dddd-4ddd-8ddd-dddddddddddd');

    resetAuthRuntimeForTests();
    expect(getRuntimeDeviceId()).toBeNull();
    configureAuthRuntime({ mode: 'password' });
    expect(getRuntimeDeviceId()).toBe('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  });

  it('clearRuntimeAuth drops tokens and persisted session', async () => {
    configureAuthRuntime({ mode: 'password' });
    writeAuthSession(SESSION);
    setRuntimeAccessToken('fresh-access-token');

    await clearRuntimeAuth({ userId: SESSION.user.id });

    expect(getRuntimeAccessToken()).toBeNull();
    expect(readAuthSession()).toBeNull();
  });
});
