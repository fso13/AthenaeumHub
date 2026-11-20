package ru.krug.backend.workspace.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

/** Effective rights of one role. */
public record WorkspaceRolePermissionsResponse(
        String role,
        @JsonProperty("manage_workspace") boolean manageWorkspace,
        @JsonProperty("manage_members") boolean manageMembers,
        @JsonProperty("manage_invites") boolean manageInvites,
        @JsonProperty("manage_permissions") boolean managePermissions,
        @JsonProperty("view_audit") boolean viewAudit,
        @JsonProperty("manage_security") boolean manageSecurity) {
}
