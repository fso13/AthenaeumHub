package ru.krug.backend.workspace.domain.repository;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import ru.krug.backend.workspace.domain.model.WorkspaceAuditEvent;

/**
 * Read side of the workspace audit view. The SQL function re-checks the caller's
 * OWNER/ADMIN membership and filters by workspace, so an application guard bypass still
 * returns no rows.
 */
public interface WorkspaceAuditRepository {

    /**
     * @param action exact action filter or null
     * @param actorId exact actor filter or null
     * @param from inclusive lower bound or null
     * @param to inclusive upper bound or null
     * @param cursorCreatedAt last row {@code created_at} or null
     * @param cursorId last row id or null
     */
    List<WorkspaceAuditEvent> page(UUID workspaceId, UUID callerId, String action,
                                   UUID actorId, Instant from, Instant to,
                                   Instant cursorCreatedAt, UUID cursorId, int limit);
}
