import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createAuthApi, type AuthApi } from '../api/authApi';
import { ApiClient } from '../api/http';
import type { AuthSession } from '../api/types';
import type { AppConfig } from '../config/env';
import type { MessageKey } from '../i18n/ru';
import { useNavigate } from '../router/router';
import {
  AppAuthContext,
  PasswordAuthContext,
  type AppAuthValue,
  type AuthStatus,
  type PasswordAuthValue,
  type PendingVerification,
  type RegisterInput,
} from './AuthContext';
import { toAuthError, type AuthErrorInfo } from './errors';
import { setReauthHandler } from './reauth';
import { clearRuntimeAuth, setRuntimeAccessToken } from './runtime';
import { clearSession } from './session';
import {
  clearAuthSession,
  clearPendingVerification,
  readAuthSession,
  readPendingVerification,
  writeAuthSession,
  writePendingVerification,
} from './storage';
import { toAuthUser, type AuthUser, type StoredAuthSession } from './types';

interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  pending: PendingVerification | null;
  busy: boolean;
  error: AuthErrorInfo | null;
  notice: MessageKey | null;
}

function storedSessionState(): AuthState {
  const session = readAuthSession();
  return {
    status: session ? 'authenticated' : 'anonymous',
    user: session ? toAuthUser(session) : null,
    pending: readPendingVerification(),
    busy: false,
    error: null,
    notice: null,
  };
}

function isPendingExpired(pending: PendingVerification, now: number): boolean {
  return pending.expiresAt !== null && pending.expiresAt <= now;
}

function toStoredSession(session: AuthSession): StoredAuthSession {
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: Date.now() + session.expires_in * 1000,
    user: {
      id: session.user.id,
      displayName: session.user.display_name,
      email: session.user.email,
    },
  };
}

interface PasswordAuthProviderProps {
  config: AppConfig;
  children: ReactNode;
}

/**
 * Password-mode provider (Auth BFF, docs/TASKS-AUTH-BFF.md). The browser only
 * talks to `/api/v1/auth/*`; there is no OIDC redirect, callback or Keycloak
 * URL. Tokens are persisted through `auth/storage.ts` and exposed to the app
 * only as a safe `AuthUser` view model.
 */
export function PasswordAuthProvider({ config, children }: PasswordAuthProviderProps) {
  const navigate = useNavigate();
  const [state, setState] = useState<AuthState>(storedSessionState);
  const refreshPromise = useRef<Promise<boolean> | null>(null);

  const api = useMemo<AuthApi>(
    () =>
      createAuthApi(
        new ApiClient({
          baseUrl: config.apiBaseUrl,
          timeoutMs: config.requestTimeoutMs,
          // Auth endpoints are public; tokens are added by the app client only.
          getToken: () => null,
          getDeviceId: () => null,
        }),
      ),
    [config.apiBaseUrl, config.requestTimeoutMs],
  );

  // Drop a verification that expired while the tab was closed.
  useEffect(() => {
    setState((current) => {
      if (!current.pending || !isPendingExpired(current.pending, Date.now())) return current;
      clearPendingVerification();
      return { ...current, pending: null };
    });
  }, []);

  const applySession = useCallback((session: AuthSession) => {
    const stored = toStoredSession(session);
    writeAuthSession(stored);
    clearPendingVerification();
    setRuntimeAccessToken(stored.accessToken);
    setState({
      status: 'authenticated',
      user: toAuthUser(stored),
      pending: null,
      busy: false,
      error: null,
      notice: null,
    });
  }, []);

  const clearAll = useCallback(async (userId: string | null) => {
    await clearRuntimeAuth({ userId });
    clearSession();
    setState({
      status: 'anonymous',
      user: null,
      pending: null,
      busy: false,
      error: null,
      notice: null,
    });
  }, []);

  const refresh = useCallback(async (): Promise<boolean> => {
    if (refreshPromise.current) return refreshPromise.current;
    const stored = readAuthSession();
    if (!stored) return false;

    refreshPromise.current = (async () => {
      try {
        const session = await api.refresh(stored.refreshToken);
        applySession(session);
        return true;
      } catch {
        // Keep the device id/E2EE account: this is an expired session, not a
        // logout. The next successful login reuses the same device.
        setRuntimeAccessToken(null);
        clearAuthSession();
        setState({
          status: 'anonymous',
          user: null,
          pending: readPendingVerification(),
          busy: false,
          error: null,
          notice: null,
        });
        return false;
      }
    })().finally(() => {
      refreshPromise.current = null;
    });
    return refreshPromise.current;
  }, [api, applySession]);

  useEffect(() => {
    setReauthHandler(refresh);
    return () => setReauthHandler(null);
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string): Promise<boolean> => {
      setState((current) => ({ ...current, busy: true, error: null, notice: null }));
      try {
        const session = await api.login({ email: email.trim(), password });
        applySession(session);
        return true;
      } catch (error) {
        const info = toAuthError(error);
        if (info.code === 'EMAIL_NOT_VERIFIED' && info.verificationId) {
          const pending: PendingVerification = {
            id: info.verificationId,
            email: email.trim(),
            expiresAt: null,
            resendUntil: 0,
          };
          writePendingVerification(pending);
          setState({
            status: 'anonymous',
            user: null,
            pending,
            busy: false,
            error: null,
            notice: 'auth.verify.sent',
          });
          navigate('/verify');
          return false;
        }
        setState((current) => ({ ...current, busy: false, error: info }));
        return false;
      }
    },
    [api, applySession, navigate],
  );

  const register = useCallback(
    async (input: RegisterInput): Promise<boolean> => {
      setState((current) => ({ ...current, busy: true, error: null, notice: null }));
      try {
        const response = await api.register({
          email: input.email.trim(),
          display_name: input.displayName.trim(),
          password: input.password,
        });
        const now = Date.now();
        const pending: PendingVerification = {
          id: response.verification_id,
          email: input.email.trim(),
          expiresAt: now + response.expires_in * 1000,
          resendUntil: now + response.resend_after * 1000,
        };
        writePendingVerification(pending);
        setState({
          status: 'anonymous',
          user: null,
          pending,
          busy: false,
          error: null,
          notice: null,
        });
        navigate('/verify');
        return true;
      } catch (error) {
        setState((current) => ({ ...current, busy: false, error: toAuthError(error) }));
        return false;
      }
    },
    [api, navigate],
  );

  const verify = useCallback(
    async (code: string): Promise<boolean> => {
      const pending = state.pending;
      if (!pending) {
        setState((current) => ({
          ...current,
          error: { code: 'NOT_FOUND', status: 0 },
        }));
        return false;
      }
      setState((current) => ({ ...current, busy: true, error: null, notice: null }));
      try {
        const session = await api.verifyEmail({ verification_id: pending.id, code });
        applySession(session);
        return true;
      } catch (error) {
        setState((current) => ({ ...current, busy: false, error: toAuthError(error) }));
        return false;
      }
    },
    [api, applySession, state.pending],
  );

  const resendCode = useCallback(async (): Promise<boolean> => {
    const pending = state.pending;
    if (!pending) {
      setState((current) => ({ ...current, error: { code: 'NOT_FOUND', status: 0 } }));
      return false;
    }
    setState((current) => ({ ...current, busy: true, error: null, notice: null }));
    try {
      const response = await api.resendEmailCode({ verification_id: pending.id });
      const now = Date.now();
      const next: PendingVerification = {
        ...pending,
        expiresAt: now + response.expires_in * 1000,
        resendUntil: now + response.resend_after * 1000,
      };
      writePendingVerification(next);
      setState((current) => ({
        ...current,
        pending: next,
        busy: false,
        error: null,
        notice: 'auth.verify.resent',
      }));
      return true;
    } catch (error) {
      setState((current) => ({ ...current, busy: false, error: toAuthError(error) }));
      return false;
    }
  }, [api, state.pending]);

  const signOut = useCallback(async (): Promise<void> => {
    const stored = readAuthSession();
    const userId = state.user?.sub ?? null;
    if (stored?.refreshToken) {
      // Revoke first, best-effort: a network failure must not keep local tokens.
      await api.logout(stored.refreshToken).catch(() => undefined);
    }
    await clearAll(userId);
    navigate('/login?logged_out=1', { replace: true });
  }, [api, clearAll, navigate, state.user?.sub]);

  const openLogin = useCallback(() => {
    setState((current) => ({ ...current, error: null, notice: null }));
    navigate('/login');
  }, [navigate]);

  const openRegister = useCallback(() => {
    setState((current) => ({ ...current, error: null, notice: null }));
    navigate('/register');
  }, [navigate]);

  const clearError = useCallback(() => {
    setState((current) => (current.error ? { ...current, error: null } : current));
  }, []);

  const appValue = useMemo<AppAuthValue>(
    () => ({
      status: state.status,
      user: state.user,
      error: state.error ? state.error.code : null,
      signOut,
      refresh,
    }),
    [state.status, state.user, state.error, signOut, refresh],
  );

  const value = useMemo<PasswordAuthValue>(
    () => ({
      status: state.status,
      user: state.user,
      pending: state.pending,
      busy: state.busy,
      error: state.error,
      notice: state.notice,
      login,
      register,
      verify,
      resendCode,
      signOut,
      refresh,
      openLogin,
      openRegister,
      clearError,
    }),
    [
      state.status,
      state.user,
      state.pending,
      state.busy,
      state.error,
      state.notice,
      login,
      register,
      verify,
      resendCode,
      signOut,
      refresh,
      openLogin,
      openRegister,
      clearError,
    ],
  );

  return (
    <AppAuthContext.Provider value={appValue}>
      <PasswordAuthContext.Provider value={value}>{children}</PasswordAuthContext.Provider>
    </AppAuthContext.Provider>
  );
}

/** Test-only reset: clears tokens/pending but keeps the app E2EE state. */
export function resetPasswordAuthForTests(): void {
  clearAuthSession();
  clearPendingVerification();
  setRuntimeAccessToken(null);
}
