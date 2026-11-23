package ru.krug.backend.ops.infrastructure.scheduling;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import ru.krug.backend.ops.application.usecase.WorkspaceRetentionService;

/**
 * Daily workspace retention job (#101). Disabled by {@code krug.retention.enabled=false}
 * (tests call the service directly). The cron is configurable and defaults to 03:30 in
 * the server time zone; a failed run is logged and retried by the next daily tick.
 */
@Component
@ConditionalOnProperty(name = "krug.retention.enabled", havingValue = "true",
        matchIfMissing = true)
public class WorkspaceRetentionScheduler {

    private static final Logger log = LoggerFactory.getLogger(WorkspaceRetentionScheduler.class);

    private final WorkspaceRetentionService retentionService;

    public WorkspaceRetentionScheduler(WorkspaceRetentionService retentionService) {
        this.retentionService = retentionService;
    }

    @Scheduled(cron = "${krug.retention.workspace-cron:0 30 3 * * *}")
    public void purge() {
        try {
            retentionService.run();
        } catch (RuntimeException ex) {
            // No message is logged: a failed batch may carry SQL parameters.
            log.error("retention.workspace.scheduler_failed type={}",
                    ex.getClass().getSimpleName());
        }
    }
}
