package ru.krug.backend.ops.domain.repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.ops.domain.model.AdminAuditRow;
import ru.krug.backend.ops.domain.model.AdminChatDeleteResult;
import ru.krug.backend.ops.domain.model.AdminUserDetailRow;
import ru.krug.backend.ops.domain.model.AdminUserStatusChange;

/**
 * Write-side cross-tenant operations for the platform admin (FR-ADM-15…FR-ADM-17).
 * Implementations must use the narrow V25 SECURITY DEFINER functions; the application-level
 * platform-admin guard is applied by the callers, not here. No method physically deletes a
 * chat, message or file.
 */
public interface AdminActionRepository {

    /** One non-deleted user, or empty when the id is unknown/already deleted. */
    Optional<AdminUserDetailRow> findUser(UUID userId);

    /** Atomically assigns ACTIVE/SUSPENDED; the database enforces the last-admin backstop. */
    AdminUserStatusChange setUserStatus(UUID userId, String status);

    /** Soft-deletes a chat by setting {@code deleted_at}; never deletes messages. */
    AdminChatDeleteResult softDeleteChat(UUID chatId);

    /**
     * Cross-tenant audit page ordered by {@code (created_at DESC, id DESC)}. When
     * {@code beforeCreatedAt}/{@code beforeId} are set, only strictly older keys are
     * returned (opaque keyset). {@code limit} is already bounded by the caller.
     */
    List<AdminAuditRow> findAuditEvents(String action, Instant beforeCreatedAt, UUID beforeId,
                                        int limit);
}
