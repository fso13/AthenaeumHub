package ru.krug.backend.workspace.domain.repository;

import java.util.List;
import java.util.UUID;

import ru.krug.backend.workspace.domain.model.WorkspaceMemberIdentity;

/**
 * Read-only directory of the Keycloak subjects of ACTIVE workspace members. The database
 * function (V42) verifies that the caller is an ACTIVE OWNER/ADMIN of an ACTIVE
 * workspace, so this is safe even if the application guard is bypassed.
 */
public interface WorkspaceSessionDirectory {

    List<WorkspaceMemberIdentity> findKeycloakMembers(UUID workspaceId, UUID callerId);
}
