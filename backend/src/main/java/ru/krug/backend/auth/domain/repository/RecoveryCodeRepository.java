package ru.krug.backend.auth.domain.repository;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * One-time recovery-code persistence (P0-4 / #82). Only SHA-256 hex digests cross this
 * port; a raw code is never stored or read back.
 */
public interface RecoveryCodeRepository {

    /** Atomically replaces the whole set; previously issued codes stop working. */
    void replaceAll(UUID userId, List<String> codeHashes, Instant now);

    /** Marks one unused digest as consumed. {@code false} when it is unknown/used. */
    boolean consume(UUID userId, String codeHash, Instant now);

    long countRemaining(UUID userId);

    /** Removes every digest, used and unused (authenticator disable). */
    void deleteAll(UUID userId);
}
