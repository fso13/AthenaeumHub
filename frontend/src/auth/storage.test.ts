import { describe, expect, it } from 'vitest';
import {
  clearAppStorage,
  clearAuthSession,
  clearAuthStorage,
  clearPendingVerification,
  getStoredDeviceId,
  readAuthSession,
  readPendingVerification,
  readStored,
  setStoredDeviceId,
  writeAuthSession,
  writePendingVerification,
  writeStored,
} from './storage';
import type { StoredAuthSession } from './types';

const SESSION: StoredAuthSession = {
  accessToken: 'access-token-value',
  expiresAt: 1_900_000_000_000,
  user: {
    id: '11111111-1111-4111-8111-111111111111',
    displayName: 'Дмитрий Крылов',
    email: 'dmitry@example.test',
  },
};

describe('auth storage', () => {
  it('round-trips the Auth BFF session through sessionStorage only', () => {
    writeAuthSession(SESSION);

    expect(readAuthSession()).toEqual(SESSION);
    expect(readStored('krug.auth.session')).toBe(JSON.stringify(SESSION));
  });

  it('rejects malformed or incomplete stored sessions instead of trusting them', () => {
    writeStored('krug.auth.session', '{not-json');
    expect(readAuthSession()).toBeNull();

    writeStored('krug.auth.session', JSON.stringify({ accessToken: 'a', expiresAt: 1 }));
    expect(readAuthSession()).toBeNull();

    writeStored('krug.auth.session', JSON.stringify({ ...SESSION, accessToken: '' }));
    expect(readAuthSession()).toBeNull();
  });

  it('purges a legacy stored refresh token left by an older build (#103)', () => {
    writeStored(
      'krug.auth.session',
      JSON.stringify({ ...SESSION, refreshToken: 'legacy-refresh-token' }),
    );

    expect(readAuthSession()).toBeNull();
    expect(readStored('krug.auth.session')).toBeNull();
  });

  it('round-trips a pending verification without a code or password', () => {
    writePendingVerification({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      email: 'pending@example.test',
      expiresAt: 1_900_000_000_000,
      resendUntil: 1_800_000_000_000,
    });

    expect(readPendingVerification()).toEqual({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      email: 'pending@example.test',
      expiresAt: 1_900_000_000_000,
      resendUntil: 1_800_000_000_000,
    });
    expect(readStored('krug.auth.pending')).not.toContain('123456');
    expect(readStored('krug.auth.pending')).not.toContain('password');
  });

  it('clears only namespaced app state', () => {
    setStoredDeviceId('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    writeAuthSession(SESSION);
    writePendingVerification({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      email: 'pending@example.test',
      expiresAt: null,
      resendUntil: 0,
    });
    writeStored('other.key', 'keep-me');

    clearAppStorage();

    expect(getStoredDeviceId()).toBeNull();
    expect(readAuthSession()).toBeNull();
    expect(readPendingVerification()).toBeNull();
    expect(readStored('other.key')).toBe('keep-me');
  });

  it('clearAuthStorage removes tokens, pending verification and the device id', async () => {
    setStoredDeviceId('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    writeAuthSession(SESSION);
    writePendingVerification({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      email: 'pending@example.test',
      expiresAt: null,
      resendUntil: 0,
    });

    await clearAuthStorage({ userId: SESSION.user.id });

    expect(readAuthSession()).toBeNull();
    expect(readPendingVerification()).toBeNull();
    expect(getStoredDeviceId()).toBeNull();
  });

  it('clearAuthSession/clearPendingVerification are idempotent', () => {
    clearAuthSession();
    clearPendingVerification();
    clearAuthSession();
    expect(readAuthSession()).toBeNull();
    expect(readPendingVerification()).toBeNull();
  });
});
