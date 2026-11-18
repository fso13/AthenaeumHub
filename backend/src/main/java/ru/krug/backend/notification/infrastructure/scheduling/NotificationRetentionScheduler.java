package ru.krug.backend.notification.infrastructure.scheduling;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import ru.krug.backend.notification.application.usecase.NotificationRetentionService;

/** E6 90-day notification GC. Disabled in tests; the service is called directly there. */
@Component
@ConditionalOnProperty(name = "krug.notifications.retention-enabled", havingValue = "true",
        matchIfMissing = true)
public class NotificationRetentionScheduler {

    private static final Logger log = LoggerFactory.getLogger(NotificationRetentionScheduler.class);

    private final NotificationRetentionService retentionService;

    public NotificationRetentionScheduler(NotificationRetentionService retentionService) {
        this.retentionService = retentionService;
    }

    @Scheduled(fixedDelayString = "${krug.notifications.retention-poll-interval:10m}")
    public void purge() {
        try {
            retentionService.run();
        } catch (RuntimeException ex) {
            // A failed batch must not kill the scheduler; the next tick retries.
            log.error("notification.retention failed", ex);
        }
    }
}
