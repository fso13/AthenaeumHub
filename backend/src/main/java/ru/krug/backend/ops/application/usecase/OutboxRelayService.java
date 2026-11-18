package ru.krug.backend.ops.application.usecase;

import java.util.List;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.ops.application.port.EventPublisher;
import ru.krug.backend.ops.application.port.OutboxRelaySettings;
import ru.krug.backend.ops.domain.model.OutboxRecord;
import ru.krug.backend.ops.domain.repository.OutboxRepository;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.WorkerContext;

/**
 * Kafka publishing is a stub in B-01/B-02. Rows are locked with SKIP LOCKED, "published"
 * via the adapter (metadata-only log line), then marked published in the same transaction.
 *
 * <p>B-02: the relay is the only cross-tenant reader of {@code ops.outbox}. It explicitly
 * activates the {@code outbox-relay} worker role; tenant transactions keep the workspace
 * RLS guard and can never read another tenant's rows.</p>
 */
@Service
public class OutboxRelayService {

    private final OutboxRepository outboxRepository;
    private final EventPublisher eventPublisher;
    private final OutboxRelaySettings settings;
    private final WorkerContext workerContext;
    private final ClockPort clock;

    public OutboxRelayService(OutboxRepository outboxRepository, EventPublisher eventPublisher,
                              OutboxRelaySettings settings, WorkerContext workerContext,
                              ClockPort clock) {
        this.outboxRepository = outboxRepository;
        this.eventPublisher = eventPublisher;
        this.settings = settings;
        this.workerContext = workerContext;
        this.clock = clock;
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public int publishPending() {
        workerContext.activate(WorkerContext.WorkerRole.OUTBOX_RELAY);
        List<OutboxRecord> rows = outboxRepository.lockUnpublished(settings.batchSize());
        for (OutboxRecord row : rows) {
            eventPublisher.publish(row.id(), row.eventType(), row.aggregateId(), row.workspaceId(),
                    row.partitionKey());
            outboxRepository.markPublished(row.id(), clock.now());
        }
        return rows.size();
    }
}
