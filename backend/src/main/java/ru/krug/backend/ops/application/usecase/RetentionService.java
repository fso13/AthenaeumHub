package ru.krug.backend.ops.application.usecase;

import java.util.function.IntSupplier;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import ru.krug.backend.ops.application.model.RetentionReport;
import ru.krug.backend.shared.application.port.RetentionMetrics;
import ru.krug.backend.shared.application.port.RetentionSettings;

/**
 * Drains expired idempotency keys and published outbox rows in bounded batches. Each batch
 * runs in its own transaction (see {@link IdempotencyOutboxRetentionBatch}); the per-run
 * cap prevents a runaway job from starving request processing.
 */
@Service
public class RetentionService {

    public static final String IDEMPOTENCY_TARGET = "idempotency_keys";
    public static final String OUTBOX_TARGET = "outbox";
    private static final int MAX_BATCHES_PER_RUN = 100;
    private static final Logger log = LoggerFactory.getLogger(RetentionService.class);

    private final IdempotencyOutboxRetentionBatch batch;
    private final RetentionSettings settings;
    private final RetentionMetrics metrics;

    public RetentionService(IdempotencyOutboxRetentionBatch batch, RetentionSettings settings,
                            RetentionMetrics metrics) {
        this.batch = batch;
        this.settings = settings;
        this.metrics = metrics;
    }

    public RetentionReport run() {
        int keys = drain(IDEMPOTENCY_TARGET, batch::deleteIdempotencyBatch);
        int outbox = drain(OUTBOX_TARGET, batch::deleteOutboxBatch);
        log.info("retention.run idempotency_keys={} outbox={}", keys, outbox);
        return new RetentionReport(keys, outbox);
    }

    private int drain(String target, IntSupplier deletion) {
        int total = 0;
        for (int i = 0; i < MAX_BATCHES_PER_RUN; i++) {
            int deleted = deletion.getAsInt();
            if (deleted <= 0) {
                break;
            }
            total += deleted;
            metrics.deleted(target, deleted);
            if (deleted < settings.batchSize()) {
                break;
            }
        }
        return total;
    }
}
