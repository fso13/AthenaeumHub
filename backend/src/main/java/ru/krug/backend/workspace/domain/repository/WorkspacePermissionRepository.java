package ru.krug.backend.workspace.domain.repository;

import java.util.Map;
import java.util.UUID;

import ru.krug.backend.workspace.domain.model.Membership;
import ru.krug.backend.workspace.domain.model.WorkspacePermission;

/**
 * Effective workspace role matrix (P0-4 / #82). Reads return persisted rows; a missing row
 * is interpreted by the application as the built-in default for the role.
 */
public interface WorkspacePermissionRepository {

    /** Effective rows of one workspace, keyed by role then permission. */
    Map<Membership.Role, Map<WorkspacePermission, Boolean>> findMatrix(UUID workspaceId);

    /** Idempotent seeding of the documented defaults for a workspace without rows. */
    void insertDefaultsIfAbsent(UUID workspaceId);

    void update(UUID workspaceId, Membership.Role role, WorkspacePermission permission,
                boolean allowed);

    /** Persisted-or-default effective value for one cell. */
    boolean isAllowed(UUID workspaceId, Membership.Role role, WorkspacePermission permission);
}
