package ru.krug.backend.auth.application.port;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

/**
 * Short-lived server-side bridge between registration and verification. The browser never
 * sees these tokens; they exist because {@code /auth/verify-email} must return a Keycloak
 * session without ever receiving the password again (and the password is not stored).
 *
 * <p>Deliberately not a database table: an unverified Keycloak user is disabled, so the
 * cached refresh token is not usable until verification succeeds.</p>
 */
public interface PendingSessionPort {

    void store(UUID verificationId, String refreshToken, Instant expiresAt);

    /** Removes and returns the token; a second consume returns empty. */
    Optional<String> consume(UUID verificationId);

    void discard(UUID verificationId);
}
