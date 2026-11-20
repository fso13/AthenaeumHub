package ru.krug.backend.workspace.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.workspace.domain.model.DlpAction;
import ru.krug.backend.workspace.domain.model.DlpEvent;
import ru.krug.backend.workspace.domain.repository.DlpEventRepository;

/**
 * Read-only keyset query over the append-only DLP event log. No content column exists in
 * the table, and this adapter cannot mutate it.
 */
@Repository
public class DlpEventRepositoryAdapter implements DlpEventRepository {

    private final EntityManager entityManager;

    public DlpEventRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public List<DlpEvent> findEvents(UUID workspaceId, UUID policyId, DlpAction action,
                                     Instant cursorCreatedAt, UUID cursorId, int limit) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT id, workspace_id, policy_id, rule_name, action, actor_id,
                               chat_id, created_at
                          FROM workspace.dlp_events
                         WHERE workspace_id = ?1
                           AND (CAST(?2 AS uuid) IS NULL OR policy_id = CAST(?2 AS uuid))
                           AND (CAST(?3 AS text) IS NULL OR action = CAST(?3 AS text))
                           AND (CAST(?4 AS timestamptz) IS NULL
                                OR (created_at, id) < (CAST(?4 AS timestamptz),
                                                       CAST(?5 AS uuid)))
                         ORDER BY created_at DESC, id DESC
                         LIMIT ?6
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, policyId)
                .setParameter(3, action == null ? null : action.name())
                .setParameter(4, cursorCreatedAt == null ? null
                        : Timestamp.from(cursorCreatedAt))
                .setParameter(5, cursorId)
                .setParameter(6, limit)
                .getResultList();
        return rows.stream().map(row -> new DlpEvent((UUID) row[0], (UUID) row[1],
                (UUID) row[2], (String) row[3], DlpAction.valueOf((String) row[4]),
                (UUID) row[5], (UUID) row[6], instant(row[7]))).toList();
    }

    private static Instant instant(Object value) {
        Instant instant = JdbcInstants.toInstant(value);
        if (instant == null) {
            throw new IllegalStateException("dlp event timestamp is missing");
        }
        return instant;
    }
}
