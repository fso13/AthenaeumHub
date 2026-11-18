package ru.krug.backend.ops.application.port;

import java.util.UUID;

/**
 * Kafka publishing is a stub in B-01 (SL-02). The relay only hands metadata to the adapter.
 */
public interface EventPublisher {

    void publish(long eventId, String eventType, UUID aggregateId, UUID workspaceId,
                 String partitionKey);
}
