package ru.krug.backend.ops.domain.model;

import java.time.Instant;
import java.util.UUID;

/**
 * One audit row for the admin audit view. Deliberately excludes {@code metadata}, hashes
 * and request ids: the public contract exposes action/actor/target/time only.
 */
public record AdminAuditRow(
        UUID id,
        String action,
        UUID actorId,
        String actorEmail,
        String targetType,
        UUID targetId,
        Instant createdAt) {
}
