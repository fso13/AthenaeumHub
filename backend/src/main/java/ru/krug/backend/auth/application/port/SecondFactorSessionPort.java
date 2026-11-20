package ru.krug.backend.auth.application.port;

/**
 * Tracks which BFF refresh tokens belong to a session that actually completed the second
 * factor (#91). Only a hash of the opaque refresh token is kept; the token itself is never
 * stored or logged.
 *
 * <p>Used by {@code POST /auth/refresh}: when the installation requires 2FA (or the
 * account has an enabled authenticator), a refresh token that was never minted by a
 * completed challenge is refused, so a password-only session cannot be kept alive past
 * the access-token lifetime. Ordinary non-2FA installations keep the pre-#91 behaviour.</p>
 */
public interface SecondFactorSessionPort {

    /** Marks the refresh token as issued by a second-factor-completed session. */
    void markVerified(String refreshToken);

    /** Whether the presented refresh token was issued by a completed session. */
    boolean isVerified(String refreshToken);
}
