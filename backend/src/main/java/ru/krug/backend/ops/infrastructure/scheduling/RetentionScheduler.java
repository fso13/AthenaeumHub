package ru.krug.backend.ops.infrastructure.scheduling;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import ru.krug.backend.ops.application.usecase.RetentionService;

/**
 * B-02 scheduled retention for idempotency keys and the outbox. Enabled by default;
 * {@code krug.retention.enabled=false} disables it (tests use the service directly).
 */
@Component
@ConditionalOnProperty(name = "krug.retention.enabled", havingValue = "true",
        matchIfMissing = true)
public class RetentionScheduler {

    private static final Logger log = LoggerFactory.getLogger(RetentionScheduler.class);

    private final RetentionService retentionService;

    public RetentionScheduler(RetentionService retentionService) {
        this.retentionService = retentionService;
    }

    @Scheduled(fixedDelayString = "${krug.retention.poll-interval:10m}")
    public void purge() {
        try {
            retentionService.run();
        } catch (RuntimeException ex) {
            // A failed run must not kill the scheduler; the next tick retries.
            log.error("retention.run failed", ex);
        }
    }
}
