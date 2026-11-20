package ru.krug.backend.workspace.application.model;

import java.util.UUID;

/** Resolved manager context: the workspace and its immutable security mode. */
public record WorkspaceSecurityContext(UUID workspaceId, String securityMode) {

    public boolean e2ee() {
        return "E2EE".equals(securityMode);
    }
}
