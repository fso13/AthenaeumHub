package ru.krug.backend.auth.application.model;

/**
 * Kind of login challenge (#91). {@code TOTP} is the existing post-password challenge for
 * an account with a confirmed authenticator; {@code ENROLL} is issued when the
 * installation requires 2FA but the account has no confirmed authenticator yet. Only the
 * matching completion endpoint accepts each mode, so an enrollment challenge cannot be
 * used to skip enrollment and a TOTP challenge cannot mint a secret.
 */
public enum TwoFactorChallengeMode {
    TOTP,
    ENROLL
}
