package ru.krug.backend.ops.infrastructure.persistence;

import java.util.List;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.ops.application.model.RetentionTarget;
import ru.krug.backend.ops.application.port.RetentionTargetDirectory;
import ru.krug.backend.shared.application.port.WorkerContext;

/**
 * Cross-tenant target lookup for the daily retention job (#101). The transaction-local
 * retention worker role is activated first; the SQL function re-checks that role and
 * returns only {@code workspace_id}/{@code retention_days}.
 */
@Repository
public class RetentionTargetDirectoryAdapter implements RetentionTargetDirectory {

    private final EntityManager entityManager;
    private final WorkerContext workerContext;

    public RetentionTargetDirectoryAdapter(EntityManager entityManager,
                                           WorkerContext workerContext) {
        this.entityManager = entityManager;
        this.workerContext = workerContext;
    }

    @Override
    @Transactional(readOnly = true)
    public List<RetentionTarget> targets(int limit) {
        workerContext.activate(WorkerContext.WorkerRole.RETENTION);
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT workspace_id, retention_days
                          FROM workspace.retention_targets(?1)
                        """)
                .setParameter(1, limit)
                .getResultList();
        return rows.stream()
                .map(row -> new RetentionTarget((UUID) row[0], ((Number) row[1]).intValue()))
                .toList();
    }
}
