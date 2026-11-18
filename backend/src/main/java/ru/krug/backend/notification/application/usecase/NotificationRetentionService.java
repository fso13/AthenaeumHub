package ru.krug.backend.notification.application.usecase;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import ru.krug.backend.notification.application.port.NotificationRetentionSettings;
import ru.krug.backend.shared.application.port.RetentionMetrics;

/**
 * Drains expired notifications in bounded batches until the table is clean or the per-run
 * cap is hit. Runs under the explicit {@code notification-retention} worker role.
 */
@Service
public class NotificationRetentionService {

    public static final String TARGET = "notifications";
    private static final int MAX_BATCHES_PER_RUN = 100;
    private static final Logger log = LoggerFactory.getLogger(NotificationRetentionService.class);

    private final NotificationRetentionBatch batch;
    private final NotificationRetentionSettings settings;
    private final RetentionMetrics metrics;

    public NotificationRetentionService(NotificationRetentionBatch batch,
                                        NotificationRetentionSettings settings,
                                        RetentionMetrics metrics) {
        this.batch = batch;
        this.settings = settings;
        this.metrics = metrics;
    }

    public int run() {
        int total = 0;
        for (int i = 0; i < MAX_BATCHES_PER_RUN; i++) {
            int deleted = batch.deleteBatch();
            if (deleted <= 0) {
                break;
            }
            total += deleted;
            metrics.deleted(TARGET, deleted);
            if (deleted < settings.batchSize()) {
                break;
            }
        }
        if (total > 0) {
            log.info("notification.retention.run deleted={}", total);
        }
        return total;
    }
}
