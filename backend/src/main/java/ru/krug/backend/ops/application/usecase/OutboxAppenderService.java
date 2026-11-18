package ru.krug.backend.ops.application.usecase;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.ops.application.model.OutboxEvent;
import ru.krug.backend.ops.application.port.OutboxPort;
import ru.krug.backend.ops.domain.model.OutboxMessage;
import ru.krug.backend.ops.domain.repository.OutboxRepository;

/**
 * Appends the outbox row in the caller's transaction (REQUIRED joins the message insert).
 */
@Service
public class OutboxAppenderService implements OutboxPort {

    private final OutboxRepository outboxRepository;

    public OutboxAppenderService(OutboxRepository outboxRepository) {
        this.outboxRepository = outboxRepository;
    }

    @Override
    @Transactional
    public void append(OutboxEvent event) {
        outboxRepository.save(new OutboxMessage(event.workspaceId(), event.aggregateType(),
                event.aggregateId(), event.eventType(), event.eventVersion(),
                event.partitionKey(), event.payload(), event.occurredAt()));
    }
}
