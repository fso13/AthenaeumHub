import type { ApiClient } from './http';
import { ApiError } from './problem';
import type {
  AuthLoginRequest,
  AuthLogoutRequest,
  AuthRefreshRequest,
  AuthRegisterRequest,
  AuthRegisterResponse,
  AuthResendEmailCodeRequest,
  AuthResendEmailCodeResponse,
  AuthSession,
  AuthTwoFactorChallenge,
  AuthTwoFactorEnrollmentResult,
  AuthTwoFactorEnrollStartRequest,
  AuthTwoFactorEnrollVerifyRequest,
  AuthTwoFactorVerifyRequest,
  AuthVerifyEmailRequest,
  TwoFactorRecoveryCodes,
  TwoFactorSetup,
} from './types';

/**
 * Result of `POST /auth/login` (P0-4 / #82): a no-2FA account gets the session
 * synchronously, a TOTP account gets a single-use `202` challenge instead. The
 * Keycloak token pair stays server-side until the second factor is accepted.
 */
export type AuthLoginResult =
  | { kind: 'session'; session: AuthSession }
  | { kind: 'challenge'; challenge: AuthTwoFactorChallenge };

/**
 * `POST /auth/verify-email` mirrors login when the installation policy requires
 * a second factor: `202` returns an ENROLL/TOTP challenge instead of a session.
 */
export type AuthVerifyEmailResult = AuthLoginResult;

/**
 * Typed Auth BFF client (`contracts/openapi.yaml` §auth). Every endpoint is
 * public (`security: []`): the browser sends no Keycloak token here — the
 * backend is the BFF and returns the session. Refresh/logout pass the token in
 * the body, never in the URL.
 */
export interface AuthApi {
  register(body: AuthRegisterRequest): Promise<AuthRegisterResponse>;
  verifyEmail(body: AuthVerifyEmailRequest): Promise<AuthVerifyEmailResult>;
  resendEmailCode(body: AuthResendEmailCodeRequest): Promise<AuthResendEmailCodeResponse>;
  login(body: AuthLoginRequest): Promise<AuthLoginResult>;
  /** `POST /auth/2fa/verify`: completes a login challenge, returns the session. */
  verifyTwoFactor(body: AuthTwoFactorVerifyRequest): Promise<AuthSession>;
  /**
   * #93 `POST /auth/2fa/enroll/start`: begins setup for a `202 ENROLL` login.
   * The challenge id is the proof of the already-verified password; no secret
   * is sent anywhere and the result lives only in memory.
   */
  startTwoFactorEnrollment(body: AuthTwoFactorEnrollStartRequest): Promise<TwoFactorSetup>;
  /**
   * #93 `POST /auth/2fa/enroll/verify`: confirms the first TOTP code and
   * returns the held session. The published contract has no recovery codes in
   * this response; the caller issues them separately and must persist neither.
   */
  verifyTwoFactorEnrollment(
    body: AuthTwoFactorEnrollVerifyRequest,
  ): Promise<AuthTwoFactorEnrollmentResult>;
  /**
   * After enrollment the contract returns only `AuthSession`; recovery codes
   * are issued separately. The freshly minted access token is passed
   * explicitly because the public auth client has no ambient token, and the
   * endpoint still requires the account password re-auth.
   */
  regenerateRecoveryCodesForSession(
    accessToken: string,
    password: string,
  ): Promise<TwoFactorRecoveryCodes>;
  refresh(refreshToken: string): Promise<AuthSession>;
  logout(refreshToken: string): Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readAuthSession(value: unknown): AuthSession | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.access_token !== 'string' || typeof record.refresh_token !== 'string') {
    return null;
  }
  if (typeof record.expires_in !== 'number' || !asRecord(record.user)) return null;
  return record as unknown as AuthSession;
}

function readRecoveryCodes(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value
    : Array.isArray(asRecord(value)?.codes)
      ? (asRecord(value)?.codes as unknown[])
      : [];
  return list.filter((code): code is string => typeof code === 'string' && code.length > 0);
}

/**
 * Tolerant normalization of the enrollment verify response. The published
 * shape is a bare `AuthSession`; a `{session, recovery_codes}` projection is
 * accepted too so a slightly different backend cannot lose the session after a
 * valid first code.
 */
function normalizeEnrollmentResult(data: unknown): AuthTwoFactorEnrollmentResult {
  const record = asRecord(data);
  const session = readAuthSession(record?.session) ?? readAuthSession(data);
  const codes = readRecoveryCodes(record?.recovery_codes ?? record?.codes);
  if (!session) {
    throw ApiError.client('INVALID_RESPONSE', 'Enrollment response did not contain a session');
  }
  // The published contract returns a bare `AuthSession`; recovery codes are
  // issued by the caller through `/me/2fa/recovery-codes` after enrollment.
  return { session, recoveryCodes: codes };
}

export function createAuthApi(client: ApiClient): AuthApi {
  return {
    async register(body) {
      const response = await client.post<AuthRegisterResponse>('/auth/register', body, {
        auth: false,
      });
      return response.data;
    },

    async verifyEmail(body) {
      const response = await client.post<AuthSession | AuthTwoFactorChallenge>(
        '/auth/verify-email',
        body,
        { auth: false },
      );
      if (response.status === 202) {
        return { kind: 'challenge', challenge: response.data as AuthTwoFactorChallenge };
      }
      return { kind: 'session', session: response.data as AuthSession };
    },

    async resendEmailCode(body) {
      const response = await client.post<AuthResendEmailCodeResponse>(
        '/auth/resend-email-code',
        body,
        { auth: false },
      );
      return response.data;
    },

    async login(body) {
      const response = await client.post<AuthSession | AuthTwoFactorChallenge>(
        '/auth/login',
        body,
        {
          auth: false,
        },
      );
      if (response.status === 202) {
        return { kind: 'challenge', challenge: response.data as AuthTwoFactorChallenge };
      }
      return { kind: 'session', session: response.data as AuthSession };
    },

    async verifyTwoFactor(body) {
      const response = await client.post<AuthSession>('/auth/2fa/verify', body, { auth: false });
      return response.data;
    },

    async startTwoFactorEnrollment(body) {
      const response = await client.post<TwoFactorSetup>('/auth/2fa/enroll/start', body, {
        auth: false,
      });
      return response.data;
    },

    async verifyTwoFactorEnrollment(body) {
      const response = await client.post<unknown>('/auth/2fa/enroll/verify', body, {
        auth: false,
      });
      return normalizeEnrollmentResult(response.data);
    },

    async regenerateRecoveryCodesForSession(accessToken, password) {
      const response = await client.post<TwoFactorRecoveryCodes>(
        '/me/2fa/recovery-codes',
        { password },
        { auth: false, headers: { Authorization: `Bearer ${accessToken}` } },
      );
      return response.data;
    },

    async refresh(refreshToken) {
      const body: AuthRefreshRequest = { refresh_token: refreshToken };
      const response = await client.post<AuthSession>('/auth/refresh', body, { auth: false });
      return response.data;
    },

    async logout(refreshToken) {
      const body: AuthLogoutRequest = { refresh_token: refreshToken };
      await client.post('/auth/logout', body, { auth: false });
    },
  };
}
