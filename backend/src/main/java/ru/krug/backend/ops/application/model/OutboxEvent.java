package ru.krug.backend.ops.application.model;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

/**
 * Cross-context port contract for appending an event. The message context builds it;
 * ops translates it into its own domain model.
 */
public record OutboxEvent(
        UUID workspaceId,
        String aggregateType,
        UUID aggregateId,
        String eventType,
        int eventVersion,
        String partitionKey,
        Map<String, Object> payload,
        Instant occurredAt) {
}
