package ru.krug.backend.realtime.infrastructure.scheduling;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import ru.krug.backend.realtime.application.usecase.RealtimeTicketRetentionService;

/** B-02 scheduled cleanup of expired/consumed realtime tickets (default 1 day). */
@Component
@ConditionalOnProperty(name = "krug.retention.enabled", havingValue = "true",
        matchIfMissing = true)
public class RealtimeTicketRetentionScheduler {

    private static final Logger log = LoggerFactory.getLogger(RealtimeTicketRetentionScheduler.class);

    private final RealtimeTicketRetentionService retentionService;

    public RealtimeTicketRetentionScheduler(RealtimeTicketRetentionService retentionService) {
        this.retentionService = retentionService;
    }

    @Scheduled(fixedDelayString = "${krug.retention.poll-interval:10m}")
    public void purge() {
        try {
            retentionService.run();
        } catch (RuntimeException ex) {
            log.error("realtime ticket retention.run failed", ex);
        }
    }
}
