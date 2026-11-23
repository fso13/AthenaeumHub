package ru.krug.backend.ops.application.usecase;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import ru.krug.backend.file.application.port.ObjectStoragePort;
import ru.krug.backend.ops.application.model.FileRetentionBatch;
import ru.krug.backend.ops.application.model.MessageRetentionBatch;
import ru.krug.backend.ops.application.model.RetentionTarget;
import ru.krug.backend.ops.application.model.WorkspaceRetentionReport;
import ru.krug.backend.ops.application.port.ContentRetentionPort;
import ru.krug.backend.ops.application.port.RetentionRunsPort;
import ru.krug.backend.ops.application.port.RetentionTargetDirectory;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.RetentionMetrics;
import ru.krug.backend.shared.application.port.RetentionSettings;

/**
 * Daily workspace retention (#101): every ACTIVE workspace applies its own
 * {@code retention_days} window to managed messages and attachments.
 *
 * <p>Invariants:
 * <ul>
 *   <li><b>Bounded</b> — each workspace is drained in batches of
 *       {@link RetentionSettings#batchSize()} with at most {@link #MAX_BATCHES_PER_RUN}
 *       batches per run. Older rows left behind are handled by the next daily run.</li>
 *   <li><b>Idempotent</b> — only rows that are not already soft-deleted are selected; a
 *       repeated run (or a crash between batches) deletes nothing twice.</li>
 *   <li><b>Tenant-scoped</b> — every batch runs in a transaction with the workspace GUC and
 *       the normal RLS policies; the cross-tenant target list is read through the narrow
 *       retention worker function.</li>
 *   <li><b>Content-free counters</b> — {@code workspace.retention_runs} stores counts and a
 *       bounded exception class only. Message bodies are cleared and attachments become
 *       {@code DELETED}; object bytes are removed from storage after the DB commit.</li>
 *   <li><b>Idempotent failure isolation</b> — a failure in one workspace does not stop the
 *       others; it is recorded as {@code FAILED} and counted.</li>
 * </ul>
 *
 * <p>Legal holds: this slice has no legal-hold feature or table, so there is nothing to
 * skip. A production legal hold must add a per-message/per-file hold flag and an explicit
 * predicate here; document that before relying on retention for compliance deletion.
 * Already soft-deleted (tombstoned) messages are left untouched, preserving timeline
 * pagination and audit references.</p>
 */
@Service
public class WorkspaceRetentionService {

    public static final int MAX_BATCHES_PER_RUN = 20;
    public static final int MAX_TARGETS_PER_RUN = 1000;

    private static final Logger log = LoggerFactory.getLogger(WorkspaceRetentionService.class);

    private final RetentionTargetDirectory directory;
    private final ContentRetentionPort content;
    private final RetentionRunsPort runs;
    private final RetentionSettings settings;
    private final RetentionMetrics metrics;
    private final ObjectStoragePort storage;
    private final ClockPort clock;

    public WorkspaceRetentionService(RetentionTargetDirectory directory,
                                     ContentRetentionPort content, RetentionRunsPort runs,
                                     RetentionSettings settings, RetentionMetrics metrics,
                                     ObjectStoragePort storage, ClockPort clock) {
        this.directory = directory;
        this.content = content;
        this.runs = runs;
        this.settings = settings;
        this.metrics = metrics;
        this.storage = storage;
        this.clock = clock;
    }

    public WorkspaceRetentionReport run() {
        List<RetentionTarget> targets = directory.targets(MAX_TARGETS_PER_RUN);
        int batchSize = settings.batchSize();
        int workspaces = 0;
        int messages = 0;
        int files = 0;
        int batches = 0;
        int failed = 0;

        for (RetentionTarget target : targets) {
            Instant startedAt = clock.now();
            Instant cutoff = startedAt.minus(Duration.ofDays(target.retentionDays()));
            int targetMessages = 0;
            int targetFiles = 0;
            int targetBatches = 0;
            String status = "COMPLETED";
            String errorCode = null;
            try {
                boolean messagesDone = false;
                while (targetBatches < MAX_BATCHES_PER_RUN && !messagesDone) {
                    MessageRetentionBatch batch =
                            content.softDeleteMessages(target.workspaceId(), cutoff, batchSize);
                    targetBatches++;
                    targetMessages += batch.deleted();
                    messagesDone = batch.deleted() < batchSize;
                }
                boolean filesDone = false;
                while (targetBatches < MAX_BATCHES_PER_RUN && !filesDone) {
                    FileRetentionBatch batch =
                            content.softDeleteFiles(target.workspaceId(), cutoff, batchSize);
                    targetBatches++;
                    targetFiles += batch.deleted();
                    filesDone = batch.deleted() < batchSize;
                    deleteObjects(batch.objectKeys());
                }
            } catch (RuntimeException ex) {
                status = "FAILED";
                errorCode = ex.getClass().getSimpleName();
                failed++;
                // Exception messages may contain SQL parameters; only the class is logged.
                log.warn("retention.workspace.failed workspace_id={} type={}",
                        target.workspaceId(), errorCode);
            }

            Instant finishedAt = clock.now();
            try {
                runs.record(target.workspaceId(), startedAt, finishedAt,
                        target.retentionDays(), targetMessages, targetFiles, targetBatches,
                        status, errorCode);
            } catch (RuntimeException ex) {
                log.warn("retention.workspace.counters_failed workspace_id={} type={}",
                        target.workspaceId(), ex.getClass().getSimpleName());
            }
            if (targetMessages > 0) {
                metrics.deleted("workspace_messages", targetMessages);
            }
            if (targetFiles > 0) {
                metrics.deleted("workspace_files", targetFiles);
            }
            workspaces++;
            messages += targetMessages;
            files += targetFiles;
            batches += targetBatches;
        }

        log.info("retention.workspace.run workspaces={} messages={} files={} batches={} failed={}",
                workspaces, messages, files, batches, failed);
        return new WorkspaceRetentionReport(workspaces, messages, files, batches, failed);
    }

    private void deleteObjects(List<String> objectKeys) {
        for (String key : objectKeys) {
            try {
                storage.delete(key);
            } catch (RuntimeException ex) {
                // The DB row is already DELETED, so the content is unreachable even if the
                // object store is temporarily unavailable. The key is not logged.
                log.warn("retention.workspace.object_delete_failed type={}",
                        ex.getClass().getSimpleName());
            }
        }
    }
}
