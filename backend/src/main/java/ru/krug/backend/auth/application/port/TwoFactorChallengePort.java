package ru.krug.backend.auth.application.port;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.auth.application.model.KeycloakIdentity;
import ru.krug.backend.auth.application.model.TokenSet;
import ru.krug.backend.auth.application.model.TwoFactorChallengeMode;

/**
 * Short-lived server-side bridge between a successful password grant and the second factor
 * (P0-4 / #82). Keycloak tokens are held in memory only for the challenge TTL and are never
 * returned before the TOTP/recovery code is accepted.
 *
 * <p>Deliberately not a database table: a restart (or another node) loses pending
 * challenges, and the user simply signs in again.</p>
 */
public interface TwoFactorChallengePort {

    UUID store(UUID userId, KeycloakIdentity identity, TokenSet tokens, Instant expiresAt,
               TwoFactorChallengeMode mode);

    /** Back-compat overload: the pre-#91 challenge was always a TOTP challenge. */
    default UUID store(UUID userId, KeycloakIdentity identity, TokenSet tokens,
                       Instant expiresAt) {
        return store(userId, identity, tokens, expiresAt, TwoFactorChallengeMode.TOTP);
    }

    /** Live challenge; an expired entry is removed and answered as empty. */
    Optional<Challenge> find(UUID challengeId);

    /**
     * Counts one failed verification. The challenge is discarded when the configured
     * attempt budget is exhausted.
     */
    void recordFailure(UUID challengeId);

    /** Single-use consume; a second call returns empty. */
    Optional<Challenge> consume(UUID challengeId);

    void discard(UUID challengeId);

    record Challenge(UUID id, UUID userId, KeycloakIdentity identity, TokenSet tokens,
                     int attempts, Instant expiresAt, TwoFactorChallengeMode mode) {

        @Override
        public String toString() {
            return "Challenge[id=" + id + ", userId=" + userId + ", mode=" + mode
                    + ", attempts=" + attempts + "]";
        }
    }
}
