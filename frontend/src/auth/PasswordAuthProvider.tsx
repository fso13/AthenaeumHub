import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createAuthApi, type AuthApi } from '../api/authApi';
import { ApiClient } from '../api/http';
import { isApiError } from '../api/problem';
import type { AuthSession, AuthTwoFactorChallenge, TwoFactorSetup } from '../api/types';
import type { AppConfig } from '../config/env';
import type { MessageKey } from '../i18n/ru';
import { withInviteToken, readInviteToken, workspaceInvitePath } from '../router/inviteRoutes';
import { useLocation, useNavigate } from '../router/router';
import {
  AppAuthContext,
  PasswordAuthContext,
  type AppAuthValue,
  type AuthStatus,
  type EnrollmentStatus,
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
import {
  toAuthUser,
  type AuthUser,
  type PendingTwoFactorChallenge,
  type StoredAuthSession,
} from './types';

interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  pending: PendingVerification | null;
  /** P0-4: in-memory `202` login challenge (never persisted). */
  challenge: PendingTwoFactorChallenge | null;
  /** #93: login-time ENROLL setup; optional so older full-state sets stay valid. */
  enrollmentSetup?: TwoFactorSetup | null;
  enrollmentRecoveryCodes?: string[] | null;
  enrollmentStatus?: EnrollmentStatus;
  enrollmentError?: AuthErrorInfo | null;
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
    challenge: null,
    enrollmentSetup: null,
    enrollmentRecoveryCodes: null,
    enrollmentStatus: 'idle',
    enrollmentError: null,
    busy: false,
    error: null,
    notice: null,
  };
}

/**
 * #93: map the `202` challenge projection to the screen mode. `mode` is the
 * documented field; `enrollment_required` and an `ENROLL` method entry are
 * accepted so a forward-compatible backend cannot silently skip enrollment.
 */
function toChallengeMode(challenge: AuthTwoFactorChallenge): 'TOTP' | 'ENROLL' {
  const mode = typeof challenge.mode === 'string' ? challenge.mode.toUpperCase() : '';
  const methods = Array.isArray(challenge.methods) ? challenge.methods : [];
  if (
    mode === 'ENROLL' ||
    challenge.enrollment_required === true ||
    methods.some((method) => String(method).toUpperCase() === 'ENROLL')
  ) {
    return 'ENROLL';
  }
  return 'TOTP';
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
  const location = useLocation();
  /**
   * #100: the invite token may ride in the query string across login/register
   * (`?invite_token=…`). It is read from the URL on demand and never written
   * to storage; the URL itself is the only carrier.
   */
  const inviteToken = readInviteToken(location);
  const [state, setState] = useState<AuthState>(storedSessionState);
  const refreshPromise = useRef<Promise<boolean> | null>(null);
  /**
   * P0-4: credentials of the password step that produced a `202` challenge.
   * They are kept in memory only (never storage) and cleared on verify,
   * cancel, logout or an invalidated challenge. They are used solely to
   * request a fresh challenge ("resend") because the contract has no separate
   * resend endpoint.
   */
  const challengeCredentials = useRef<{ email: string; password: string } | null>(null);
  /**
   * #93: the session returned with the enrollment verification is held in
   * memory until the user acknowledges the one-time recovery codes. It is never
   * written to storage before `finishEnrollment()`.
   */
  const pendingEnrollmentSession = useRef<AuthSession | null>(null);

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
    challengeCredentials.current = null;
    pendingEnrollmentSession.current = null;
    setState({
      status: 'authenticated',
      user: toAuthUser(stored),
      pending: null,
      challenge: null,
      enrollmentSetup: null,
      enrollmentRecoveryCodes: null,
      enrollmentStatus: 'idle',
      enrollmentError: null,
      busy: false,
      error: null,
      notice: null,
    });
  }, []);

  const clearAll = useCallback(async (userId: string | null) => {
    await clearRuntimeAuth({ userId });
    clearSession();
    challengeCredentials.current = null;
    pendingEnrollmentSession.current = null;
    setState({
      status: 'anonymous',
      user: null,
      pending: null,
      challenge: null,
      enrollmentSetup: null,
      enrollmentRecoveryCodes: null,
      enrollmentStatus: 'idle',
      enrollmentError: null,
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
      } catch (error) {
        // #91: an access/refresh token minted before the server-wide policy was
        // enabled cannot be extended. The backend answers
        // `403 TWO_FACTOR_REQUIRED`; block the shell and ask for a fresh login,
        // which will return the ENROLL/TOTP challenge.
        const requiresTwoFactor = isApiError(error) && error.code === 'TWO_FACTOR_REQUIRED';
        // Keep the device id/E2EE account: this is an expired session, not a
        // logout. The next successful login reuses the same device.
        setRuntimeAccessToken(null);
        clearAuthSession();
        challengeCredentials.current = null;
        setState({
          status: 'anonymous',
          user: null,
          pending: readPendingVerification(),
          challenge: null,
          enrollmentSetup: null,
          enrollmentRecoveryCodes: null,
          enrollmentStatus: 'idle',
          enrollmentError: null,
          busy: false,
          error: null,
          notice: null,
        });
        if (requiresTwoFactor) {
          navigate(withInviteToken('/login?2fa=required', inviteToken), { replace: true });
        }
        return false;
      }
    })().finally(() => {
      refreshPromise.current = null;
    });
    return refreshPromise.current;
  }, [api, applySession, inviteToken, navigate]);

  useEffect(() => {
    setReauthHandler(refresh);
    return () => setReauthHandler(null);
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string): Promise<boolean> => {
      setState((current) => ({ ...current, busy: true, error: null, notice: null }));
      try {
        const result = await api.login({ email: email.trim(), password });
        if (result.kind === 'challenge') {
          // P0-4: the password is valid but the account has TOTP. No session
          // is issued; hold the challenge in memory and ask for the code.
          challengeCredentials.current = { email: email.trim(), password };
          const now = Date.now();
          const challenge: PendingTwoFactorChallenge = {
            id: result.challenge.challenge_id,
            expiresAt: now + Math.max(1, result.challenge.expires_in) * 1000,
            methods: result.challenge.methods,
            mode: toChallengeMode(result.challenge),
          };
          setState((current) => ({
            ...current,
            status: 'anonymous',
            user: null,
            pending: null,
            challenge,
            enrollmentSetup: null,
            enrollmentRecoveryCodes: null,
            enrollmentStatus: 'idle',
            enrollmentError: null,
            busy: false,
            error: null,
            notice: null,
          }));
          navigate(withInviteToken('/2fa', inviteToken));
          return true;
        }
        applySession(result.session);
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
            challenge: null,
            busy: false,
            error: null,
            notice: 'auth.verify.sent',
          });
          navigate(withInviteToken('/verify', inviteToken));
          return false;
        }
        setState((current) => ({ ...current, busy: false, error: info }));
        return false;
      }
    },
    [api, applySession, inviteToken, navigate],
  );

  const verifyTwoFactor = useCallback(
    async (code: string): Promise<boolean> => {
      const challenge = state.challenge;
      if (!challenge) {
        setState((current) => ({ ...current, error: { code: 'NOT_FOUND', status: 0 } }));
        return false;
      }
      setState((current) => ({ ...current, busy: true, error: null, notice: null }));
      try {
        const session = await api.verifyTwoFactor({
          challenge_id: challenge.id,
          code: code.trim(),
        });
        applySession(session);
        return true;
      } catch (error) {
        const info = toAuthError(error);
        // An invalid/expired/consumed challenge is no longer usable: drop it so
        // the guard returns to the credentials form, keeping the error visible.
        const invalidChallenge =
          info.code === 'TWO_FACTOR_CHALLENGE_INVALID' || info.status === 401;
        challengeCredentials.current = invalidChallenge ? null : challengeCredentials.current;
        setState((current) => ({
          ...current,
          challenge: invalidChallenge ? null : current.challenge,
          busy: false,
          error: info,
        }));
        return false;
      }
    },
    [api, applySession, state.challenge],
  );

  const startEnrollment = useCallback(async (): Promise<boolean> => {
    const challenge = state.challenge;
    if (!challenge || challenge.mode !== 'ENROLL') return false;
    if (state.enrollmentStatus === 'starting' || state.enrollmentSetup) return false;
    setState((current) => ({
      ...current,
      enrollmentStatus: 'starting',
      enrollmentError: null,
    }));
    try {
      const setup = await api.startTwoFactorEnrollment({ challenge_id: challenge.id });
      setState((current) => ({
        ...current,
        enrollmentSetup: setup,
        enrollmentStatus: 'ready',
        enrollmentError: null,
      }));
      return true;
    } catch (error) {
      const info = toAuthError(error);
      // An invalid/expired challenge has to return to the credentials form.
      const invalidChallenge = info.code === 'TWO_FACTOR_CHALLENGE_INVALID' || info.status === 401;
      if (invalidChallenge) {
        challengeCredentials.current = null;
        pendingEnrollmentSession.current = null;
      }
      setState((current) => ({
        ...current,
        challenge: invalidChallenge ? null : current.challenge,
        enrollmentSetup: null,
        enrollmentStatus: 'error',
        enrollmentError: info,
      }));
      return false;
    }
  }, [api, state.challenge, state.enrollmentSetup, state.enrollmentStatus]);

  const verifyEnrollment = useCallback(
    async (code: string): Promise<boolean> => {
      const challenge = state.challenge;
      if (!challenge || challenge.mode !== 'ENROLL' || !state.enrollmentSetup) return false;
      setState((current) => ({
        ...current,
        enrollmentStatus: 'verifying',
        enrollmentError: null,
      }));
      try {
        const result = await api.verifyTwoFactorEnrollment({
          challenge_id: challenge.id,
          code: code.trim(),
        });
        // The contract returns only the session; issue the one-time recovery
        // codes with the freshly minted token and the password already held
        // from the login step. A failure is not fatal: the recovery step
        // explains that codes can be reissued from the profile.
        let recoveryCodes = result.recoveryCodes;
        const password = challengeCredentials.current?.password;
        if (recoveryCodes.length === 0 && password) {
          try {
            const issued = await api.regenerateRecoveryCodesForSession(
              result.session.access_token,
              password,
            );
            recoveryCodes = issued.codes;
          } catch {
            recoveryCodes = [];
          }
        }
        // Hold the session in memory: the user has to save the one-time
        // recovery codes before the app shell (and its storage) is opened.
        pendingEnrollmentSession.current = result.session;
        setState((current) => ({
          ...current,
          enrollmentRecoveryCodes: recoveryCodes,
          enrollmentStatus: 'recovery',
          enrollmentError: null,
          busy: false,
          error: null,
        }));
        return true;
      } catch (error) {
        const info = toAuthError(error);
        const invalidChallenge =
          info.code === 'TWO_FACTOR_CHALLENGE_INVALID' || info.status === 401;
        if (invalidChallenge) {
          challengeCredentials.current = null;
          pendingEnrollmentSession.current = null;
        }
        setState((current) => ({
          ...current,
          challenge: invalidChallenge ? null : current.challenge,
          enrollmentSetup: invalidChallenge ? null : current.enrollmentSetup,
          enrollmentStatus: invalidChallenge ? 'error' : 'ready',
          enrollmentError: info,
          busy: false,
        }));
        return false;
      }
    },
    [api, state.challenge, state.enrollmentSetup],
  );

  const finishEnrollment = useCallback(() => {
    const session = pendingEnrollmentSession.current;
    if (!session) return;
    applySession(session);
    navigate(inviteToken ? workspaceInvitePath(inviteToken) : '/', { replace: true });
  }, [applySession, inviteToken, navigate]);

  const resendChallenge = useCallback(async (): Promise<boolean> => {
    const credentials = challengeCredentials.current;
    if (!credentials) {
      setState((current) => ({ ...current, error: { code: 'NOT_FOUND', status: 0 } }));
      return false;
    }
    setState((current) => ({ ...current, busy: true, error: null, notice: null }));
    try {
      const result = await api.login(credentials);
      if (result.kind === 'session') {
        applySession(result.session);
        return true;
      }
      const challenge: PendingTwoFactorChallenge = {
        id: result.challenge.challenge_id,
        expiresAt: Date.now() + Math.max(1, result.challenge.expires_in) * 1000,
        methods: result.challenge.methods,
        mode: toChallengeMode(result.challenge),
      };
      setState((current) => ({
        ...current,
        challenge,
        // A renewed challenge invalidates the old enrollment setup and codes.
        enrollmentSetup: null,
        enrollmentRecoveryCodes: null,
        enrollmentStatus: 'idle',
        enrollmentError: null,
        busy: false,
        error: null,
        notice: 'auth.twoFactor.challengeRenewed',
      }));
      return true;
    } catch (error) {
      const info = toAuthError(error);
      setState((current) => ({ ...current, busy: false, error: info }));
      return false;
    }
  }, [api, applySession]);

  const cancelChallenge = useCallback(() => {
    challengeCredentials.current = null;
    pendingEnrollmentSession.current = null;
    setState((current) => ({
      ...current,
      challenge: null,
      enrollmentSetup: null,
      enrollmentRecoveryCodes: null,
      enrollmentStatus: 'idle',
      enrollmentError: null,
      busy: false,
      error: null,
      notice: null,
    }));
    navigate(withInviteToken('/login', inviteToken), { replace: true });
  }, [inviteToken, navigate]);

  const register = useCallback(
    async (input: RegisterInput): Promise<boolean> => {
      setState((current) => ({ ...current, busy: true, error: null, notice: null }));
      // #100: the token comes from the URL/route flow. The server keeps only a
      // SHA-256 hash with the pending verification; this client never stores it.
      const registrationInviteToken = input.inviteToken ?? inviteToken;
      try {
        const response = await api.register({
          email: input.email.trim(),
          display_name: input.displayName.trim(),
          password: input.password,
          ...(registrationInviteToken ? { invite_token: registrationInviteToken } : {}),
        });
        const now = Date.now();
        const pending: PendingVerification = {
          id: response.verification_id,
          email: input.email.trim(),
          expiresAt: now + response.expires_in * 1000,
          resendUntil: now + response.resend_after * 1000,
        };
        // #93: keep the password in memory through email verification so an
        // ENROLL challenge can issue recovery codes via the re-auth endpoint;
        // it is never persisted and is dropped on success/cancel/logout.
        challengeCredentials.current = {
          email: input.email.trim(),
          password: input.password,
        };
        writePendingVerification(pending);
        setState({
          status: 'anonymous',
          user: null,
          pending,
          challenge: null,
          busy: false,
          error: null,
          notice: null,
        });
        navigate(withInviteToken('/verify', registrationInviteToken));
        return true;
      } catch (error) {
        setState((current) => ({ ...current, busy: false, error: toAuthError(error) }));
        return false;
      }
    },
    [api, inviteToken, navigate],
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
        const result = await api.verifyEmail({ verification_id: pending.id, code });
        if (result.kind === 'challenge') {
          // #91/#93: email verification can require the second factor too.
          clearPendingVerification();
          const challenge: PendingTwoFactorChallenge = {
            id: result.challenge.challenge_id,
            expiresAt: Date.now() + Math.max(1, result.challenge.expires_in) * 1000,
            methods: result.challenge.methods,
            mode: toChallengeMode(result.challenge),
          };
          setState((current) => ({
            ...current,
            status: 'anonymous',
            user: null,
            pending: null,
            challenge,
            enrollmentSetup: null,
            enrollmentRecoveryCodes: null,
            enrollmentStatus: 'idle',
            enrollmentError: null,
            busy: false,
            error: null,
            notice: null,
          }));
          navigate(withInviteToken('/2fa', inviteToken));
          return true;
        }
        applySession(result.session);
        return true;
      } catch (error) {
        setState((current) => ({ ...current, busy: false, error: toAuthError(error) }));
        return false;
      }
    },
    [api, applySession, inviteToken, navigate, state.pending],
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
    navigate(withInviteToken('/login?logged_out=1', inviteToken), { replace: true });
  }, [api, clearAll, inviteToken, navigate, state.user?.sub]);

  const openLogin = useCallback(() => {
    setState((current) => ({ ...current, error: null, notice: null }));
    navigate(withInviteToken('/login', inviteToken));
  }, [inviteToken, navigate]);

  const openRegister = useCallback(() => {
    setState((current) => ({ ...current, error: null, notice: null }));
    navigate(withInviteToken('/register', inviteToken));
  }, [inviteToken, navigate]);

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
      challenge: state.challenge,
      enrollmentSetup: state.enrollmentSetup ?? null,
      enrollmentRecoveryCodes: state.enrollmentRecoveryCodes ?? null,
      enrollmentStatus: state.enrollmentStatus ?? 'idle',
      enrollmentError: state.enrollmentError ?? null,
      busy: state.busy,
      error: state.error,
      notice: state.notice,
      login,
      register,
      verify,
      resendCode,
      verifyTwoFactor,
      startEnrollment,
      verifyEnrollment,
      finishEnrollment,
      resendChallenge,
      cancelChallenge,
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
      state.challenge,
      state.enrollmentSetup,
      state.enrollmentRecoveryCodes,
      state.enrollmentStatus,
      state.enrollmentError,
      state.busy,
      state.error,
      state.notice,
      login,
      register,
      verify,
      resendCode,
      verifyTwoFactor,
      startEnrollment,
      verifyEnrollment,
      finishEnrollment,
      resendChallenge,
      cancelChallenge,
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
