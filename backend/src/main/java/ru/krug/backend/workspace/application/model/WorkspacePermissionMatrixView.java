package ru.krug.backend.workspace.application.model;

import java.util.List;
import java.util.UUID;

/** Full OWNER/ADMIN/MEMBER matrix returned by {@code GET/PATCH .../permissions}. */
public record WorkspacePermissionMatrixView(UUID workspaceId,
                                            List<WorkspaceRolePermissionsView> roles) {
}
