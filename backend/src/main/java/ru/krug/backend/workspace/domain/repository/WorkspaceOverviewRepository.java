package ru.krug.backend.workspace.domain.repository;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.workspace.domain.model.WorkspaceOverviewStats;

/**
 * Read side of the workspace overview. The SQL function re-checks ACTIVE membership and
 * the current tenant GUC, so a caller who bypasses the application guard receives no row.
 */
public interface WorkspaceOverviewRepository {

    /**
     * @param now caller-clock instant used for the trailing 24-hour windows, so tests can
     *            control the boundary without changing the database clock
     * @return empty when the caller is not an ACTIVE member of the ACTIVE workspace
     */
    Optional<WorkspaceOverviewStats> stats(UUID workspaceId, UUID callerId, Instant now);
}
