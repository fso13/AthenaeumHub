package ru.krug.backend.ops.application.usecase;

import java.time.Instant;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.ops.domain.repository.IdempotencyKeyRepository;
import ru.krug.backend.ops.domain.repository.OutboxRepository;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.RetentionSettings;
import ru.krug.backend.shared.application.port.WorkerContext;

/**
 * One bounded deletion batch per transaction. The orchestrator calls these repeatedly so
 * a long purge never holds a single transaction (or its locks) for the whole table.
 */
@Service
public class IdempotencyOutboxRetentionBatch {

    private final WorkerContext workerContext;
    private final IdempotencyKeyRepository idempotencyKeys;
    private final OutboxRepository outbox;
    private final RetentionSettings settings;
    private final ClockPort clock;

    public IdempotencyOutboxRetentionBatch(WorkerContext workerContext,
                                            IdempotencyKeyRepository idempotencyKeys,
                                            OutboxRepository outbox, RetentionSettings settings,
                                            ClockPort clock) {
        this.workerContext = workerContext;
        this.idempotencyKeys = idempotencyKeys;
        this.outbox = outbox;
        this.settings = settings;
        this.clock = clock;
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public int deleteIdempotencyBatch() {
        workerContext.activate(WorkerContext.WorkerRole.RETENTION);
        Instant now = clock.now();
        return idempotencyKeys.deleteExpired(now,
                now.minus(settings.idempotencyInProgressTimeout()), settings.batchSize());
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public int deleteOutboxBatch() {
        workerContext.activate(WorkerContext.WorkerRole.RETENTION);
        Instant cutoff = clock.now().minus(settings.outboxRetention());
        return outbox.deletePublishedBefore(cutoff, settings.batchSize());
    }
}
