package ru.krug.backend.workspace.api.dto;

import java.time.Instant;
import java.util.UUID;

/**
 * One workspace audit row (contract {@code WorkspaceAuditEvent}). No metadata, hashes,
 * request id or actor email.
 */
public record WorkspaceAuditEventResponse(
        UUID id,
        String action,
        UUID actorId,
        String targetType,
        UUID targetId,
        Instant createdAt) {
}
