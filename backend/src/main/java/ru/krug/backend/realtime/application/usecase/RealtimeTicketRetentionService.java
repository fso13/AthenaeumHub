package ru.krug.backend.realtime.application.usecase;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import ru.krug.backend.shared.application.port.RetentionMetrics;
import ru.krug.backend.shared.application.port.RetentionSettings;

/**
 * Drains expired/consumed E3 tickets older than the retention window (default 1 day).
 * Tickets have no RLS (they are looked up before a tenant context exists), so no worker
 * role is needed; batching keeps the deletion short.
 */
@Service
public class RealtimeTicketRetentionService {

    public static final String TARGET = "realtime_tickets";
    private static final int MAX_BATCHES_PER_RUN = 100;
    private static final Logger log = LoggerFactory.getLogger(RealtimeTicketRetentionService.class);

    private final RealtimeTicketRetentionBatch batch;
    private final RetentionSettings settings;
    private final RetentionMetrics metrics;

    public RealtimeTicketRetentionService(RealtimeTicketRetentionBatch batch,
                                          RetentionSettings settings,
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
        log.info("retention.run realtime_tickets={}", total);
        return total;
    }
}
