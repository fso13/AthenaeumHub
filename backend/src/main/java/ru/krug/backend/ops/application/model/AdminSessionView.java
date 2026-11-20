package ru.krug.backend.ops.application.model;

import java.time.Instant;
import java.util.UUID;

/**
 * One session row exposed to the platform admin. {@code current} marks the caller's own
 * Keycloak {@code sid} when the selected user is the caller. No IP/username/token is
 * carried.
 */
public record AdminSessionView(
        String id,
        UUID userId,
        String device,
        Instant createdAt,
        Instant lastSeenAt,
        boolean current) {
}
