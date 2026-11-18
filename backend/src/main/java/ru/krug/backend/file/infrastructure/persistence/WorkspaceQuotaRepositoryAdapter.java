package ru.krug.backend.file.infrastructure.persistence;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.file.domain.model.QuotaUsage;
import ru.krug.backend.file.domain.model.WorkspaceLimits;
import ru.krug.backend.file.domain.repository.WorkspaceQuotaRepository;

/**
 * Quota persistence adapter. The FOR UPDATE lock is taken by WorkspaceUsageJpaRepository;
 * lazily creating the usage/limits rows keeps workspaces created before/after V9 working
 * without a cross-module trigger.
 */
@Repository
public class WorkspaceQuotaRepositoryAdapter implements WorkspaceQuotaRepository {

    private final WorkspaceLimitsJpaRepository limitsJpaRepository;
    private final WorkspaceUsageJpaRepository usageJpaRepository;
    private final EntityManager entityManager;

    public WorkspaceQuotaRepositoryAdapter(WorkspaceLimitsJpaRepository limitsJpaRepository,
                                           WorkspaceUsageJpaRepository usageJpaRepository,
                                           EntityManager entityManager) {
        this.limitsJpaRepository = limitsJpaRepository;
        this.usageJpaRepository = usageJpaRepository;
        this.entityManager = entityManager;
    }

    @Override
    public Optional<WorkspaceLimits> findLimits(UUID workspaceId) {
        return limitsJpaRepository.findById(workspaceId).map(WorkspaceLimitsEntity::toDomain);
    }

    @Override
    public void saveLimits(WorkspaceLimits limits) {
        entityManager.createNativeQuery("""
                        INSERT INTO file.workspace_limits
                               (workspace_id, tariff, max_file_bytes, storage_bytes,
                                max_attachments, guest_file_bytes, retention_months)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                        ON CONFLICT (workspace_id) DO UPDATE
                           SET tariff = EXCLUDED.tariff,
                               max_file_bytes = EXCLUDED.max_file_bytes,
                               storage_bytes = EXCLUDED.storage_bytes,
                               max_attachments = EXCLUDED.max_attachments,
                               guest_file_bytes = EXCLUDED.guest_file_bytes,
                               retention_months = EXCLUDED.retention_months,
                               updated_at = now()
                        """)
                .setParameter(1, limits.workspaceId())
                .setParameter(2, limits.tariff().name())
                .setParameter(3, limits.maxFileBytes())
                .setParameter(4, limits.storageBytes())
                .setParameter(5, limits.maxAttachments())
                .setParameter(6, limits.guestFileBytes())
                .setParameter(7, limits.retentionMonths())
                .executeUpdate();
    }

    @Override
    public Optional<QuotaUsage> findUsage(UUID workspaceId) {
        return usageJpaRepository.findById(workspaceId).map(WorkspaceUsageEntity::toDomain);
    }

    @Override
    @Transactional
    public QuotaUsage lockUsage(UUID workspaceId) {
        entityManager.createNativeQuery("""
                        INSERT INTO file.workspace_usage (workspace_id)
                        VALUES (?1)
                        ON CONFLICT (workspace_id) DO NOTHING
                        """)
                .setParameter(1, workspaceId)
                .executeUpdate();
        return usageJpaRepository.findForUpdate(workspaceId)
                .map(WorkspaceUsageEntity::toDomain)
                .orElseGet(QuotaUsage::empty);
    }

    @Override
    public void saveUsage(UUID workspaceId, QuotaUsage usage) {
        int updated = entityManager.createNativeQuery("""
                        UPDATE file.workspace_usage
                           SET used_bytes = ?2,
                               reserved_bytes = ?3,
                               version = version + 1,
                               updated_at = now()
                         WHERE workspace_id = ?1
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, usage.used())
                .setParameter(3, usage.reserved())
                .executeUpdate();
        if (updated == 0) {
            entityManager.createNativeQuery("""
                            INSERT INTO file.workspace_usage
                                   (workspace_id, used_bytes, reserved_bytes)
                            VALUES (?1, ?2, ?3)
                            ON CONFLICT (workspace_id) DO UPDATE
                               SET used_bytes = EXCLUDED.used_bytes,
                                   reserved_bytes = EXCLUDED.reserved_bytes,
                                   version = file.workspace_usage.version + 1,
                                   updated_at = now()
                            """)
                    .setParameter(1, workspaceId)
                    .setParameter(2, usage.used())
                    .setParameter(3, usage.reserved())
                    .executeUpdate();
        }
    }

    @Override
    public List<UUID> listWorkspaceIds(int limit) {
        @SuppressWarnings("unchecked")
        List<UUID> ids = entityManager.createNativeQuery("""
                        SELECT workspace_id FROM file.workspace_usage
                         ORDER BY workspace_id
                         LIMIT ?1
                        """)
                .setParameter(1, limit)
                .getResultList();
        return ids;
    }

    @Override
    public long committedAttachmentBytes(UUID workspaceId) {
        Object result = entityManager.createNativeQuery("""
                        SELECT COALESCE(SUM(size_bytes), 0)
                          FROM file.attachments
                         WHERE workspace_id = ?1
                           AND status IN ('READY', 'BOUND')
                           AND deleted_at IS NULL
                        """)
                .setParameter(1, workspaceId)
                .getSingleResult();
        return result == null ? 0 : ((Number) result).longValue();
    }

    @Override
    public long activeReservationBytes(UUID workspaceId) {
        Object result = entityManager.createNativeQuery("""
                        SELECT COALESCE(SUM(size_bytes), 0)
                          FROM file.quota_reservations
                         WHERE workspace_id = ?1 AND status = 'ACTIVE'
                        """)
                .setParameter(1, workspaceId)
                .getSingleResult();
        return result == null ? 0 : ((Number) result).longValue();
    }
}
