package ru.krug.backend.ops.application.model;

import java.time.Instant;
import java.util.UUID;

/**
 * One audit-log row exposed to the platform admin. There is deliberately no metadata field:
 * the contract allows action/actor/target/time only (FR-ADM-17).
 */
public record AdminAuditView(
        UUID id,
        String action,
        UUID actorId,
        String actorEmail,
        String targetType,
        UUID targetId,
        Instant createdAt) {
}
