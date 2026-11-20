package ru.krug.backend.workspace.api.dto;

import java.util.List;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonProperty;

/** {@code GET/PATCH /workspaces/{id}/permissions}. */
public record WorkspacePermissionMatrixResponse(
        @JsonProperty("workspace_id") UUID workspaceId,
        List<WorkspaceRolePermissionsResponse> roles) {
}
