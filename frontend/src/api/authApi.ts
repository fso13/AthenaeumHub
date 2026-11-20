import type { ApiClient } from './http';
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
  AuthTwoFactorVerifyRequest,
  AuthVerifyEmailRequest,
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
 * Typed Auth BFF client (`contracts/openapi.yaml` §auth). Every endpoint is
 * public (`security: []`): the browser sends no Keycloak token here — the
 * backend is the BFF and returns the session. Refresh/logout pass the token in
 * the body, never in the URL.
 */
export interface AuthApi {
  register(body: AuthRegisterRequest): Promise<AuthRegisterResponse>;
  verifyEmail(body: AuthVerifyEmailRequest): Promise<AuthSession>;
  resendEmailCode(body: AuthResendEmailCodeRequest): Promise<AuthResendEmailCodeResponse>;
  login(body: AuthLoginRequest): Promise<AuthLoginResult>;
  /** `POST /auth/2fa/verify`: completes a login challenge, returns the session. */
  verifyTwoFactor(body: AuthTwoFactorVerifyRequest): Promise<AuthSession>;
  refresh(refreshToken: string): Promise<AuthSession>;
  logout(refreshToken: string): Promise<void>;
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
      const response = await client.post<AuthSession>('/auth/verify-email', body, { auth: false });
      return response.data;
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
