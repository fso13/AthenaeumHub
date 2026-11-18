package ru.krug.backend.file.infrastructure.scheduling;

import java.util.List;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import ru.krug.backend.file.application.usecase.QuotaReconciliationHandler;
import ru.krug.backend.file.application.usecase.UploadGcHandler;
import ru.krug.backend.file.application.usecase.UploadScanHandler;
import ru.krug.backend.file.infrastructure.config.FilesProperties;

/**
 * E4-B background jobs. Single-node slice: in-process scheduler; a distributed lock is v1.
 * Every job runs each entity in its own transaction with the narrow worker role.
 */
@Component
public class FileMaintenanceScheduler {

    private static final Logger log = LoggerFactory.getLogger(FileMaintenanceScheduler.class);

    private final FilesProperties properties;
    private final UploadScanHandler scanHandler;
    private final UploadGcHandler gcHandler;
    private final QuotaReconciliationHandler reconciliationHandler;

    public FileMaintenanceScheduler(FilesProperties properties, UploadScanHandler scanHandler,
                                    UploadGcHandler gcHandler,
                                    QuotaReconciliationHandler reconciliationHandler) {
        this.properties = properties;
        this.scanHandler = scanHandler;
        this.gcHandler = gcHandler;
        this.reconciliationHandler = reconciliationHandler;
    }

    @Scheduled(fixedDelayString = "${krug.files.scan-poll-interval:2s}",
            initialDelayString = "${krug.files.scan-initial-delay:3s}")
    public void scanPending() {
        if (!properties.isScanEnabled()) {
            return;
        }
        try {
            List<UUID> ids = scanHandler.pendingUploadIds(properties.getScanBatchSize());
            for (UUID id : ids) {
                try {
                    scanHandler.scanOne(id);
                } catch (RuntimeException ex) {
                    log.warn("file.scan.job_failed upload_id={} type={}", id,
                            ex.getClass().getSimpleName());
                }
            }
        } catch (RuntimeException ex) {
            log.warn("file.scan.batch_failed type={}", ex.getClass().getSimpleName());
        }
    }

    @Scheduled(fixedDelayString = "${krug.files.gc-poll-interval:10m}",
            initialDelayString = "${krug.files.gc-initial-delay:1m}")
    public void gcExpired() {
        if (!properties.isGcEnabled()) {
            return;
        }
        try {
            List<UUID> ids = gcHandler.expiredUploadIds(properties.getGcBatchSize());
            for (UUID id : ids) {
                try {
                    gcHandler.gcOne(id);
                } catch (RuntimeException ex) {
                    log.warn("file.gc.job_failed upload_id={} type={}", id,
                            ex.getClass().getSimpleName());
                }
            }
        } catch (RuntimeException ex) {
            log.warn("file.gc.batch_failed type={}", ex.getClass().getSimpleName());
        }
    }

    @Scheduled(fixedDelayString = "${krug.files.reconcile-interval:24h}",
            initialDelayString = "${krug.files.reconcile-initial-delay:1m}")
    public void reconcileQuota() {
        if (!properties.isReconcileEnabled()) {
            return;
        }
        try {
            int count = reconciliationHandler.reconcile(properties.getReconcileBatchSize());
            if (count > 0) {
                log.info("file.quota.reconciled workspaces={}", count);
            }
        } catch (RuntimeException ex) {
            log.warn("file.quota.reconcile_failed type={}", ex.getClass().getSimpleName());
        }
    }
}
