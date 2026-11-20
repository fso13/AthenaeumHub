import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { createAuthApi } from './authApi';
import { ApiClient } from './http';
import { toAuthError } from '../auth/errors';
import { MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD, MOCK_EMAIL_CODE } from '../mocks/fixtures';
import { mockDb, server } from '../test/server';

function makeAuth() {
  const client = new ApiClient({
    baseUrl: 'http://api.test/api/v1',
    timeoutMs: 5_000,
    getToken: () => 'must-not-be-sent',
    getDeviceId: () => 'must-not-be-sent',
  });
  return createAuthApi(client);
}

async function captureAuthError(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return toAuthError(error);
  }
  throw new Error('expected an Auth BFF rejection');
}

function firstVerificationId(): string {
  const ids = [...mockDb.authVerifications.keys()];
  expect(ids).toHaveLength(1);
  return ids[0]!;
}

describe('Auth BFF client', () => {
  it('POST /auth/register sends the contract body without Authorization/devices headers', async () => {
    let captured: Headers | null = null;
    let body: unknown;
    server.use(
      http.post('*/api/v1/auth/register', async ({ request }) => {
        captured = request.headers;
        body = await request.clone().json();
        return HttpResponse.json(
          {
            verification_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            expires_in: 600,
            resend_after: 60,
          },
          { status: 202 },
        );
      }),
    );

    const response = await makeAuth().register({
      email: ' new@example.test ',
      display_name: 'Новый пользователь',
      password: 'Krug-password-2026',
    });

    expect(response.verification_id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(response.resend_after).toBe(60);
    expect(body).toEqual({
      email: ' new@example.test ',
      display_name: 'Новый пользователь',
      password: 'Krug-password-2026',
    });
    expect(captured).not.toBeNull();
    const headers = captured as unknown as Headers;
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-device-id')).toBeNull();
  });

  it('POST /auth/verify-email returns the AuthSession and enables the user', async () => {
    const api = makeAuth();
    await api.register({
      email: 'verify@example.test',
      display_name: 'Verify',
      password: 'Krug-password-2026',
    });

    const session = await api.verifyEmail({
      verification_id: firstVerificationId(),
      code: MOCK_EMAIL_CODE,
    });

    expect(session.token_type).toBe('Bearer');
    expect(session.access_token).toMatch(/^mock-access-/);
    expect(session.refresh_token).toMatch(/^mock-refresh-/);
    expect(session.user.email).toBe('verify@example.test');
    expect(mockDb.authUsers.find((user) => user.email === 'verify@example.test')?.verified).toBe(
      true,
    );
  });

  it('maps wrong credentials to INVALID_CREDENTIALS', async () => {
    const info = await captureAuthError(() =>
      makeAuth().login({ email: MOCK_DEMO_EMAIL, password: 'wrong-password' }),
    );
    expect(info).toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 });
  });

  it('maps an unverified login to EMAIL_NOT_VERIFIED with verification_id', async () => {
    const api = makeAuth();
    const registration = await api.register({
      email: 'pending@example.test',
      display_name: 'Pending',
      password: 'Krug-password-2026',
    });

    const info = await captureAuthError(() =>
      api.login({ email: 'pending@example.test', password: 'Krug-password-2026' }),
    );
    expect(info).toMatchObject({
      code: 'EMAIL_NOT_VERIFIED',
      status: 403,
      verificationId: registration.verification_id,
    });
  });

  it('maps CODE_INVALID attempts_left, CODE_EXPIRED and exhausted attempts', async () => {
    const api = makeAuth();
    await api.register({
      email: 'codes@example.test',
      display_name: 'Codes',
      password: 'Krug-password-2026',
    });
    const verificationId = firstVerificationId();

    const invalid = await captureAuthError(() =>
      api.verifyEmail({ verification_id: verificationId, code: '000000' }),
    );
    expect(invalid).toMatchObject({ code: 'CODE_INVALID', attemptsLeft: 4 });

    const verification = mockDb.authVerifications.get(verificationId);
    if (!verification) throw new Error('verification missing');
    verification.expiresAt = Date.now() - 1;
    const expired = await captureAuthError(() =>
      api.verifyEmail({ verification_id: verificationId, code: MOCK_EMAIL_CODE }),
    );
    expect(expired.code).toBe('CODE_EXPIRED');

    const next = await api.register({
      email: 'codes2@example.test',
      display_name: 'Codes 2',
      password: 'Krug-password-2026',
    });
    const second = mockDb.authVerifications.get(next.verification_id);
    if (!second) throw new Error('verification missing');
    second.attempts = 5;

    const limited = await captureAuthError(() =>
      api.verifyEmail({ verification_id: next.verification_id, code: MOCK_EMAIL_CODE }),
    );
    expect(limited).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 60 });
  });

  it('maps duplicate email to EMAIL_TAKEN', async () => {
    const info = await captureAuthError(() =>
      makeAuth().register({
        email: MOCK_DEMO_EMAIL,
        display_name: 'Duplicate',
        password: 'Krug-password-2026',
      }),
    );
    expect(info.code).toBe('EMAIL_TAKEN');
  });

  it('rotates refresh tokens and revokes the refresh token on logout', async () => {
    const api = makeAuth();
    const login = await api.login({
      email: MOCK_DEMO_EMAIL,
      password: MOCK_DEMO_PASSWORD,
    });
    if (login.kind !== 'session') throw new Error('Expected a session login result');
    const session = login.session;

    const refreshed = await api.refresh(session.refresh_token);
    expect(refreshed.access_token).not.toBe(session.access_token);
    expect(refreshed.refresh_token).not.toBe(session.refresh_token);
    expect(mockDb.authRefreshRequests).toEqual([session.refresh_token]);

    const rotated = await captureAuthError(() => api.refresh(session.refresh_token));
    expect(rotated.code).toBe('INVALID_CREDENTIALS');

    await expect(api.logout(refreshed.refresh_token)).resolves.toBeUndefined();
    expect(mockDb.authLogoutRequests).toEqual([refreshed.refresh_token]);
    expect(mockDb.authRefreshTokens.has(refreshed.refresh_token)).toBe(false);
  });

  it('maps 503 to AUTH_UNAVAILABLE and password-policy 422 to VALIDATION_FAILED', async () => {
    const api = makeAuth();
    server.use(
      http.post('*/api/v1/auth/login', () =>
        HttpResponse.json(
          { code: 'AUTH_UNAVAILABLE', message: 'Keycloak is down', request_id: 'req_503' },
          { status: 503 },
        ),
      ),
      http.post('*/api/v1/auth/register', () =>
        HttpResponse.json(
          { code: 'VALIDATION_FAILED', message: 'Password rejected', request_id: 'req_422' },
          { status: 422 },
        ),
      ),
    );

    const unavailable = await captureAuthError(() =>
      api.login({ email: MOCK_DEMO_EMAIL, password: MOCK_DEMO_PASSWORD }),
    );
    expect(unavailable.code).toBe('AUTH_UNAVAILABLE');
    const validation = await captureAuthError(() =>
      api.register({
        email: 'weak@example.test',
        display_name: 'Weak',
        password: 'short',
      }),
    );
    expect(validation.code).toBe('VALIDATION_FAILED');
  });
});
