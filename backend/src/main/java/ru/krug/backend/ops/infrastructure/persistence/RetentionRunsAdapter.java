package ru.krug.backend.ops.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.ops.application.port.RetentionRunsPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;

/**
 * Stores one retention counter row per workspace run (#101). The tenant GUC is set so the
 * row is visible to that workspace's OWNER/ADMIN through RLS; no content or error message
 * is stored (only a bounded exception class name).
 */
@Repository
public class RetentionRunsAdapter implements RetentionRunsPort {

    private static final String REQUEST_ID = "retention";

    private final EntityManager entityManager;
    private final TenantContext tenantContext;

    public RetentionRunsAdapter(EntityManager entityManager, TenantContext tenantContext) {
        this.entityManager = entityManager;
        this.tenantContext = tenantContext;
    }

    @Override
    @Transactional
    public void record(UUID workspaceId, Instant startedAt, Instant finishedAt,
                       int retentionDays, int messagesDeleted, int filesDeleted, int batches,
                       String status, String errorCode) {
        tenantContext.activate(new Principal(null, null, workspaceId, REQUEST_ID));
        entityManager.createNativeQuery("""
                        INSERT INTO workspace.retention_runs
                               (id, workspace_id, started_at, finished_at, retention_days,
                                messages_deleted, files_deleted, batches, status, error_code)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                        """)
                .setParameter(1, UUID.randomUUID())
                .setParameter(2, workspaceId)
                .setParameter(3, Timestamp.from(startedAt))
                .setParameter(4, Timestamp.from(finishedAt))
                .setParameter(5, retentionDays)
                .setParameter(6, messagesDeleted)
                .setParameter(7, filesDeleted)
                .setParameter(8, batches)
                .setParameter(9, status)
                .setParameter(10, errorCode)
                .executeUpdate();
    }
}
