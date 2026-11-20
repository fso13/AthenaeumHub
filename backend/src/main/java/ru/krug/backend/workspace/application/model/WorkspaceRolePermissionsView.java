package ru.krug.backend.workspace.application.model;

/** Effective rights of one workspace role. OWNER is always all-true and immutable. */
public record WorkspaceRolePermissionsView(
        String role,
        boolean manageWorkspace,
        boolean manageMembers,
        boolean manageInvites,
        boolean managePermissions,
        boolean viewAudit,
        boolean manageSecurity) {
}
