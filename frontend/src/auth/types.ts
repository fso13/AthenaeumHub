/** Auth view-model. Access tokens deliberately never appear here. */
export interface AuthUser {
  sub: string;
  name: string;
  email?: string;
  /** Milliseconds since epoch, when known. */
  expiresAt: number | null;
}

/** User block of the Auth BFF `AuthSession` (contract). */
export interface AuthSessionUser {
  id: string;
  displayName: string;
  email: string;
}

/**
 * Persisted password-mode session. It is written only by the auth storage
 * module and never exposed to components; the UI sees `AuthUser` instead.
 */
export interface StoredAuthSession {
  accessToken: string;
  refreshToken: string;
  /** Access-token expiry, milliseconds since epoch. */
  expiresAt: number;
  user: AuthSessionUser;
}

/** Pending email verification. Never contains a code or a password. */
export interface StoredPendingVerification {
  id: string;
  email: string;
  /** Code expiry in epoch ms; `null` when the server did not disclose it. */
  expiresAt: number | null;
  /** Earliest resend time in epoch ms (`0` = can resend immediately). */
  resendUntil: number;
}

/**
 * P0-4 (#82) second-factor login challenge. It is held in memory only: the
 * challenge id is single-use, expires quickly and is worthless without the
 * TOTP/recovery code, but it is still not persisted.
 */
export interface PendingTwoFactorChallenge {
  id: string;
  /** Challenge expiry in epoch ms (`expires_in` from the `202` response). */
  expiresAt: number;
  /** Methods the server accepts for this account (`TOTP`/`RECOVERY_CODE`). */
  methods: Array<'TOTP' | 'RECOVERY_CODE'>;
}

export function toAuthUser(session: StoredAuthSession): AuthUser {
  return {
    sub: session.user.id,
    name: session.user.displayName,
    email: session.user.email,
    expiresAt: session.expiresAt,
  };
}
