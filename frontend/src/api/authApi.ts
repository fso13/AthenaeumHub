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
  AuthVerifyEmailRequest,
} from './types';

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
  login(body: AuthLoginRequest): Promise<AuthSession>;
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
      const response = await client.post<AuthSession>('/auth/login', body, { auth: false });
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
