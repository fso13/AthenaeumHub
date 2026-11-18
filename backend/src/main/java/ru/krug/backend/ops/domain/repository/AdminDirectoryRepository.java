package ru.krug.backend.ops.domain.repository;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import ru.krug.backend.ops.domain.model.AdminChatRow;
import ru.krug.backend.ops.domain.model.AdminStorageWorkspaceRow;
import ru.krug.backend.ops.domain.model.AdminUserRow;

/**
 * Read-only cross-tenant reads for the platform-admin directory. Implementations must use
 * the narrow SECURITY DEFINER functions from V23; the application-level platform-admin
 * guard is applied by the callers, not here.
 */
public interface AdminDirectoryRepository {

    /**
     * Users ordered by {@code (created_at DESC, id DESC)}, excluding DELETED. When
     * {@code beforeCreatedAt}/{@code beforeId} are set, only strictly older keys are
     * returned (opaque keyset). {@code limit} is already bounded by the caller.
     */
    List<AdminUserRow> findUsers(String query, Instant beforeCreatedAt, UUID beforeId, int limit);

    /**
     * Non-deleted chats (and non-deleted workspaces) ordered by
     * {@code (created_at DESC, id DESC)} with optional workspace/name/type filters.
     */
    List<AdminChatRow> findChats(UUID workspaceId, String query, String type,
                                 Instant beforeCreatedAt, UUID beforeId, int limit);

    /** Storage dashboard rows, optionally narrowed to one workspace. */
    List<AdminStorageWorkspaceRow> findStorageWorkspaces(UUID workspaceId);
}
