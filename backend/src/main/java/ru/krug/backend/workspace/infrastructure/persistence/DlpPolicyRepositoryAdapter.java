package ru.krug.backend.workspace.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.workspace.domain.model.DlpAction;
import ru.krug.backend.workspace.domain.model.DlpPatternType;
import ru.krug.backend.workspace.domain.model.DlpPolicy;
import ru.krug.backend.workspace.domain.model.DlpScope;
import ru.krug.backend.workspace.domain.repository.DlpPolicyRepository;

/**
 * Tenant-scoped DLP rule persistence. RLS ({@code app.workspace_id}) and the explicit
 * {@code workspace_id} predicate both apply; the pattern is stored as an opaque bounded
 * text value and is never compiled by the database or the application.
 */
@Repository
public class DlpPolicyRepositoryAdapter implements DlpPolicyRepository {

    private final EntityManager entityManager;

    public DlpPolicyRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public List<DlpPolicy> findAll(UUID workspaceId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT id, workspace_id, name, action, pattern_type, pattern,
                               scope, max_file_size_bytes, enabled, created_by,
                               created_at, updated_at
                          FROM workspace.dlp_policies
                         WHERE workspace_id = ?1
                         ORDER BY created_at DESC, id DESC
                         LIMIT 100
                        """)
                .setParameter(1, workspaceId)
                .getResultList();
        return rows.stream().map(DlpPolicyRepositoryAdapter::map).toList();
    }

    @Override
    public Optional<DlpPolicy> findById(UUID workspaceId, UUID policyId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT id, workspace_id, name, action, pattern_type, pattern,
                               scope, max_file_size_bytes, enabled, created_by,
                               created_at, updated_at
                          FROM workspace.dlp_policies
                         WHERE workspace_id = ?1 AND id = ?2
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, policyId)
                .getResultList();
        return rows.stream().findFirst().map(DlpPolicyRepositoryAdapter::map);
    }

    @Override
    public boolean nameTaken(UUID workspaceId, String name, UUID excludeId) {
        Number count = (Number) entityManager.createNativeQuery("""
                        SELECT count(*)
                          FROM workspace.dlp_policies
                         WHERE workspace_id = ?1
                           AND lower(name) = lower(?2)
                           AND (CAST(?3 AS uuid) IS NULL OR id <> CAST(?3 AS uuid))
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, name)
                .setParameter(3, excludeId)
                .getSingleResult();
        return count.longValue() > 0;
    }

    @Override
    public long count(UUID workspaceId) {
        Number count = (Number) entityManager.createNativeQuery("""
                        SELECT count(*) FROM workspace.dlp_policies WHERE workspace_id = ?1
                        """)
                .setParameter(1, workspaceId)
                .getSingleResult();
        return count.longValue();
    }

    @Override
    public boolean insert(DlpPolicy policy) {
        int inserted = entityManager.createNativeQuery("""
                        INSERT INTO workspace.dlp_policies
                               (id, workspace_id, name, action, pattern_type, pattern,
                                scope, max_file_size_bytes, enabled, created_by, created_at,
                                updated_at)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                        ON CONFLICT DO NOTHING
                        """)
                .setParameter(1, policy.id())
                .setParameter(2, policy.workspaceId())
                .setParameter(3, policy.name())
                .setParameter(4, policy.action().name())
                .setParameter(5, policy.patternType().name())
                .setParameter(6, policy.pattern())
                .setParameter(7, policy.scope().name())
                .setParameter(8, policy.maxFileSizeBytes())
                .setParameter(9, policy.enabled())
                .setParameter(10, policy.createdBy())
                .setParameter(11, Timestamp.from(policy.createdAt()))
                .setParameter(12, Timestamp.from(policy.updatedAt()))
                .executeUpdate();
        return inserted == 1;
    }

    @Override
    public boolean update(DlpPolicy policy) {
        int updated = entityManager.createNativeQuery("""
                        UPDATE workspace.dlp_policies
                           SET name = ?3,
                               action = ?4,
                               pattern_type = ?5,
                               pattern = ?6,
                               scope = ?7,
                               max_file_size_bytes = ?8,
                               enabled = ?9,
                               updated_at = ?10
                         WHERE workspace_id = ?1 AND id = ?2
                        """)
                .setParameter(1, policy.workspaceId())
                .setParameter(2, policy.id())
                .setParameter(3, policy.name())
                .setParameter(4, policy.action().name())
                .setParameter(5, policy.patternType().name())
                .setParameter(6, policy.pattern())
                .setParameter(7, policy.scope().name())
                .setParameter(8, policy.maxFileSizeBytes())
                .setParameter(9, policy.enabled())
                .setParameter(10, Timestamp.from(policy.updatedAt()))
                .executeUpdate();
        return updated == 1;
    }

    @Override
    public boolean delete(UUID workspaceId, UUID policyId) {
        int deleted = entityManager.createNativeQuery("""
                        DELETE FROM workspace.dlp_policies
                         WHERE workspace_id = ?1 AND id = ?2
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, policyId)
                .executeUpdate();
        return deleted == 1;
    }

    private static DlpPolicy map(Object[] row) {
        Long maxFileSizeBytes = row[7] == null ? null : ((Number) row[7]).longValue();
        return new DlpPolicy((UUID) row[0], (UUID) row[1], (String) row[2],
                DlpAction.valueOf((String) row[3]), DlpPatternType.valueOf((String) row[4]),
                (String) row[5], DlpScope.valueOf((String) row[6]), maxFileSizeBytes,
                Boolean.TRUE.equals(row[8]), (UUID) row[9], instant(row[10]), instant(row[11]));
    }

    private static Instant instant(Object value) {
        Instant instant = JdbcInstants.toInstant(value);
        if (instant == null) {
            throw new IllegalStateException("dlp policy timestamp is missing");
        }
        return instant;
    }
}
