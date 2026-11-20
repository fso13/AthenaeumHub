package ru.krug.backend.workspace.application.model;

import java.time.Instant;
import java.util.UUID;

/**
 * One active Keycloak session of a workspace member. The raw admin payload (IP address,
 * username, client map) never crosses the adapter; {@code device} is a client-derived
 * label, and {@code current} marks the caller's own {@code sid}.
 */
public record WorkspaceSessionView(
        String id,
        UUID userId,
        String device,
        Instant createdAt,
        Instant lastSeenAt,
        boolean current) {
}
