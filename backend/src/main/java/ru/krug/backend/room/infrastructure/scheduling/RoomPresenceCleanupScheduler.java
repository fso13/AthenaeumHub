package ru.krug.backend.room.infrastructure.scheduling;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import ru.krug.backend.room.application.usecase.RoomPresenceCleanupService;

/**
 * Periodic physical cleanup of stale {@code room.presence} rows. Logical TTL (30 s) is
 * always enforced by the read queries; this job only bounds table growth. Disabled in the
 * shared test profile, where the cleanup service is exercised directly.
 */
@Component
@ConditionalOnProperty(name = "krug.rooms.presence-cleanup-enabled", havingValue = "true",
        matchIfMissing = true)
public class RoomPresenceCleanupScheduler {

    private static final Logger log = LoggerFactory.getLogger(RoomPresenceCleanupScheduler.class);

    private final RoomPresenceCleanupService cleanup;

    public RoomPresenceCleanupScheduler(RoomPresenceCleanupService cleanup) {
        this.cleanup = cleanup;
    }

    @Scheduled(fixedDelayString = "${krug.rooms.presence-cleanup-interval:1m}")
    public void purge() {
        try {
            int deleted = cleanup.cleanup();
            if (deleted > 0) {
                log.debug("room.presence cleanup deleted={}", deleted);
            }
        } catch (RuntimeException ex) {
            log.error("room.presence cleanup failed", ex);
        }
    }
}
