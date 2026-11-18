package ru.krug.backend.audit.application.model;

import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/**
 * Application-level request to append an audit event. {@code workspaceId} is null for
 * identity events created before the user has a workspace (JIT provisioning).
 */
public record AuditRecord(
        UUID workspaceId,
        UUID actorId,
        String action,
        String targetType,
        UUID targetId,
        String requestId,
        Map<String, Object> metadata,
        Instant occurredAt) {

    public AuditRecord {
        Objects.requireNonNull(actorId, "actorId");
        Objects.requireNonNull(action, "action");
        metadata = metadata == null ? Map.of() : Map.copyOf(metadata);
        Objects.requireNonNull(occurredAt, "occurredAt");
    }
}
