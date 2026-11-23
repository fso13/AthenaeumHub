package ru.krug.backend.auth.domain.repository;

import java.util.UUID;

/**
 * Reads the effective workspace idle timeout for a user (#101). The implementation calls a
 * SQL function that returns the strictest ACTIVE workspace policy and re-checks that the
 * caller is the user in the transaction context.
 */
public interface SessionTimeoutRepository {

    /** @return minutes, or 0 when the user has no active workspace policy */
    int effectiveTimeoutMinutes(UUID userId);
}
