package ru.krug.backend.ops.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.ops.domain.model.AdminChatRow;
import ru.krug.backend.ops.domain.model.AdminStorageWorkspaceRow;
import ru.krug.backend.ops.domain.model.AdminUserRow;
import ru.krug.backend.ops.domain.repository.AdminDirectoryRepository;

/**
 * Cross-tenant admin reads through the V23 SECURITY DEFINER functions. Every method is a
 * single SQL statement (no per-row round trips): a page is one query, and the chat page
 * computes member/message aggregates through correlated subqueries/joins in the database.
 */
@Repository
public class AdminDirectoryRepositoryAdapter implements AdminDirectoryRepository {

    private final EntityManager entityManager;

    public AdminDirectoryRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public List<AdminUserRow> findUsers(String query, Instant beforeCreatedAt, UUID beforeId,
                                        int limit) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT id, email, display_name, is_platform_admin, status,
                               workspaces_count, chats_count, storage_used_bytes, created_at
                          FROM ops.admin_users_page(CAST(?1 AS text), CAST(?2 AS integer),
                                                    CAST(?3 AS timestamptz), CAST(?4 AS uuid))
                        """)
                .setParameter(1, query)
                .setParameter(2, limit)
                .setParameter(3, timestamp(beforeCreatedAt))
                .setParameter(4, beforeId)
                .getResultList();
        return rows.stream().map(AdminDirectoryRepositoryAdapter::toUserRow).toList();
    }

    @Override
    public List<AdminChatRow> findChats(UUID workspaceId, String query, String type,
                                        Instant beforeCreatedAt, UUID beforeId, int limit) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT id, name, type, security_mode, workspace_id, workspace_name,
                               members_count, messages_count, created_at, last_activity_at
                          FROM ops.admin_chats_page(CAST(?1 AS uuid), CAST(?2 AS text),
                                                    CAST(?3 AS text), CAST(?4 AS integer),
                                                    CAST(?5 AS timestamptz), CAST(?6 AS uuid))
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, query)
                .setParameter(3, type)
                .setParameter(4, limit)
                .setParameter(5, timestamp(beforeCreatedAt))
                .setParameter(6, beforeId)
                .getResultList();
        return rows.stream().map(AdminDirectoryRepositoryAdapter::toChatRow).toList();
    }

    @Override
    public List<AdminStorageWorkspaceRow> findStorageWorkspaces(UUID workspaceId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT workspace_id, workspace_name, security_mode, used_bytes,
                               reserved_bytes, storage_limit_bytes, objects, attachments
                          FROM ops.admin_storage_workspaces(CAST(?1 AS uuid))
                        """)
                .setParameter(1, workspaceId)
                .getResultList();
        return rows.stream().map(AdminDirectoryRepositoryAdapter::toStorageRow).toList();
    }

    private static AdminUserRow toUserRow(Object[] row) {
        return new AdminUserRow((UUID) row[0], (String) row[1], (String) row[2],
                Boolean.TRUE.equals(row[3]), (String) row[4], number(row[5]), number(row[6]),
                number(row[7]), instant(row[8]));
    }

    private static AdminChatRow toChatRow(Object[] row) {
        return new AdminChatRow((UUID) row[0], (String) row[1], (String) row[2], (String) row[3],
                (UUID) row[4], (String) row[5], number(row[6]), number(row[7]), instant(row[8]),
                instant(row[9]));
    }

    private static AdminStorageWorkspaceRow toStorageRow(Object[] row) {
        return new AdminStorageWorkspaceRow((UUID) row[0], (String) row[1], (String) row[2],
                number(row[3]), number(row[4]), number(row[5]), number(row[6]), number(row[7]));
    }

    private static long number(Object value) {
        return value == null ? 0L : ((Number) value).longValue();
    }

    private static Timestamp timestamp(Instant value) {
        return value == null ? null : Timestamp.from(value);
    }

    /**
     * PostgreSQL {@code timestamptz} arrives as {@link OffsetDateTime} through Hibernate 6
     * native queries; other JDBC layers may hand back {@link Timestamp}/{@link Instant}.
     * {@code LocalDateTime} is interpreted as UTC (the database session timezone).
     */
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
