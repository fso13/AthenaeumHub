package ru.krug.backend.ops.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.ops.domain.model.AdminAuditRow;
import ru.krug.backend.ops.domain.model.AdminChatDeleteResult;
import ru.krug.backend.ops.domain.model.AdminUserDetailRow;
import ru.krug.backend.ops.domain.model.AdminUserStatusChange;
import ru.krug.backend.ops.domain.repository.AdminActionRepository;

/**
 * Cross-tenant admin writes/reads through the V25 SECURITY DEFINER functions. Every method
 * is one SQL statement; the application-level guard runs before any call. The functions are
 * the only place that may touch another tenant's rows, so RLS policies stay untouched.
 */
@Repository
public class AdminActionRepositoryAdapter implements AdminActionRepository {

    private final EntityManager entityManager;

    public AdminActionRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public Optional<AdminUserDetailRow> findUser(UUID userId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT id, email, display_name, status, is_platform_admin
                          FROM ops.admin_user_detail(CAST(?1 AS uuid))
                        """)
                .setParameter(1, userId)
                .getResultList();
        return rows.stream().findFirst().map(row -> new AdminUserDetailRow(
                (UUID) row[0], (String) row[1], (String) row[2], (String) row[3],
                Boolean.TRUE.equals(row[4])));
    }

    @Override
    public AdminUserStatusChange setUserStatus(UUID userId, String status) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT outcome, id, status
                          FROM ops.admin_set_user_status(CAST(?1 AS uuid),
                                                         CAST(?2 AS text))
                        """)
                .setParameter(1, userId)
                .setParameter(2, status)
                .getResultList();
        Object[] row = rows.stream().findFirst()
                .orElseThrow(() -> new IllegalStateException(
                        "ops.admin_set_user_status returned no row"));
        return new AdminUserStatusChange(AdminUserStatusChange.outcome((String) row[0]),
                (UUID) row[1], (String) row[2]);
    }

    @Override
    public AdminChatDeleteResult softDeleteChat(UUID chatId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT outcome, workspace_id, members_count
                          FROM ops.admin_soft_delete_chat(CAST(?1 AS uuid))
                        """)
                .setParameter(1, chatId)
                .getResultList();
        Object[] row = rows.stream().findFirst()
                .orElseThrow(() -> new IllegalStateException(
                        "ops.admin_soft_delete_chat returned no row"));
        return new AdminChatDeleteResult(AdminChatDeleteResult.outcome((String) row[0]),
                (UUID) row[1], row[2] == null ? 0L : ((Number) row[2]).longValue());
    }

    @Override
    public List<AdminAuditRow> findAuditEvents(String action, Instant beforeCreatedAt,
                                               UUID beforeId, int limit) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT id, action, actor_id, actor_email, target_type, target_id,
                               created_at
                          FROM ops.admin_audit_page(CAST(?1 AS text), CAST(?2 AS integer),
                                                    CAST(?3 AS timestamptz),
                                                    CAST(?4 AS uuid))
                        """)
                .setParameter(1, action)
                .setParameter(2, limit)
                .setParameter(3, timestamp(beforeCreatedAt))
                .setParameter(4, beforeId)
                .getResultList();
        return rows.stream().map(row -> new AdminAuditRow((UUID) row[0], (String) row[1],
                (UUID) row[2], (String) row[3], (String) row[4], (UUID) row[5],
                instant(row[6]))).toList();
    }

    private static Timestamp timestamp(Instant value) {
        return value == null ? null : Timestamp.from(value);
    }

    private static Instant instant(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof Instant instant) {
            return instant;
        }
        if (value instanceof OffsetDateTime offset) {
            return offset.toInstant();
        }
        if (value instanceof Timestamp timestamp) {
            return timestamp.toInstant();
        }
        if (value instanceof LocalDateTime local) {
            return local.toInstant(ZoneOffset.UTC);
        }
        throw new IllegalStateException("Unexpected admin timestamp type: "
                + value.getClass().getName());
    }
}
