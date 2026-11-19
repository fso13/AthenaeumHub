import { describe, expect, it } from 'vitest';
import { resolveConfig } from './env';

describe('auth mode configuration', () => {
  it('defaults to dev and never enables a password flow implicitly', () => {
    const config = resolveConfig({});
    expect(config.authMode).toBe('dev');
    expect(config.devSession).toBe(true);
    expect(Object.keys(config)).not.toContain('oidc');
  });

  it('accepts VITE_AUTH_MODE=password in any case', () => {
    expect(resolveConfig({ VITE_AUTH_MODE: 'password' }).authMode).toBe('password');
    expect(resolveConfig({ VITE_AUTH_MODE: ' PASSWORD ' }).authMode).toBe('password');
  });

  it('falls back to dev for legacy/unknown values (keycloak is gone)', () => {
    expect(resolveConfig({ VITE_AUTH_MODE: 'keycloak' }).authMode).toBe('dev');
    expect(resolveConfig({ VITE_AUTH_MODE: 'oidc' }).authMode).toBe('dev');
  });

  it('derives the API base URL from mock/dev flags only', () => {
    expect(resolveConfig({ VITE_USE_MOCKS: 'true' }).apiBaseUrl).toBe('/api/v1');
    expect(resolveConfig({ VITE_USE_MOCKS: 'false' }).apiBaseUrl).toBe(
      'http://localhost:8081/api/v1',
    );
    expect(
      resolveConfig({ VITE_USE_MOCKS: 'false', VITE_API_BASE_URL: '/api/v1' }).apiBaseUrl,
    ).toBe('/api/v1');
  });

  it('keeps auth-related env free of Keycloak/OIDC fields', () => {
    const config = resolveConfig({
      VITE_AUTH_MODE: 'password',
      VITE_OIDC_AUTHORITY: 'http://localhost:8180/realms/krug',
    });
    expect(JSON.stringify(config)).not.toContain('8180');
    expect(JSON.stringify(config)).not.toContain('keycloak');
  });

  it('treats VITE_DEV_SESSION=false as disabled', () => {
    expect(resolveConfig({ VITE_DEV_SESSION: 'false' }).devSession).toBe(false);
    expect(resolveConfig({ VITE_DEV_SESSION: 'true' }).devSession).toBe(true);
  });

  it('defaults WebRTC to no STUN and parses VITE_WEBRTC_ICE_SERVERS', () => {
    expect(resolveConfig({}).webrtcIceServers).toEqual([]);
    expect(
      resolveConfig({
        VITE_WEBRTC_ICE_SERVERS:
          'stun:stun.example.test:3478, turn:turn.example.test:3478, nope:invalid',
      }).webrtcIceServers,
    ).toEqual([{ urls: 'stun:stun.example.test:3478' }, { urls: 'turn:turn.example.test:3478' }]);
  });
});
