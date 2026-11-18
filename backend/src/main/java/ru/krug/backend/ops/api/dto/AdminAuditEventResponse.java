package ru.krug.backend.ops.api.dto;

import java.time.Instant;
import java.util.UUID;

/**
 * Response DTO for one audit-log row (contract {@code AdminAuditEvent}). There is no
 * metadata field by design: bodies, file names and secrets are never exposed here.
 */
public record AdminAuditEventResponse(
        UUID id,
        String action,
        UUID actorId,
        String actorEmail,
        String targetType,
        UUID targetId,
        Instant createdAt) {
}
