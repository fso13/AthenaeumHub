package ru.krug.backend.ops.domain.model;

import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/**
 * Transactional outbox record. Payload is metadata only (never plaintext message content).
 */
public record OutboxMessage(
        UUID workspaceId,
        String aggregateType,
        UUID aggregateId,
        String eventType,
        int eventVersion,
        String partitionKey,
        Map<String, Object> payload,
        Instant occurredAt) {

    public OutboxMessage {
        Objects.requireNonNull(workspaceId, "workspaceId");
        Objects.requireNonNull(aggregateType, "aggregateType");
        Objects.requireNonNull(aggregateId, "aggregateId");
        Objects.requireNonNull(eventType, "eventType");
        Objects.requireNonNull(partitionKey, "partitionKey");
        Objects.requireNonNull(payload, "payload");
        Objects.requireNonNull(occurredAt, "occurredAt");
    }
}
