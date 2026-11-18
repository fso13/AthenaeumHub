package ru.krug.backend.ops.domain.model;

import java.util.UUID;

/**
 * Metadata of an unpublished outbox row used by the relay.
 */
public record OutboxRecord(
        long id,
        UUID workspaceId,
        String eventType,
        UUID aggregateId,
        String partitionKey) {
}
