package ru.krug.backend.workspace.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.workspace.domain.model.WorkspaceSecuritySettings;
import ru.krug.backend.workspace.domain.repository.WorkspaceSecuritySettingsRepository;

/** Tenant-scoped persistence of the one security-settings row per workspace. */
@Repository
public class WorkspaceSecuritySettingsRepositoryAdapter
        implements WorkspaceSecuritySettingsRepository {

    private final EntityManager entityManager;

    public WorkspaceSecuritySettingsRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public Optional<WorkspaceSecuritySettings> find(UUID workspaceId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT workspace_id, require_2fa, session_timeout_minutes,
                               dlp_enabled, retention_days, updated_at, updated_by
                          FROM workspace.security_settings
                         WHERE workspace_id = ?1
                        """)
                .setParameter(1, workspaceId)
                .getResultList();
        return rows.stream().findFirst().map(WorkspaceSecuritySettingsRepositoryAdapter::map);
    }

    @Override
    public void insertDefaultIfAbsent(UUID workspaceId) {
        entityManager.createNativeQuery("""
                        INSERT INTO workspace.security_settings (workspace_id)
                        VALUES (?1)
                        ON CONFLICT (workspace_id) DO NOTHING
                        """)
                .setParameter(1, workspaceId)
                .executeUpdate();
    }

    @Override
    public void update(WorkspaceSecuritySettings settings) {
        entityManager.createNativeQuery("""
                        UPDATE workspace.security_settings
                           SET require_2fa = ?2,
                               session_timeout_minutes = ?3,
                               dlp_enabled = ?4,
                               retention_days = ?5,
                               updated_at = ?6,
                               updated_by = ?7
                         WHERE workspace_id = ?1
                        """)
                .setParameter(1, settings.workspaceId())
                .setParameter(2, settings.requireTwoFactor())
                .setParameter(3, settings.sessionTimeoutMinutes())
                .setParameter(4, settings.dlpEnabled())
                .setParameter(5, settings.retentionDays())
                .setParameter(6, Timestamp.from(settings.updatedAt()))
                .setParameter(7, settings.updatedBy())
                .executeUpdate();
    }

    private static WorkspaceSecuritySettings map(Object[] row) {
        Instant updatedAt = JdbcInstants.toInstant(row[5]);
        if (updatedAt == null) {
            throw new IllegalStateException("workspace security updated_at is missing");
        }
        return new WorkspaceSecuritySettings((UUID) row[0], Boolean.TRUE.equals(row[1]),
                ((Number) row[2]).intValue(), Boolean.TRUE.equals(row[3]),
                ((Number) row[4]).intValue(), updatedAt, (UUID) row[6]);
    }
}
