package ru.krug.backend.workspace.domain.model;

import java.util.Locale;
import java.util.Optional;

/**
 * Workspace-level rights (P0-4 / #82). The matrix covers OWNER/ADMIN/MEMBER; a GUEST has
 * no workspace-level rights in this slice. OWNER is always allowed and its rows are
 * immutable through the API.
 */
public enum WorkspacePermission {

    MANAGE_WORKSPACE("manage_workspace"),
    MANAGE_MEMBERS("manage_members"),
    MANAGE_INVITES("manage_invites"),
    MANAGE_PERMISSIONS("manage_permissions"),
    VIEW_AUDIT("view_audit"),
    MANAGE_SECURITY("manage_security");

    private final String apiName;

    WorkspacePermission(String apiName) {
        this.apiName = apiName;
    }

    public String apiName() {
        return apiName;
    }

    public static Optional<WorkspacePermission> parse(String value) {
        if (value == null || value.isBlank()) {
            return Optional.empty();
        }
        String normalized = value.strip().toLowerCase(Locale.ROOT);
        for (WorkspacePermission permission : values()) {
            if (permission.apiName.equals(normalized)) {
                return Optional.of(permission);
            }
        }
        return Optional.empty();
    }

    /**
     * Built-in fallback used when a row is missing (defensive) and when a workspace is
     * first provisioned. OWNER rows are always true.
     */
    public static boolean defaultFor(Membership.Role role, WorkspacePermission permission) {
        if (role == Membership.Role.OWNER) {
            return true;
        }
        if (role == Membership.Role.ADMIN) {
            return true;
        }
        return false;
    }
}
