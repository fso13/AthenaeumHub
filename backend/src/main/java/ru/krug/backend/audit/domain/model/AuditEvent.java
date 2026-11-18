package ru.krug.backend.audit.domain.model;

import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/**
 * Immutable audit event. Hash chain: hash = SHA-256(prev_hash || canonical_json(event)).
 */
public record AuditEvent(
        UUID id,
        String scopeKey,
        UUID workspaceId,
        long seq,
        String actorType,
        UUID actorId,
        String action,
        String targetType,
        UUID targetId,
        String requestId,
        Map<String, Object> metadata,
        byte[] prevHash,
        byte[] hash,
        Instant createdAt) {

    public AuditEvent {
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(scopeKey, "scopeKey");
        if (seq <= 0) {
            throw new IllegalArgumentException("Audit seq must be positive");
        }
        Objects.requireNonNull(actorType, "actorType");
        Objects.requireNonNull(action, "action");
        metadata = metadata == null ? Map.of() : Map.copyOf(metadata);
        Objects.requireNonNull(prevHash, "prevHash");
        Objects.requireNonNull(hash, "hash");
        Objects.requireNonNull(createdAt, "createdAt");
    }
}
