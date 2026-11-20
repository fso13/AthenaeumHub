package ru.krug.backend.workspace.api.dto;

import java.time.Instant;
import java.util.UUID;

/**
 * One workspace member session (contract {@code WorkspaceSession}). There is no IP
 * address, username or token field by design.
 */
public record WorkspaceSessionResponse(
        String id,
        UUID userId,
        String device,
        Instant createdAt,
        Instant lastSeenAt,
        boolean current) {
}
