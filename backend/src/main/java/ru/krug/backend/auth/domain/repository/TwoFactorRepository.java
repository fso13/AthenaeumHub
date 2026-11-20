package ru.krug.backend.auth.domain.repository;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.auth.domain.model.TwoFactorSettings;

/**
 * Authenticator persistence (P0-4 / #82). The port only handles plaintext secrets in
 * memory; the adapter encrypts them with AES-GCM before writing PostgreSQL.
 */
public interface TwoFactorRepository {

    /** Caller-scoped read; the RLS context must be active. */
    Optional<TwoFactorSettings> find(UUID userId);

    /** Inserts or replaces an unconfirmed setup row (enabled_at = NULL, step 0). */
    void savePending(UUID userId, String secret, Instant now);

    void enable(UUID userId, Instant now);

    /** Records the accepted time step; a lower/equal step is a no-op. */
    void updateLastUsedStep(UUID userId, long step, Instant now);

    void delete(UUID userId);
}
