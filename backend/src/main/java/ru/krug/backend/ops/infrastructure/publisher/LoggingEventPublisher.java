package ru.krug.backend.ops.infrastructure.publisher;

import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import ru.krug.backend.ops.application.port.EventPublisher;

/**
 * Kafka stub (SL-02). Metadata only: no payload, no plaintext, no tokens.
 */
@Component
public class LoggingEventPublisher implements EventPublisher {

    private static final Logger log = LoggerFactory.getLogger(LoggingEventPublisher.class);

    @Override
    public void publish(long eventId, String eventType, UUID aggregateId, UUID workspaceId,
                        String partitionKey) {
        log.info("outbox.publish event_id={} event_type={} aggregate_id={} workspace_id={}"
                        + " partition_key={} kafka=stub",
                eventId, eventType, aggregateId, workspaceId, partitionKey);
    }
}
