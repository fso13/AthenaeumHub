package ru.krug.backend.workspace.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.workspace.domain.model.WorkspaceAuditEvent;
import ru.krug.backend.workspace.domain.repository.WorkspaceAuditRepository;

/**
 * Calls the V42 {@code workspace.audit_page} SECURITY DEFINER function. The function
 * enforces the caller's OWNER/ADMIN membership and returns only the contract columns, so
 * metadata, hashes, request ids and actor email never leave the database.
 */
@Repository
public class WorkspaceAuditRepositoryAdapter implements WorkspaceAuditRepository {

    private final EntityManager entityManager;

    public WorkspaceAuditRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public List<WorkspaceAuditEvent> page(UUID workspaceId, UUID callerId, String action,
                                          UUID actorId, Instant from, Instant to,
                                          Instant cursorCreatedAt, UUID cursorId, int limit) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT id, action, actor_id, target_type, target_id, created_at
                          FROM workspace.audit_page(
                                   CAST(?1 AS uuid), CAST(?2 AS uuid), CAST(?3 AS text),
                                   CAST(?4 AS uuid), CAST(?5 AS timestamptz),
                                   CAST(?6 AS timestamptz), CAST(?7 AS integer),
                                   CAST(?8 AS timestamptz), CAST(?9 AS uuid))
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, callerId)
                .setParameter(3, action)
                .setParameter(4, actorId)
                .setParameter(5, timestamp(from))
                .setParameter(6, timestamp(to))
                .setParameter(7, limit)
                .setParameter(8, timestamp(cursorCreatedAt))
                .setParameter(9, cursorId)
                .getResultList();
        return rows.stream().map(row -> new WorkspaceAuditEvent((UUID) row[0], (String) row[1],
                (UUID) row[2], (String) row[3], (UUID) row[4], instant(row[5]))).toList();
    }

    private static Timestamp timestamp(Instant value) {
        return value == null ? null : Timestamp.from(value);
    }

    private static Instant instant(Object value) {
        Instant instant = JdbcInstants.toInstant(value);
        if (instant == null) {
            throw new IllegalStateException("workspace audit timestamp is missing");
        }
        return instant;
    }
}
