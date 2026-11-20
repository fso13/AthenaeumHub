import { createContext, useContext } from 'react';
import type { MessageKey } from '../i18n/ru';
import type { AuthErrorInfo } from './errors';
import type { AuthUser, PendingTwoFactorChallenge } from './types';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

/** Value shared with the app shell (never contains tokens). */
export interface AppAuthValue {
  status: AuthStatus;
  user: AuthUser | null;
  /** Safe, human-readable error code; never contains tokens or raw responses. */
  error: string | null;
  signOut: () => void | Promise<void>;
  refresh: () => Promise<boolean>;
}

export const AppAuthContext = createContext<AppAuthValue | null>(null);

export function useAppAuth(): AppAuthValue {
  const value = useContext(AppAuthContext);
  if (!value) throw new Error('useAppAuth must be used inside the auth provider');
  return value;
}

export function useAppAuthOptional(): AppAuthValue | null {
  return useContext(AppAuthContext);
}

export interface PendingVerification {
  id: string;
  email: string;
  /** Code expiry in epoch ms; `null` when the server did not disclose it. */
  expiresAt: number | null;
  /** Earliest resend time in epoch ms (`0` = can resend immediately). */
  resendUntil: number;
}

export interface RegisterInput {
  displayName: string;
  email: string;
  password: string;
}

/**
 * Form-level API of the password-mode provider. Screens use this context;
 * the rest of the app only needs `useAppAuth()`.
 */
export interface PasswordAuthValue {
  status: AuthStatus;
  user: AuthUser | null;
  pending: PendingVerification | null;
  /** P0-4: a `202` TOTP login challenge waiting for the second factor. */
  challenge: PendingTwoFactorChallenge | null;
  busy: boolean;
  error: AuthErrorInfo | null;
  /** One-off success message (e.g. code resent); translated by the screen. */
  notice: MessageKey | null;
  login: (email: string, password: string) => Promise<boolean>;
  register: (input: RegisterInput) => Promise<boolean>;
  verify: (code: string) => Promise<boolean>;
  resendCode: () => Promise<boolean>;
  /** P0-4: complete the login challenge with a TOTP/recovery code. */
  verifyTwoFactor: (code: string) => Promise<boolean>;
  /**
   * P0-4 "resend": request a fresh challenge by re-submitting the already
   * verified password. No new email/code is sent and no secret is exposed.
   */
  resendChallenge: () => Promise<boolean>;
  /** P0-4 back/cancel: drop the challenge and return to the credentials form. */
  cancelChallenge: () => void;
  signOut: () => Promise<void>;
  refresh: () => Promise<boolean>;
  openLogin: () => void;
  openRegister: () => void;
  clearError: () => void;
}

export const PasswordAuthContext = createContext<PasswordAuthValue | null>(null);

export function usePasswordAuth(): PasswordAuthValue {
  const value = useContext(PasswordAuthContext);
  if (!value) throw new Error('usePasswordAuth must be used inside the password auth provider');
  return value;
}
