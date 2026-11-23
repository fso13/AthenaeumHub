package ru.krug.backend.auth.domain.repository;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

/**
 * Last-activity marker for one server-side session id (#101). The table is self-scoped by
 * RLS and stores no token, IP, device label or content — only the opaque session id, the
 * local user id and two timestamps.
 */
public interface SessionActivityRepository {

    /** Inserts the first marker or moves `last_activity_at` forward for the same user. */
    void touch(UUID userId, String sessionId, Instant at);

    Optional<Instant> lastActivity(UUID userId, String sessionId);
}
